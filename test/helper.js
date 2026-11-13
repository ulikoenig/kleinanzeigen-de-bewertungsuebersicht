// Hilfsmittel: Skript in einer jsdom-Umgebung ausführen und die internen
// Funktionen über window.kbsDebug zugänglich machen.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'kleinanzeigen-de-bewertungsuebersicht.user.js');
const FIXTURES = path.join(__dirname, 'fixtures');

const LISTING_URL = 'https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217';

// Betriebswerte für den Testlauf: kurz, aber unterscheidbar von den
// Produktionswerten. Früher wurde dafür der Konfigurationsblock des Skripts per
// Regex wegpatcht - wer die Zeilen umformulierte, bekam einen stillen No-op und
// damit langsame, flatternde Tests. Heute wird über window.kbsDebug.config
// gesetzt, und der Helfer bricht ab, wenn diese Übergabe nicht existiert.
const TEST_CONFIG = { DELAY_MIN: 1, DELAY_MAX: 2, FETCH_TIMEOUT: 900 };

// Jede geoeffnete jsdom-Inferenz wird vorgemerkt, damit Tests sie am Ende
// schliessen koennen - ein offener Nachlauf- oder Cooldown-Timer haelt sonst
// den Testprozess am Ende fest (sichtbar als haengender npm test).
const geoeffnete = [];

function schliessen() {
    while (geoeffnete.length) {
        const dom = geoeffnete.pop();
        try { dom.window.close(); } catch (e) { /* egal */ }
    }
}

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function loadWindow(html, opts = {}) {
    const dom = new JSDOM(html, {
        url: opts.url || LISTING_URL,
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const win = dom.window;
    win.kbsDebugOnly = true;

    const mem = {};
    win.GM_getValue = (k, def) => (k in mem ? mem[k] : def);
    win.GM_setValue = (k, v) => { mem[k] = v; };
    win.kbsMem = mem;

    win.requests = [];
    if (opts.respond) {
        win.GM_xmlhttpRequest = (o) => {
            win.requests.push(o.url);
            const res = opts.respond(o.url);
            setTimeout(() => {
                if (res === null) { o.onerror && o.onerror({ status: 0 }); return; }
                o.onload({ status: res.status, responseText: res.html || '' });
            }, 1);
        };
    }

    geoeffnete.push(dom);
    win.eval(fs.readFileSync(SCRIPT, 'utf8'));
    if (!win.kbsDebug) throw new Error('window.kbsDebug fehlt – Skript bricht ab');
    if (!win.kbsDebug.config) {
        throw new Error('window.kbsDebug.config fehlt – Testbetrieb kann die ' +
            'Betriebswerte nicht setzen (Konfiguration im Skript als Objekt führen)');
    }
    Object.assign(win.kbsDebug.config, TEST_CONFIG, opts.config || {});
    return win;
}

// Der Auto-Start ist über kbsDebugOnly abgeschaltet; Tests starten selbst.
async function runProcessAll(win, force) {
    await win.kbsDebug.processAll(force);
}

module.exports = { loadWindow, fixture, LISTING_URL, runProcessAll, SCRIPT, TEST_CONFIG, schliessen, mem: w => w.kbsMem };
