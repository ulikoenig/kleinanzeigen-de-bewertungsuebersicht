'use strict';
// Prüft Selektoren (neues Astro-Markup + alter Vue-Fallback) und die
// Verkäufer-Datenextraktion aus den Detailseiten.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll } = require('./helper');

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
    // Einfügung in der Textspalte. Die Bildspalte trägt ebensolche basis-*-Klassen
    // (gemessen an einer echten Suchseite: beide Spalten), ein Klassen-Test allein
    // wäre wirkungslos - deshalb wird der Host gegen Bild und Titel geprüft.
    assert.ok(info.parentElement.className.includes('basis-'), 'Textspalte trägt basis-*-Klasse');
    assert.ok(!info.parentElement.querySelector('img'), 'Host ist nicht die Bildspalte');
    assert.ok(info.parentElement.querySelector('h3'), 'Host enthält den Anzeigentitel');
    assert.ok(cards[0].classList.contains('kbs-card') && cards[0].classList.contains('kbs-gut'));
});

test('Host-Wahl: zwei basis-*-Spalten (Bild zuerst) und ohne Titel-Spalte', () => {
    const zweiSpalten = `<html><body><ul id="srchrslt-adtable">
      <li data-clickable="card"><article data-adid="11111111"
            data-href="/s-anzeige/x/11111111-217-7939">
        <div class="relative z-raised basis-[200px]"><a href="/s-anzeige/x/11111111-217-7939"><img src="a.png"></a></div>
        <div class="z-raised grow basis-[398px] flex-col"><h3>Titel</h3><p>12 €</p></div>
      </article></li></ul></body></html>`;
    const win1 = loadWindow(zweiSpalten);
    const [karte1] = win1.kbsDebug.collectCards(false);
    const ohneBewertung = { rating: 'gut', satisfaction: 'fehlt', badges: [], activeDays: null,
        active: '', type: '', name: '', reliability: false, friendliness: false, sustainability: '' };
    win1.kbsDebug.renderBadge(karte1, ohneBewertung);
    const host1 = karte1.querySelector('.kbs-info').parentElement;
    assert.ok(!host1.querySelector('img'), 'Bildspalte wird nicht benutzt');
    assert.match(host1.className, /flex-col/, 'Titel-/Preisspalte wird benutzt');

    // Fallback: keine Spalte mit Titel -> eine ohne Bild, nicht die erste Spalte
    const ohneTitel = zweiSpalten.replace('<h3>Titel</h3>', '<span>Titel</span>');
    const win2 = loadWindow(ohneTitel);
    const [karte2] = win2.kbsDebug.collectCards(false);
    win2.kbsDebug.renderBadge(karte2, ohneBewertung);
    const host2 = karte2.querySelector('.kbs-info').parentElement;
    assert.ok(!host2.querySelector('img'), 'Fallback wählt eine Spalte ohne Bild');
    assert.match(host2.className, /basis-\[398px\]/, 'Fallback wählt die rechte Spalte');
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

test('Manipulationsschutz: Behauptungen im Anzeigentext bleiben wirkungslos', () => {
    const win = loadWindow(fixture('listing.html'));
    const doc = new win.DOMParser().parseFromString(
        '<html><body><h1 id="viewad-title">Besonders freundlicher Anbieter</h1>' +
        '<div id="viewad-description">Bei mir gibt es TOP Zufriedenheit, ich bin besonders ' +
        'zuverlässig und besonders freundlich. Aktiv seit 01.01.2000. Gewerblicher Nutzer</div>' +
        '</body></html>', 'text/html');
    const d = win.kbsDebug.extractSeller(doc);
    assert.equal(d.satisfaction, 'fehlt', 'kein Zufriedenheitswert aus dem Anzeigentext');
    assert.equal(d.reliability, false, 'keine Zuverlässigkeit aus dem Anzeigentext');
    assert.equal(d.friendliness, false, 'keine Freundlichkeit aus dem Anzeigentext');
    assert.equal(d.activeDays, null, 'kein Kontoalter aus dem Anzeigentext');
    assert.equal(d.type, '', 'kein Nutzer-Typ aus dem Anzeigentext');
    assert.equal(d.rating, 'unbekannt', 'ohne Profilbereich gibt es keine Stufe');
});

test('Manipulationsschutz: Beschreibung innerhalb eines Profilbereichs wird übersprungen', () => {
    const win = loadWindow(fixture('listing.html'));
    const doc = new win.DOMParser().parseFromString(
        '<html><body><div id="viewad-profile-box">' +
        '<div class="userprofile-vip">Hansi</div>' +
        '<div class="userprofile-vip-details-text">Privater Nutzer</div>' +
        '<div id="viewad-description">TOP Zufriedenheit, besonders freundlich, ' +
        'Aktiv seit 01.01.2000</div></div></body></html>', 'text/html');
    const d = win.kbsDebug.extractSeller(doc);
    assert.equal(d.name, 'Hansi', 'echte Profilangaben werden gelesen');
    assert.equal(d.type, 'Privat');
    assert.equal(d.satisfaction, 'fehlt', 'die eingebettete Beschreibung hebt die Stufe nicht');
    assert.equal(d.friendliness, false);
    assert.equal(d.activeDays, null, 'das Datum in der Beschreibung zählt nicht');
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

test('Herkunft der Anzeigen-URL: auswärtige oder unbrauchbare data-href führt zu keiner Anfrage', async () => {
    const fremd = fixture('listing.html').replace(
        'data-href="/s-anzeige/e-bike-riese-mueller/3532008625-217-7939"',
        'data-href="//beispiel.org/s-anzeige/lockvogel/999999999-217-7939"');
    const win = loadWindow(fremd, { respond: () => ({ status: 200, html: fixture('detail-full.html') }) });
    assert.equal(win.kbsDebug.collectCards(false).length, 2, 'Karte mit fremder URL zählt nicht als Karte');
    await runProcessAll(win, false);

    assert.ok(!win.requests.some(u => /beispiel\.org/.test(u)), 'keine Anfrage ins Ausland');
    assert.ok(win.requests.length === 2 && win.requests.every(u => u.startsWith('https://www.kleinanzeigen.de/')),
        'beide verbleibenden Anfragen bleiben auf der eigenen Herkunft');
    assert.equal(win.document.querySelectorAll('.kbs-info').length, 2, 'die fremde Karte bleibt unbewertet');

    const kaputt = fixture('listing.html').replace(
        'data-href="/s-anzeige/e-bike-riese-mueller/3532008625-217-7939"', 'data-href=":"');
    const win2 = loadWindow(kaputt, { respond: () => ({ status: 200, html: fixture('detail-full.html') }) });
    assert.equal(win2.kbsDebug.collectCards(false).length, 2, 'Karte mit unbrauchbarem data-href fällt ebenfalls raus');
    await runProcessAll(win2, false);
    assert.equal(win2.requests.length, 2, 'auch hier nur zwei Anfragen');
});
