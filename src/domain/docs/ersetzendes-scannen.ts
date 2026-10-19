/**
 * Verfahrensdokumentation module „Ersetzendes Scannen“ (F06 VOU-125, GOBD-08, GOBD-10; BMF GoBD Rz. 136 ff.,
 * Muster-Verfahrensdokumentation „Belegablage“ der Bundessteuerberaterkammer/DStV as orientation).
 *
 * Generated from the settings: who scans, when, what, how the capture is secured (hash, metadata, renditions),
 * quality control („vollständig geprüft“), destruction rules and storage. The owner completes what the software cannot
 * know (devices, physical archive) in the free-text part. Pure; `today` passed in.
 */
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import type { DocChapter } from "./zugriffskonzept";

export interface ScanningProcedureInput {
  today: string;
  companyName: string;
  /** Persons who capture receipts (members with write access). */
  responsible: readonly string[];
  /** Capture channels in use. */
  channels: readonly ("upload" | "email" | "app" | "api" | "mcp")[];
  /** Days within which receipts are captured (GoBD: zeitnah, default 10). */
  captureWithinDays: number;
  /** Whether paper originals may be destroyed after the check (owner decision; default false). */
  paperDestructionAllowed: boolean;
  /** Retention of booked vouchers (years). */
  retentionYears: number;
  /** Where originals are stored. */
  storage: string;
  /** Free text from the owner (devices, physical archive). */
  ownerNotes?: string;
}

const CHANNEL_DE: Record<ScanningProcedureInput["channels"][number], string> = {
  upload: "Hochladen im Browser (Datei, Ordner, Drag & Drop)",
  email: "E-Mail-Eingang (belege@…, Rohnachricht wird archiviert)",
  app: "Smartphone-Kamera und Teilen-Funktion der App (PWA)",
  api: "REST-API mit API-Schlüssel",
  mcp: "MCP-Schnittstelle (KI-Assistent mit Schlüssel)",
};

export function ersetzendesScannen(i: ScanningProcedureInput): DocChapter {
  const who = i.responsible.length > 0 ? i.responsible.join(", ") : "der Inhaber";
  return {
    title: "Ersetzendes Scannen und Belegerfassung",
    stand: formatGermanDate(i.today as CalendarDate),
    sections: [
      {
        heading: "Geltungsbereich",
        paragraphs: [
          `Dieses Kapitel beschreibt, wie ${i.companyName} Eingangsbelege (Rechnungen, Quittungen, Kassenbons, Zollbescheide) erfasst, digitalisiert und aufbewahrt. Es gilt für Papierbelege, die gescannt oder fotografiert werden, und für elektronisch empfangene Belege (PDF, XRechnung, ZUGFeRD).`,
        ],
      },
      {
        heading: "Zuständigkeit",
        paragraphs: [
          `Belege erfassen: ${who}. Die Freigabe von Bewirtungs- und Eigenbelegen erfolgt persönlich durch angemeldete Mitglieder; API- und MCP-Schlüssel können Belege hochladen, aber nicht freigeben.`,
        ],
      },
      {
        heading: "Zeitpunkt",
        paragraphs: [
          `Belege werden zeitnah, spätestens ${i.captureWithinDays} Tage nach Eingang, erfasst. Unbearbeitete Belege älter als 10 Tage erscheinen als Aufgabe („Unbearbeitet > 10 Tage“). Barzahlungen werden am Tag der Zahlung erfasst (§ 146 Abs. 1 S. 2 AO).`,
        ],
      },
      {
        heading: "Erfassungswege",
        paragraphs: ["Folgende Wege sind eingerichtet:"],
        table: { head: ["Weg"], rows: i.channels.map((c) => [CHANNEL_DE[c]]) },
      },
      {
        heading: "Sicherung bei der Erfassung",
        paragraphs: [
          "Beim Hochladen berechnet das System den SHA-256-Hashwert der unveränderten Datei und speichert ihn mit Dateiname, Dateityp (anhand des Dateiinhalts erkannt), Größe, Seitenzahl, Erfassungszeitpunkt (Server), ggf. Aufnahmezeitpunkt des Geräts, Erfassungsweg und erfassender Person.",
          "Das Original wird nie verändert. Vorschaubilder, zugeschnittene oder gedrehte Bilder, Umwandlungen (z. B. HEIC → JPEG), zusammengefügte PDFs und erkannter Text werden als gesonderte Darstellungen (Renditionen) gespeichert und als solche gekennzeichnet.",
          "Muss eine Datei ersetzt werden (z. B. unleserlicher Scan), wird die neue Datei zusätzlich gespeichert; die alte Datei und ihr Hashwert bleiben abrufbar. Nach der Buchung ist dafür ein Grund anzugeben, nach der Festschreibung sind nur Ergänzungen möglich.",
          "Ein nächtlicher Prüflauf berechnet die Hashwerte aller Originale neu und meldet Abweichungen.",
        ],
      },
      {
        heading: "Qualitätskontrolle",
        paragraphs: [
          "Nach der Erfassung wird jeder digitalisierte Papierbeleg visuell mit dem Original verglichen (Lesbarkeit, Vollständigkeit aller Seiten, Vorder- und Rückseite). Die Prüfung wird am Beleg mit „Vollständig geprüft“ (Person und Zeitpunkt) bestätigt.",
        ],
      },
      {
        heading: "Vernichtung der Papierbelege",
        paragraphs: [
          i.paperDestructionAllowed
            ? "Papierbelege dürfen erst vernichtet werden, wenn der Beleg als „vollständig geprüft“ markiert ist und kein Ausschluss besteht (z. B. Zollbescheide mit Originalerfordernis, Belege in laufenden Prüfungen oder Rechtsstreitigkeiten). Die Liste „Papier vernichtbar“ zeigt die freigegebenen Belege."
            : "Papierbelege werden derzeit nicht vernichtet, sondern zusätzlich zur digitalen Fassung aufbewahrt.",
        ],
      },
      {
        heading: "Aufbewahrung",
        paragraphs: [
          `Belege werden ${i.retentionYears} Jahre ab Ende des Kalenderjahres aufbewahrt (§ 147 AO, § 14b UStG). Speicherort: ${i.storage}. Gebuchte Belege und ihre Dateien können nicht gelöscht werden; Korrekturen erfolgen über Storno oder neue Fassungen.`,
        ],
      },
      ...(i.ownerNotes?.trim() ? [{ heading: "Ergänzungen des Unternehmers", paragraphs: [i.ownerNotes.trim()] }] : []),
    ],
  };
}
