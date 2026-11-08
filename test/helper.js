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

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Schnelle, deterministische Variante des Skripts (keine Wartezeiten).
function fastScript(code) {
    return code.replace(
        /const DELAY_MIN[\s\S]*?const COOLDOWN_MINUTES = \d+;/,
        'const DELAY_MIN = 1, DELAY_MAX = 2, FETCH_TIMEOUT = 900, CACHE_TTL_DAYS = 7, COOLDOWN_MINUTES = 30;'
    );
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

    win.eval(fastScript(fs.readFileSync(SCRIPT, 'utf8')));
    if (!win.kbsDebug) throw new Error('window.kbsDebug fehlt – Skript bricht ab');
    return win;
}

// Der Auto-Start ist über kbsDebugOnly abgeschaltet; Tests starten selbst.
async function runProcessAll(win, force) {
    await win.kbsDebug.processAll(force);
}

module.exports = { loadWindow, fixture, LISTING_URL, runProcessAll, SCRIPT, mem: w => w.kbsMem };
