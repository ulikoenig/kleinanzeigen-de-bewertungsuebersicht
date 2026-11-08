# kleinanzeigen-de-bewertungsuebersicht

Ein Tampermonkey-Skript, das Benutzerbewertungen (Kontoalter, Zufriedenheit,
Zuverlässigkeit, Freundlichkeit, Nutzer-Typ) direkt in den Suchergebnissen von
[Kleinanzeigen](https://www.kleinanzeigen.de) anzeigt.

## Versionen

| Datei | Zweck |
| --- | --- |
| `kleinanzeigen-de-bewertungsuebersicht.user.js` | Installierbares Skript (mit Update-URL, für Greasyfork/Tampermonkey) |
| `kleinanzeigen-de-bewertungsuebersicht.js` | identischer Code ohne `@downloadURL`/`@updateURL` |

## Installation

1. Tampermonkey (Firefox/Chrome) installieren.
2. `kleinanzeigen-de-bewertungsuebersicht.user.js` in Tampermonkey einfügen bzw.
   von Greasyfork installieren: <https://greasyfork.org/de/scripts/557558>
3. Suchseite neu laden (`https://www.kleinanzeigen.de/s-...`). Nach ~2 Sekunden
   erscheinen die Farbabzeichen unter jeder Anzeige.

## Bedienung

| Taste | Wirkung |
| --- | --- |
| Strg+F8 | Start / Stopp; erzwingt zudem erneute Prüfung fehlgeschlagener Karten und ignoriert den Cooldown |
| Strg+Shift+F8 | Cache und Tageszähler löschen |

Statusanzeige: unten links (verschwindet nach Abschluss automatisch).

## Bewertungssystem

Farbe = schlechtester Einzelfaktor:

- **grün (gut)**: Konto ≥ 1 Jahr **und** „TOP Zufriedenheit" (oder zusätzliches
  Abzeichen), keine schlechten Merkmale
- **gelb (mittel)**: Konto 3–12 Monate oder nur „OK Zufriedenheit"
- **rot (schlecht)**: Konto < 3 Monate oder „NAJA"
- **grau (unbekannt)**: keine Verkäuferdaten ermittelbar (z. B. Detailseite nicht
  geladen) — wurde vor 4.0 fälschlich als „schlecht" gewertet

## Technik / Anpassung an das neue Frontend (v4.0)

Die Suchseite läuft seit dem Astro-Umbau mit Tailwind-Klassen; die alten
Selektoren (`.aditem`, `[data-testid="l-aditem"]`) liefern 0 Treffer. Neu:

```
ul#srchrslt-adtable
  └ li[data-clickable="card"]
      └ article[data-adid="3532008625"][data-href="/s-anzeige/…/3532008625-217-7939"]
```

Die **Detailseiten** sind unverändert klassisches Markup, daher bleiben die
Auswertungsanker gültig (`#viewad-profile-box`,
`.userbadges-profile-rating|friendliness|reliability`,
`.userprofile-vip-details-text` mit „Aktiv seit TT.MM.JJJJ"). Für beide Fälle
gibt es Text-Fallbacks, damit ein erneutes Umbauen nicht sofort alles bricht.

Konfiguration oben im Skript:

- `MAX_PER_DAY` (600) – Anfragen pro Kalenderdatum (Cache zählt nicht)
- `CONCURRENCY` (2), `DELAY_MIN`/`DELAY_MAX` (600–1800 ms) – Request-Pool
- `CACHE_TTL_DAYS` (7) – Detaildaten werden wiederverwendet
- `COOLDOWN_MINUTES` (30) – nach HTTP 403/429 (Bot-Gegenwehr) wird automatisch
  pausiert, statt weiter anzufragen

## Test

Der Testschutz prüft Selektoren, Bewertungslogik, Cache und Fehlerbehandlung
gegen kleine Beispielseiten in `test/fixtures/` (jsdom):

```bash
npm install          # installiert jsdom (Entwickabhängigkeit)
npm test             # 13 Tests
```

Die Tests decken ab: neues Astro-Karten-Markup, alter `.aditem`-Fallback,
Badge-Auswertung (TOP / OK / keine Abzeichen), Grenzen der Kontoalter-Bewertung,
Request-Verbrauch pro Karte, Cache-Treffer, 403-Cooldown und Retry nach Strg+F8.

Bei einem erneuten Frontend-Umbau echte Seitenkopien hier ablegen (ordner ist
per `.gitignore` nicht im Repository):

```bash
mkdir -p test/fixtures/live
curl -A "Mozilla/5.0 Firefox/132.0" https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217 \
  -o test/fixtures/live/listing.html
curl -A "Mozilla/5.0 Firefox/132.0" "https://www.kleinanzeigen.de/s-anzeige/…" \
  -o test/fixtures/live/anzeige.html
node test/live-check.js     # zeigt Kartenanzahl + ausgelesene Verkäuferdaten
```

Zeigt `live-check.js` 0 Karten, ist `CARD_SELECTOR` im Skript anzupassen.

Im Browser hilft `window.kbsDebug` (z. B. `kbsDebug.collectCards()` in der
Konsole) beim Prüfen, ob die Selektoren noch treffen.

## Lizenz

GPL-3.0-or-later
