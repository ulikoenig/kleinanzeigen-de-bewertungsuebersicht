'use strict';
// Prüft den Mobilbetrieb. Die mobile Auslieferung nutzt ein anderes Markup als die
// Desktop-Auslieferung (gemessen 2026-02): ul#srp-results > li.j-adlistitem ohne
// article[data-adid], und auf der Detailseite ein userprofile-teaser ohne Kontoalter.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { loadWindow, fixture } = require('./helper');

// Ausgefädelte jsdom-Fenster schließen, sonst hält ein offener Nachlauf-Timer
// den Testprozess fest (siehe test/helper.js).
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

    // Dieselbe Seite behauptet im Anzeigentext Freundlichkeit, Zuverlaessigkeit und ein
    // Konto seit 2000 - nichts davon darf ankommen.
    assert.equal(d.friendliness, false, 'Anzeigentext erfindet keine Freundlichkeit');
    assert.equal(d.reliability, false, 'Anzeigentext erfindet keine Zuverlaessigkeit');
});
