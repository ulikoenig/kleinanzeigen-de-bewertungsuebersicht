// ==UserScript==
// @name         Kleinanzeigen Verkäufer-Bewertungen in Suchergebnissen anzeigen
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Zeigt in der Suchübersicht Account-Alter und Bewertungen der Nutzer direkt unter den Suchergebnissen an.
// @author       Uli König
// @match        https://www.kleinanzeigen.de/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      www.kleinanzeigen.de
// @license      GPL-3.0-or-later
// ==/UserScript==

/*
 * Änderungsprotokoll
 * 4.0  Anpassung an das neue Astro-/Tailwind-Frontend der Suchseite (2026):
 *      - Karten sind nicht mehr ".aditem", sondern ul#srchrslt-adtable >
 *        li[data-clickable="card"] > article[data-adid][data-href].
 *      - Anzeigen-ID/Detail-URL wird über data-href gelesen (Fallback: Link).
 *      - Ergebnis-Cache (pro Anzeige, TTL konfigurierbar) statt Zähler-Chaos.
 *      - Request-Pool mit Jitter, Tageslimit pro Kalenderdatum, Cooldown bei
 *        403/429 (Bot-Gegenwehr) statt stummer Fehler.
 *      - Reine CSS-Bebilderung statt inline style + onmouseenter (überlebt
 *        Re-Renders und stört das Site-Hover nicht).
 *      - MutationObserver für nachträglich eingefügte Karten (Lazy/Pagination).
 *      - "unbekannt" als eigene Stufe, wenn keine Verkäuferdaten ermittelbar
 *        sind (vorher: fälschlich "schlecht" wegen activeDays = 0).
 */

(function () {
    'use strict';

    // ----------------------------- Konfiguration -----------------------------
    const MAX_PER_DAY   = 600;    // geprüfte Anzeigen pro Kalenderdatum (Cache zählt nicht)
    const CONCURRENCY   = 2;      // parallele Detail-Requests
    const DELAY_MIN     = 600;    // ms Pause pro Worker zwischen Requests
    const DELAY_MAX     = 1800;   // ms (zufällig, wirkt wie menschliches Tempo)
    const FETCH_TIMEOUT = 15000;  // ms
    const CACHE_TTL_DAYS = 7;     // Anzeige-Daten wiederverwenden
    const COOLDOWN_MINUTES = 30;  // nach 403/429/429-Panic: nichts mehr laden

    const NS = 'kbs_v4_';
    const PREFIX = '[Verkäufer-Checker]';

    // Karten: neue Astro-Oberfläche, danach alte (Vue-)Oberfläche
    const CARD_SELECTOR = [
        'li[data-clickable="card"]',
        '.aditem',
        '[data-testid="l-aditem"]',
        '[class*="ad-list-item"]'
    ].join(', ');

    const log  = (...a) => console.log(PREFIX, ...a);
    const warn = (...a) => console.warn(PREFIX, ...a);

    // ------------------------------- Speicher --------------------------------
    const dayKey = () => {
        const d = new Date();
        return NS + 'count_' + d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    };

    function store(name, value) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(name, value);
            else localStorage.setItem(name, JSON.stringify(value));
        } catch (e) { warn('Speichern fehlgeschlagen', e); }
    }

    function load(name, fallback) {
        try {
            if (typeof GM_getValue === 'function') {
                const v = GM_getValue(name, fallback);
                return typeof v === 'string' && typeof fallback === 'object' ? JSON.parse(v) : v;
            }
            const raw = localStorage.getItem(name);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function getCount(key, def) { return Number(load(key, def)) || 0; }

    function todayUsed()   { return getCount(dayKey(), 0); }
    function bumpToday()   { store(dayKey(), todayUsed() + 1); }

    function getCache()    { return load(NS + 'cache', {}); }
    function putCache(k, v) {
        const c = getCache();
        c[k] = v;
        // Cache nebenbei von altem Ballast befreien
        const cutoff = Date.now() - CACHE_TTL_DAYS * 864e5;
        for (const id of Object.keys(c)) {
            if (!c[id] || (c[id].ts || 0) < cutoff) delete c[id];
        }
        store(NS + 'cache', c);
    }
    function clearCache()  { store(NS + 'cache', {}); }

    function cooldownUntil() { return Number(load(NS + 'cooldown', 0)) || 0; }
    function setCooldown()   { store(NS + 'cooldown', Date.now() + COOLDOWN_MINUTES * 60000); }

    // ------------------------------ Hilfsfunktionen ---------------------------
    const clean = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    function parseGermanDate(text) {
        const m = clean(text).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (!m) return null;
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        return isNaN(d) ? null : d;
    }

    function daysSince(date) {
        if (!date) return null;
        const diff = Date.now() - date.getTime();
        return diff < 0 ? 0 : Math.floor(diff / 864e5);
    }

    function formatActive(days) {
        if (days === null || days === undefined) return '';
        if (days < 30) return days + ' Tag' + (days === 1 ? '' : 'e') + ' aktiv';
        const months = Math.floor(days / 30.44);
        if (months < 12) return months + ' Monat' + (months === 1 ? '' : 'e') + ' aktiv';
        const years = Math.floor(months / 12);
        return years + ' Jahr' + (years === 1 ? '' : 'e') + ' aktiv';
    }

    function computeRating(d) {
        const parts = [];

        if (d.activeDays !== null) {
            if (d.activeDays < 90) parts.push('schlecht');       // < 3 Monate
            else if (d.activeDays < 365) parts.push('mittel');   // < 1 Jahr
            else parts.push('gut');                              // >= 1 Jahr
        }

        if (d.satisfaction === 'TOP') parts.push('gut');
        else if (d.satisfaction === 'OK') parts.push('mittel');
        else if (d.satisfaction === 'NAJA') parts.push('schlecht');

        if (d.reliability) parts.push('gut');
        if (d.friendliness) parts.push('gut');

        if (!parts.length) return 'unbekannt';
        if (parts.includes('schlecht')) return 'schlecht';
        return parts.every(p => p === 'gut') ? 'gut' : 'mittel';
    }

    // ------------------------------- Extraktion -------------------------------
    // Detailseiten nutzen weiterhin das klassische Markup (#viewad-profile-box).
    // Zusätzlich gibt es Text-/Klassen-Fallbacks für eine mögliche neue Variante.
    function extractSeller(doc) {
        const box = doc.querySelector('#viewad-profile-box')
            || doc.querySelector('#viewad-contact')
            || doc.querySelector('[class*="userprofile"]')
            || doc.body
            || doc;

        const scope = box.closest('div, section') || box;
        const text = clean(scope.textContent || '');

        const d = {
            name: '',
            userId: '',
            type: '',
            activeDays: null,
            active: '',
            satisfaction: 'fehlt',
            reliability: false,
            friendliness: false,
            sustainability: '',
            badges: []
        };

        const nameEl = scope.querySelector('.userprofile-vip, [class*="userprofile--name"], [class*="userprofile-vip"]');
        if (nameEl) d.name = clean(nameEl.textContent);

        const userLink = scope.querySelector('a[href*="userId="]')
            || doc.querySelector('a[href*="s-bestandsliste.html?userId="]')
            || scope.querySelector('a[href^="/user/"], a[href^="/pro/"]');
        if (userLink) {
            const m = userLink.href.match(/userId=(\d+)/);
            if (m) d.userId = m[1];
        }

        // Abzeichen: Zufriedenheit / Freundlichkeit / Zuverlässigkeit / Nachhaltigkeit
        // (userbadge-Container, userbadge-Link und Icon-Klasse werden zusammengefasst)
        const seenBadges = new Set();
        const addBadge = (t, kind) => {
            if (!t || seenBadges.has(t)) return;
            seenBadges.add(t);
            d.badges.push(t);
            if (kind === 'rating') {
                const tl = t.toLowerCase();
                if (/\btop\b/.test(tl)) d.satisfaction = 'TOP';
                else if (/\bnaja\b/.test(tl)) d.satisfaction = 'NAJA';
                else if (/\bok\b/.test(tl)) d.satisfaction = 'OK';
            } else if (kind === 'reliability') d.reliability = true;
            else if (kind === 'friendliness') d.friendliness = true;
            else if (kind === 'sustainability') d.sustainability = t;
        };

        const byKind = [
            ['rating', '.userbadges-profile-rating, [class*="userbadges-profile-rating"]'],
            ['friendliness', '.userbadges-profile-friendliness, [class*="userbadges-profile-friendliness"]'],
            ['reliability', '.userbadges-profile-reliability, [class*="userbadges-profile-reliability"]'],
            ['sustainability', '.userbadges-profile-sustainability, [class*="userbadges-profile-sustainability"]']
        ];
        let found = false;
        byKind.forEach(([kind, sel]) => {
            scope.querySelectorAll(sel).forEach(el => {
                found = true;
                addBadge(clean(el.textContent), kind);
            });
        });

        if (!found) {
            scope.querySelectorAll('.userbadge, [data-testid*="rating"], [class*="rating-badge"]').forEach(el => {
                const t = clean(el.textContent);
                const icon = el.querySelector('[class*="icon-"]');
                const hay = (String(el.className) + ' ' +
                    (icon ? icon.className : '') + ' ' + t).toLowerCase();
                if (/rating|zufrieden/.test(hay)) addBadge(t, 'rating');
                else if (/reliab|zuverl/.test(hay)) addBadge(t, 'reliability');
                else if (/friendli|freundlich/.test(hay)) addBadge(t, 'friendliness');
                else if (/sustain|nachhalt/.test(hay)) addBadge(t, 'sustainability');
            });
        }

        // Zufriedenheit, falls kein Badge-Container gefunden wurde
        if (d.satisfaction === 'fehlt') {
            if (/top zufriedenheit/i.test(text)) d.satisfaction = 'TOP';
            else if (/naja zufriedenheit/i.test(text)) d.satisfaction = 'NAJA';
            else if (/\bok zufriedenheit/i.test(text)) d.satisfaction = 'OK';
        }
        if (!d.reliability && /besonders zuverlässig/i.test(text)) d.reliability = true;
        if (!d.friendliness && /besonders freundlich/i.test(text)) d.friendliness = true;

        // Nutzertyp
        const typeEl = scope.querySelectorAll(
            '.userprofile-vip-details-text, [class*="userprofile-details-text"]'
        );
        typeEl.forEach(el => {
            const t = clean(el.textContent);
            if (/gewerblich/i.test(t)) d.type = 'Gewerblich';
            else if (/privat/i.test(t)) d.type = 'Privat';
        });
        if (!d.type) {
            if (/gewerblicher nutzer/i.test(text)) d.type = 'Gewerblich';
            else if (/privater nutzer/i.test(text)) d.type = 'Privat';
        }

        // Aktiv seit
        const actEl = scope.querySelector(
            '.userprofile-vip-details-text[class*="ktiv"], [class*="userprofile-details-text"]'
        );
        let activeTxt = '';
        typeEl.forEach(el => {
            const t = clean(el.textContent);
            if (/aktiv seit/i.test(t)) activeTxt = t;
        });
        if (!activeTxt) {
            const m = text.match(/aktiv seit[:\s]*\d{1,2}\.\d{1,2}\.\d{4}/i);
            if (m) activeTxt = m[0];
        }
        if (!activeTxt && actEl) activeTxt = clean(actEl.textContent);

        if (activeTxt) {
            const date = parseGermanDate(activeTxt);
            d.activeDays = daysSince(date);
            d.active = formatActive(d.activeDays) || clean(activeTxt);
        }

        d.rating = computeRating(d);
        return d;
    }

    // ------------------------------ Netzwerkteil ------------------------------
    function httpGetDoc(url, referer) {
        return new Promise(resolve => {
            const finish = (doc, status) => resolve({ doc, status });

            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: FETCH_TIMEOUT,
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
                        'Referer': referer || location.href,
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'same-origin'
                    },
                    onload: r => {
                        if (r.status === 200) {
                            try {
                                finish(new DOMParser().parseFromString(r.responseText, 'text/html'), r.status);
                            } catch (e) {
                                finish(null, r.status);
                            }
                        } else {
                            finish(null, r.status);
                        }
                    },
                    onerror: r => finish(null, (r && r.status) || 0),
                    ontimeout: () => finish(null, 'timeout'),
                    onabort: () => finish(null, 'abort')
                });
                return;
            }

            // Fallback ohne GM-API: same-origin fetch genügt auf kleinanzeigen.de
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
            fetch(url, {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' },
                referrer: referer || location.href,
                signal: ctrl.signal
            }).then(res => {
                if (!res.ok) return finish(null, res.status);
                return res.text().then(html =>
                    finish(new DOMParser().parseFromString(html, 'text/html'), res.status));
            }).catch(() => finish(null, 0))
              .finally(() => clearTimeout(timer));
        });
    }

    // ------------------------------- Anzeige ---------------------------------
    function injectStyles() {
        if (document.getElementById('kbs-style')) return;
        const css = `
            .kbs-info { display: block; margin-top: 8px; }
            .kbs-chip {
                display: inline-block;
                font-size: 11px; font-weight: 600; line-height: 1.4;
                color: #000; padding: 3px 9px;
                border-radius: 12px; border: 2px solid #adb5bd;
                background: #e9ecef;
            }
            .kbs-meta { color: #555; font-size: 11px; margin-left: 6px; }
            .kbs-info.kbs-gut      .kbs-chip { background:#d4edda; border-color:#28a745; }
            .kbs-info.kbs-mittel   .kbs-chip { background:#fff3cd; border-color:#ffc107; }
            .kbs-info.kbs-schlecht .kbs-chip { background:#f8d7da; border-color:#dc3545; }
            .kbs-info.kbs-unbekannt .kbs-chip { background:#e9ecef; border-color:#adb5bd; color:#444; }
            .kbs-info.kbs-failed .kbs-chip { border-style: dashed; color:#a11; }
            li.kbs-card, .aditem.kbs-card {
                box-shadow: inset 6px 0 0 0 var(--kbs-c, #adb5bd);
                transition: box-shadow .25s ease, background-color .25s ease;
            }
            li.kbs-card.kbs-gut      { --kbs-c:#28a745; }
            li.kbs-card.kbs-mittel   { --kbs-c:#ffc107; }
            li.kbs-card.kbs-schlecht { --kbs-c:#dc3545; }
            li.kbs-card.kbs-unbekannt{ --kbs-c:#adb5bd; }
            li.kbs-card:hover, .aditem.kbs-card:hover { background-color: var(--kbs-bg, transparent); }
            li.kbs-card.kbs-gut:hover      { --kbs-bg:#d4edda33; }
            li.kbs-card.kbs-mittel:hover   { --kbs-bg:#fff3cd44; }
            li.kbs-card.kbs-schlecht:hover { --kbs-bg:#f8d7da44; }
            #kbs-status {
                position: fixed; left: 12px; bottom: 12px; z-index: 2147483647;
                background: #222; color: #fff; font: 12px/1.5 system-ui, sans-serif;
                padding: 6px 10px; border-radius: 6px; opacity: .9;
            }
        `;
        const style = document.createElement('style');
        style.id = 'kbs-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    let statusEl = null;
    function setStatus(msg) {
        if (!msg) {
            if (statusEl) { statusEl.remove(); statusEl = null; }
            return;
        }
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'kbs-status';
            document.body.appendChild(statusEl);
        }
        statusEl.textContent = msg;
    }

    function cardInfoHost(card) {
        // Neue Oberfläche: rechte Spalte des Artikel-Containers
        const article = card.matches('article') ? card : card.querySelector('article[data-adid]');
        if (article) {
            const cols = Array.from(article.children).filter(el => el.tagName === 'DIV');
            const col = cols.find(el => /basis-/.test(el.className)) || cols[cols.length - 1];
            if (col) return col;
            return article;
        }
        // Alte Oberfläche
        return card.querySelector('.aditem-main--bottom')
            || card.querySelector('.aditem-main')
            || card;
    }

    function renderBadge(card, d) {
        const host = cardInfoHost(card);
        if (!host) return;
        host.querySelector('.kbs-info')?.remove();

        const row = document.createElement('div');
        row.className = 'kbs-info kbs-' + d.rating + (d.failed ? ' kbs-failed' : '');

        const chip = document.createElement('span');
        chip.className = 'kbs-chip';
        const infos = [];
        if (d.satisfaction !== 'fehlt') infos.push(d.satisfaction);
        if (d.reliability) infos.push('besonders zuverlässig');
        if (d.friendliness) infos.push('besonders freundlich');
        if (d.sustainability) infos.push(d.sustainability);
        if (d.type) infos.push(d.type);
        if (d.active) infos.push(d.active);
        chip.textContent = infos.length ? infos.join(' | ')
            : (d.failed ? 'Detailseite nicht ladbar' : 'keine Bewertungen');

        const when = d.cached ? ' (aus Cache)' : '';
        chip.title = [
            'Stufe: ' + d.rating.toUpperCase(),
            d.name ? 'Verkäufer: ' + d.name : '',
            d.activeDays !== null ? 'Kontoalter: ' + d.activeDays + ' Tage' + when : 'Kontoalter unbekannt',
            d.badges.length ? 'Abzeichen: ' + d.badges.join(', ') : 'keine Abzeichen',
            d.failed ? 'Detailseite konnte nicht geladen werden (HTTP ' + (d.failStatus || '?') +
                ')\nErneut versuchen: Strg+F8' : ''
        ].filter(Boolean).join('\n');

        row.appendChild(chip);
        if (d.activeDays !== null) {
            const meta = document.createElement('span');
            meta.className = 'kbs-meta';
            meta.textContent = 'seit ' + new Date(Date.now() - d.activeDays * 864e5)
                .toLocaleDateString('de-DE');
            row.appendChild(meta);
        }
        host.appendChild(row);

        ['kbs-gut', 'kbs-mittel', 'kbs-schlecht', 'kbs-unbekannt'].forEach(c => card.classList.remove(c));
        card.classList.add('kbs-card', 'kbs-' + d.rating);
    }

    // -------------------------- Karten sammeln / abarbeiten -------------------
    function getAdId(card) {
        const article = card.matches('article[data-adid]') ? card : card.querySelector('article[data-adid]');
        if (article && article.dataset.adid) return article.dataset.adid;
        const a = card.querySelector('a[href*="/s-anzeige/"]');
        const m = a && a.href.match(/\/(\d{6,})-\d+/);
        return m ? m[1] : (a ? a.href : '');
    }

    function getDetailUrl(card) {
        const article = card.matches('article[data-href]') ? card : card.querySelector('article[data-href]');
        if (article && article.dataset.href) {
            return new URL(article.dataset.href, location.origin).href;
        }
        const a = card.querySelector('a[href*="/s-anzeige/"]');
        return a ? a.href : '';
    }

    function collectCards(force) {
        const seen = new Set();
        const out = [];
        document.querySelectorAll(CARD_SELECTOR).forEach(el => {
            // Nur Karten mit Anzeigenbezug
            const url = getDetailUrl(el);
            if (!url || !/\/s-anzeige\//.test(url)) return;
            const done = el.querySelector('.kbs-info:not(.kbs-failed)');
            if (done || (!force && el.querySelector('.kbs-info'))) return;
            if (seen.has(el)) return;
            seen.add(el);
            out.push(el);
        });
        return out;
    }

    let running = false;
    let stopRequested = false;
    const stats = { cached: 0, fetched: 0, failed: 0, blocked: 0 };

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

    async function handleCard(card, index, total) {
        const adId = getAdId(card) || ('url_' + getDetailUrl(card));
        const cache = getCache();
        const hit = cache[adId];
        if (hit && (Date.now() - (hit.ts || 0)) < CACHE_TTL_DAYS * 864e5) {
            hit.data.cached = true;
            renderBadge(card, hit.data);
            stats.cached++;
            return;
        }
        setStatus('Prüfe Verkäufer ' + (index + 1) + '/' + total + ' … (' + todayUsed() + '/' + MAX_PER_DAY + ')');
        const { doc, status } = await httpGetDoc(getDetailUrl(card), location.href);

        if (status === 403 || status === 429) {
            setCooldown();
            stats.blocked++;
            stopRequested = true;
            warn('HTTP', status, '- Bot-Gegenwehr getroffen. Cooldown bis',
                new Date(cooldownUntil()).toLocaleTimeString('de-DE'));
            setStatus('Blockiert (HTTP ' + status + ') – ' + COOLDOWN_MINUTES +
                ' Min Pause. Ctrl+F8 zum frühen Neustart.');
            return;
        }

        if (!doc) {
            warn('Detailseite nicht geladen:', getDetailUrl(card), 'Status', status);
            stats.failed++;
            renderBadge(card, {
                rating: 'unbekannt', satisfaction: 'fehlt', badges: [],
                activeDays: null, active: '', type: '', name: '', failed: true, failStatus: status,
                reliability: false, friendliness: false, sustainability: ''
            });
            return;
        }

        bumpToday();
        stats.fetched++;
        const data = extractSeller(doc);
        putCache(adId, { ts: Date.now(), data });
        renderBadge(card, data);
        log('✓', adId, data.rating, '|', data.type || '?', '|', data.satisfaction,
            '|', data.active || 'kein Datum', '|', todayUsed() + '/' + MAX_PER_DAY);
    }

    function looksLikeListing(force) {
        if (/\/s-anzeige\//.test(location.pathname)) return false;
        if (document.getElementById('srchrslt-adtable')) return true;
        return collectCards(force).length >= 2;
    }

    async function processAll(force) {
        if (running) return;
        if (!looksLikeListing(force)) return;
        injectStyles();

        const cd = cooldownUntil();
        if (cd > Date.now() && !force) {
            setStatus('Cooldown bis ' + new Date(cd).toLocaleTimeString('de-DE') +
                ' – Ctrl+F8 ignoriert das Limit.');
            warn('Cooldown aktiv bis', new Date(cd).toLocaleTimeString('de-DE'));
            return;
        }
        if (force) store(NS + 'cooldown', 0);

        let cards = collectCards(force);
        if (!cards.length) {
            if (document.querySelector('#srchrslt-adtable, .aditem, [data-testid="l-aditem"]')) {
                warn('Karten gefunden, aber ohne /s-anzeige/-Link – Markup geändert?');
            }
            return;
        }
        if (todayUsed() >= MAX_PER_DAY) {
            setStatus('Tageslimit (' + MAX_PER_DAY + ') erreicht. Ctrl+Shift+F8 löscht den Zähler.');
            return;
        }

        running = true;
        stopRequested = false;
        Object.keys(stats).forEach(k => stats[k] = 0);
        log('Verarbeite', cards.length, 'Anzeigen (Tageslimit', MAX_PER_DAY +
            ', bereits genutzt', todayUsed() + ')');

        let i = 0;
        const worker = async () => {
            while (!stopRequested) {
                if (i >= cards.length) return;
                if (todayUsed() >= MAX_PER_DAY) {
                    setStatus('Tageslimit (' + MAX_PER_DAY + ') erreicht. Ctrl+Shift+F8 = Reset.');
                    return;
                }
                const idx = i++;
                await handleCard(cards[idx], idx, cards.length);
                if (i < cards.length) await sleep(jitter());
            }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cards.length) }, worker));
        running = false;

        const hinweise = [];
        if (stats.cached) hinweise.push(stats.cached + ' aus Cache');
        if (stats.failed) hinweise.push(stats.failed + ' Fehler (Strg+F8 = erneut)');
        if (stats.blocked) hinweise.push(stats.blocked + ' blockiert');
        setStatus('Fertig: ' + cards.length + ' Karten · ' + stats.fetched + ' neue Anfragen · ' +
            todayUsed() + '/' + MAX_PER_DAY + ' heute' +
            (hinweise.length ? ' · ' + hinweise.join(' · ') : ''));
        setTimeout(() => setStatus(''), 10000);
    }

    function stop() {
        stopRequested = true;
        setStatus('Gestoppt.');
    }

    // Nachladen von Karten (Unendliche Liste, Filter-Rerender) beobachten
    function observeDom() {
        let timer = null;
        const obs = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (running || stopRequested) return;
                if (collectCards(false).length) processAll(false);
            }, 800);
        });
        const target = document.getElementById('srchrslt-adtable') || document.body;
        obs.observe(target, { childList: true, subtree: true });
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'F8' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) {
                clearCache();
                store(dayKey(), 0);
                store(NS + 'cooldown', 0);
                setStatus('Cache und Tageszähler geleert.');
                log('Cache + Zähler geleert.');
            } else if (running) {
                stop();
            } else {
                processAll(true);
            }
        }
    });

    // Debug-/Pflegemöglichkeit für Tests (kein Einfluss auf den Betrieb)
    try {
        window.kbsDebug = {
            extractSeller, computeRating, collectCards, renderBadge, looksLikeListing,
            getDetailUrl, getAdId, formatActive, parseGermanDate, daysSince,
            clearCache, processAll, stop, stats
        };
    } catch (e) { /* egal */ }

    if (!window.kbsDebugOnly) {
        setTimeout(() => {
            log('Bereit. Strg+F8 = starten/stoppen, Strg+Shift+F8 = Cache + Zähler löschen.');
            processAll();
            observeDom();
        }, 1500);
    }
})();
