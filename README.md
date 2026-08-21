# RedactionResearch – lokale Web-App

![](/human_in_the_loop/public/assets/tagline.png)

RedactionResearch prüft PDF-Dokumente darauf, ob geschwärzte Informationen technisch noch vorhanden und
auslesbar sind. Die lokale Web-App erkennt mögliche Schwachstellen, zeigt den Text hinter verdächtigen
Schwärzungen und lässt jeden Fund anschließend von einem Menschen bestätigen oder überspringen.

Alle PDFs, Analyseergebnisse und Review-Entscheidungen bleiben lokal auf dem Computer.

## Voraussetzungen

- Node.js 22.5 oder neuer
- Ein lokaler Ordner mit PDF-Dateien

## Installation und Start

```bash
cd human_in_the_loop
npm install
npm start
```

Danach im Browser öffnen:

```text
http://127.0.0.1:3000/
```

Nach Änderungen an der App muss der Server neu gestartet und die Seite neu geladen werden.

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

## Forensic-Run

**Forensic-Run** startet die technische Untersuchung aller noch nicht erfolgreich gescannten PDFs des Projekts.

Der Scanner sucht unter anderem nach:

- sichtbaren Schwärzungsflächen, hinter denen Text erhalten geblieben ist;
- unsichtbarem, weißem oder außerhalb der Seite positioniertem Text;
- PDF-Redaction-Annotationen und verdächtigen Overlays;
- sensiblen Informationen in PDF-Metadaten;
- verdächtigen eingebetteten Dateien oder Anhängen;
- weiteren strukturellen und visuellen Hinweisen auf unvollständige Schwärzungen.

Der Fortschritt erscheint direkt auf der Projektkarte. Bereits erfolgreich gescannte PDFs werden
übersprungen. Der Run bestätigt keine Funde automatisch.

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
