'use strict';
// Prüft Abarbeitung: ein Request pro Karte, Cache, Tageszähler,
// Fehlerpfad (404), Bot-Gegenwehr (403 -> Cooldown + Stopp), manueller Retry.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll, mem } = require('./helper');

// Ausgefädelte jsdom-Fenster schließen, sonst hält ein offener Nachlauf-Timer
// den Testprozess fest (siehe test/helper.js).
after(require('./helper').schliessen);

test('Nach Cooldown-Ablauf arbeitet das Skript selbst weiter, ein ausdrücklicher Stopp nicht', async () => {
    const win = loadWindow(fixture('listing.html'), {
        config: { COOLDOWN_MINUTES: 0.05 },          // 3 Sekunden Sperpause
        respond: responder(403)
    });
    await runProcessAll(win, false);
    const nachDerSperre = win.requests.length;
    assert.ok(nachDerSperre >= 1 && nachDerSperre <= 2, 'Sperre nach einer Anfrage pro Worker');

    await new Promise(r => setTimeout(r, 4200));      // Ablauf abwarten, kein Neuladen
    assert.ok(win.requests.length > nachDerSperre, 'automatischer Lauf nach Cooldown-Ende');

    const win2 = loadWindow(fixture('listing.html'), {
        config: { COOLDOWN_MINUTES: 0.02 }, respond: responder(403)
    });
    await runProcessAll(win2, false);
    win2.kbsDebug.stop();                             // ausdrücklicher Stopp
    const gestoppt = win2.requests.length;
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(win2.requests.length, gestoppt, 'der vorgemerkte Nachlauf ist nach dem Stopp weg');
});

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

test('Wiederholte Netzfehler: gestaffelte Pause und Abbruch nach der Schwelle', async () => {
    const win = loadWindow(fixture('mobile-listing.html'), {
        config: { MAX_FAILED_SERIES: 3, BACKOFF_BASE: 1, BACKOFF_MAX: 2 },
        respond: () => null                      // Verbindungsabbruch ohne Antwort
    });
    await runProcessAll(win, false);

    assert.ok(win.requests.length <= 4,
        'der Lauf bricht ab, statt alle 32 Karten abzurufen (zwei Worker, eine Zählerreihe)');
    assert.ok(win.requests.length >= 3, 'die Schwelle selbst erreicht er aber');
    assert.ok(win.kbsDebug.stats.backoff >= 2, 'vor jedem neuen Versuch liegt eine Pause');
    const status = win.document.getElementById('kbs-status').textContent;
    assert.match(status, /keine Detailseite geladen/, 'der Abbruch ist als solcher gemeldet');
    assert.match(status, /Fertig:/, 'die Statistik bleibt trotzdem lesbar');
});

test('Netzfehler erholen sich: ein Erfolg beendet die Fehlerreihe', async () => {
    let versuch = 0;
    const win = loadWindow(fixture('listing.html'), {
        config: { MAX_FAILED_SERIES: 2, BACKOFF_BASE: 1, BACKOFF_MAX: 2 },
        respond: (url) => {
            versuch++;
            if (versuch === 1) return null;      // erste Karte: Verbindungsabbruch
            const id = (url.match(/\/(\d{6,})-\d+/) || [])[1];
            return { status: 200, html: fixture(id === '3566219879' ? 'detail-ok.html' : 'detail-full.html') };
        }
    });
    await runProcessAll(win, false);

    assert.equal(versuch, 3, 'trotz eines Fehlers werden alle drei Karten versucht');
    assert.equal(win.kbsDebug.stats.backoff, 1, 'genau eine Pause, danach normale Reihenfolge');
    assert.equal(win.document.querySelectorAll('.kbs-info').length, 3, 'alle Karten bewertet');
    assert.match(win.document.getElementById('kbs-status').textContent, /Fertig: 3 Karten/,
        'kein Abbruch, weil die Fehlerreihe riss');
});

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
    const statusText = win.document.getElementById('kbs-status').textContent;
    assert.match(statusText, /Cooldown bis \d{2}:\d{2}/,
        'die Sperung bleibt stehen, statt von der Statistik verdrängt zu werden');
    assert.match(statusText, /Fertig:/, 'die Statistik ist angehängt, nicht verloren');
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
    // Ein Eintrag, der der Formpruefung (T46) genuegt, aber beim Rendern wirft:
    // ein getter, der kaputte Daten liefert. Damit bleibt der Fall erhalten, dass
    // eine einzelne Karte eine Ausnahme ausloest.
    const kaputt = { rating: 'gut', badges: [], activeDays: null };
    Object.defineProperty(kaputt, 'satisfaction', {
        get() { throw new Error('kaputter Cache-Inhalt'); }
    });
    win.kbsMem['kbs_v4_cache'] = {
        '3532008625': { ts: Date.now(), variant: 'profil', complete: true, data: kaputt }
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

test('Unbrauchbarer Cache-Eintrag wird verworfen und die Karte neu geladen', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    // Ein Eintrag von vor der Formpruefung: ohne badges-Feld, ohne rating
    win.kbsMem['kbs_v4_cache'] = {
        '3532008625': { ts: Date.now() - 3600e3, complete: true, variant: 'profil',
            data: { satisfaction: 'TOP', activeDays: 400 } }
    };
    await runProcessAll(win, false);

    assert.equal(win.kbsDebug.stats.error, 0, 'kein Ausnahmefehler mehr, der Eintrag wird aussortiert');
    assert.ok(win.requests.some(u => /3532008625/.test(u)), 'Karte wird regulär neu geladen');
    const infos = [...win.document.querySelectorAll('.kbs-info')];
    assert.equal(infos.length, 3, 'alle drei Karten sind bewertet');
    // Die dritte Karte ist die 404-Karte des Grund-Fixtures - sie darf weiterhin als
    // Fehler gelten, die ehemals kaputt gecachte Karte dagegen nicht.
    const karte = win.kbsDebug.collectCards(true).find(c => win.kbsDebug.getAdId(c) === '9876543');
    assert.ok(karte.querySelector('.kbs-info').classList.contains('kbs-failed'),
        'die reguläre 404-Karte bleibt als Fehler markiert');
    const gerettete = Array.from(win.document.querySelectorAll('.kbs-info'))
        .filter(i => i.classList.contains('kbs-failed'));
    assert.equal(gerettete.length, 1, 'nur die 404-Karte ist ein Fehler, die ausgebesserte nicht');
    const cache = win.kbsMem['kbs_v4_cache'];
    assert.ok(Array.isArray(cache['3532008625'].data.badges), 'der neue Eintrag ist vollständig');
});

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

test('Cache: mobiler Teilauszug wird auf dem Desktop neu geladen, voller Auszug wiederverwendet', async () => {
    const TEASER = { name: 'Kyrylo', userId: '', type: 'Privat', variant: 'teaser',
        activeDays: null, active: '', satisfaction: 'TOP', reliability: false,
        friendliness: false, sustainability: '', badges: ['Zufriedenheit: TOP'], rating: 'gut' };
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    // Ein erst am Tag zuvor mobil gelernten, unvollständiger Auszug:
    win.kbsMem['kbs_v4_cache'] = { '3532008625': { ts: Date.now() - 6 * 3600e3, variant: 'teaser',
        complete: false, data: TEASER } };
    await runProcessAll(win, false);

    assert.ok(win.requests.some(u => /3532008625/.test(u)),
        'unvollständiger Auszug reicht auf dem Desktop nicht, es wird neu geladen');
    const infos = [...win.document.querySelectorAll('.kbs-info')];
    const erste = infos.find(i => i.closest('li') && win.kbsDebug.getAdId(i.closest('li')) === '3532008625');
    assert.match(win.kbsDebug.getAdId(erste.closest('li')), /3532008625/);
    assert.match(erste.querySelector('.kbs-chip').textContent, /Jahre? aktiv/,
        'Kontoalter aus dem Desktop-Profil ersetzt den Teilauszug');
    assert.equal(erste.className, 'kbs-info kbs-gut');

    // Jetzt ist ein vollständiger Auszug gecacht: zweiter Lauf ohne Markierungen
    // braucht keine Anfrage mehr (die 404-Karte bleibt als Fehler markiert).
    win.document.querySelectorAll('.kbs-info:not(.kbs-failed)').forEach(el => el.remove());
    const vorher = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, vorher, 'vollständiger Auszug wird wiederverwendet');
    assert.equal(win.kbsDebug.stats.cached, 2, 'beide guten Karten kommen aus dem Cache');
});

test('Cache: derselbe Teilauszug darf auf einer mobilen Karte stehen bleiben', async () => {
    const win = loadWindow(fixture('mobile-listing.html'), { respond: () => ({ status: 200, html: fixture('mobile-anzeige.html') }) });
    const TEASER = { name: 'Kyrylo', userId: '', type: 'Privat', variant: 'teaser',
        activeDays: null, active: '', satisfaction: 'TOP', reliability: false,
        friendliness: false, sustainability: '', badges: ['Zufriedenheit: TOP'], rating: 'gut' };
    win.kbsMem['kbs_v4_cache'] = { '3568052645': { ts: Date.now() - 6 * 3600e3, variant: 'teaser',
        complete: false, data: TEASER } };
    await runProcessAll(win, false);
    assert.equal(win.requests.some(u => /3568052645/.test(u)), false,
        'auf der mobilen Seite wird der passende Teilauszug wiederverwendet');
    assert.equal(win.kbsDebug.stats.cached >= 1, true, 'mindestens eine Karte aus dem Cache');
});

test('Bot-Gegenwehr mit Status 200: Cooldown statt Cache, automatischer Retry erst nach der Pause', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: () => ({ status: 200, html: BLOCKSEITE }) });
    await runProcessAll(win, false);

    assert.ok(win.requests.length <= 2, 'Pool bricht ab, statt alle Karten abzurufen');
    assert.ok(mem(win)['kbs_v4_cooldown'] > Date.now(), 'Cooldown gespeichert');
    const statusText = win.document.getElementById('kbs-status').textContent;
    assert.match(statusText, /Cooldown bis \d{2}:\d{2}/,
        'die Sperung bleibt stehen, statt von der Statistik verdrängt zu werden');
    assert.match(statusText, /Fertig:/, 'die Statistik ist angehängt, nicht verloren');
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
