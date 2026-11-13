'use strict';
// Manueller Check gegen echte Seitenkopien (nicht Teil von npm test).
//   mkdir -p test/fixtures/live
//   curl -A "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0" \
//     https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217 \
//     -o test/fixtures/live/listing.html
//   curl -A "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0" \
//     https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217 \
//     -o test/fixtures/live/mobile-listing.html
//   curl -A "Mozilla/5.0 …" "https://www.kleinanzeigen.de<s-anzeige-link>" \
//     -o test/fixtures/live/anzeige.html
//   node test/live-check.js
const fs = require('fs');
const path = require('path');
const { loadWindow, LISTING_URL } = require('./helper');

const dir = path.join(__dirname, 'fixtures', 'live');
if (!fs.existsSync(dir)) {
    console.log('Kein Ordner test/fixtures/live – nichts zu prüfen.');
    process.exit(0);
}
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
const listings = files.filter(f => /list|such|listing|srp|result|k0c|s-/i.test(f));
const details = files.filter(f => !listings.includes(f));

let fehlgeschlagen = false;
for (const listing of listings) {
    const win = loadWindow(fs.readFileSync(path.join(dir, listing), 'utf8'), { url: LISTING_URL });
    const cards = win.kbsDebug.collectCards(false);
    // Vergleichsgröße ist die Zahl unterschiedlicher Anzeigen, nicht die Zahl der
    // Links: eine Desktop-Karte verlinkt zweimal auf dieselbe Anzeige.
    const ids = new Set(Array.from(win.document.querySelectorAll('a[href*="/s-anzeige/"]'))
        .map(a => (a.getAttribute('href').match(/\/(\d{6,})-\d+/) || [])[1]).filter(Boolean));
    console.log('Listing-Kopie:', listing.padEnd(24), '→ Karten:', String(cards.length).padStart(3),
        '| verschiedene Anzeigen auf der Seite:', ids.size);
    if (cards[0]) console.log('   Beispiel:', win.kbsDebug.getDetailUrl(cards[0]));
    if (!cards.length) {
        console.error('   >> 0 Karten: Selektoren im Skript anpassen (CARD_SELECTOR).');
        fehlgeschlagen = true;
    } else if (cards.length !== ids.size) {
        console.warn('   >> Achtung: Kartenanzahl weicht von der Zahl der Anzeigen auf der Seite ab.');
    }
}

for (const f of details) {
    const win = loadWindow(fs.readFileSync(listings.length ? path.join(dir, listings[0]) : '<html></html>', 'utf8'), { url: LISTING_URL });
    const doc = new win.DOMParser().parseFromString(fs.readFileSync(path.join(dir, f), 'utf8'), 'text/html');
    const d = win.kbsDebug.extractSeller(doc);
    console.log('Detail-Kopie:', f.padEnd(24), '→', JSON.stringify({
        typ: d.type, aktiv: d.active, zufrieden: d.satisfaction,
        zuverlaessig: d.reliability, freundlich: d.friendliness, stufe: d.rating
    }));
}

if (fehlgeschlagen) process.exit(1);
