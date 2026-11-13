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
// @grant        GM_registerMenuCommand
// @connect      www.kleinanzeigen.de
// @license      GPL-3.0-or-later
// @downloadURL https://update.greasyfork.org/scripts/557558/Kleinanzeigen%20Verk%C3%A4ufer-Bewertungen%20in%20Suchergebnissen%20anzeigen.user.js
// @updateURL https://update.greasyfork.org/scripts/557558/Kleinanzeigen%20Verk%C3%A4ufer-Bewertungen%20in%20Suchergebnissen%20anzeigen.meta.js
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
    // Alle Betriebswerte in einem veränderlichen Objekt: Tests (und später ein
    // Menüpunkt) können sie setzen, ohne den Wortlaut dieses Blocks zu kennen.
    const CONFIG = {
        MAX_PER_DAY: 600,        // geprüfte Anzeigen pro Kalenderdatum (Cache zählt nicht)
        CONCURRENCY: 2,          // parallele Detail-Requests
        DELAY_MIN: 600,          // ms Pause pro Worker zwischen Requests
        DELAY_MAX: 1800,         // ms (zufällig, wirkt wie menschliches Tempo)
        FETCH_TIMEOUT: 15000,    // ms
        CACHE_TTL_DAYS: 7,       // Anzeige-Daten wiederverwenden
        COOLDOWN_MINUTES: 30,    // nach 403/429/Blockseite: nichts mehr laden
        BACKOFF_BASE: 4000,      // ms: erste Pause nach einem Netzfehler
        BACKOFF_MAX: 300000,     // ms: oberste Grenze der gestaffelten Pause
        MAX_FAILED_SERIES: 5,    // so viele Fehlschläge hintereinander, dann Abbruch
        CACHE_TTL_INCOMPLETE_HOURS: 24 // unvollstaendiger Auszug (z. B. mobil ohne
                                       // Kontoalter) wird deutlich kuerzer gehalten
    };

    const NS = 'kbs_v4_';
    const PREFIX = '[Verkäufer-Checker]';

    // Karten: neue Astro-Oberfläche (Desktop), mobile Auslieferung, dann alte
    // (Vue-)Oberfläche. Die mobile Seite liefert anderes Markup: sie nutzt
    // ul#srp-results > li.j-adlistitem ohne article[data-adid] und ohne
    // #srchrslt-adtable (gemessen 2026-02 an einer Android-Auslieferung).
    const CARD_SELECTOR = [
        'li[data-clickable="card"]',
        'li.j-adlistitem',
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
        } catch {
            return fallback;
        }
    }

    function getCount(key, def) { return Number(load(key, def)) || 0; }

    function todayUsed()   { return getCount(dayKey(), 0); }
    function bumpToday()   { store(dayKey(), todayUsed() + 1); }

    // Der Ergebnis-Cache wird pro Lauf einmal gelesen und dann gebündelt
    // zurückgeschrieben. Vorher wurde bei jeder Karte der komplette Speicher
    // (bis zu mehreren tausend Einträgen) gelesen und neu serialisiert.
    let cachePuffer = null;
    let cacheSchmutzig = false;
    let cacheSeitSchreiben = 0;

    function getCache() {
        if (!cachePuffer) cachePuffer = load(NS + 'cache', {});
        return cachePuffer;
    }

    function cacheSaeubern(c) {
        const cutoff = Date.now() - CONFIG.CACHE_TTL_DAYS * 864e5;
        for (const id of Object.keys(c)) {
            if (!c[id] || (c[id].ts || 0) < cutoff) delete c[id];
        }
    }

    function putCache(k, v) {
        const c = getCache();
        c[k] = v;
        cacheSaeubern(c);
        cacheSchmutzig = true;
        cacheSeitSchreiben++;
        // Zwischendurch schreiben, damit ein abgebrochener Lauf nicht alles
        // Verarbeitete kostet.
        if (cacheSeitSchreiben >= 8) schreibeCache();
    }

    function schreibeCache() {
        if (!cacheSchmutzig) return;
        store(NS + 'cache', getCache());
        cacheSchmutzig = false;
        cacheSeitSchreiben = 0;
    }

    function clearCache() {
        cachePuffer = {};
        cacheSchmutzig = false;
        cacheSeitSchreiben = 0;
        store(NS + 'cache', {});
    }

    function cooldownUntil() { return Number(load(NS + 'cooldown', 0)) || 0; }
    function setCooldown()   { store(NS + 'cooldown', Date.now() + CONFIG.COOLDOWN_MINUTES * 60000); }

    // ------------------------------ Hilfsfunktionen ---------------------------
    const clean = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    function parseGermanDate(text) {
        const m = clean(text).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (!m) return null;
        const tag = Number(m[1]), monat = Number(m[2]), jahr = Number(m[3]);
        const d = new Date(jahr, monat - 1, tag);
        // Rückwärtskontrolle: `new Date(2024, 1, 31)` rollt lautlos auf den 2. März,
        // `isNaN` greift dabei nie. Ohne diese Prüfung entsteht aus Unsinn ein Datum.
        if (isNaN(d.getTime()) || d.getFullYear() !== jahr ||
            d.getMonth() !== monat - 1 || d.getDate() !== tag) return null;
        // Ein Konto, das erst in der Zukunft angelegt worden sein will, ist kein Beweis.
        if (d.getTime() > Date.now()) return null;
        return d;
    }

    function daysSince(date) {
        if (!date) return null;
        const diff = Date.now() - date.getTime();
        return diff < 0 ? 0 : Math.floor(diff / 864e5);
    }

    // Deutsches Datum ohne ICU-Glück: toLocaleDateString('de-DE') liefert je nach
    // Umgebung "4.6.2020" oder "04.06.2020".
    function datumDe(ms) {
        const d = new Date(ms);
        return String(d.getDate()).padStart(2, '0') + '.' +
            String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
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
    // Zonen mit frei schreibbarem Text des Verkäufers (Anzeigentitel, Beschreibung):
    // niemals Datenquelle. Gemessen an echten Detailseiten: 2.169 bis 3.546 Zeichen
    // frei erfindbarer Text, beim Gewerbetext beginnt er mit “✅LEASING ✅FINANZIERUNG
    // … ✅TOP BERATUNG“.
    const SELLER_TEXT_SELECTOR = [
        '#viewad-description', '#viewad-title', '#viewad-detailsection',
        '[id*="description"]', '[class*="detailsection"]', '[class*="adshowdescription"]'
    ].join(', ');

    function isSellerZone(el) {
        return !!(el && el.matches && el.matches(SELLER_TEXT_SELECTOR));
    }

    // Ein Element, das innerhalb einer Verkäufer-Textzone liegt, ist ebenso
    // unvertrauenswuerdig - auch wenn der Rahmen selbst in Ordnung ist.
    function insideSellerZone(scope, el) {
        if (!el) return false;
        for (const zone of scope.querySelectorAll(SELLER_TEXT_SELECTOR)) {
            if (zone.contains(el)) return true;
        }
        return false;
    }

    // Vertrauenswuerdiger Rahmen der Auswertung: ausschliesslich der
    // systemseitige Profil-/Kontaktbereich (gemessen an echten Detailseiten: Name,
    // Nutzer-Typ, “Aktiv seit”, Abzeichen und userId-Link liegen alle darin).
    // Kein Rueckfall auf document.body - damit lesen die Text-Fallbacks niemals
    // den Anzeigentext, in dem der Verkäufer behaupten kann, was er will.
    function profileScope(doc) {
        const candidates = [
            '#viewad-profile-box', '#viewad-contact',
            '[class*="userprofile-teaser"]', '[class*="userprofile"]'
        ];
        for (const sel of candidates) {
            const el = doc.querySelector(sel);
            if (el && !isSellerZone(el)) return el;
        }
        return null;
    }

    // Text des Rahmens ohne verkäuferkontrollierte Unterbereiche.
    function trustedText(scope) {
        const parts = [];
        (function walk(node) {
            for (const child of node.childNodes) {
                if (child.nodeType === 3) { parts.push(child.nodeValue); continue; }
                if (child.nodeType !== 1 || isSellerZone(child)) continue;
                walk(child);
            }
        })(scope);
        return clean(parts.join(' '));
    }

    function extractSeller(doc) {
        const d = {
            name: '',
            userId: '',
            type: '',
            variant: '',
            activeDays: null,
            activeSince: null,
            active: '',
            satisfaction: 'fehlt',
            reliability: false,
            friendliness: false,
            sustainability: '',
            badges: []
        };

        const scope = profileScope(doc);
        if (!scope) {
            // Nichts Vertrauenswuerdiges auf der Seite: lieber “unbekannt” als
            // irgendetwas aus dem Anzeigentext zu uebernehmen.
            d.rating = computeRating(d);
            return d;
        }
        const text = trustedText(scope);
        d.variant = scope.matches('[class*="userprofile-teaser"]') ? 'teaser' : 'profil';

        const nameEl = scope.querySelector('.userprofile-vip, [class*="userprofile--name"], ' +
            '[class*="userprofile-vip"], [class*="userprofile-teaser--title"]');
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
                if (insideSellerZone(scope, el)) return;
                found = true;
                addBadge(clean(el.textContent), kind);
            });
        });

        if (!found) {
            scope.querySelectorAll('.userbadge, [data-testid*="rating"], [class*="rating-badge"]').forEach(el => {
                if (insideSellerZone(scope, el)) return;
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

        // Zufriedenheit, falls kein Badge-Container gefunden wurde. Zuerst das Muster
        // der mobilen Auslieferung (“Zufriedenheit: TOP” im userprofile-teaser), dann
        // die Badge-Formulierungen der Desktop-Seite.
        if (d.satisfaction === 'fehlt') {
            const mob = text.match(/zufriedenheit:\s*(top|ok|naja)/i);
            if (mob) {
                d.satisfaction = mob[1].toUpperCase();
                d.badges.push('Zufriedenheit: ' + d.satisfaction);
            }
        }
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
            d.activeSince = date ? date.getTime() : null;
            d.active = formatActive(d.activeDays) || clean(activeTxt);
        }

        d.rating = computeRating(d);
        return d;
    }

    // Auslieferungsart einer Karte: Desktop-Markup (Profilbereich mit Kontoalter) oder
    // mobile Auslieferung (Teaser ohne Kontoalter). Bestimmt, welcher Cache-Auszug
    // dafuer ueberhaupt in Frage kommt.
    function deliveryVariant(card) {
        return (card.matches && card.matches('li.j-adlistitem')) ? 'teaser' : 'profil';
    }

    // Formpruefung eines Cache-Eintrags: ein Eintrag, den wir nicht darstellen
    // koennen, wuerde bei jedem Treffer erneut werfen und die Karte dauerhaft offen
    // lassen. Alte/beschädigte Einträge werden deshalb verworfen - die Karte wird
    // dann ganz normal neu geladen.
    function isUsableEntry(entry) {
        const d = entry && entry.data;
        return !!(d && typeof d === 'object' && Array.isArray(d.badges) &&
            typeof d.rating === 'string');
    }

    // Verwertbarer Cache-Treffer fuer diese Karte, oder null.
    function cacheHit(adId, card) {
        const cache = getCache();
        const hit = cache[adId];
        if (!hit || !hit.data) return null;
        if (!isUsableEntry(hit)) {
            delete cache[adId];
            store(NS + 'cache', cache);
            warn('Unbrauchbaren Cache-Eintrag verworfen:', adId);
            return null;
        }
        const vollstaendig = hit.complete === true;
        const erlaubt = vollstaendig
            ? CONFIG.CACHE_TTL_DAYS * 864e5
            : CONFIG.CACHE_TTL_INCOMPLETE_HOURS * 3600e3;
        if ((Date.now() - (hit.ts || 0)) >= erlaubt) return null;
        // Ein unvollstaendiger Auszug taugt nur fuer die Auslieferungsart, die ihn
        // erzeugt hat: sonst zeigt ein Desktop-Lauf wegen einer mobilen
        // Teilinformation sieben Tage lang “Kontoalter unbekannt”, obwohl es die
        // Daten gäbe.
        if (!vollstaendig && hit.variant !== deliveryVariant(card)) return null;
        return hit;
    }

    // ------------------------------ Netzwerkteil ------------------------------
    function httpGetDoc(url, referer) {
        return new Promise(resolve => {
            const finish = (doc, status) => resolve({ doc, status });

            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: CONFIG.FETCH_TIMEOUT,
                    // Nur was nachweislich ankommt: `referer` und `user-agent` nennt die
                    // Tampermonkey-Doku als setzbare Header (auf Safari und Android-Browsern
                    // teils eingeschränkt). `Sec-Fetch-*` sind verbotene Request-Header und
                    // werden vom Browser übernommen, nicht vom Skript - hier also weggelassen.
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
                        'referer': referer || location.href
                    },
                    onload: r => {
                        if (r.status === 200) {
                            try {
                                finish(new DOMParser().parseFromString(r.responseText, 'text/html'), r.status);
                            } catch {
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
            const timer = setTimeout(() => ctrl.abort(), CONFIG.FETCH_TIMEOUT);
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

    // Bot-Gegenwehr antwortet gelegentlich mit Status 200 und einer Hinweis-/Captcha-
    // Seite. Erkennung nur, wenn die Seite keinerlei Profil-Container enthaelt: damit
    // eine Anzeige, in deren Titel ein solcher Block-Begriff steht (z. B. ein
    // „Roboter“-Staubsauger), nicht fälschlich einen Cooldown ausloest.
    function looksLikeBlockPage(doc) {
        if (doc.querySelector('#viewad-profile-box, #viewad-contact, [class*="userprofile"], .userbadge'))
            return false;
        const t = clean(doc.title).toLowerCase();
        if (!t) return false;
        return /captcha|verifizier|kein roboter|roboter\?|are you a (human|bot)|access denied|access to request|too many requests|temporarily blocked|sicherheitspr[üu]fung|sicherheit check/.test(t);
    }

    // Nur ein Befund mit mindestens einem belastbaren Signal darf wiederverwendet
    // werden. Eine Seite ohne jedes Anzeichen eines Verkäufers ist kein Fund, sondern
    // ein weicher Fehler (typisch: Bot-/Captcha-Seite mit Status 200).
    function isUsable(d) {
        if (!d) return false;
        if (d.userId || d.name) return true;
        if (d.badges && d.badges.length) return true;
        if (typeof d.activeDays === 'number') return true;
        return !!(d.satisfaction && d.satisfaction !== 'fehlt');
    }

    // ------------------------------- Anzeige ---------------------------------
    function injectStyles() {
        if (document.getElementById('kbs-style')) return;
        const css = `
            .kbs-info { display: block; margin-top: 8px; max-width: 100%; }
            .kbs-chip {
                display: inline-block;
                font-size: 11px; font-weight: 600; line-height: 1.4;
                color: #000; padding: 3px 9px;
                border-radius: 12px; border: 2px solid #adb5bd;
                background: #e9ecef;
            }
            .kbs-meta { color: #555; font-size: 11px; margin-left: 6px; }
            .kbs-stufe { font-size: 11px; font-weight: 700; margin-right: 6px; }
            .kbs-info.kbs-gut .kbs-stufe { color: #1b6e2a; }
            .kbs-info.kbs-mittel .kbs-stufe { color: #8a6d1a; }
            .kbs-info.kbs-schlecht .kbs-stufe { color: #a1121f; }
            .kbs-info.kbs-unbekannt .kbs-stufe { color: #555; }
            /* Enge Karten (mobile Auslieferung, schmales Browserfenster): der Chip
               bricht innerhalb der Textspalte um und verdraengt weder Bild noch Preis. */
            .kbs-chip { max-width: 100%; overflow-wrap: anywhere; }
            @media (max-width: 720px) {
                .kbs-chip { font-size: 10px; padding: 2px 7px; }
                .kbs-meta { display: block; margin-left: 0; }
                .kbs-info { margin-top: 6px; }
            }
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
                display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
                max-width: calc(100vw - 24px);
            }
            #kbs-status .kbs-text { flex: 1 1 auto; }
            #kbs-status .kbs-aktionen { display: flex; gap: 6px; flex: 0 0 auto; }
            #kbs-status .kbs-knopf {
                font: 12px/1.2 system-ui, sans-serif; color: #fff;
                background: #444; border: 1px solid #777; border-radius: 5px;
                /* Touch-Zielgröße: auf dem Handy nicht deutlich unter 40 px Höhe */
                padding: 10px 12px; min-height: 40px; min-width: 44px; cursor: pointer;
            }
            #kbs-status .kbs-knopf:hover { background: #555; }
        `;
        const style = document.createElement('style');
        style.id = 'kbs-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    let statusEl = null;
    let statusTimer = null;

    // Eine Sperung (Cooldown, Tageslimit) ist wichtiger als eine Statistikmeldung:
    // sie bleibt stehen, und kein abgelaufener Timer einer aelteren Meldung darf sie
    // loeschen. Deshalb traegt jede Meldung jetzt ihre Anzeigedauer selbst.
    function setStatus(msg, bleibt) {
        if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
        if (!msg) {
            if (statusEl) { statusEl.remove(); statusEl = null; }
            return;
        }
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'kbs-status';
            const text = document.createElement('span');
            text.className = 'kbs-text';
            statusEl.appendChild(text);
            document.body.appendChild(statusEl);
        }
        statusEl.querySelector('.kbs-text').textContent = msg;
        steuerungEinblenden();
        if (!bleibt) statusTimer = setTimeout(() => setStatus(''), 10000);
    }

    // Aktionen, die sonst nur über die Tastatur erreichbar sind. Auf dem Handy gibt
    // es keine Tastatur: Strg+F8 und Strg+Shift+F8 sind dort unbenutzbar, also
    // brauchen dieselben Vorgänge einen Touch-Zugang (Bedienfeld und Manager-Menü).
    function zuruecksetzen() {
        clearCache();
        store(dayKey(), 0);
        store(NS + 'cooldown', 0);
        if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
        setStatus('Cache und Tageszähler geleert. „Prüfen“ drücken oder Seite neu laden.', true);
        log('Cache + Zähler geleert.');
    }

    function steuerungEinblenden() {
        if (!statusEl || statusEl.querySelector('.kbs-aktionen')) return;
        const feld = document.createElement('span');
        feld.className = 'kbs-aktionen';
        const knopf = (text, titel, handler) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'kbs-knopf';
            b.textContent = text;
            b.title = titel;
            b.setAttribute('aria-label', titel);
            b.addEventListener('click', ev => { ev.preventDefault(); handler(); });
            feld.appendChild(b);
        };
        knopf('Prüfen', 'Verkäuferbewertungen jetzt prüfen (auch fehlgeschlagene Karten)', () => processAll(true));
        knopf('Stopp', 'Abarbeitung anhalten', stop);
        knopf('Zurücksetzen', 'Cache und Tageszähler löschen', zuruecksetzen);
        statusEl.appendChild(feld);
    }

    function menueBefehle() {
        if (typeof GM_registerMenuCommand !== 'function') return false;
        try {
            GM_registerMenuCommand('Jetzt prüfen', () => processAll(true));
            GM_registerMenuCommand('Abarbeitung stoppen', stop);
            GM_registerMenuCommand('Cache und Tageszähler löschen', zuruecksetzen);
            GM_registerMenuCommand('Fehlersuche einschalten', fehlersucheEinschalten);
            return true;
        } catch (e) {
            warn('Menübefehle nicht nutzbar:', e);
            return false;
        }
    }

    function cardInfoHost(card) {
        // Neue Oberfläche: die Spalte mit Titel/Preis, niemals die Bildspalte.
        // Achtung: beide Spalten tragen `basis-*`-Klassen (gemessen an einer echten
        // Suchseite: 27/27 Karten), die Bildspalte steht zuerst – ein pauschales
        // /basis-/ Muster erwischt also immer das Thumbnail.
        const article = artikelElement(card);
        if (article) {
            const cols = Array.from(article.children).filter(el => el.tagName === 'DIV');
            const heads = cols.filter(el => el.querySelector('h2, h3, [class*="headline"]'));
            const col = heads.find(el => !el.querySelector('img')) || heads[0]
                || cols.find(el => !el.querySelector('img')) || cols[cols.length - 1];
            if (col) return col;
            return article;
        }
        // Mobile Auslieferung: Textbereich der Karte (Titel, Preis, Ort)
        if (card.matches && card.matches('li.j-adlistitem')) {
            const feld = card.querySelector('.adlist--item--descarea')
                || card.querySelector('[class*="adlist--item--desc"]');
            return feld || card;
        }
        // Alte Oberfläche
        return card.querySelector('.aditem-main--bottom')
            || card.querySelector('.aditem-main')
            || card;
    }

    const STUFE_TEXT = {
        gut: '✓ gut', mittel: '! mittel', schlecht: '✕ schlecht', unbekannt: '? unbekannt'
    };

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
        const fehlerText = typeof d.failStatus === 'number'
            ? 'Detailseite nicht ladbar' : 'keine belastbaren Verkäuferdaten';
        chip.textContent = infos.length ? infos.join(' | ')
            : (d.failed ? fehlerText : 'keine Bewertungen');

        const when = d.cached ? ' (aus Cache)' : '';
        chip.title = [
            'Stufe: ' + d.rating.toUpperCase(),
            d.name ? 'Verkäufer: ' + d.name : '',
            d.activeDays !== null ? 'Kontoalter: ' + d.activeDays + ' Tage' + when : 'Kontoalter unbekannt',
            typeof d.activeSince === 'number' ? 'Konto seit ' + datumDe(d.activeSince) : '',
            typeof d.bewertetAm === 'number'
                ? 'Bewertet am ' + datumDe(d.bewertetAm) +
                  (typeof d.gueltigBis === 'number'
                      ? ', Angabe wiederverwendbar bis ' + datumDe(d.gueltigBis) : '')
                : '',
            d.badges.length ? 'Abzeichen: ' + d.badges.join(', ') : 'keine Abzeichen',
            d.failed ? 'Fehlergrund: ' +
                (typeof d.failStatus === 'number' ? 'HTTP ' + d.failStatus : d.failStatus) +
                '\nErneut versuchen: Strg+F8' : ''
        ].filter(Boolean).join('\n');

        // Stufe nicht nur über die Farbe: für rot-grün-sehschwache Nutzer sind
        // Grün und Rot kaum zu unterscheiden, und ohne Text lässt sich die Stufe
        // auch nicht vorlesen.
        const stufe = document.createElement('span');
        stufe.className = 'kbs-stufe';
        stufe.textContent = STUFE_TEXT[d.rating] || d.rating;
        row.setAttribute('aria-label', 'Verkäufer-Bewertung: ' + (d.rating || 'unbekannt'));
        row.appendChild(stufe);
        row.appendChild(chip);
        if (d.activeDays !== null) {
            const meta = document.createElement('span');
            meta.className = 'kbs-meta';
            // Das von der Seite gelesene Datum statt einer zurückgerechneten Näherung:
            // die Rundung der Tageszahl konnte um bis zu zwei Tage daneben liegen.
            const seit = typeof d.activeSince === 'number'
                ? d.activeSince
                : Date.now() - d.activeDays * 864e5;
            meta.textContent = 'seit ' + datumDe(seit);
            row.appendChild(meta);
        }
        host.appendChild(row);

        ['kbs-gut', 'kbs-mittel', 'kbs-schlecht', 'kbs-unbekannt'].forEach(c => card.classList.remove(c));
        card.classList.add('kbs-card', 'kbs-' + d.rating);
    }

    // -------------------------- Karten sammeln / abarbeiten -------------------
    // Der Karteninhalt steckt je nach Auslieferung in einem article-Element; alle
    // drei Zugriffe (ID, Detail-URL, Einfügeort) brauchen denselben Knoten.
    function artikelElement(karte) {
        if (karte.matches && karte.matches('article[data-adid], article[data-href]')) return karte;
        return karte.querySelector &&
            karte.querySelector('article[data-adid], article[data-href]');
    }

    function getAdId(card) {
        const article = artikelElement(card);
        if (article && article.dataset.adid) return article.dataset.adid;
        const a = card.querySelector('a[href*="/s-anzeige/"]');
        const m = a && a.href.match(/\/(\d{6,})-\d+/);
        return m ? m[1] : (a ? a.href : '');
    }

    function getDetailUrl(card) {
        const artikel = artikelElement(card);
        if (artikel && artikel.dataset.href) {
            // data-href ist Seitengabe: eine protokollrelative oder auswärtige Angabe
            // würde sonst ins Ausland getragen (@connect bremst nur den GM-Pfad, der
            // fetch-Fallback nicht). Ungültige oder auswärtige Ziel -> Karte überspringen.
            try {
                const url = new URL(artikel.dataset.href, location.origin);
                if (url.origin === location.origin) return url.href;
                warn('Karte übersprungen: data-href zeigt auf fremde Herkunft', url.origin);
            } catch {
                warn('Karte übersprungen: unbrauchbares data-href', artikel.dataset.href);
            }
            return '';
        }
        const a = card.querySelector('a[href*="/s-anzeige/"]');
        return a ? a.href : '';
    }

    function collectCards(force) {
        const out = [];
        document.querySelectorAll(CARD_SELECTOR).forEach(el => {
            // Nur Karten mit Anzeigenbezug
            const url = getDetailUrl(el);
            if (!url || !/\/s-anzeige\//.test(url)) return;
            const done = el.querySelector('.kbs-info:not(.kbs-failed)');
            if (done || (!force && el.querySelector('.kbs-info'))) return;
            out.push(el);
        });
        return out;
    }

    let running = false;
    let stopRequested = false;     // bricht den laufenden Pool ab
    let userStopped = false;       // vom Nutzer gestoppt: nichts automatisch neu starten
    let cooldownTimer = null;
    const stats = { cached: 0, fetched: 0, failed: 0, blocked: 0, error: 0, quotaSkip: 0, backoff: 0 };

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => CONFIG.DELAY_MIN + Math.random() * (CONFIG.DELAY_MAX - CONFIG.DELAY_MIN);

    // Vollständiges, gefahrlos renderbares Ergebnis für eine nicht auswertbare
    // Karte. Ein handgeschriebenes Teillobject wuerde in renderBadge erneut werfen.
    function failedData(status) {
        return {
            name: '', userId: '', type: '', variant: '', activeDays: null, activeSince: null,
            active: '',
            satisfaction: 'fehlt', reliability: false, friendliness: false,
            sustainability: '', badges: [], rating: 'unbekannt',
            failed: true, failStatus: status
        };
    }

    async function handleCard(card, index, total) {
        const adId = getAdId(card) || ('url_' + getDetailUrl(card));
        const hit = cacheHit(adId, card);
        if (hit) {
            hit.data.cached = true;
            hit.data.bewertetAm = hit.ts;
            hit.data.gueltigBis = hit.bis || null;
            renderBadge(card, hit.data);
            stats.cached++;
            return 'cached';
        }
        // Tageslimit bremst nur echte Anfragen - eine bereits gecachte Bewertung
        // kostet nichts und muss deshalb auch bei vollem Zähler zu sehen sein.
        if (todayUsed() >= CONFIG.MAX_PER_DAY) {
            stats.quotaSkip++;
            return 'quota';
        }
        setStatus('Prüfe Verkäufer ' + (index + 1) + '/' + total + ' … (' + todayUsed() + '/' + CONFIG.MAX_PER_DAY + ')');
        // Der Zähler läuft vor der Anfrage und zählt den Versuch, nicht den Erfolg:
        // sonst schützt das Tageslimit nicht vor einer Endlosschleife fehlgeschlagener
        // Abrufe, und die Prüfung könnte von beiden Workern gleichzeitig passiert werden.
        bumpToday();
        const { doc, status } = await httpGetDoc(getDetailUrl(card), location.href);

        if (status === 403 || status === 429) {
            setCooldown();
            stats.blocked++;
            stopRequested = true;
            warn('HTTP', status, '- Bot-Gegenwehr getroffen. Cooldown bis',
                new Date(cooldownUntil()).toLocaleTimeString('de-DE'));
            setStatus('Blockiert (HTTP ' + status + ') – ' + CONFIG.COOLDOWN_MINUTES +
                ' Min Pause. Ctrl+F8 zum frühen Neustart.', true);
            return 'blocked';
        }

        if (!doc) {
            warn('Detailseite nicht geladen:', getDetailUrl(card), 'Status', status);
            stats.failed++;
            renderBadge(card, failedData(status));
            return 'failed';
        }

        stats.fetched++;
        const data = extractSeller(doc);
        if (!isUsable(data)) {
            // Wie eine Bot-Gegenwehr aussehen: nicht weiterladen, sondern eine Pause einlegen.
            if (looksLikeBlockPage(doc)) {
                setCooldown();
                stats.blocked++;
                stopRequested = true;
                warn('Bot-Gegenwehr mit Status 200 erkannt. Cooldown bis',
                    new Date(cooldownUntil()).toLocaleTimeString('de-DE'));
                setStatus('Blockiert (Seite verlangt eine Bestätigung) – ' + CONFIG.COOLDOWN_MINUTES +
                    ' Min Pause. Ctrl+F8 zum frühen Neustart.', true);
                return 'blocked';
            }
            // Ein leeres Ergebnis wird nicht gecacht: sonst bliebe die Karte bis zum
            // Ablauf der TTL (sieben Tage) auf “unbekannt” stehen, obwohl erneut
            // geladen werden könnte.
            stats.failed++;
            data.failed = true;
            data.failStatus = 'keine Verkäuferdaten';
            warn('Keine Verkäuferdaten erkannt:', getDetailUrl(card));
        } else {
            const jetzt = Date.now();
            const vollstaendig = typeof data.activeDays === 'number';
            data.bewertetAm = jetzt;
            data.gueltigBis = jetzt + (vollstaendig
                ? CONFIG.CACHE_TTL_DAYS * 864e5
                : CONFIG.CACHE_TTL_INCOMPLETE_HOURS * 3600e3);
            putCache(adId, {
                ts: jetzt,
                bis: data.gueltigBis,
                variant: data.variant,
                complete: vollstaendig,
                data
            });
        }
        renderBadge(card, data);
        log('✓', adId, data.rating, '|', data.type || '?', '|', data.satisfaction,
            '|', data.active || 'kein Datum', '|', todayUsed() + '/' + CONFIG.MAX_PER_DAY);
        return data.failed ? 'soft' : 'ok';
    }

    // Mobilgeraete liefern eine schmalere Karte, haengen oft an Funkverbindungen und
    // haben keine Tastatur. Deshalb dort: ein Request gleichzeitig, kleineres
    // Tageskontingent, laengere Pausen. Die Zahlen sind bewusst konservativ gewaehlt,
    // weil der Geraetbefund (T45) noch aussteht; ueber "Zuruecksetzen" sind sie
    // im Betrieb wieder einfangbar.
    function mobilerBetrieb() {
        try {
            if (typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches) return true;
        } catch { /* egal */ }
        const breit = window.innerWidth || 0;
        return breit > 0 && breit <= 720;
    }

    function gerateEinstellungen() {
        if (!mobilerBetrieb()) return false;
        CONFIG.CONCURRENCY = 1;
        CONFIG.MAX_PER_DAY = Math.min(CONFIG.MAX_PER_DAY, 150);
        CONFIG.DELAY_MIN = Math.max(CONFIG.DELAY_MIN, 900);
        CONFIG.DELAY_MAX = Math.max(CONFIG.DELAY_MAX, 2400);
        CONFIG.BACKOFF_BASE = Math.max(CONFIG.BACKOFF_BASE, 8000);
        log('Mobilbetrieb erkannt: 1 Anfrage gleichzeitig, maximal', CONFIG.MAX_PER_DAY,
            'Details am Tag, Pausen', CONFIG.DELAY_MIN + '-' + CONFIG.DELAY_MAX, 'ms');
        return true;
    }

    function looksLikeListing(force) {
        if (/\/s-anzeige\//.test(location.pathname)) return false;
        if (document.getElementById('srchrslt-adtable')) return true;
        if (document.getElementById('srp-results')) return true;   // mobile Auslieferung
        return collectCards(force).length >= 2;
    }

    async function processAll(force) {
        if (running) return;
        if (!looksLikeListing(force)) return;
        injectStyles();

        const cd = cooldownUntil();
        if (cd > Date.now() && !force) {
            setStatus('Cooldown bis ' + new Date(cd).toLocaleTimeString('de-DE') +
                ' – Ctrl+F8 ignoriert das Limit.', true);
            warn('Cooldown aktiv bis', new Date(cd).toLocaleTimeString('de-DE'));
            planeCooldownFortsetzung();
            return;
        }
        if (force) store(NS + 'cooldown', 0);

        // Pro Lauf wird der Cache frisch aus dem Speicher gelesen: sonst arbeitet der
        // Puffer eines früheren Laufs weiter (auch gegen über die Tastatur gelöschte
        // oder von außen geänderte Bestände).
        schreibeCache();
        cachePuffer = null;

        let cards = collectCards(force);
        if (!cards.length) {
            if (document.querySelector('#srchrslt-adtable, .aditem, [data-testid="l-aditem"]')) {
                warn('Karten gefunden, aber ohne /s-anzeige/-Link – Markup geändert?');
            }
            return;
        }
        if (todayUsed() >= CONFIG.MAX_PER_DAY) {
            warn('Tageslimit (' + CONFIG.MAX_PER_DAY + ') erreicht - gezeigt wird, was bereits gecacht ist.');
            setStatus('Tageslimit (' + CONFIG.MAX_PER_DAY + ') erreicht: gecacht angezeigte Bewertungen, '
                + 'neue Detailseiten erst nach Reset. Ctrl+Shift+F8 löscht den Zähler.', true);
        }

        running = true;
        stopRequested = false;
        userStopped = false;
        Object.keys(stats).forEach(k => stats[k] = 0);
        log('Verarbeite', cards.length, 'Anzeigen (Tageslimit', CONFIG.MAX_PER_DAY +
            ', bereits genutzt', todayUsed() + ')');

        let i = 0;
        let fehlerSerien = 0;   // Fehlschläge hintereinander (über beide Worker hinweg)
        let abbruchGrund = '';  // warum der Lauf vorzeitig endete, für die Statusmeldung
        const worker = async () => {
            while (!stopRequested) {
                if (i >= cards.length) return;
                const idx = i++;
                let ergebnis = 'error';
                try {
                    ergebnis = await handleCard(cards[idx], idx, cards.length) || 'error';
                } catch (e) {
                    // Eine einzelne kaputte Karte (fremdes Markup, unerwartetes
                    // Ergebnis) darf weder die anderen Karten aufhalten noch den
                    // Lauf in der running-Falle belassen.
                    stats.error++;
                    warn('Karte', idx + 1, 'schlug fehl:', e);
                }

                // Gestaffelte Pause nach Netzfehlern: eine store Seite oder ein
                // Timeout führt sonst zu einer series rascher Nachfragen.
                if (ergebnis === 'failed' || ergebnis === 'error') {
                    fehlerSerien++;
                    if (fehlerSerien >= CONFIG.MAX_FAILED_SERIES) {
                        abbruchGrund = 'Wiederholt keine Detailseite geladen (' + fehlerSerien +
                            ' Fehlversuche in Folge) – Abbruch. Ctrl+F8 versucht es später erneut.';
                        setStatus(abbruchGrund, true);
                        warn('Abbruch nach', fehlerSerien, 'Fehlversuchen in Folge');
                        stopRequested = true;
                        return;
                    }
                    const pause = Math.min(
                        CONFIG.BACKOFF_BASE * Math.pow(2, fehlerSerien - 1), CONFIG.BACKOFF_MAX);
                    stats.backoff++;
                    warn(fehlerSerien + '. Fehlversuch in Folge – Pause', pause, 'ms');
                    await sleep(pause);
                    continue;
                }
                if (ergebnis === 'ok' || ergebnis === 'cached') fehlerSerien = 0;
                if (i < cards.length) await sleep(jitter());
            }
        };

        try {
            await Promise.all(Array.from({ length: Math.min(CONFIG.CONCURRENCY, cards.length) }, worker));
        } finally {
            running = false;
            schreibeCache();
        }

        const hinweise = [];
        if (stats.cached) hinweise.push(stats.cached + ' aus Cache');
        if (stats.failed) hinweise.push(stats.failed + ' Fehler (Strg+F8 = erneut)');
        if (stats.error) hinweise.push(stats.error + ' Karte mit Ausnahmefehler (Strg+F8 = erneut)');
        if (stats.blocked) hinweise.push(stats.blocked + ' blockiert');
        if (stats.quotaSkip) hinweise.push(stats.quotaSkip + ' ohne Anfrage (Tageslimit)');
        if (stats.backoff) hinweise.push(stats.backoff + ' × gestaffelte Pause');
        const fertig = 'Fertig: ' + cards.length + ' Karten · ' + stats.fetched + ' neue Anfragen · ' +
            todayUsed() + '/' + CONFIG.MAX_PER_DAY + ' heute' +
            (hinweise.length ? ' · ' + hinweise.join(' · ') : '');
        if (cooldownUntil() > Date.now()) planeCooldownFortsetzung();

        const spater = cooldownUntil();
        if (abbruchGrund) {
            setStatus(abbruchGrund + ' | ' + fertig, true);
        } else if (stats.blocked > 0 || spater > Date.now()) {
            // Die Statistik durfte die Sperung nicht ueberschreiben - beide zusammen.
            setStatus('Blockiert – Cooldown bis ' + new Date(spater).toLocaleTimeString('de-DE') +
                '. Ctrl+F8 startet früher. | ' + fertig, true);
        } else {
            setStatus(fertig);
        }
    }

    function stop() {
        stopRequested = true;
        userStopped = true;
        if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
        setStatus('Gestoppt. Strg+F8 startet wieder.');
    }

    // Nach einem Cooldown darf das Skript nicht bis zum Seitenneuladen schlafen:
    // der Ablauf wird vorgemerkt und dann automatisch weitergearbeitet.
    function planeCooldownFortsetzung() {
        if (cooldownTimer) clearTimeout(cooldownTimer);
        const bis = cooldownUntil() - Date.now();
        if (bis <= 0) { cooldownTimer = null; return; }
        cooldownTimer = setTimeout(() => {
            cooldownTimer = null;
            log('Cooldown abgelaufen – automatischer Lauf.');
            processAll(false);
        }, bis + 400);
    }

    // Nachladen von Karten (Unendliche Liste, Filter-Rerender) beobachten
    function observeDom() {
        let timer = null;
        const obs = new MutationObserver((eintraege) => {
            // Eigene Einfuegungen (Bewertungszeile, Statusleiste) duerfen den
            // Beobachter nicht erneut ausloesen - sonst haelt er sich selbst beschaeftigt.
            const fremd = eintraege.some(e => Array.from(e.addedNodes).some(n =>
                n.nodeType === 1 && !(n.closest && n.closest('.kbs-info, #kbs-status')) &&
                !n.classList.contains('kbs-info')));
            if (!fremd) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (running || userStopped) return;
                if (cooldownUntil() > Date.now()) { planeCooldownFortsetzung(); return; }
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
                zuruecksetzen();
            } else if (running) {
                stop();
            } else {
                processAll(true);
            }
        }
    });

    // Debug-/Pflegemöglichkeit: nur nach bewusster Freigabe, nicht im Normalbetrieb.
    // In Tampermonkeys Sandbox ist ein auf `window` gelegtes Objekt ohnehin nicht von
    // der Seitenkonsole aus erreichbar; nutzbar ist es im Skriptkontext (Tampermonkey:
    // „Inhalt im Seitenkontext ausführen“, oder die Konsole des Skript-Editors) und im
    // Testbetrieb. Freigabe über die Adresse (#kbs-debug) oder den Menüpunkt
    // „Fehlersuche einschalten“.
    function debugFreigegeben() {
        if (window.kbsDebugOnly) return true;                        // Testbetrieb
        if (/[?&#]kbs-debug/.test(location.href)) return true;        // URL-Freigabe
        try { return !!load(NS + 'debug', false); } catch { return false; }
    }

    function fehlersucheEinschalten() {
        store(NS + 'debug', true);
        log('Fehlersuche eingeschaltet. Seite neu laden, dann steht kbsDebug bereit.');
        setStatus('Fehlersuche eingeschaltet – bitte Seite neu laden.', true);
    }

    if (debugFreigegeben()) {
      try {
        window.kbsDebug = {
            config: CONFIG,
            extractSeller, computeRating, collectCards, renderBadge, looksLikeListing,
            getDetailUrl, getAdId, artikelElement, schreibeCache,
            formatActive, parseGermanDate, daysSince, datumDe,
            clearCache, processAll, stop, stats, zuruecksetzen, steuerungEinblenden, menueBefehle,
            gerateEinstellungen, mobilerBetrieb, debugFreigegeben
        };
      } catch { /* egal */ }
    }

    if (!window.kbsDebugOnly) {
        gerateEinstellungen();
        // Der Beobachter laeuft von Anfang an: bei der mobilen Auslieferung erscheinen
        // Karten oft erst nach der Erstenzeichnung, ein starrer Start nach 1,5 s lief
        // dann ins Leere.
        observeDom();
        setTimeout(() => {
            const menue = menueBefehle();
            log('Bereit. Strg+F8 = starten/stoppen, Strg+Shift+F8 = Cache + Zähler löschen' +
                (menue ? '; dasselbe im Tampermonkey-Menü und im Bedienfeld.' : ' (Menübefehle hier nicht verfügbar).'));
            processAll();
        }, 1500);
    }
})();
