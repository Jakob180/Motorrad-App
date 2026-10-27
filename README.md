# Motorrad-Begleiter (PWA)

Progressive Web App für Motorradfahrer: **Fahrwetter mit Ampel**, **Logbuch** (Tanken, Wartung,
Statistik) und **Service-Erinnerungen**. Reines HTML/CSS/JavaScript ohne Build-Tool – läuft auf
GitHub Pages und wird am iPhone über Safari → „Zum Home-Bildschirm" installiert.

## Ausbaustufen

| Schritt | Inhalt | Stand |
|---|---|---|
| 1 | Grundgerüst, Logbuch, Backup, Offline-Cache | ✅ fertig |
| 2 | Wetter am Standort + Fahr-Ampel | ✅ fertig |
| 3 | Wetter entlang einer Route (Karte, OSRM) | ✅ fertig |
| 4 | Service-Intervalle, Pickerl, Erinnerungen, .ics-Export | ✅ fertig |
| 5 | Push-Benachrichtigungen (Cloudflare Worker) | ✅ fertig |

## Projektstruktur

```
index.html          App-Gerüst (Kopfzeile, Tabs, Tab-Leiste)
manifest.json       PWA-Manifest (Name, Icons, Farben)
sw.js               Service Worker – Offline-Cache, VERSION bei Updates erhöhen!
.nojekyll           sagt GitHub Pages, die Dateien unverändert auszuliefern
css/styles.css      dunkles, handschuhtaugliches Design
icons/              App-Icons (SVG + PNG für iOS/Android)
js/app.js           Einstieg: Tabs/Navigation, Service Worker, Hinweis-Banner
js/db.js            IndexedDB (lokale Datenbank), Einstellungen, API-Cache, Backup
js/ui.js            Formatierung (de-AT), Formularbausteine, Dialoge, Toasts
js/weather.js       Wetter-Tab: Standort, Vorhersage (Open-Meteo), Ortssuche
js/ampel.js         Fahr-Ampel: Bewertung pro Stunde + Tagesfazit (ohne DOM, auch für den Push-Server)
js/route.js         Wetter entlang einer Route: Karte, OSRM-Route, Wetterpunkte, beste Abfahrt, Favoriten
js/logbook.js       Logbuch: Motorräder, Einträge, Verbrauch, Statistik, Diagramme
js/service.js       Service: Intervalle, Pickerl, Fälligkeiten, Hinweise, Kalender-Export (.ics)
js/settings.js      Einstellungen: Ampel-Grenzwerte, Wohnort, Benachrichtigungen, Backup, Updates
js/push.js          Push: Erlaubnis, Web-Push-Abo, Abgleich mit dem Worker

worker/             Push-Server (Cloudflare Worker) – wird NICHT über GitHub Pages ausgeliefert
  wrangler.toml     Worker-Konfiguration (KV, Cron, erlaubte Adressen)
  src/index.js      API, stündlicher Cron, Morgen-Nachricht (nutzt js/ampel.js mit)
  src/webpush.js    Web-Push-Verschlüsselung (RFC 8291) und VAPID – ohne externe Bibliothek
  scripts/setup.mjs erzeugt VAPID-Schlüssel + Token und speichert sie als Secrets
  test/             Tests (npm test) – laufen ohne Cloudflare-Konto
```

Externe Bibliotheken werden per CDN geladen und vom Service Worker für den Offline-Betrieb
gecacht: [Chart.js](https://www.chartjs.org/) (Diagramme), ab Schritt 3 [Leaflet](https://leafletjs.com/) (Karte).
Für die Datenbank wird bewusst **keine** Bibliothek verwendet (kleiner eigener IndexedDB-Wrapper in
`db.js`), damit das Logbuch garantiert auch beim ersten Offline-Start funktioniert.

## Logbuch: Kilometer oder Betriebsstunden

Pro Motorrad lässt sich im Formular unter **Zähler** wählen, ob es nach **Kilometern** oder nach
**Betriebsstunden (Bh)** geführt wird – z. B. für Enduros und Crosser. Bei Betriebsstunden:

- überall wird der Stand in Bh eingegeben (mit Kommastelle, z. B. `123,5`),
- der Verbrauch wird in **l/h** statt l/100 km berechnet, Spritkosten in €/h,
- statt Reichweite zeigt die App die **Laufzeit mit vollem Tank**,
- die Statistik zeigt Betriebsstunden pro Monat/Jahr und Kosten pro Bh.

Die gespeicherten Zahlen ändern sich beim Umstellen nicht – die App warnt deshalb, wenn ein
Motorrad schon Einträge hat.

## Wetter & Fahr-Ampel

- **Datenquelle:** [Open-Meteo](https://open-meteo.com/) (kostenlos, ohne API-Key) – Forecast-API für
  heute + 3 Tage, Geocoding-API für die Ortssuche. Ortsnamen zum GPS-Standort kommen von
  OpenStreetMap (Nominatim). Antworten werden 30 Minuten zwischengespeichert, Ortsnamen 30 Tage.
- **Standort:** GPS, ein gesuchter Ort oder der **Wohnort** (Einstellungen). Klappt GPS nicht,
  zeigt die App den Wohnort bzw. den letzten bekannten Standort. Eine GPS-Position wird
  15 Minuten wiederverwendet, damit das iPhone nicht ständig nachfragt.
- **Ohne Internet** werden die zuletzt geladenen Daten mit Uhrzeit („Stand 14:05") angezeigt.

**So bewertet die Ampel jede Stunde** (Grenzwerte in den Einstellungen änderbar):

| | Gelb | Rot |
|---|---|---|
| Regenwahrscheinlichkeit | über 40 % | über 70 % |
| Regenmenge | über 0,5 mm/h | über 2 mm/h |
| Regen gesamt | – | Wahrscheinlichkeit **und** Menge über Gelb |
| Temperatur | unter 8 °C | unter 3 °C (Glättegefahr) |
| Böen | über 50 km/h | über 70 km/h |
| Sonstiges | Nebel, nasse Straße (≥ 1 mm Regen in den 2 Stunden davor) | Gewitter, Schnee, gefrierender Regen |

**Tagesfazit:** Bewertet wird die Fahrzeit (Standard 8–20 Uhr, einstellbar). Grün, wenn mindestens
3 Stunden am Stück grün sind; Gelb, wenn 3 Stunden am Stück höchstens gelb sind; sonst Rot.
Dazu ein kurzer Satz wie *„Bis 10 Uhr zu kalt, ideal von 10–16 Uhr, ab 16 Uhr Regen"*.

Die Logik steckt in `js/ampel.js` und kann ohne Browser getestet werden:

```bash
node --input-type=module -e "import { rateHour } from './js/ampel.js'; console.log(rateHour({ temp: 6, rainProb: 50, rain: 0.2, gust: 30, code: 3 }, { rainProbYellow: 40, rainProbRed: 70, rainMmYellow: 0.5, rainMmRed: 2, tempYellow: 8, tempRed: 3, gustYellow: 50, gustRed: 70 }))"
```

## Wetter entlang einer Route

Im Wetter-Tab oben auf **Route** wechseln.

1. **Start, Ziel, Zwischenstopps** (bis 5) per Ortssuche, GPS oder Tipp auf die Karte setzen.
   Punkte auf der Karte lassen sich verschieben, **⇅ Umdrehen** tauscht Start und Ziel.
2. **Tag** (heute + 3 Tage), **Abfahrt** und **Ø Tempo** wählen (Standard in den Einstellungen).
3. **Route & Wetter berechnen**: Die Route kommt vom öffentlichen
   [OSRM-Demo-Server](https://project-osrm.org/). Alle ca. 15 km wird ein Wetterpunkt gesetzt
   und das Wetter für die Uhrzeit geprüft, zu der du dort ankommst (Ø Tempo, ohne Pausen).
   Die Strecke wird nach der Ampel eingefärbt, darunter stehen Hinweise wie
   *„Bei km 85 um 15:20 Uhr: Regen 80 % · 1,2 mm"*.
4. **Beste Abfahrt:** Die App rechnet alle Abfahrtszeiten des Tages im 30-Minuten-Takt
   innerhalb der Fahrzeit durch (ohne weitere Abfragen) und schlägt die beste vor – auch, wenn
   ein anderer Tag besser wäre. Ankunft nach Sonnenuntergang zählt als Nachteil.
5. **Favoriten:** Route speichern und später mit einem Tipp wieder laden.

**Sparsam mit den Servern:** Eine Berechnung braucht genau eine Anfrage an OSRM und eine an
Open-Meteo (alle Wetterpunkte gemeinsam). Routen werden 30 Tage gecacht, das Wetter 30 Minuten –
Abfahrtszeit oder Tempo ändern löst gar keine Anfrage aus. Kartenkacheln kommen von
OpenStreetMap und brauchen Internet.

## Service & Erinnerungen

Im Tab **Service** (für das aktive Motorrad):

- **Intervalle** nach km bzw. Betriebsstunden und/oder Zeit, z. B. *Ölwechsel alle 5.000 km oder
  12 Monate*, *Kette schmieren alle 500 km*. **✨ Vorschläge** legt übliche Intervalle an – getrennt
  für Straßenmotorräder (km) und Enduros (Bh). Bitte mit dem Handbuch abgleichen.
- **„Zuletzt erledigt"** kommt automatisch aus dem Logbuch (z. B. letzter Ölwechsel-Eintrag, bei der
  Kette zählen Einträge mit „Schmieren"). Steht es nicht im Logbuch, beim Intervall Datum/Stand eintragen.
- **✓ Erledigt** öffnet den passenden Logbuch-Eintrag vorausgefüllt – nach dem Speichern startet das
  Intervall neu. Eigene Aufgaben zählen Einträge „Sonstiges/Service/Reparatur" mit gleicher Bezeichnung.
- **Status:** „Fällig in 320 km", „Fällig in 3 Wochen", „Überfällig seit …" – farbig markiert.
  *Bald fällig* = weniger als 30 Tage bzw. die letzten 10 % des Intervalls. Bei reinen km-Intervallen
  schätzt die App aus deiner Fahrleistung, wann es so weit ist.
- **Kilometerstand aktualisieren**, wenn länger nichts im Logbuch steht – sonst stimmen km-Fälligkeiten nicht.
- **Pickerl (§57a):** gelochten Monat eintragen. Begutachtung möglich ab dem Monat davor, Toleranzfrist
  bis Ende des 4. Monats danach. **Erledigt** setzt das nächste Pickerl (Vorschlag: +1 Jahr) und trägt
  die Kosten optional ins Logbuch ein.
- **Hinweis-Banner** beim Öffnen der App, wenn bei irgendeinem Motorrad etwas bald fällig oder
  überfällig ist („ausblenden" gilt bis morgen).
- **Mit dem Wetter kombiniert:** Bei Fahrwetter erinnert der Wetter-Tab an fällige Wartungen. Bei einer
  Route warnt die App auch, wenn ein Intervall *während* der Fahrt erreicht wird
  („Kette schmieren: fällig in 100 km – die Route ist 123 km lang"; bei Bh über die geschätzte Fahrzeit).
- **📅 Kalender:** erzeugt eine `.ics`-Datei (ganztägiger Termin mit Erinnerung). Am iPhone erscheint
  die Termin-Vorschau → „Hinzufügen"; die Erinnerung kommt dann vom iPhone-Kalender. Klappt der
  Download in der installierten App nicht, über **Teilen …** versuchen oder die Seite in Safari öffnen.

## Push-Benachrichtigungen (Cloudflare Worker)

Jeden Morgen zur eingestellten Uhrzeit (Standard 7:00) schickt ein kleiner Server eine Nachricht:

- **🟢 Fahrwetter am Wohnort** – nur bei gutem Wetter oder jeden Morgen (einstellbar), z. B.
  *„Gutes Fahrwetter in Hallein – Ideal von 10–16 Uhr, ab 17 Uhr Regen · 8–17 °C"*
- **🔧 Fällige Wartungen** und **🔖 Pickerl** – jede Erinnerung höchstens einmal pro Woche
- Tippen auf die Nachricht öffnet direkt den passenden Tab der App.

**So funktioniert es:** Die App schickt bei jeder Änderung (gebündelt) Push-Abo, Wohnort,
Ampel-Grenzwerte und Fälligkeiten an den Worker, der sie in Cloudflare KV speichert. Ein Cron-Job
läuft **stündlich** (Cron-Zeiten sind immer UTC); der Worker prüft selbst, ob es in
**Europe/Vienna** gerade die gewünschte Uhrzeit ist – dadurch stimmt es automatisch bei Sommer-
und Winterzeit. Das Wetter holt der Worker frisch von Open-Meteo und bewertet es mit derselben
Ampel-Logik wie die App (`js/ampel.js`).

**Voraussetzungen am iPhone:** iOS **16.4 oder neuer** und die App muss **über den
Home-Bildschirm installiert** sein (in Safari allein gibt es keine Push-Nachrichten).

### Einrichtung Schritt für Schritt (einmalig, ca. 15 Minuten)

Alles im kostenlosen Cloudflare-Plan (100.000 Aufrufe/Tag, KV 1.000 Schreibvorgänge/Tag – reicht
locker). Du brauchst [Node.js](https://nodejs.org/) (Version 18 oder neuer).

1. **Cloudflare-Konto anlegen:** [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
   Danach im Dashboard links **Workers & Pages** öffnen und einmal eine
   `workers.dev`-Subdomain wählen (z. B. `jakob180`).

2. **Wrangler (Cloudflare-Werkzeug) installieren** – im Projektordner:

   ```bash
   cd worker
   npm install
   ```

3. **Anmelden** (öffnet den Browser, dort „Allow" klicken):

   ```bash
   npx wrangler login
   ```

4. **KV-Speicher anlegen:**

   ```bash
   npx wrangler kv namespace create PUSH_KV
   ```

   Die ausgegebene `id` in `worker/wrangler.toml` bei `id = "HIER_DIE_KV_ID_EINTRAGEN"` einsetzen
   (fragt Wrangler, ob es das selbst eintragen soll, einfach mit „Yes" bestätigen).

5. **Erlaubte Adressen prüfen:** In `worker/wrangler.toml` steht unter `ALLOWED_ORIGINS` deine
   GitHub-Pages-Adresse **ohne Pfad**: `https://jakob180.github.io`. Nur von dort (und von
   `localhost:8080` zum Testen) darf die App den Worker aufrufen.

6. **Hochladen:**

   ```bash
   npx wrangler deploy
   ```

   Am Ende steht die Adresse, z. B. `https://motorrad-push.jakob180.workers.dev` – notieren.

7. **Schlüssel und Token erzeugen** (speichert alles als geheime Secrets bei Cloudflare):

   ```bash
   npm run setup
   ```

   Das Skript erzeugt die **VAPID-Schlüssel** (damit Apple/Google wissen, dass die Nachrichten von
   dir kommen) und einen **Zugangs-Token**. Der private Schlüssel wird nie angezeigt und landet in
   keiner Datei. Den am Ende angezeigten **Token** brauchst du gleich in der App.

8. **Prüfen:** Die Worker-Adresse im Browser öffnen. Es sollte
   `{"ok":true, … "ready":true}` erscheinen. Steht `"ready":false`, fehlt ein Secret oder KV.

9. **In der App** (am iPhone, installierte App): **Einstellungen → Benachrichtigungen**
   - Server-Adresse und Zugangs-Token eintragen, auswählen was du bekommen willst und die Uhrzeit
   - **„Benachrichtigungen aktivieren"** → iPhone fragt nach der Erlaubnis → **Erlauben**
   - **„Test-Nachricht senden"** – sollte sofort ankommen
   - **„Morgen-Nachricht jetzt testen"** – zeigt, was morgen früh kommen würde
   - Für die Fahrwetter-Nachricht muss oben ein **Wohnort** festgelegt sein.

**Später Code ändern:** `cd worker` → `npx wrangler deploy`. **Logs live ansehen:**
`npm run logs`. **Token verloren?** `npm run setup -- --token-only` und neu in der App eintragen.
`npm run setup` ohne Zusatz erzeugt auch neue VAPID-Schlüssel – danach in der App
Benachrichtigungen einmal deaktivieren und wieder aktivieren.

**Tests ohne Cloudflare-Konto:** `cd worker` → `npm test` (prüft u. a. die Verschlüsselung gegen
die offiziellen Testwerte aus RFC 8291, Token-Schutz, Cron-Zeiten mit Sommer-/Winterzeit).

**Sicherheit & Datenschutz:** Jeder Aufruf braucht den Token, der Worker nimmt nur Anfragen von
deiner App-Adresse an (CORS) und speichert nur: Push-Abo, Wohnort, Ampel-Grenzwerte und die Liste
der Fälligkeiten. Server-Adresse und Token stehen nur auf dem Gerät und **nicht** im Backup.

## Lokal testen

Die App muss über einen Webserver laufen (nicht per Doppelklick auf `index.html`), weil
ES-Module und Service Worker sonst nicht funktionieren. `localhost` gilt als sicher –
Service Worker und Standort funktionieren dort auch ohne https.

**Variante A – Python** (unter Windows meist schon installiert):

```bash
python -m http.server 8080
```

**Variante B – Node.js:**

```bash
npx serve -l 8080
```

Dann im Browser **http://localhost:8080** öffnen.

Tipps für Chrome/Edge (F12 → Entwicklertools):

- **Handy-Ansicht:** Symbol „Gerätesymbolleiste" (Strg+Umschalt+M) → z. B. „iPhone 14 Pro".
- **Service Worker beim Entwickeln:** Tab *Application* → *Service Workers* → Haken bei
  **„Update on reload"** setzen. Sonst liefert der Offline-Cache nach Code-Änderungen weiter die
  alten Dateien aus.
- **Offline testen:** Tab *Network* → „Offline" wählen und neu laden.
- **Daten ansehen/löschen:** Tab *Application* → *IndexedDB* → `motorrad-begleiter`.

> Am iPhone im WLAN über `http://192.168.x.x:8080` zu testen klappt nur eingeschränkt:
> Ohne https gibt es keinen Service Worker und keinen Standort. Zum Testen am iPhone daher
> GitHub Pages verwenden (ist kostenlos und dauert 2 Minuten).

## Auf GitHub Pages veröffentlichen

1. Auf [github.com](https://github.com) ein **neues, öffentliches Repository** anlegen, z. B. `motorrad-app`
   (GitHub Pages ist für private Repos nur in bezahlten Plänen verfügbar).
2. Im Projektordner:

   ```bash
   git init
   git add .
   git commit -m "Motorrad-Begleiter: Schritt 1"
   git branch -M main
   git remote add origin https://github.com/DEIN-NAME/motorrad-app.git
   git push -u origin main
   ```

3. Im Repository: **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **main**, Ordner **/ (root)** → **Save**
4. Nach 1–2 Minuten ist die App erreichbar unter
   **https://DEIN-NAME.github.io/motorrad-app/**

Alle Pfade in der App sind relativ – sie funktioniert daher auch im Unterordner `/motorrad-app/`.

## Am iPhone installieren

1. Die GitHub-Pages-Adresse in **Safari** öffnen (nicht Chrome – nur Safari kann installieren).
2. Unten auf **Teilen** (Quadrat mit Pfeil) tippen.
3. **„Zum Home-Bildschirm"** wählen → **Hinzufügen**.
4. Die App ab jetzt immer über das Icon am Home-Bildschirm starten. Sie läuft dann im Vollbild,
   funktioniert offline und (ab Schritt 5) kann Push-Benachrichtigungen empfangen.

> Achtung: Safari und die installierte App haben **getrennte Speicher**. Daten, die du in Safari
> eingibst, siehst du in der installierten App nicht (und umgekehrt). Daher direkt die
> installierte App verwenden – oder per Backup übertragen.

## Updates veröffentlichen (wichtig!)

Der Service Worker liefert die App aus dem Offline-Cache aus. Damit installierte Apps neue
Dateien bekommen, bei **jeder** Änderung:

1. In `sw.js` die Version erhöhen:

   ```js
   const VERSION = 'v2';   // vorher 'v1'
   ```

2. Neue Dateien (z. B. `js/weather.js`) in die Liste `APP_FILES` in `sw.js` eintragen.
3. Committen und pushen:

   ```bash
   git add .
   git commit -m "Update: Beschreibung"
   git push
   ```

Beim nächsten Öffnen erkennt die App die neue Version und zeigt oben
**„Neue Version verfügbar → Aktualisieren"**. In den Einstellungen gibt es zusätzlich
**„Nach Updates suchen"**. GitHub Pages braucht nach dem Push 1–2 Minuten, und der Browser
cacht Dateien bis zu 10 Minuten – also notfalls kurz warten.

## Datensicherung

Alle Daten liegen **nur lokal** auf dem Gerät (IndexedDB) – es gibt keinen Server, kein Konto.
iOS kann Daten von Web-Apps löschen (z. B. bei Speichermangel oder wenn die App wochenlang
nicht geöffnet wurde). Deshalb:

- **Einstellungen → Backup sichern** erzeugt eine JSON-Datei mit allen Daten (inkl. Fotos).
  Am iPhone öffnet sich das Teilen-Menü → **„In Dateien sichern"** → z. B. iCloud Drive.
- **Backup importieren** ersetzt alle Daten auf dem Gerät durch die Datei – so kommst du
  auch auf ein neues Handy.
- Hat das Logbuch Einträge und das letzte Backup ist älter als 30 Tage, erinnert die App oben
  mit einem Banner daran.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| Änderungen am Code erscheinen nicht | `VERSION` in `sw.js` erhöhen bzw. in den Entwicklertools „Update on reload" aktivieren |
| Leere Seite / Fehler in der Konsole | Läuft die App über einen Webserver (`http://localhost…`) und nicht als `file://`? |
| Diagramme fehlen | Beim allerersten Start ist Internet nötig, damit Chart.js in den Cache kommt |
| Keine Push-Nachrichten am iPhone | App über den Home-Bildschirm öffnen (nicht Safari), iOS ≥ 16.4, iPhone-Einstellungen → Mitteilungen → Motorrad → erlauben. In der App „Test-Nachricht senden". |
| „Push-Server nicht erreichbar" | Worker-Adresse prüfen (im Browser öffnen), `ALLOWED_ORIGINS` in `worker/wrangler.toml` muss deine Pages-Adresse enthalten, danach `npx wrangler deploy` |
| „Der Zugangs-Token stimmt nicht" | Token aus `npm run setup` neu eintragen (oder `npm run setup -- --token-only`) |
| „Standortzugriff nicht erlaubt" | iPhone: Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Safari-Websites → „Beim Verwenden der App". Oder einen Wohnort festlegen. |
| Daten am iPhone weg | Backup importieren (Einstellungen → Backup importieren) |
