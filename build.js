#!/usr/bin/env node
'use strict';
// Erzeugt die installierbare Variante (.user.js) aus der gepflegten Quelle (.js).
//
// Beide Dateien enthielten denselben Code von Hand gepflegt - die Tests lasen nur
// .user.js, die .js konnte also unbemerkt abweichen. Jetzt ist .js die Quelle und
// .user.js wird erzeugt; `--check` prüft, ohne zu schreiben (bei Abweichung Exit 1).
//
//   node build.js          .user.js aus .js erzeugen
//   node build.js --check   Abweichung melden, nichts ändern

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const QUELLE = 'kleinanzeigen-de-bewertungsuebersicht.js';
const ZIEL = 'kleinanzeigen-de-bewertungsuebersicht.user.js';

// Greasyfork-Eintrag (Skript 557558); Reihenfolge im Header ist gleichgültig,
// die Zeilen gehören in die UserScript-Metadaten-Block.
const UPDATE_ZEILEN = [
    '// @downloadURL https://update.greasyfork.org/scripts/557558/' +
        'Kleinanzeigen%20Verk%C3%A4ufer-Bewertungen%20in%20Suchergebnissen%20anzeigen.user.js',
    '// @updateURL https://update.greasyfork.org/scripts/557558/' +
        'Kleinanzeigen%20Verk%C3%A4ufer-Bewertungen%20in%20Suchergebnissen%20anzeigen.meta.js'
];
const ANKER = '@license';

function erzeuge() {
    const zeilen = fs.readFileSync(path.join(ROOT, QUELLE), 'utf8').split('\n');
    const idx = zeilen.findIndex(z => z.includes(ANKER));
    if (idx < 0) throw new Error(`Header-Anker "${ANKER}" nicht gefunden – Metadaten-Block geändert?`);
    const ohne = zeilen.slice(idx + 1).some(z => /@downloadURL|@updateURL/.test(z));
    if (ohne) throw new Error(`Update-Zeilen stehen bereits in ${QUELLE} – die Quelle ist keine Quelle mehr.`);
    zeilen.splice(idx + 1, 0, ...UPDATE_ZEILEN);
    return zeilen.join('\n');
}

function vergleiche() {
    const erzeugt = erzeuge();
    const vorhanden = fs.readFileSync(path.join(ROOT, ZIEL), 'utf8');
    return { erzeugt, vorhanden, gleich: erzeugt === vorhanden };
}

if (require.main === module) {
    try {
        const pruefen = process.argv.includes('--check');
        const { erzeugt, gleich } = vergleiche();
        if (pruefen) {
            if (gleich) {
                console.log(`${ZIEL} stimmt mit ${QUELLE} überein.`);
            } else {
                console.error(`>> ${ZIEL} weicht von ${QUELLE} ab. Bitte "npm run build" laufen lassen ` +
                    'und die Quelle (.js) bearbeiten, nicht die abgeleitete Datei.');
                process.exit(1);
            }
        } else {
            fs.writeFileSync(path.join(ROOT, ZIEL), erzeugt);
            console.log(`${ZIEL} aus ${QUELLE} erzeugt (${erzeugt.split('\n').length} Zeilen)`);
        }
    } catch (e) {
        console.error('>> Build fehlgeschlagen:', e.message);
        process.exit(1);
    }
}

module.exports = { erzeuge, vergleiche, QUELLE, ZIEL, UPDATE_ZEILEN };
