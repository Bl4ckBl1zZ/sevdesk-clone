/**
 * Timesheet / Leistungsnachweis (F11 PRJ-014). Pure: builds the section model of the PDF from the frozen entries
 * of a finalised invoice (date, description, duration, rounded duration, optionally rate and amount) with the
 * invoice number and period. Rendered to PDF/A-3b by the generic section renderer (src/pdf/import-protocol.tsx —
 * same fonts and reproducible bytes) and archived as `documentArtifacts.kind = "timesheet_pdf"`.
 */
import { formatCents, formatMicros } from "../money";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { exactTimeNetCents } from "./invoicing";
import { formatMinutes, periodLabel } from "./time-entries";

export interface TimesheetEntry {
  readonly date: CalendarDate;
  readonly description: string;
  readonly durationMinutes: number;
  /** Rounded at invoicing (PRJ-009); absent with „pro Gruppe runden“ → the raw duration. */
  readonly roundedMinutes?: number | undefined;
  readonly hourlyRateMicros: number;
}

export interface TimesheetInput {
  readonly invoiceNumber: string;
  readonly documentDate: CalendarDate;
  readonly sellerName: string;
  readonly customerName: string;
  readonly projectLabel?: string | undefined;
  readonly entries: readonly TimesheetEntry[];
  /** Show rate and amount columns (default true). */
  readonly showRates?: boolean | undefined;
  /** Finalisation instant: the PDF creation date (reproducible bytes). */
  readonly createdAt: number;
}

export interface TimesheetModel {
  readonly title: string;
  readonly subtitle: string;
  readonly fileName: string;
  readonly createdAt: number;
  readonly sections: {
    title: string;
    paragraphs?: string[];
    table?: { headers: string[]; rows: string[][]; widths: number[] };
  }[];
  readonly footer: string;
  readonly totals: { readonly minutes: number; readonly roundedMinutes: number; readonly amountCents: number };
}

const rounded = (e: TimesheetEntry) => e.roundedMinutes ?? e.durationMinutes;

export function buildTimesheet(input: TimesheetInput): TimesheetModel {
  const entries = [...input.entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const showRates = input.showRates !== false;
  const dates = entries.map((e) => e.date);
  const from = dates[0] ?? input.documentDate;
  const to = dates.at(-1) ?? input.documentDate;
  const totals = entries.reduce(
    (t, e) => ({
      minutes: t.minutes + e.durationMinutes,
      roundedMinutes: t.roundedMinutes + rounded(e),
      amountCents: t.amountCents + exactTimeNetCents(rounded(e), e.hourlyRateMicros),
    }),
    { minutes: 0, roundedMinutes: 0, amountCents: 0 },
  );
  const headers = ["Datum", "Tätigkeit", "Dauer", "Abgerechnet", ...(showRates ? ["Satz", "Betrag"] : [])];
  const widths = showRates ? [11, 45, 10, 12, 10, 12] : [12, 60, 13, 15];
  const rows = entries.map((e) => [
    formatGermanDate(e.date),
    e.description,
    formatMinutes(e.durationMinutes),
    formatMinutes(rounded(e)),
    ...(showRates
      ? [
          `${formatMicros(e.hourlyRateMicros)} €/h`,
          `${formatCents(exactTimeNetCents(rounded(e), e.hourlyRateMicros))} €`,
        ]
      : []),
  ]);
  rows.push([
    "",
    "Summe",
    formatMinutes(totals.minutes),
    formatMinutes(totals.roundedMinutes),
    ...(showRates ? ["", `${formatCents(totals.amountCents)} €`] : []),
  ]);
  const period = periodLabel(from, to);
  return {
    title: `Leistungsnachweis zur Rechnung ${input.invoiceNumber}`,
    subtitle: `${input.sellerName} · Kunde: ${input.customerName} · Leistungszeitraum ${period}`,
    fileName: `Leistungsnachweis_${input.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`,
    createdAt: input.createdAt,
    sections: [
      {
        title: "Angaben",
        paragraphs: [
          `Rechnung ${input.invoiceNumber} vom ${formatGermanDate(input.documentDate)}`,
          `Leistungszeitraum: ${period}`,
          ...(input.projectLabel ? [`Projekt: ${input.projectLabel}`] : []),
          `${entries.length} Zeiteinträge`,
        ],
      },
      { title: "Erfasste Zeiten", table: { headers, rows, widths } },
    ],
    footer: `Anlage zur Rechnung ${input.invoiceNumber} · erstellt aus den abgerechneten Zeiteinträgen`,
    totals,
  };
}
