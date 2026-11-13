'use strict';
// Prüft das Testfundament selbst: die Betriebswerte müssen wirklich übergabar
// sein, sonst laufen Tests still mit Produktionswerten (alte Regex-Variante).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll, TEST_CONFIG } = require('./helper');

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
