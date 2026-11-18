# Watchbettertogether

Private YouTube-Watchpartys ohne Anmeldung: Einladungsraeume fuer bis zu
5 Teilnehmer, gemeinsame Steuerung und Warteschlange. Jeder Browser spielt
YouTube direkt ab; der Server synchronisiert nur den Raumzustand.

## Lokal entwickeln

Node.js 24 oder neuer wird benoetigt (SQLite ist in Node integriert).

```powershell
npm ci
npm run dev
```

Die Oberflaeche ist unter `http://localhost:5173` erreichbar.
Der Server laeuft auf Port 3000, Vite leitet HTTP und WebSockets weiter.
SQLite liegt standardmaessig unter `data/watchparty.sqlite`.

```powershell
npm test
npm run build
$env:APP_ORIGIN = "http://localhost:3000"
$env:NODE_ENV = "production"
npm start
```

Browserintegration:

```powershell
npx playwright install chromium
npm run test:browser
```

Die automatisierten Browsertests simulieren die YouTube-API fuer reproduzierbare
Steuerungs-/Fehlertests. Die echte YouTube-Wiedergabe muss zusaetzlich mit mehreren
Browsern und einem auf deinem Standort einbettbaren Video geprueft werden.

Der optionale Test laedt YouTube wirklich, liest die vom IFrame gemeldeten
Positionen und prueft laufende Wiedergabe, native Play/Pause-/Spulbedienung
und lokales Vollbild mit zwei Browsern:

```powershell
$env:REAL_YOUTUBE = "1"
npm run test:browser
```

Lokaler Nachweis: Raum-/Socket-/Speichertests, Produktionsbuild und zwei
Browser mit echter YouTube-Wiedergabe wurden erfolgreich geprueft.
Docker ist auf dem Entwicklungsrechner nicht verfuegbar; Image-Build,
Container-Neustart und deine externe HTTPS-/NPM-Verbindung muessen deshalb
auf dem Zielserver geprueft werden.

## Portainer und Nginx Proxy Manager

Ein Container, eine persistente SQLite-Datenbank, kein Redis oder separater
Datenbankserver. Das Image muss zuerst auf dem Docker-Zielserver gebaut werden
(oder aus deiner eigenen Registry auf diesen Server geladen werden):

```sh
docker build -t watchbettertogether:0.1.0 .
```

1. Den Inhalt von [compose.yaml](./compose.yaml) als Portainer-Stack verwenden.
2. Stack-Variable `APP_ORIGIN` auf `https://deine-domain.example` setzen,
   **ohne abschliessenden Slash oder Pfad**.
3. `PROXY_NETWORK` auf das vorhandene Docker-Netz von Nginx Proxy Manager setzen.
   App und NPM muessen in diesem gleichen Netz liegen. Standard ist `proxy`.
4. Stack starten. Das benannte Volume `watchparty-data` speichert SQLite
   unabhaengig von Containerupdates. Nicht bei Updates loeschen.
5. In NPM einen Proxy Host fuer die Domain anlegen:
   Scheme `http`, Forward Hostname `watchbettertogether`, Port `3000`.
   **Websockets Support einschalten**, SSL-Zertifikat auswaehlen und Force SSL
   aktivieren. Die Zertifikate bleiben bei NPM.
6. Domain oeffnen, Raum erstellen, Link in einem zweiten Browser oeffnen,
   Video hinzufuegen und Play/Pause/Spulen testen.

Es wird kein oeffentlicher App-Port veroeffentlicht; der Zugang geht nur ueber
NPM. `TRUST_PROXY=1` setzt genau einen vertrauenswuerdigen Proxy voraus.
Bei anderer Proxy-Kette muss dieser Wert gezielt angepasst werden.
NPM darf den App-Origin und den HTTP-Origin-Header nicht umschreiben.

Falls NPM auf einem anderen Docker-Host laeuft, braucht es statt des gemeinsamen
Netzes eine gezielte interne Portfreigabe mit Firewallregel fuer diesen Proxy.
Keine uneingeschraenkte oeffentliche Freigabe des App-Ports.

Updates: neues Image bauen/laden und Stack neu bereitstellen. Fuer Backups den
Stack stoppen und das vollstaendige Datenvolume sichern (SQLite inklusive
eventueller WAL-/SHM-Dateien). Wiederherstellung bei gestopptem Container mit
Dateirechten fuer UID/GID 1000 (`node`). Ein Datenbankfehler wird nicht durch
eine neue leere Datenbank verborgen.
Nach einem Schreibfehler werden weitere Raumbefehle gesperrt und der Healthcheck
schlaegt fehl; der naechste Speicher-Checkpoint beendet den Prozess mit Fehler,
damit die Container-Neustartregel greifen kann. Ursache (z.B. volles Volume)
beheben statt das Datenvolume zu loeschen.

## Verhalten

- Alle koennen steuern. Player-Befehle werden in festen 100-ms-Fenstern
  entschieden. Bei Konflikten gewinnt der fruehere Beitrittsrang; mehrere
  Befehle dieser Person werden durch ihren zuletzt eingegangenen Befehl ersetzt.
  Ausserhalb des Fensters kann jeder normal steuern. Ein verworfener Befehl wird
  sichtbar gemeldet.
- Queue-Aenderungen werden nacheinander verarbeitet. Erstes Video wird pausiert
  geladen, weitere werden angehaengt. Alle duerfen umsortieren, entfernen,
  einzelne Queue-Videos direkt abspielen und weiterspringen.
- Videoende schaltet genau einmal auf das naechste Video. Ist die Queue leer,
  wird der Player geleert. Der laufende Eintrag ist nicht Teil der Queue.
- Native YouTube-Controls sind aktiviert, auch im Vollbild. Play, Pause und
  Spulen synchronisieren den Raum; Vollbild und Lautstaerke bleiben lokal.
  Die zusaetzlichen Bedienelemente unter dem Player funktionieren weiterhin.
  Vom Server ausgeloeste Player-Aenderungen werden nicht als neue Befehle gesendet.
- Bei Verbindungsverlust pausiert der lokale Player. Ein Reconnect innerhalb
  von 60 Sekunden behaelt den Rang mit einer tabbezogenen temporaeren Kennung.
  Danach oder nach bewusstem Verlassen wird ein neuer Rang vergeben.
  Separate Tabs sind separate Teilnehmer.
- Neustarts stellen gespeicherte Raeume und Queues **pausiert** wieder her.
  Positionen werden bei Aenderungen, alle 5 Sekunden und beim normalen
  Herunterfahren gespeichert. Bei hartem Abbruch kann der Stand entsprechend
  zurueckliegen. Teilnehmerraenge werden nach Server-Neustart neu vergeben.
- Leere Raeume werden nach 24 Stunden geloescht. Die Leerstandsfrist ueberlebt
  Neustarts; zuvor belegte Raeume beginnen bei Wiederherstellung eine neue Frist.
- Kein Benutzerkonto: Jeder mit dem Einladungslink darf beitreten und steuern.
  Links nicht oeffentlich teilen. Es gibt keinen Passwortschutz oder Moderator.
  Raum- und Befehlslimits schuetzen vor einfachem Spam, nicht vor jedem Angriff.

## Synchronitaet und Einschraenkungen

Der Server verwaltet Referenzposition und Serverzeit verbindlich. Clients
messen den Zeitversatz, gleichen alle 2 Sekunden ab und korrigieren ab
0,75 Sekunden Positionsabweichung. Ziel unter stabilen Bedingungen ist meist
weniger als 1 Sekunde Abweichung, keine garantierte Frame-Synchronitaet.
Native Spulvorgaenge werden ueber Zeitspruenge von mehr als 0,75 Sekunden erkannt, da die
YouTube-IFrame-API kein eigenes Seek-Ereignis bereitstellt.

Werbung, Buffering, Hintergrundtabs, Browser-Autoplay-Regeln und Netzqualitaet
koennen die Wiedergabe auseinanderlaufen lassen. Neue Videos starten automatisch.
Blockiert ein Browser Autoplay mit Ton, laeuft das Video dort stumm synchron weiter;
der Ton laesst sich mit **Ton einschalten** oder dem Lautsprecher-Symbol im
YouTube-Player aktivieren. Eine vom Browser erzwungene Pause wird nicht an andere
Teilnehmer weitergegeben. Fehlerhafte,
gesperrte oder nicht einbettbare Videos werden angezeigt, nicht umgangen.
YouTube muss vom Browser erreichbar sein; auch Contentblocker koennen die
Einbettung verhindern.

Nur normale YouTube-Videos (Watch-, youtu.be-, Shorts- und Embed-Links).
Keine Livestream-Synchronisierung, kein Playlist-Import, keine Downloads,
kein Chat. Ein Livestream mit gewoehnlicher Watch-URL laesst sich ohne
Metadaten-API nicht sicher vorab erkennen und bleibt nicht unterstuetzt.
Links mit Playlist-Parametern importieren hoechstens das einzelne Video.
Videotitel werden nicht extern abgerufen; Eintraege zeigen die Video-ID.
Kein YouTube-API-Key benoetigt.

## Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `APP_ORIGIN` | lokale Entwicklungsadressen | Erlaubter Browser-Origin, im Produktivbetrieb erforderlich; mehrere durch Komma trennbar |
| `PORT` | `3000` | HTTP/WebSocket-Port |
| `DATABASE_PATH` | `data/watchparty.sqlite` | SQLite-Pfad; im Image `/app/data/watchparty.sqlite` |
| `TRUST_PROXY` | `0` | Anzahl vertrauenswuerdiger Proxy-Hops; im Stack `1` |
| `MAX_ROOMS` | `100` | Maximale Zahl gespeicherter Raeume inklusive noch nicht abgelaufener leerer Raeume |

`GET /api/health` prueft HTTP und Datenbank und wird im Image als Healthcheck
verwendet. Origin-Pruefung gilt sowohl fuer Raumerstellung als auch Socket.IO.
Die Anwendung speichert keine Video-Dateien und protokolliert keine kompletten
Einladungslinks oder Teilnehmergeheimnisse.
