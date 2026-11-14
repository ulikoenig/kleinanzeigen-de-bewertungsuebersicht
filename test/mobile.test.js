'use strict';
// Prüft den Mobilbetrieb. Die mobile Auslieferung nutzt ein anderes Markup als die
// Desktop-Auslieferung (gemessen 2026-02): ul#srp-results > li.j-adlistitem ohne
// article[data-adid], und auf der Detailseite ein userprofile-teaser ohne Kontoalter.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll } = require('./helper');

// Ausgefädelte jsdom-Fenster schließen, sonst hält ein offener Nachlauf-Timer
// den Testprozess fest (siehe test/helper.js).
afterEach(require('./helper').schliessen);
after(require('./helper').schliessen);

const OHNE_STUFE = {
    rating: 'unbekannt', satisfaction: 'fehlt', badges: [], activeDays: null,
    active: '', type: '', name: '', reliability: false, friendliness: false, sustainability: ''
};

test('Mobile Suchseite: als Suchseite erkannt, Karten plus Anzeigen-ID und Detail-URL', () => {
    const win = loadWindow(fixture('mobile-listing.html'));
    assert.equal(win.kbsDebug.looksLikeListing(false), true, 'gilt als Suchseite');

    const karten = win.kbsDebug.collectCards(false);
    assert.equal(karten.length, 3, 'drei Anzeigenkarten, Werbeeinblendung ohne Anzeige ignoriert');
    assert.equal(win.kbsDebug.getAdId(karten[0]), '3568052645', 'AdId aus der Link-Endung');
    assert.match(win.kbsDebug.getDetailUrl(karten[0]), /\/s-anzeige\/.+\/\d{6,}-\d+-\d+$/);

    win.kbsDebug.renderBadge(karten[0], OHNE_STUFE);
    const host = karten[0].querySelector('.kbs-info').parentElement;
    assert.match(host.className, /adlist--item--descarea/, 'Einfügeort ist der Textbereich der Karte');
    assert.ok(!host.querySelector('img'), 'Bildseite wird nicht benutzt');
});

test('Mobile Detailseite: Teaser liefert Zufriedenheit und Typ, Kontoalter bleibt unbekannt', () => {
    const win = loadWindow(fixture('listing.html'));
    const doc = new win.DOMParser().parseFromString(fixture('mobile-anzeige.html'), 'text/html');
    const d = win.kbsDebug.extractSeller(doc);

    assert.equal(d.name, 'Kyrylo');
    assert.equal(d.type, 'Privat');
    assert.equal(d.satisfaction, 'TOP', 'Zufriedenheit aus dem userprofile-teaser');
    assert.deepEqual(Array.from(d.badges), ['Zufriedenheit: TOP']);
    assert.equal(d.activeDays, null, 'die mobile Auslieferung liefert kein Kontoalter');
    assert.equal(d.active, '');
    assert.equal(d.rating, 'gut', 'Stufe aus den vorhandenen Signalen, nie „schlecht“ wegen fehlender Daten');

    // Dieselbe Seite behauptet im Anzeigentext Freundlichkeit, Zuverlässigkeit und ein
    // Konto seit 2000 - nichts davon darf ankommen.
    assert.equal(d.friendliness, false, 'Anzeigentext erfindet keine Freundlichkeit');
    assert.equal(d.reliability, false, 'Anzeigentext erfindet keine Zuverlaessigkeit');
});

test('Bedienung ohne Tastatur: Bedienfeld in der Statusleiste, Menübefehle wenn vorhanden', async () => {
    const menue = [];
    const win = loadWindow(fixture('mobile-listing.html'), {
        respond: () => ({ status: 404, html: '' })       // alle Karten schlagen fehl
    });
    win.GM_registerMenuCommand = (text) => { menue.push(text); return 1; };

    await runProcessAll(win, false);
    assert.ok(win.kbsDebug.menueBefehle(), 'Menübefehle werden eingetragen, wenn der Manager sie hat');
    assert.deepEqual(menue, ['Jetzt prüfen', 'Abarbeitung stoppen', 'Cache und Tageszähler löschen',
        'Fehlersuche einschalten']);

    const feld = win.document.querySelector('#kbs-status .kbs-aktionen');
    assert.ok(feld, 'die Statusleiste trägt ein Bedienfeld');
    const knoepfe = [...feld.querySelectorAll('button.kbs-knopf')];
    assert.deepEqual(knoepfe.map(b => b.textContent), ['Prüfen', 'Stopp', 'Zurücksetzen']);
    assert.ok(knoepfe.every(b => b.getAttribute('aria-label')), 'jeder Knopf ist benannt');

    // „Prüfen“ ersetzt Strg+F8: fehlgeschlagene Karten werden erneut abgearbeitet
    const vorher = win.requests.length;
    knoepfe[0].click();
    await new Promise(r => setTimeout(r, 500));
    assert.ok(win.requests.length > vorher, 'Knopf „Prüfen“ holt die fehlgeschlagenen Karten erneut');

    // „Zurücksetzen“ ersetzt Strg+Shift+F8
    assert.ok(Object.keys(win.kbsMem).some(k => k.startsWith('kbs_v4_count_')), 'der Zähler ist gelaufen');
    feld.querySelectorAll('button.kbs-knopf')[2].click();
    // Die Schlüssel bleiben bestehen, aber ihr Inhalt ist entleert (0 bzw. {}).
    const gefuellt = Object.entries(win.kbsMem).filter(([k, v]) =>
        k.startsWith('kbs_v4_') && (k === 'kbs_v4_cache' ? Object.keys(v || {}).length > 0 : Number(v) > 0));
    assert.equal(gefuellt.length, 0, 'Cache, Tageszähler und Cooldown sind entleert');
});

test('Ohne Menüunterstützung bleibt das Bedienfeld der einzige Zugang (kein Absturz)', async () => {
    const win = loadWindow(fixture('mobile-listing.html'), { respond: () => ({ status: 404, html: '' }) });
    assert.equal(win.kbsDebug.menueBefehle(), false, 'ohne GM_registerMenuCommand keine Menübefehle');
    await runProcessAll(win, false);
    assert.equal(win.document.querySelectorAll('#kbs-status .kbs-knopf').length, 3,
        'das Bedienfeld ist trotzdem da');
});

test('Schmales Format: Chip bleibt in der Textspalte und bricht dort um', async () => {
    const win = loadWindow(fixture('mobile-listing.html'), {
        respond: () => ({ status: 200, html: fixture('mobile-anzeige.html') })
    });
    await runProcessAll(win, false);
    const info = win.document.querySelector('.kbs-info');
    assert.ok(info, 'Bewertungszeile vorhanden');
    const spalte = info.parentElement;
    assert.match(spalte.className, /adlist--item--descarea/, 'in der Textspalte der Karte');
    assert.ok(!spalte.querySelector('img'), 'die Bildseite bleibt frei');
    assert.equal(spalte.lastElementChild, info,
        'die Zeile steht am Ende der Textspalte, unter Titel und Preis');

    const css = win.document.getElementById('kbs-style').textContent;
    assert.match(css, /@media \(max-width: 720px\)/, 'es gibt Regeln für schmale Formate');
    assert.match(css, /\.kbs-chip \{ max-width: 100%/, 'der Chip bleibt innerhab der Spalte');
});

test('Mobilgerät: ein Request gleichzeitig, kleineres Kontingent, längere Pausen', () => {
    const win = loadWindow(fixture('mobile-listing.html'));
    const enger = 390;
    Object.defineProperty(win, 'innerWidth', { value: enger, configurable: true });
    win.kbsDebug.config.CONCURRENCY = 2;
    win.kbsDebug.config.MAX_PER_DAY = 600;
    win.kbsDebug.config.DELAY_MIN = 600;
    win.kbsDebug.config.DELAY_MAX = 1800;

    assert.equal(win.kbsDebug.mobilerBetrieb(), true, '390 px Breite gilt als Mobilbetrieb');
    assert.equal(win.kbsDebug.gerateEinstellungen(), true, 'die Einstellungen werden angepasst');
    assert.equal(win.kbsDebug.config.CONCURRENCY, 1, 'kein Parallelbetrieb auf dem Handy');
    assert.ok(win.kbsDebug.config.MAX_PER_DAY <= 150, 'kleineres Tageskontingent');
    assert.ok(win.kbsDebug.config.DELAY_MIN >= 900 && win.kbsDebug.config.DELAY_MAX >= 2400,
        'deutlich längere Pausen zwischen den Abrufen');

    Object.defineProperty(win, 'innerWidth', { value: 1280, configurable: true });
    assert.equal(win.kbsDebug.mobilerBetrieb(), false, 'Desktopbreite bleibt beim Produktionswert');
});

test('Mobil: Detailseiten werden mit Desktop-Kopf angefragt, damit das Kontoalter nicht fehlt', async () => {
    // Mobile Karten, desktop-ausgelieferte Detailseite (so misst es das Gerät)
    const win = loadWindow(fixture('mobile-listing.html'), {
        respond: () => ({ status: 200, html: fixture('detail-full.html') })
    });
    Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
    await runProcessAll(win, false);

    const option = win.requestOptionen[0];
    assert.ok(option, 'die Anfrage wurde inklusive Köpfe aufgezeichnet');
    assert.equal(option.headers['user-agent'], win.kbsDebug.config.DESKTOP_UA,
        'der Desktop-Kopf steht in der Anfrage');
    const info = win.document.querySelector('.kbs-info');
    assert.match(info.querySelector('.kbs-chip').textContent, /Jahre? aktiv/,
        'Kontoalter ist da, obwohl die Suchseite mobil ausgeliefert wurde');

    // Abschaltbar: ohne Schalter kein eigener Kopf
    const aus = loadWindow(fixture('mobile-listing.html'), {
        config: { UA_DESKTOP_FUER_DETAILSEITEN: false },
        respond: () => ({ status: 200, html: fixture('detail-full.html') })
    });
    Object.defineProperty(aus, 'innerWidth', { value: 390, configurable: true });
    await runProcessAll(aus, false);
    assert.equal(aus.requestOptionen[0].headers['user-agent'], undefined,
        'ohne Schalter bleibt der eigene Kopf weg');

    // Am Desktop braucht es den Trick nicht
    const desktop = loadWindow(fixture('listing.html'), {
        respond: () => ({ status: 200, html: fixture('detail-full.html') })
    });
    await runProcessAll(desktop, false);
    assert.equal(desktop.requestOptionen[0].headers['user-agent'], undefined,
        'desktop-ausgelieferte Seiten behalten ihren Kopf');
});

test('Bedienfeld bleibt erhalten, wenn die Statusmeldung verblasst', async () => {
    const win = loadWindow(fixture('mobile-listing.html'), {
        respond: () => ({ status: 200, html: fixture('mobile-anzeige.html') })
    });
    await runProcessAll(win, false);
    assert.equal(win.document.querySelectorAll('#kbs-status .kbs-knopf').length, 3,
        'während und nach der Abarbeitung drei Knöpfe da sind');

    // Die automatische Klarmeldung nach der Statistik darf das Bedienfeld nicht entfernen
    win.kbsDebug.setStatus('');
    const feld = win.document.querySelector('#kbs-status .kbs-aktionen');
    assert.ok(feld, 'Bedienfeld ist noch im Dokument');
    assert.equal(feld.querySelectorAll('button.kbs-knopf').length, 3, 'alle drei Knöpfe anklickbar');
    assert.equal(win.document.querySelector('#kbs-status .kbs-text').textContent, '',
        'nur der Text ist weg');
});

test('Statusleiste liegt nicht in der Navigationskante des Geräts', async () => {
    const win = loadWindow(fixture('mobile-listing.html'), {
        respond: () => ({ status: 200, html: fixture('mobile-anzeige.html') })
    });
    await runProcessAll(win, false);
    const css = win.document.getElementById('kbs-style').textContent;
    assert.match(css, /bottom: calc\(20px \+ env\(safe-area-inset-bottom/,
        'Grundabstand inklusive Sicherheitsbereich');
    assert.match(css, /@media \(max-width: 720px\)[\s\S]{0,80}#kbs-status \{ bottom: calc\(28px/,
        'auf schmalen Geräten zusätzlicher Abstand');
});
