'use strict';
// Prüft Abarbeitung: ein Request pro Karte, Cache, Tageszähler,
// Fehlerpfad (404), Bot-Gegenwehr (403 -> Cooldown + Stopp), manueller Retry.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll, mem } = require('./helper');

const PAGES = {
    '3532008625': { status: 200, html: () => fixture('detail-full.html') },
    '3566219879': { status: 200, html: () => fixture('detail-ok.html') },
    '9876543': { status: 404, html: () => '' }
};

function responder(statusOverride) {
    return (url) => {
        const id = (url.match(/\/(\d{6,})-\d+/) || [])[1];
        const page = PAGES[id];
        if (!page) return { status: 500, html: '' };
        const status = statusOverride || page.status;
        return { status, html: status === 200 ? page.html() : '' };
    };
}

const todayKey = () => {
    const d = new Date();
    return 'kbs_v4_count_' + d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// Mehr Karten, als das Fixture hat - fuer Limit-Tests. Jede Kopie bekommt eine
// eigene Anzeigen-ID, damit der Cache nicht als Doppelbehandlung eingreift.
function kartenKlon(win, anzahl) {
    const tabelle = win.document.getElementById('srchrslt-adtable');
    const vorlage = tabelle.querySelector('li[data-clickable="card"]');
    for (let i = 0; i < anzahl; i++) {
        const karte = vorlage.cloneNode(true);
        karte.querySelectorAll('article').forEach(a => {
            a.dataset.adid = 'klon-' + i;
            a.dataset.href = '/s-anzeige/klon/' + (1000000 + i) + '-217-7939';
        });
        tabelle.appendChild(karte);
    }
}

test('Abarbeitung: 1 Request pro Karte, Ergebnis als Farbstufe sichtbar', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);

    assert.equal(win.requests.length, 3, 'genau eine Anfrage pro Anzeigenkarte');
    const infos = [...win.document.querySelectorAll('.kbs-info')];
    assert.equal(infos.length, 3);
    assert.equal(infos[0].className, 'kbs-info kbs-gut');
    assert.equal(infos[1].className, 'kbs-info kbs-mittel');
    assert.equal(infos[2].className, 'kbs-info kbs-unbekannt kbs-failed', '404-Karte ist als Fehler markiert');

    const cache = mem(win)['kbs_v4_cache'];
    assert.deepEqual(Object.keys(cache).sort(), ['3532008625', '3566219879']);
    assert.equal(mem(win)[todayKey()], 3, 'Zähler zählt jeden Versuch, auch die fehlgeschlagene 404-Karte');
});

test('Zweiter Durchlauf: nichts zu tun, keine weiteren Requests', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);
    const first = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, first, 'keine Doppelanfragen');
    assert.equal(win.kbsDebug.collectCards(false).length, 0);
});

test('Cache trifft: bereits gelernte Karte wird ohne Request bewertet', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);
    // Ergebnis-Cache behalten, Markierungen im DOM entfernen -> nur Karte 1 offen
    for (const el of win.document.querySelectorAll('.kbs-info')) el.remove();
    for (const el of win.document.querySelectorAll('li')) el.classList.remove('kbs-card', 'kbs-gut', 'kbs-mittel', 'kbs-unbekannt');
    const before = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, before + 1, 'nur die fehlerhafte Karte wird erneut geladen');
    assert.equal(mem(win)[todayKey()], 4, 'Cache-Treffer zählen nicht gegen das Tageslimit');
});

test('HTTP 403: Cooldown gesetzt und Abarbeitung gestoppt', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder(403) });
    await runProcessAll(win, false);
    assert.ok(win.requests.length <= 2, 'Pool bricht ab, statt alle Karten abzurufen');
    assert.ok(mem(win)['kbs_v4_cooldown'] > Date.now(), 'Cooldown gespeichert');
    assert.equal(win.document.querySelectorAll('.kbs-info').length, 0, 'keine Bewertungen erraten');

    // Folgender automatischer Lauf respektiert den Cooldown
    const vorCooldown = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, vorCooldown, 'Cooldown blockiert automatische Läufe');
    // Strg+F8 (force) umgeht ihn
    await runProcessAll(win, true);
    assert.ok(win.requests.length > vorCooldown, 'manueller Start arbeitet weiter');
});

test('Fehlerhafte Karte wird nur bei manuellem Start (force) erneut versucht', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);
    const total = win.requests.length;

    await runProcessAll(win, false);
    assert.equal(win.requests.length, total, 'automatisch kein Retry');

    const offeneFehler = win.kbsDebug.collectCards(true).map(c => win.kbsDebug.getAdId(c));
    assert.deepEqual(Array.from(offeneFehler), ['9876543']);
});

test('Detailseite ohne Anzeigenbezug: Skript greift nicht auf der Anzeigenseite', () => {
    const win = loadWindow(fixture('listing.html'), {
        url: 'https://www.kleinanzeigen.de/s-anzeige/test/3532008625-217-7939'
    });
    assert.equal(win.kbsDebug.looksLikeListing(false), false);
});

test('Ausnahme in einer Karte (beschädigter Cache-Eintrag) blockiert nicht den ganzen Lauf', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    // Ein Eintrag in alter/beschädigter Form: Daten ohne badges-Feld -> renderBadge wirft
    win.kbsMem['kbs_v4_cache'] = {
        '3532008625': { ts: Date.now(), data: { rating: 'gut', satisfaction: 'fehlt', activeDays: null } }
    };
    await runProcessAll(win, false);

    assert.equal(win.kbsDebug.stats.error, 1, 'Ausnahme als Fehler gezählt');
    const infos = [...win.document.querySelectorAll('.kbs-info')];
    assert.equal(infos.length, 2, 'nur die kaputte Karte blieb ohne Bewertung');
    // Array.from: collectCards läuft im jsdom-Realm, dessen Array-Prototyp bei
    // deepStrictEqual sonst als unterschiedlich gilt.
    assert.deepEqual(Array.from(win.kbsDebug.collectCards(true).map(c => win.kbsDebug.getAdId(c))),
        ['3532008625', '9876543'], 'kaputte Cache-Karte und 404-Karte bleiben offen');

    // Der running-Schalter muss frei sein: ein erzwungener Folgedurchlauf arbeitet wieder.
    const requests1 = win.requests.length;
    win.kbsMem['kbs_v4_cache'] = {};        // Beschädigung entfernt
    await runProcessAll(win, true);
    assert.ok(win.requests.length > requests1, 'Folgedurchlauf nach Ausnahmefehler läuft wieder');
    assert.equal(win.document.querySelectorAll('.kbs-info').length, 3, 'alle Karten bewertet');
});

const BLOCKSEITE = '<html><head><title>Sicherheitsprüfung · kleinanzeigen.de</title></head><body>' +
    '<h1>Bitte bestätige, dass du kein Roboter bist</h1></body></html>';
const BLOCKTITEL_MIT_PROFIL = '<html><head><title>Roboter Staubsauger – kleinanzeigen.de</title></head><body>' +
    '<div id="viewad-profile-box"><div class="userprofile-vip-details-text">Aktiv seit 04.06.2020</div>' +
    '<span class="userbadge userbadges-profile-rating">TOP Zufriedenheit</span></div></body></html>';

test('Testhelfer: Kartenklon mit eigener Anzeigen-ID', () => {
    const win = loadWindow(fixture('listing.html'));
    kartenKlon(win, 3);
    assert.equal(win.kbsDebug.collectCards(false).length, 6, 'Grundkarte plus drei Klone');
});

test('Tageslimit: keine Prellung auch bei zwei Workern, und Versuche zählen', async () => {
    const win = loadWindow(fixture('listing.html'), {
        config: { MAX_PER_DAY: 10 },
        respond: () => ({ status: 200, html: fixture('detail-full.html') })
    });
    kartenKlon(win, 9);                 // 3 Grundkarten + 9 Klone = 12 Karten
    win.kbsMem[todayKey()] = 9;         // es darf genau eine weitere Anfrage geben
    await runProcessAll(win, false);

    assert.equal(win.requests.length, 1, 'genau eine Anfrage, obwohl zwei Worker laufen');
    assert.equal(mem(win)[todayKey()], 10, 'Zähler endet exakt am Limit, nicht darüber');
    assert.equal(win.kbsDebug.stats.quotaSkip, 11, 'der Rest bleibt ohne Anfrage zurück');
});

test('Voller Tageslimit: Cachedaten bleiben sichtbar, neue Anfragen bleiben aus', async () => {
    const win = loadWindow(fixture('listing.html'), { config: { MAX_PER_DAY: 10 }, respond: responder() });
    await runProcessAll(win, false);            // Cache mit zwei Treffern fuellen
    const requestsVorher = win.requests.length;
    assert.equal(requestsVorher, 3, 'im ersten Lauf drei Versuche');

    win.document.querySelectorAll('.kbs-info').forEach(el => el.remove());
    win.kbsMem[todayKey()] = 10;                // Limit ausgeschöpft
    await runProcessAll(win, false);

    assert.equal(win.requests.length, requestsVorher, 'keine einzige neue Anfrage');
    const infos = [...win.document.querySelectorAll('.kbs-info')];
    assert.equal(infos.length, 2, 'beide gecachten Karten sind wieder bewertet');
    assert.deepEqual(Array.from(infos.map(i => i.className)), ['kbs-info kbs-gut', 'kbs-info kbs-mittel']);
    assert.match(win.document.getElementById('kbs-status').textContent, /Tageslimit/,
        'der Hinweis auf das Limit ist sichtbar');
});

test('Bot-Gegenwehr mit Status 200: Cooldown statt Cache, automatischer Retry erst nach der Pause', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: () => ({ status: 200, html: BLOCKSEITE }) });
    await runProcessAll(win, false);

    assert.ok(win.requests.length <= 2, 'Pool bricht ab, statt alle Karten abzurufen');
    assert.ok(mem(win)['kbs_v4_cooldown'] > Date.now(), 'Cooldown gespeichert');
    assert.equal(Object.keys(mem(win)['kbs_v4_cache'] || {}).length, 0, 'nichts Unbrauchbares gecacht');
    assert.equal(win.kbsDebug.stats.blocked, win.requests.length, 'als Blockierung gezählt');
    assert.equal(win.document.querySelectorAll('.kbs-info').length, 0, 'es wird nichts erfunden');

    const vorDerPause = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, vorDerPause, 'Cooldown blockiert automatische Läufe');
    await runProcessAll(win, true);
    assert.ok(win.requests.length > vorDerPause, 'manueller Start arbeitet weiter');

    // Kein False-Positive: Block-Wort im Anzeigentitel, aber echtes Profil vorhanden
    const win2 = loadWindow(fixture('listing.html'), { respond: () => ({ status: 200, html: BLOCKTITEL_MIT_PROFIL }) });
    await runProcessAll(win2, false);
    assert.equal(win2.requests.length, 3, 'alle Karten werden regulär abgerufen');
    assert.ok(!mem(win2)['kbs_v4_cooldown'], 'ein Anzeigentitel löst keinen Cooldown aus');
    assert.equal(win2.document.querySelectorAll('.kbs-info').length, 3, 'Bewertungen erscheinen');
});

test('Leeres Ergebnis ohne Blockseite: weicher Fehler, kein Cache, Retry nur bei force', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: () => ({ status: 200, html: '<html><body><p>Wholesaler</p></body></html>' }) });
    await runProcessAll(win, false);

    assert.equal(Object.keys(mem(win)['kbs_v4_cache'] || {}).length, 0, 'leerer Befund wird nicht gecacht');
    assert.ok(!mem(win)['kbs_v4_cooldown'], 'ohne Blockseite kein Cooldown');
    assert.equal(win.kbsDebug.stats.failed, 3, 'alle drei als weichen Fehler gezählt');
    const chip = win.document.querySelector('.kbs-info .kbs-chip');
    assert.equal(chip.textContent, 'keine belastbaren Verkäuferdaten', 'Grund sichtbar');
    assert.match(chip.title, /Fehlergrund: keine Verkäuferdaten/, 'Grund im Tooltip');

    await runProcessAll(win, false);
    assert.ok(!mem(win)['kbs_v4_cooldown'], 'automatischer Lauf ohne Blockseite bleibt cooldown-frei');
    assert.equal(win.kbsDebug.collectCards(true).length, 3, ' Retry nur bei manuellem Start');
});
