'use strict';
// Prüft Abarbeitung: ein Request pro Karte, Cache, Tageszähler,
// Fehlerpfad (404), Bot-Gegenwehr (403 -> Cooldown + Stopp), manueller Retry.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWindow, fixture, runProcessAll, mem } = require('./helper');

const PAGES = {
    '3532008625': { status: 200, html: () => fixture('detail-full.html') },
    '3566219879': { status: 200, html: () => fixture('detail-ok.html') },
    '9876543': { status: 404, html: () => '' }
};

function responder(statusOverride) {
    return (url) => {
        const id = (url.match(/\/(\d{6,})-\d+/) || [])[1];
        const page = PAGES[id];
        if (!page) return { status: 500, html: '' };
        const status = statusOverride || page.status;
        return { status, html: status === 200 ? page.html() : '' };
    };
}

const todayKey = () => {
    const d = new Date();
    return 'kbs_v4_count_' + d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
};

test('Abarbeitung: 1 Request pro Karte, Ergebnis als Farbstufe sichtbar', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);

    assert.equal(win.requests.length, 3, 'genau eine Anfrage pro Anzeigenkarte');
    const infos = [...win.document.querySelectorAll('.kbs-info')];
    assert.equal(infos.length, 3);
    assert.equal(infos[0].className, 'kbs-info kbs-gut');
    assert.equal(infos[1].className, 'kbs-info kbs-mittel');
    assert.equal(infos[2].className, 'kbs-info kbs-unbekannt kbs-failed', '404-Karte ist als Fehler markiert');

    const cache = mem(win)['kbs_v4_cache'];
    assert.deepEqual(Object.keys(cache).sort(), ['3532008625', '3566219879']);
    assert.equal(mem(win)[todayKey()], 2, 'Zähler zählt nur echte Abrufe');
});

test('Zweiter Durchlauf: nichts zu tun, keine weiteren Requests', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);
    const first = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, first, 'keine Doppelanfragen');
    assert.equal(win.kbsDebug.collectCards(false).length, 0);
});

test('Cache trifft: bereits gelernte Karte wird ohne Request bewertet', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);
    // Ergebnis-Cache behalten, Markierungen im DOM entfernen -> nur Karte 1 offen
    for (const el of win.document.querySelectorAll('.kbs-info')) el.remove();
    for (const el of win.document.querySelectorAll('li')) el.classList.remove('kbs-card', 'kbs-gut', 'kbs-mittel', 'kbs-unbekannt');
    const before = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, before + 1, 'nur die fehlerhafte Karte wird erneut geladen');
    assert.equal(mem(win)[todayKey()], 2, 'Cache-Treffer zählt nicht gegen das Tageslimit');
});

test('HTTP 403: Cooldown gesetzt und Abarbeitung gestoppt', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder(403) });
    await runProcessAll(win, false);
    assert.ok(win.requests.length <= 2, 'Pool bricht ab, statt alle Karten abzurufen');
    assert.ok(mem(win)['kbs_v4_cooldown'] > Date.now(), 'Cooldown gespeichert');
    assert.equal(win.document.querySelectorAll('.kbs-info').length, 0, 'keine Bewertungen erraten');

    // Folgender automatischer Lauf respektiert den Cooldown
    const vorCooldown = win.requests.length;
    await runProcessAll(win, false);
    assert.equal(win.requests.length, vorCooldown, 'Cooldown blockiert automatische Läufe');
    // Strg+F8 (force) umgeht ihn
    await runProcessAll(win, true);
    assert.ok(win.requests.length > vorCooldown, 'manueller Start arbeitet weiter');
});

test('Fehlerhafte Karte wird nur bei manuellem Start (force) erneut versucht', async () => {
    const win = loadWindow(fixture('listing.html'), { respond: responder() });
    await runProcessAll(win, false);
    const total = win.requests.length;

    await runProcessAll(win, false);
    assert.equal(win.requests.length, total, 'automatisch kein Retry');

    const offeneFehler = win.kbsDebug.collectCards(true).map(c => win.kbsDebug.getAdId(c));
    assert.deepEqual(Array.from(offeneFehler), ['9876543']);
});

test('Detailseite ohne Anzeigenbezug: Skript greift nicht auf der Anzeigenseite', () => {
    const win = loadWindow(fixture('listing.html'), {
        url: 'https://www.kleinanzeigen.de/s-anzeige/test/3532008625-217-7939'
    });
    assert.equal(win.kbsDebug.looksLikeListing(false), false);
});
