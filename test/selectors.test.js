'use strict';
// Prüft Selektoren (neues Astro-Markup + alter Vue-Fallback) und die
// Verkäufer-Datenextraktion aus den Detailseiten.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, fixture } = require('./helper');

test('Suchkarten: 3 Anzeigen, Werbekarte ohne Anzeige wird ignoriert', () => {
    const win = loadWindow(fixture('listing.html'));
    const cards = win.kbsDebug.collectCards(false);
    assert.equal(cards.length, 3, 'Anzahl Anzeigenkarten');

    assert.equal(win.kbsDebug.getAdId(cards[0]), '3532008625');
    assert.equal(
        win.kbsDebug.getDetailUrl(cards[0]),
        'https://www.kleinanzeigen.de/s-anzeige/e-bike-riese-mueller/3532008625-217-7939'
    );
    // Fallback ohne data-href/data-adid (altes Markup)
    assert.equal(win.kbsDebug.getAdId(cards[2]), '9876543');
    assert.match(win.kbsDebug.getDetailUrl(cards[2]), /\/s-anzeige\/altes-fahrrad\/9876543/);
});

test('Badge-Einfügung in rechter Spalte bzw. altem Fußbereich', () => {
    const win = loadWindow(fixture('listing.html'));
    const cards = win.kbsDebug.collectCards(false);
    const data = win.kbsDebug.extractSeller(
        new win.DOMParser().parseFromString(fixture('detail-full.html'), 'text/html')
    );
    win.kbsDebug.renderBadge(cards[0], data);

    const info = cards[0].querySelector('.kbs-info');
    assert.ok(info, 'Info-Zeile vorhanden');
    assert.equal(info.className, 'kbs-info kbs-gut');
    assert.match(info.querySelector('.kbs-chip').textContent, /TOP \| besonders zuverlässig \| besonders freundlich \| Gewerblich/);
    // Einfügung in der Textspalte (div mit basis-...), nicht im Bilderbereich
    assert.ok(info.parentElement.className.includes('basis-'));
    assert.ok(cards[0].classList.contains('kbs-card') && cards[0].classList.contains('kbs-gut'));
});

test('Detailseite: voller Badge-Satz (Gewerblich)', () => {
    const win = loadWindow(fixture('listing.html'));
    const d = win.kbsDebug.extractSeller(
        new win.DOMParser().parseFromString(fixture('detail-full.html'), 'text/html')
    );
    assert.equal(d.satisfaction, 'TOP');
    assert.equal(d.reliability, true);
    assert.equal(d.friendliness, true);
    assert.equal(d.type, 'Gewerblich');
    assert.ok(d.activeDays > 1500, 'Kontoalter in Tagen: ' + d.activeDays);
    assert.deepEqual(Array.from(d.badges), ['TOP Zufriedenheit', 'Besonders freundlich', 'Besonders zuverlässig']);
    assert.equal(d.rating, 'gut');
});

test('Detailseite: nur OK-Badge -> mittel', () => {
    const win = loadWindow(fixture('listing.html'));
    const d = win.kbsDebug.extractSeller(
        new win.DOMParser().parseFromString(fixture('detail-ok.html'), 'text/html')
    );
    assert.equal(d.userId, '87836675');
    assert.equal(d.satisfaction, 'OK');
    assert.equal(d.type, 'Privat');
    assert.equal(d.rating, 'mittel');
});

test('Detailseite ohne Abzeichen -> Bewertung nur aus Kontoalter', () => {
    const win = loadWindow(fixture('listing.html'));
    const d = win.kbsDebug.extractSeller(
        new win.DOMParser().parseFromString(fixture('detail-no-badge.html'), 'text/html')
    );
    assert.equal(d.satisfaction, 'fehlt');
    assert.equal(d.badges.length, 0);
    assert.equal(d.activeDays > 3000, true);
    assert.equal(d.rating, 'gut');
});

test('Fehlende Verkäuferdaten -> unbekannt statt schlecht', () => {
    const win = loadWindow(fixture('listing.html'));
    const d = win.kbsDebug.extractSeller(
        new win.DOMParser().parseFromString('<html><body><p>Captcha</p></body></html>', 'text/html')
    );
    assert.equal(d.activeDays, null);
    assert.equal(d.rating, 'unbekannt');
});

test('Bewertungslogik an den Kontogrenzen', () => {
    const win = loadWindow(fixture('listing.html'));
    const base = { satisfaction: 'fehlt', reliability: false, friendliness: false };
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: 89 }), 'schlecht');
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: 90 }), 'mittel');
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: 364 }), 'mittel');
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: 365 }), 'gut');
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: 400, satisfaction: 'NAJA' }), 'schlecht');
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: 10, satisfaction: 'TOP', reliability: true }), 'schlecht');
    assert.equal(win.kbsDebug.computeRating({ ...base, activeDays: null }), 'unbekannt');
});
