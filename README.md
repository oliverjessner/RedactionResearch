# RedactionResearch – lokale Web-App

![RedactionResearch](public/assets/tagline.png)

RedactionResearch prüft PDF-Dokumente darauf, ob geschwärzte Informationen technisch noch vorhanden und
auslesbar sind. Die lokale Web-App erkennt mögliche Schwachstellen, zeigt den Text hinter verdächtigen
Schwärzungen und lässt jeden Fund anschließend von einem Menschen bestätigen oder überspringen.

Alle PDFs, Analyseergebnisse und Review-Entscheidungen bleiben lokal auf dem Computer.

## Voraussetzungen

- Node.js 22.5 oder neuer
- Ein lokaler Ordner mit PDF-Dateien

## Installation und Start

```bash
npm install
npm link
RedactionResearch
```

Danach im Browser öffnen:

```text
http://127.0.0.1:3000/
```

Einen anderen Port festlegen:

```bash
RedactionResearch --port 4000
```

`RedactionResearch --help` zeigt alle verfügbaren Optionen. Alternativ funktioniert der bisherige Start mit
`npm start` weiterhin.

Nach Änderungen an der App muss der Server neu gestartet und die Seite neu geladen werden.

## Repository-Struktur

```text
server.js       Lokaler Webserver und API
forensic.mjs    PDF-Scanner
public/         Benutzeroberfläche
lib/            Gemeinsame SQLite- und PDF-Funktionen
test/           Automatisierte Tests
package.json    Installation und alle Befehle
```

## Projekt anlegen

Die App startet in der Ansicht **Projekte**.

1. Einen eindeutigen Projektnamen eingeben.
2. Optional die Organisation oder Quelle angeben.
3. **Ordner auswählen** anklicken und den lokalen Ordner mit den PDFs auswählen.
4. **Anlegen & importieren** anklicken.

Die App berücksichtigt ausschließlich PDF-Dateien und importiert sie in einen eigenen Projektordner:

```text
output/download/pdfs/<project_id>/
```

Gleichnamige, aber unterschiedliche PDFs werden nicht überschrieben. Bereits vorhandene identische Dateien
werden übersprungen.

Über **PDFs hinzufügen** können später weitere PDFs in ein bestehendes Projekt importiert werden.

Über **Projekt löschen** wird das Projekt nach einer Bestätigung aus SQLite entfernt. Dabei werden auch alle
zugehörigen Dokumenteinträge, Findings, Review-Entscheidungen, Scan-Zustände und Job-Verläufe gelöscht. Die
PDF-Dateien auf der Festplatte bleiben erhalten. Projekte mit einem laufenden Import oder Scan können nicht
gelöscht werden.

## Forensic-Run

**Forensic-Run** startet die technische Untersuchung aller noch nicht erfolgreich gescannten PDFs des Projekts.

### Erkannte mögliche Schwachstellen

- `REDACTION_ANNOTATION_WITH_LIVE_TEXT`: Eine echte PDF-Redaction-Annotation liegt über weiterhin
  maschinenlesbarem Text.
- `DARK_ANNOTATION_OVER_LIVE_TEXT`: Eine dunkle Square-, Stamp-, FreeText- oder Ink-Annotation überdeckt
  weiterhin vorhandenen Text.
- `ANNOTATION_OVERLAY_HIDES_LIVE_TEXT`: Ein Annotation-Overlay verdeckt Text; beim Rendern ohne Annotationen
  verschwindet die dunkle Fläche.
- `DARK_PAGE_CONTENT_HIDES_LIVE_TEXT`: Ein schwarzes Seitenobjekt, Rechteck oder Bild liegt über
  weiterhin vorhandenem Text.
- `LIVE_TEXT_NOT_VISIBLE_ON_WHITE_REGION`: Text ist technisch vorhanden, wird aber auf einer nahezu weißen
  Fläche nicht sichtbar dargestellt.
- `FORM_FIELD_VALUES_REMAIN_MACHINE_READABLE`: Ausgefüllte Formularfelder enthalten weiterhin auslesbare
  Werte.
- `SENSITIVE_PATTERN_IN_PDF_METADATA`: PDF- oder XMP-Metadaten enthalten ein erkanntes Muster für eine
  E-Mail-Adresse, IBAN oder österreichische beziehungsweise deutsche Telefonnummer.
- `SENSITIVE_PATTERN_IN_BOOKMARK_OUTLINE`: Titel in der Lesezeichenstruktur enthalten eines dieser sensiblen
  Muster.
- `SUSPICIOUS_EMBEDDED_ATTACHMENT`: Ein eingebetteter Anhang besitzt einen verdächtigen Namen wie
  „ungeschwärzt“, „unredacted“, „original“, „raw“, „source“ oder „backup“.
- `INCREMENTAL_PDF_REVISIONS_PRESENT`: Das PDF enthält frühere inkrementelle Revisionen, in denen alte Inhalte
  fortbestehen könnten. Revisionen allein sind noch kein Beweis für ein Datenleck.

### Zusätzliche Warnsignale

Diese Merkmale werden als Kontext gespeichert und erhöhen nicht automatisch den Status zu einem tatsächlichen
Problem:

- `OPTIONAL_CONTENT_LAYERS_PRESENT`: Das PDF enthält optionale oder ausblendbare Ebenen.
- `EMBEDDED_ATTACHMENTS_PRESENT`: Das PDF enthält eingebettete Dateien oder Anhänge.
- `FORM_FIELDS_WITH_VALUES_PRESENT`: Das PDF enthält ausgefüllte Formularfelder.
- `INCREMENTAL_PDF_REVISIONS_PRESENT`: Das PDF enthält mehrere Revisionen oder Verweise auf frühere
  Dokumentstände. Digitale Signaturen werden dabei als möglicher legitimer Grund berücksichtigt.

Bei E-Mail-Adressen, IBANs und Telefonnummern speichert der Scanner nur die erkannte Datenkategorie, nicht den
gefundenen Inhalt.

Der Fortschritt erscheint direkt auf der Projektkarte. Bereits erfolgreich gescannte PDFs werden
übersprungen. Nach dem Scan rekonstruiert die App den Text in allen offenen Fundregionen. Findings, deren
Regionen ausschließlich Unterstriche und Leerraum enthalten, werden automatisch als **Skip** markiert. Leere
Regionen, andere Symbole sowie Inhalte mit mindestens einem Buchstaben oder einer Zahl bleiben zur manuellen
Prüfung offen. Der Run bestätigt keine Funde automatisch.

## Investigate

Über **Review öffnen** gelangt man zu den offenen Verdachtsfällen des Projekts.

Die Ansicht zeigt:

- das PDF mit scrollbaren Seiten und auswählbarer Textschicht;
- die betroffene Seite und erkannte Regionen;
- den rekonstruierten Text hinter einer möglichen Schwärzung;
- PDF-Metadaten mit hervorgehobenen E-Mail-Adressen;
- Risk Score, Severity und technische Evidence;
- alle weiteren Funde im aktuellen PDF.

Entscheidungen:

- **Accept** bestätigt einen tatsächlichen problematischen Fund.
- **Skip** markiert den Fund als nicht relevant.

Bereits entschiedene Funde erscheinen nach einem Neuladen nicht erneut unter Investigate. Die Anzeige
**Noch offen** zeigt, wie viele Funde noch geprüft werden müssen.

## Found

Die Ansicht **Found** enthält ausschließlich bestätigte Funde. Zuerst wird eine Übersicht der betroffenen
Dokumente angezeigt. Von dort kann jedes Dokument mit seinen bestätigten Fundstellen geöffnet werden.

Das zugehörige Projekt wird bei jedem bestätigten Dokument angezeigt.

## Skipped

Die Ansicht **Skipped** enthält alle manuell oder automatisch übersprungenen Funde. Wie bei Found erscheint
zuerst eine Übersicht der betroffenen Dokumente. Von dort lassen sich die übersprungenen Fundstellen erneut im
PDF-Viewer öffnen und vollständig untersuchen. Das bloße Ansehen verändert die gespeicherte Entscheidung nicht.

## Lokale Datenspeicherung

Die Web-App speichert ihre Daten an zwei Stellen:

```text
output/download/pdfs/<project_id>/
output/forensic/forensic.sqlite
```

SQLite enthält unter anderem:

- Projekte und Projektkonfigurationen;
- gescannte Dokumente;
- technische Findings und Scanfehler;
- Import- und Scanfortschritt;
- Accept- und Skip-Entscheidungen.

Der rekonstruierte Text und ausgelesene PDF-Inhalte werden nur lokal angezeigt und nicht als Review-Text
gespeichert.

## Bedienung

- Mit dem Mausrad kann durch das gesamte PDF gescrollt werden.
- Text im PDF kann markiert und kopiert werden.
- Ein Klick auf einen Fund springt zur betroffenen PDF-Seite.
- Koordinaten wie `[51.02, 373.88, 140.66, 388.13]` können im Viewer als Box eingezeichnet werden.
- In Investigate bestätigt die Taste `A` den aktuellen Fund und `S` überspringt ihn.

## Tests

Im Projektverzeichnis ausführen:

```bash
npm test
```
