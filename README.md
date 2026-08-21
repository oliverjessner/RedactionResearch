# RedactionResearch

Benötigt Node.js 22.5 oder neuer, da Scanner und Review-App das integrierte SQLite-Modul von Node verwenden.

# Step 1 - Collect

start to collect ~3k redacted pdf links from fragDenStaat (14.08.2026)

```bash
node runs/fragdenstaat/discovery.js
```

Discovery-Ergebnisse und Kandidatenlisten werden unter `output/discovery/` gespeichert.

# Step 2 - download

```bash
node runs/fragdenstaat/download.js --project-id 1
```

Download-Ergebnisse und Download-Fortschritt werden als JSON unter `output/download/` gespeichert. Die PDF-Dateien
liegen projektweise unter `output/download/pdfs/<project_id>/`, für `fragdenstaat.de` also unter
`output/download/pdfs/1/`.

# Step 3 - detect

```bash
npm run scan -- --project fragdenstaat.de
```

Forensische Ergebnisse, Scan-Fortschritt und Fehler werden relational in
`output/forensic/forensic.sqlite` gespeichert. Neue Scans gehören standardmäßig zum Projekt
`fragdenstaat.de`; mit `--project NAME` kann ein anderes Projekt gewählt werden. Der Scanner ermittelt die
zugehörige Projekt-ID aus SQLite und liest die PDFs aus dem entsprechenden Projektordner.

# Step 4 - double check with human

```bash
cd human_in_the_loop
npm install
npm start
```

Anschließend `http://localhost:3000` öffnen. Die App liest Findings direkt aus
`output/forensic/forensic.sqlite` und schreibt Accept-/Skip-Entscheidungen transaktional in dieselbe Datenbank.

Die App startet mit der Projektübersicht. Dort lassen sich Projekte mit Projektname und Organisation anlegen;
der lokale PDF-Ordner wird über einen nativen Ordnerdialog ausgewählt. „PDFs hinzufügen“ importiert die
ausgewählten PDFs nach `output/download/pdfs/<project_id>/`; „Forensic-Run“ scannt nur dieses Projekt im Hintergrund. Über
„Review öffnen“ sind Investigate und Found anschließend auf das ausgewählte Projekt begrenzt. Import- und
Scan-Status werden ebenfalls in SQLite gespeichert.

Discovery und Download verwenden weiterhin ausschließlich ihre JSON-Dateien unter `output/discovery/` und
`output/download/`.

## Offene Funde nach rekonstruiertem Text filtern

Das Batch-Skript verwendet dieselbe Regionsauswertung wie die Review-App. Es speichert oder protokolliert den
rekonstruierten Text nicht. Zuerst einen Dry Run ausführen:

```bash
npm run filter:open
```

Nur Funde, deren nicht-leerer Text ausschließlich aus Unterstrichen und Leerraum besteht, werden mit `--apply`
automatisch als `skipped` gespeichert. Treffer mit mindestens einem Buchstaben oder einer Zahl sowie leere,
nicht auslesbare oder andere reine Symboltreffer bleiben offen:

```bash
npm run filter:open -- --apply
```

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
