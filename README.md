# RedactionResearch

# Step 1 - Collect

start to collect ~3k redacted pdf links from fragDenStaat (14.08.2026)

```bash
node discovery.js
```

Discovery-Ergebnisse und Kandidatenlisten werden unter `output/discovery/` gespeichert.

# Step 2 - download

```bash
node download.js
```

Downloads, Download-Ergebnisse und Download-Fortschritt werden unter `output/download/` gespeichert.

# Step 3 - detect

```bash
node forensic.mjs
```

Forensische Ergebnisse und Scan-Fortschritt werden unter `output/forensic/` gespeichert.

# Step 4 - double check with human

```bash
cd human_in_the_loop
npm install
npm start
```

Anschließend `http://localhost:3000` öffnen. Menschlich bestätigte Funde und Review-Fortschritt werden unter
`output/forensic/` gespeichert.

## Problems

- Schwarzer Balken über weiterhin vorhandenem Text
- Schwarzes Bild über weiterhin vorhandenem Text
- Weiße Fläche über weiterhin vorhandenem Text
- Weißer Text auf weißem Hintergrund
- Transparenter/unsichtbarer Text bleibt erhalten
- PDF-Annotation statt echter Redaction
- Redaction-Markierung vorhanden, aber nicht "applied"
- Versteckte PDF-Layer enthalten Originaltext
- Clip-Masken verstecken Text nur visuell
- Text außerhalb des sichtbaren Seitenbereichs
- Überlagerte Objekte lassen Originalinhalt bestehen
- Formularfelder enthalten ungeschwärzte Werte
- Kommentare/Notizen enthalten sensible Informationen
- PDF-Metadaten enthalten sensible Informationen
- Eingebettete Dateien enthalten Originaldaten
- Anhänge im PDF enthalten ungeschwärzte Fassungen
- Alte Revisionen/Versionen bleiben eingebettet
- OCR-Text unter geschwärztem Scan bleibt erhalten
- Text lässt sich trotz Schwärzung kopieren
- Text lässt sich über Suche weiterhin finden
- Links/URLs enthalten geschwärzte Informationen
- Lesezeichen/Outline enthalten geschwärzte Informationen
- Dateiname enthält sensible Informationen
- Bildmetadaten enthalten sensible Informationen
- Teilweise Schwärzung: einzelne Zeichen/Wörter bleiben sichtbar
- Zu kurze Schwärzungsfläche
- Verschobene Schwärzungsfläche
- Schwärzung nur auf einer von mehreren identischen Stellen
- Kopf-/Fußzeile bleibt ungeschwärzt
- Wiederholung derselben Information an anderer Stelle
- Tabellen-/Excel-Inhalte nur optisch ausgeblendet
- Versteckte Tabellenzeilen/-spalten bleiben vorhanden
- Änderungsverfolgung enthält ursprünglichen Inhalt
- Dokumentkommentare enthalten ursprünglichen Inhalt
- Text unter eingebetteten Screenshots/Bildern bleibt vorhanden
- Vorschaubild/Thumbnail zeigt ungeschwärzte Version
- Signaturdaten/Zertifikatsinformationen verraten geschwärzte Angaben
