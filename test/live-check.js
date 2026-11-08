'use strict';
// Manueller Check gegen echte Seitenkopien (nicht Teil von npm test).
//   mkdir -p test/fixtures/live
//   curl -A "Mozilla/5.0 Firefox/132.0" https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217 \
//     -o test/fixtures/live/listing.html
//   curl -A "Mozilla/5.0 Firefox/132.0" "https://www.kleinanzeigen.de<s-anzeige-link>" \
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
const files = fs.readdirSync(dir);
const listing = files.find(f => /list|such|k0c|s-/i.test(f) && f.endsWith('.html'));
const win = loadWindow(fs.readFileSync(path.join(dir, listing), 'utf8'), { url: LISTING_URL });

const cards = win.kbsDebug.collectCards(false);
console.log('Listing-Kopie:', listing, '→ Karten:', cards.length);
console.log('Beispiel:', cards[0] && win.kbsDebug.getDetailUrl(cards[0]));

for (const f of files.filter(f => f !== listing && f.endsWith('.html'))) {
    const doc = new win.DOMParser().parseFromString(fs.readFileSync(path.join(dir, f), 'utf8'), 'text/html');
    const d = win.kbsDebug.extractSeller(doc);
    console.log(f, '→', JSON.stringify({
        typ: d.type, aktiv: d.active, zufrieden: d.satisfaction,
        zuverlaessig: d.reliability, freundlich: d.friendliness, stufe: d.rating
    }));
}
if (!cards.length) {
    console.error('\n>> 0 Karten: Selektoren im Skript anpassen (CARD_SELECTOR).');
    process.exit(1);
}
