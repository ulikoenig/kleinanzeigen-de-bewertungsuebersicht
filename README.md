# kleinanzeigen-de-bewertungsuebersicht

Ein Tampermonkey-Skript, das die Vertrauenswürdigkeit eines Verkäufers
(Kontoalter, Zufriedenheit, Zuverlässigkeit, Freundlichkeit, Nutzer-Typ) direkt in
den Suchergebnissen von [Kleinanzeigen](https://www.kleinanzeigen.de) anzeigt –
auf dem Rechner **und** auf dem Handy (Firefox mit Tampermonkey).

## Installation

1. Tampermonkey installieren (Firefox Desktop oder Firefox Android).
2. `kleinanzeigen-de-bewertungsuebersicht.user.js` einfügen bzw. von Greasyfork
   installieren: <https://greasyfork.org/de/scripts/557558>
3. Suchseite neu laden (`https://www.kleinanzeigen.de/s-…`). Nach rund zwei
   Sekunden erscheinen die Bewertungen unter den Anzeigen; Karten, die später
   nachgeladen werden, laufen automatisch mit.

## Bedienung

| Zugang | Wirkung |
| --- | --- |
| Strg+F8 (⌘-F8 am Mac) | starten / stoppen; erzwingt zudem die erneute Prüfung fehlgeschlagener Karten und ignoriert den Cooldown |
| Strg+Shift+F8 | Cache und Tageszähler löschen |
| Bedienfeld unten links | dieselben Vorgänge per Touch: **Prüfen**, **Stopp**, **Zurücksetzen** (auf dem Handy der einzige Weg, wenn keine Tastatur da ist) |
| Tampermonkey-Menü | „Jetzt prüfen“, „Abarbeitung stoppen“, „Cache und Tageszähler löschen“, „Fehlersuche einschalten“ |

Statusanzeige: unten links. Sperr-Hinweise (Cooldown, Tageslimit, Abbruch) bleiben
stehen, andere Meldungen verschwinden nach zehn Sekunden.

## Bewertungssystem

Farbe **und** Stufenwort stehen für den schlechtesten Einzelfaktor:

| Stufe | wann |
| --- | --- |
| ✓ gut | Konto ≥ 1 Jahr **und** „TOP Zufriedenheit“ (oder zusätzliches Abzeichen), keine schlechten Merkmale |
| ! mittel | Konto 3–12 Monate oder nur „OK Zufriedenheit“ |
| ✕ schlecht | Konto < 3 Monate oder „NAJA“ |
| ? unbekannt | keine belastbaren Verkäuferdaten ermittelbar – z. B. Detailseite nicht geladbar, oder mobil ausgeliefert **ohne** Kontoalter. Wurde vor 4.0 fälschlich als „schlecht“ gewertet |

Wichtig: **Verkäufer-selbst geschriebener Text zählt nicht.** Ausgewertet wird nur
der systemseitige Profil-/Kontaktbereich; Anzeigentitel und Beschreibung
(`#viewad-description`, `[id*=description]`, `detailsection`-Bereich) werden aktiv
übersprungen. Ein Verkäufer kann seine Stufe also nicht durch Sätze wie
„TOP Zufriedenheit, besonders freundlich“ in seiner eigenen Anzeige anheben.

## Technik

Die **Suchergebnisse** erscheinen in zwei Ausprägungen, je nachdem, welches
User-Agent die Seite bedient (gemessen 2026-02):

```
Desktop: ul#srchrslt-adtable > li[data-clickable="card"]
           > article[data-adid="3532008625"][data-href="/s-anzeige/…"]
         Einfügeort: die Spalte mit Titel/Preis (beide Spalten tragen basis-*-Klassen!)

Mobil:   ul#srp-results > li.j-adlistitem.adlist--item
           > div.adlist--item--descarea > strong.adlist--item--boldtitle > a[href]
         Einfügeort: .adlist--item--descarea
```

Die **Detailseiten** unterscheiden sich ebenfalls nach Auslieferung:

```
Desktop: #viewad-profile-box mit .userbadge.userbadges-profile-rating|friendliness|
         reliability, .userprofile-vip-details-text („Aktiv seit TT.MM.JJJJ“)
Mobil:   div.userprofile-teaser mit --title, --postertype („Privater Nutzer“)
         und --ratings („Zufriedenheit: TOP“) – ein Kontoalter gibt es dort nicht
```

Beide Fälle werden ausgewertet; Text-Fallbacks gibt es nur innerhalb dieses Rahmens.

### Betriebswerte (`CONFIG` oben im Skript)

| Wert | Standard | Bedeutung |
| --- | --- | --- |
| `MAX_PER_DAY` | 600 | geprüfte Anzeigen pro Kalenderdatum (Cache zählt nicht; **Versuche** zählen, auch fehlgeschlagene) |
| `CONCURRENCY` | 2 | parallele Detail-Anfragen |
| `DELAY_MIN` / `DELAY_MAX` | 600 / 1800 ms | Pause pro Worker, zufällig |
| `FETCH_TIMEOUT` | 15000 ms | Zeit für eine Anfrage |
| `CACHE_TTL_DAYS` | 7 | Wiederverwendung vollständiger Angaben |
| `CACHE_TTL_INCOMPLETE_HOURS` | 24 | Wiederverwendung unvollständiger Auszüge (z. B. mobil ohne Kontoalter); diese werden außerdem nur für die Auslieferungsart genutzt, die sie erzeugt hat |
| `COOLDOWN_MINUTES` | 30 | nach HTTP 403/429 **oder** einer Bot-/Captcha-Seite mit Status 200: nichts mehr anfragen; nach Ablauf läuft das Skript von selbst weiter |
| `BACKOFF_BASE` / `BACKOFF_MAX` | 4000 / 300000 ms | gestaffelte Pause nach Netzfehlern |
| `MAX_FAILED_SERIES` | 5 | so viele Fehlschläge hintereinander, dann bricht der Lauf ab |

Auf Mobilgeräten (schmales Fenster) setzt das Skript sparsamere Werte:
1 Anfrage gleichzeitig, höchstens 150 Details am Tag, Pausen 900–2400 ms,
Rückfall ab 8 s. „Zurücksetzen“ fängt das wieder ein.

## Dateien und Werkzeuge

| Datei | Zweck |
| --- | --- |
| `kleinanzeigen-de-bewertungsuebersicht.js` | **Quelle**, hier wird gepflegt |
| `kleinanzeigen-de-bewertungsuebersicht.user.js` | installierbare Fassung, erzeugt (`npm run build`), enthält `@downloadURL`/`@updateURL` |
| `build.js` | erzeugt bzw. prüft die abgeleitete Datei (`npm run check`) |
| `LICENSE` | GPL-3.0-or-later Volltext |

```bash
npm install          # jsdom und ESLint (Entwickabhängigkeiten)
npm run build        # .user.js aus der Quelle erzeugen
npm run check        # Prüfen, ob .user.js noch zur Quelle passt (läuft vor npm test)
npm run lint         # ESLint, 0 Fehler und 0 Warnungen als Maßstab
npm test             # 45 Tests – jede gegen beide Dateiausprägungen
node test/live-check.js   # manuelle Prüfung gegen echte Seitenkopien
```

## Tests und Mitprüfen am echten Stand

Die Tests (jsdom) decken ab: beide Karten-Ausprägungen der Suchseite,
Badge-/Teaser-Auswertung, Grenzen der Kontoalter-Bewertung, Manipulationsfestigkeit
gegen Anzeigentext, Request-Verbrauch und Tageslimit pro Karte, Cache-Treffer und
-Ausgeschlossenheit, Cooldown bei 403 **und** bei Blockseite mit Status 200,
gestaffelte Pausen, Wiederaufnahme nach Cooldown, Touch-Bedienung,
Auslieferungsart-abhängige Cache-Wiederverwendung und die Prüfungen der
Dateiausprägungen.

Seitenkopien gehören nach `test/fixtures/live/` (Ordner ist nicht im Repository):

```bash
mkdir -p test/fixtures/live
curl -A "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0" \
  https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217 -o test/fixtures/live/listing.html
curl -A "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0" \
  https://www.kleinanzeigen.de/s-fahrraeder/fahrrad/k0c217 -o test/fixtures/live/mobile-listing.html
```

`node test/live-check.js` meldet für **jede** Kopie die Kartenanzahl (und warnt, wenn
sie nicht zur Zahl der Anzeigen auf der Seite passt) sowie die ausgelesenen
Verkäuferdaten. Der Stand von Februar 2026: Desktop 27 Karten, mobile Auslieferung
32 Karten.

Für die Fehlersuche im Browser: Menüpunkt „Fehlersuche einschalten“ oder `#kbs-debug`
an die Adresse der Suchseite, Seite neu laden. Dann steht im **Skriptkontext**
`window.kbsDebug` bereit (Tampermonkey: „Inhalt im Seitenkontext ausführen“ oder die
Konsole des Skript-Editors – in der normalen Seitenkonsole ist das Skriptobjekt wegen
der Sandbox nicht sichtbar). Nützlich: `kbsDebug.collectCards()`,
`kbsDebug.extractSeller(dokument)`, `kbsDebug.stats`.

## Prüfen am echten Android-Gerät (adb)

Der Mobilbetrieb wurde an einem echten Gerät gemessen (Galaxy S21 Ultra, Android 15,
Firefox 157.0.1, Tampermonkey 5.5.0). So lässt sich das wiederholen:

```bash
adb devices                                   # Gerät sichtbar?
adb reverse tcp:8765 tcp:8765                 # Handy erreicht den Rechner als localhost
python3 -m http.server 8765 &                 # oder ein kleiner Prüfservice wie unten
adb shell am start -n org.mozilla.firefox/org.mozilla.fenix.IntentReceiverActivity \
  -a android.intent.action.VIEW -c android.intent.category.BROWSABLE \
  -d "http://localhost:8765/<pruefaufbau>.html"
adb shell uiautomator dump /sdcard/wurf.xml && adb shell cat /sdcard/wurf.xml
```

Im Zugbaum (`uiautomator dump`) stehen die eingefügten Zeilen als Textknoten –
`✓ gut`, `! mittel`, `✕ schlecht`, `? unbekannt`, die Chip-Texte und die
Bedienfeldknöpfe als `android.widget.Button`. Damit lassen sich Einfügeort,
Überlappung und Berührungsgröße prüfen; die `bounds` sind Physikalische Pixel
(geteilt durch `wm density / 160` = CSS-Pixel).

Beachtenswertes vom letzten Lauf: die App-Weiterleitungsabfrage
(„Diesen Link mit der Kleinanzeigen-App öffnen?“) muss mit **In Firefox bleiben**
weggetippt werden, die Statusleiste liegt bewusst nicht an der Unterkante
(Wischgeste!), und ein installiertes Skript wird über eine eigene URL mit
Versionswechsel aktualisiert („Aktualisierung des Userscripts“ – derselbe Mechanismus
wie bei Greasyfork).

## Lizenz

GPL-3.0-or-later, Volltext in [`LICENSE`](LICENSE).
