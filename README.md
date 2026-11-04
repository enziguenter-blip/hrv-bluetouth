# Polar H10 · Live-Puls und HRV

Vanilla-JavaScript-App für Chrome auf Android, ohne Build-Schritt oder externe Laufzeit-Abhängigkeiten. Einstieg: `index.html`, `styles.css`, `app.js`.

## Starten

```sh
python3 -m http.server 8000
```

Am Rechner `http://localhost:8000` öffnen. Zum Test am Galaxy S23 HTTPS verwenden: eine gewöhnliche HTTP-LAN-Adresse ist kein sicherer Web-Bluetooth-Kontext. GitHub Pages: Dateien auf `main` pushen, unter Settings → Pages „Deploy from a branch“, `main`, `/ (root)` wählen. Anschließend die bereitgestellte HTTPS-Adresse in Chrome öffnen. Keine Veröffentlichung wurde durch diese Implementierung vorgenommen.

Gurt anlegen, Elektroden befeuchten, Bluetooth aktivieren und über „Verbinden“ den H10 auswählen. Andere Sensor-Apps bei Bedarf trennen. App während der Messung im Vordergrund halten. Bildschirm sperren oder Hintergrundbetrieb kann unter Android die Verbindung und Datenerfassung unterbrechen.

## Schritt 1: Ringpuffer und Metriken

- HF und RR besitzen jeweils einen Ringpuffer mit **2048 Slots**. Einträge älter als fünf Minuten werden entfernt; bei Kapazitätsüberlauf überschreibt der nächste Eintrag den ältesten. Auch viele Artefakte können deshalb keinen unbegrenzten Live-Puffer erzeugen. Bei plausiblen RR ab 300 ms reichen 2048 Slots für fünf Minuten.
- Statistikfenster: 60 Sekunden oder fünf Minuten, jeweils anhand der monotonen **Paket-Empfangszeit**. Mehrere RR eines Pakets haben dieselbe Empfangszeit; es werden keine exakten absoluten Schlagzeitpunkte vorgetäuscht.
- SDNN: Stichproben-Standardabweichung (`n - 1`), ab zwei Werten. RMSSD: Wurzel aus dem Mittel der quadrierten Differenzen gültiger Nachbarn. pNN50: Anteil derselben Nachbarpaare mit **absoluter Differenz > 50 ms**, in Prozent.
- Ausfiltern von RR außerhalb 300–2000 ms erzeugt keine neuen Nachbarschaften. Reconnect, fehlende RR und Empfangslücken > fünf Sekunden trennen Paare ebenfalls. Ohne hinreichende Werte/Paare erscheint „–“.
- **HF-Trimmen bedeutet hier Herzfrequenz-Trimmen:** optional werden je `floor(n × 0,05)` niedrigste und höchste bpm-Werte aus dem HF-Mittel entfernt. Unter 20 HF-Werten wird nichts entfernt. Dies verändert weder RR-Metriken noch Rohdaten und ist kein Filter des spektralen HF-Bands.
- **Atemrate (LF-Näherung):** letzter zusammenhängender plausibler RR-Abschnitt aus dem Fünf-Minuten-Puffer; Zeitachse aus kumulierten RR, lineare Interpolation auf 4 Hz, linearer Trendabzug, Hann-Fenster und Radix-2-FFT. Es werden 256, 512 oder 1024 Samples benutzt (mindestens 64 s, höchstens 256 s). Aktualisierung höchstens alle fünf Sekunden.
- Peak-Suche ausschließlich **0,04–0,15 Hz**, Ausgabe `Peak-Hz × 60` (2,4–9/min). Ohne deutlichen Peak (Leistung mindestens dreimal Bandmedian) oder mit zu wenig zusammenhängenden Daten bleibt der Wert leer. Auflösung: `240 / FFT-Länge` pro Minute. Artefakte, fehlender Sensorkontakt und Datenlücken werden nicht spektral überbrückt; bei veralteten RR wird die Anzeige ausgeblendet.
- **Wesentliche Grenze:** LF-Leistung kann auch Kreislauf-/Baroreflex-Regulation abbilden. Normale schnellere Atmung liegt häufig im HF-Band und wird von dieser LF-Näherung nicht erfasst. Die Zahl ist keine validierte Atemfrequenzmessung.

## Große Live-SDNN-Anzeige (10 Sekunden)

Unter dem Puls erscheint SDNN gleich groß, mit einer Dezimalstelle, Einheit ms und Anzahl der **plausiblen** RR im zeitbasierten 10-s-Fenster. Weniger als fünf Werte ergeben „—“; fünf identische Werte ergeben korrekt „0,0“. Genau zehn Sekunden alte Werte bleiben bis zum Überschreiten der Grenze enthalten. Empfangszeit je RR entspricht dem vorhandenen Paketzeitstempel; mehrere RR eines BLE-Pakets besitzen denselben Zeitstempel.

Der separate Puffer (maximal 2048 Slots) verwendet Welford samt inverser Entfernung: Hinzufügen und Entfernen benötigen je O(1); die Ablaufbereinigung ist amortisiert O(1) pro RR. SDNN ist `sqrt(M2 / (n - 1))`. Kein erneuter Durchlauf über das Live-Fenster pro Schlag. Ein 250-ms-Timer lässt Werte auch ohne neue Notifications auslaufen. Bei Trennen/erneutem Verbindungsversuch wird nur dieser neue Live-Puffer zurückgesetzt.

RR unter 300 oder über 2000 ms sind für diese Anzeige immer ausgeschlossen, unabhängig vom bisherigen Statistikfilter. Stream, Session-Rohwerte, CSV und bestehende Dashboard-Statistik werden dadurch nicht verändert.

Die Auswahl **Roh / Geglättet** betrifft nur die Darstellung. Standard ist „Geglättet“: arithmetischer Mittelwert der letzten drei ungerundeten gültigen SDNN-Fensterwerte, beim Anlauf der verfügbaren ein bis zwei Werte. Neue plausible RR und zeitbedingte Fensteränderungen erzeugen neue Schätzwerte; bloßes Neuzeichnen oder Umschalten erzeugt keine zusätzlichen Schätzwerte. Bei weniger als fünf RR wird auch die Glättungshistorie geleert. Erst der ausgegebene Wert wird auf eine Dezimalstelle gerundet.

**Ultra-Kurzzeit-SDNN über zehn Sekunden ist nicht mit Fünf-Minuten-Standardmessungen vergleichbar.**

## Schritt 2: Orthostatischer Test

1. In Ruhe hinlegen und „Test starten“ drücken. Standard: 60 Sekunden Liegen, anschließend 60 Sekunden Stehen; jede Phase ist auf 15–300 Sekunden konfigurierbar.
2. Countdown abwarten. Nach der Liegephase vorsichtig aufstehen und „Jetzt stehen · Phase starten“ drücken. Die Übergangszeit zählt zu keiner Phase.
3. Nach dem zweiten Countdown erscheinen getrennte RMSSD-/SDNN-Werte und **Delta-RMSSD = Stehen minus Liegen**. Unzureichende Daten ergeben „–“.
4. „Test als Session speichern“ sichert beide Phasen samt Rohwerten. „Test-CSV herunterladen“ funktioniert auch, wenn localStorage nicht verfügbar ist.

Filtereinstellungen werden beim Teststart eingefroren. Pro Phase sind HF, RR und Pakete jeweils auf 2048 Einträge begrenzt. Monotone Zeitgrenzen verhindern, dass verspätete Timer die Stehphase automatisch starten oder spätere Messungen der vorigen Phase zuschlagen. Verbindungs-/Kontaktverlust, RR-Ausfall > fünf Sekunden, Hintergrundbetrieb oder manueller Abbruch beenden einen laufenden Test ohne vollständiges Ergebnis. Kurze Tests sind kein Ersatz für standardisierte medizinische Testprotokolle.

## Schritt 3: Sessions

- Vor dem Aufnehmen optional einen Namen eingeben. **Jeder Start erzeugt eine neue Session**; Stop oder Verbindungsabbruch versucht automatisch, die abgeschlossene Aufnahme zu speichern. Der Button „Session speichern“ erlaubt erneutes Speichern nach einem Fehler.
- Sessions zeigen Name, lokales Datum, Aufnahmedauer und RMSSD-/SDNN-Zusammenfassung. Ortho-Sessions enthalten zusätzlich beide Phasen und deren Delta. Zusammenfassungen verwenden die beim Start eingefrorenen Filter; Rohwerte werden nie gefiltert gespeichert.
- Speicherung unter `polar-h10.sessions.v1` in localStorage: maximal **20 Sessions**, maximal **2.000.000 UTF-16-Zeichen** insgesamt (bis etwa 4 MB Text), maximal **20.000 CSV-Messzeilen je Aufnahme**. Am Aufnahmelimit wird gestoppt; weitere Messwerte bleiben im Live-Dashboard sichtbar. Es werden keine alten Sessions automatisch gelöscht.
- Speicherzugriff, Datenformat und Messwerte werden geprüft. Bei Quoten-/Zugriffsfehlern bleiben bestehende Sessions erhalten und die aktuelle Aufnahme im Speicher zum CSV-Export verfügbar. Neue Aufnahme erst nach erfolgreichem Speichern oder angefordertem CSV-Export. Ein angeforderter Download ist keine Garantie, dass die Datei tatsächlich gesichert wurde.
- Beschädigte oder unbekannte gespeicherte Formate werden **nicht überschrieben**. Die App meldet den Fehler; bestehende Browserdaten gegebenenfalls separat sichern und über die Website-Speichereinstellungen reparieren/löschen. Sessions sind an Browser und Website-Ursprung gebunden; Inkognitomodus, Browserdaten-Löschen und andere Ursprünge können Daten entfernen bzw. unsichtbar machen.
- Löschen verlangt eine Bestätigung und wird erst nach erfolgreichem Schreiben in der Liste sichtbar. Namen werden ausschließlich als Text ausgegeben.
- CSV bleibt kompatibel: `zeitstempel_iso,hf_bpm,rr_ms`, eine Zeile pro RR, ohne RR ein leeres RR-Feld. Werte außerhalb des Plausibilitätsbereichs bleiben enthalten. ISO-Zeit stammt aus `performance.timeOrigin + performance.now()`; monotone Empfangszeiten bleiben zusätzlich in den gespeicherten Session-Ereignissen. Beim gemeinsamen Ortho-CSV stehen die Liegewerte vor den Stehwerten; Phasenmarkierungen bleiben in der Session, die drei CSV-Spalten bleiben unverändert.

## Prüfen

Ohne npm-Installation, mit Node.js:

```sh
node --check app.js
node tests/app.test.cjs
```

Die automatisierten Prüfungen decken GATT-Parsing, fehlerhafte Pakete, Reconnect-Listener, Ringpuffer, Metriken, synthetische LF-Signale, Ortho-Phasengrenzen, Session-Persistenz, Datenvalidierung und Speicherfehler ab. Sie benötigen keinen Sensor.

Zusätzlich wurde die mobile Oberfläche mit Chromium und simuliertem BLE geprüft: Aufnahme/Stop, Wiederladen, Rohdaten-CSV, geführter Ortho-Test samt Delta und Speicherung, Löschen, Quotenfehler und korrupter Speicher. Das ersetzt keinen Hardwaretest.

Manuell am Galaxy S23 + H10 prüfen:

- Verbinden/Trennen/Wiederverbinden, Gerätauswahl abbrechen, Gurtkontakt verlieren und wiederherstellen.
- Mindestens fünf Minuten messen, Statistikfenster und beide Filter umschalten; LF-Näherung nur bei geeigneten Signalen erwarten.
- Ortho-Test mit Standarddauer durchführen; Hintergrundwechsel und Verbindungsabbruch müssen abbrechen.
- Zwei benannte Sessions aufnehmen, Seite neu laden, beide CSVs prüfen, eine Session löschen und erneut laden.

Live-Messwerte und aktive Aufnahme liegen zunächst im Arbeitsspeicher. Beenden des Browserprozesses kann nicht gespeicherte Daten verlieren. Keine Cloud-Synchronisierung und kein medizinisches Diagnosegerät.
