'use strict';
// Prüft die Dateiausprägungen: eine Qülle, eine abgeleitete Datei, und beide
// werden von derselben Suite getestet (siehe npm run test:ableitung / test:qülle).
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const { SCRIPT_ABLEITUNG, SCRIPT_QUELLE, schliessen } = require('./helper');
const { vergleiche } = require('../build.js');
const os = require('node:os');
const path = require('node:path');
const MARKE = path.join(os.tmpdir(), 'kbs-fehlende-quelle.js');

// Dieselbe Prüfung wie in build.js, nur gegen eine absichtlich fehlerhafte Qülle
function erzeugeAUS(pfad) {
    const zeilen = fs.readFileSync(pfad, 'utf8').split('\n');
    const idx = zeilen.findIndex(z => z.includes('@license'));
    if (zeilen.slice(idx + 1).some(z => /@downloadURL|@updateURL/.test(z))) {
        throw new Error('Update-Zeilen stehen bereits in der Quelle – die Quelle ist keine Quelle mehr.');
    }
    return zeilen.join('\n');
}

afterEach(schliessen);
after(schliessen);

test('Abgeleitete Datei stimmt mit der Quelle überein (nur die Update-Zeilen)', () => {
    const { gleich } = vergleiche();
    assert.ok(gleich, 'kleinanzeigen-de-bewertungsuebersicht.user.js weicht von der Quelle ab – ' +
        'bitte die .js pflegen und "npm run build" laufen lassen');
});

test('Update-Zeilen stehen nur in der installierbaren Ausprägung', () => {
    const quelle = fs.readFileSync(SCRIPT_QUELLE, 'utf8');
    const ableitung = fs.readFileSync(SCRIPT_ABLEITUNG, 'utf8');
    assert.equal((quelle.match(/@(downloadURL|updateURL)/g) || []).length, 0,
        'die Quelle darf keine Update-Zeilen enthalten');
    assert.equal((ableitung.match(/@(downloadURL|updateURL)/g) || []).length, 2,
        'die abgeleitete Datei enthält genau beide Zeilen');
});

test('Der Baustein verweigert die Arbeit, wenn die Quelle selbst Update-Zeilen enthält', () => {
    const quelle = fs.readFileSync(SCRIPT_QUELLE, 'utf8');
    const misstrauisch = quelle.replace(/(\/\/ @license[^\n]*\n)/, '$1// @downloadURL https://example.invalid/x.user.js\n');
    fs.writeFileSync(MARKE, misstrauisch);
    try {
        assert.throws(() => erzeugeAUS(MARKE), /keine Quelle mehr/);
    } finally {
        fs.unlinkSync(MARKE);
    }
});

test('Der UserScript-Kopf ist unverändert gültig (Grant-Namen, Version)', () => {
    const text = fs.readFileSync(SCRIPT_QUELLE, 'utf8');
    const kopf = (text.match(/^\/\/ ==UserScript==\n([\s\S]*?)^\/\/ ==\/UserScript==/m) || [])[1];
    assert.ok(kopf, 'der Metadaten-Block fehlt');

    const grants = (kopf.match(/^\/\/ @grant\s+(\S+)\s*$/gm) || [])
        .map(z => z.replace(/^\/\/ @grant\s+/, ''));
    assert.deepEqual(grants, ['GM_xmlhttpRequest', 'GM_setValue', 'GM_getValue', 'GM_registerMenuCommand'],
        'genau diese vier Manager-Funktionen werden gebraucht');
    // Kein Manager-Namen darf einen Umlaut enthalten (Schreibmaschinen-Umbau räumte schon einmal
    // @grant-Zeilen kaputt, ohne dass ein Test es merkte).
    grants.forEach(g => assert.match(g, /^[A-Za-z_]+$/, 'Grant-Name "' + g + '" ist verstümmelt'));

    // Jeder im Code benutzte GM_-Name muss eingetragen sein
    const benutzt = new Set((text.match(/GM_[A-Za-z]+/g) || [])
        .filter(n => !kopf.includes(n)));
    for (const name of benutzt) {
        assert.ok(grants.includes(name), name + ' wird benutzt, ist aber nicht @grant');
    }

    // Versionsangabe in Skript und Paketmustek stimmen überein
    const skriptVersion = (kopf.match(/^\/\/ @version\s+(\S+)\s*$/m) || [])[1];
    const paket = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(paket.version, skriptVersion + '.0', 'package.json und @version laufen auseinander');
});
