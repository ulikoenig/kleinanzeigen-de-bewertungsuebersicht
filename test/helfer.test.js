'use strict';
// Prüft das Testfundament selbst: die Betriebswerte müssen wirklich übergabar
// sein, sonst laufen Tests still mit Produktionswerten (alte Regex-Variante).
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll, TEST_CONFIG, LISTING_URL } = require('./helper');

// Ausgefädelte jsdom-Fenster schließen, sonst hält ein offener Nachlauf-Timer
// den Testprozess fest (siehe test/helper.js).
afterEach(require('./helper').schliessen);
after(require('./helper').schliessen);

test('Testhelfer setzt die Betriebswerte wirklich', async () => {
    const win = loadWindow(fixture('listing.html'));
    assert.equal(win.kbsDebug.config.DELAY_MAX, TEST_CONFIG.DELAY_MAX, 'Testwert ist angekommen');
    assert.equal(win.kbsDebug.config.MAX_PER_DAY, 600, 'Produktionswert bleibt unangetastet');

    const win2 = loadWindow(fixture('listing.html'), {
        config: { MAX_PER_DAY: 1 },
        respond: () => ({ status: 200, html: fixture('detail-full.html') })
    });
    await runProcessAll(win2, false);
    assert.equal(win2.requests.length, 1, 'MAX_PER_DAY aus der Testkonfiguration wirkt');
});

test('Debug-Zugang kommt nur nach bewusster Freigabe', () => {
    const { JSDOM } = require('jsdom');
    const fs = require('node:fs');
    const html = fixture('listing.html');
    const quelle = fs.readFileSync(require('./helper').SCRIPT_QUELLE, 'utf8');

    const normal = new JSDOM(html, { url: LISTING_URL, runScripts: 'outside-only' }).window;
    normal.eval(quelle);
    assert.equal(normal.kbsDebug, undefined, 'im Normalbetrieb liegt nichts am Fenster');

    const perUrl = new JSDOM(html, { url: LISTING_URL + '#kbs-debug', runScripts: 'outside-only' }).window;
    perUrl.eval(quelle);
    assert.ok(perUrl.kbsDebug, 'mit #kbs-debug am Ende der Adresse ist der Zugang da');
    assert.equal(typeof perUrl.kbsDebug.collectCards, 'function');
});
