/**
 * F09 EXP-001…004 / DATEV-01: DATEV EXTF writer (header version 700). Pure: header line (§4.1.1), column header line
 * (§4.1.2), data lines with every column of the format version in order, `;` separator, CRLF, text fields in `"`
 * with `"` doubled, numbers with decimal comma and no thousands separator, Windows-1252 bytes.
 */
import { type AnsiResult, encodeCp1252 } from "../csv/cp1252";
import { type BookingFormatVersion, bookingColumns, DEBITOREN_KREDITOREN_V5 } from "./columns";

/** A cell: text (quoted), raw (unquoted: numbers, dates, keys) or empty. */
export type ExtfCell = { t: string } | { r: string } | null | undefined;
export const txt = (s: string | null | undefined): ExtfCell =>
  s === null || s === undefined || s === "" ? null : { t: s };
export const raw = (s: string | number | null | undefined): ExtfCell =>
  s === null || s === undefined || s === "" ? null : { r: String(s) };

function cell(c: ExtfCell): string {
  if (!c) return "";
  if ("t" in c) return `"${c.t.replace(/"/g, '""')}"`;
  return c.r;
}

export const extfLine = (cells: readonly ExtfCell[]): string => cells.map(cell).join(";");

/** Integer cents → "1234,56" (always positive in DATEV; the sign is the Soll/Haben-Kennzeichen). */
export function extfAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`amount must be integer cents: ${cents}`);
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

const ymd = (iso: string) => iso.replaceAll("-", "");
/** "2026-03-05" → "0503" (Belegdatum). */
export const ttmm = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}`;
/** "2026-03-05" → "05032026" (Leistungsdatum, Fälligkeit, Datum Zuord. Steuerperiode). */
export const ttmmjjjj = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
/** "2026-03-05" → "050326" (Belegfeld 2 as due date for OPOS). */
export const ttmmjj = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;

export interface ExtfHeader {
  category: 21 | 16;
  formatName: "Buchungsstapel" | "Debitoren/Kreditoren";
  formatVersion: number;
  /** "YYYYMMDDHHMMSSFFF" (Europe/Berlin). */
  createdAt: string;
  /** Exportiert von (company short name). */
  exportedBy: string;
  consultantNumber: number;
  clientNumber: number;
  /** "YYYY-MM-DD" first day of the fiscal year. */
  fiscalYearStart: string;
  accountLength: number;
  /** Booking batches only. */
  from?: string;
  to?: string;
  /** ≤ 30 characters (booking batches only). */
  description?: string;
  dictationCode?: string;
  festschreibung?: 0 | 1;
  chart: "SKR03" | "SKR04";
}

/** Header line (§4.1.1, 31 fields). */
export function extfHeaderLine(h: ExtfHeader): string {
  const booking = h.category === 21;
  return extfLine([
    txt("EXTF"),
    raw(700),
    raw(h.category),
    txt(h.formatName),
    raw(h.formatVersion),
    raw(h.createdAt),
    null, // Importiert
    txt("RE"), // Herkunft ⚠ (2 characters, replaced by DATEV on import)
    txt(h.exportedBy.slice(0, 25)),
    null, // Importiert von
    raw(h.consultantNumber),
    raw(h.clientNumber),
    raw(ymd(h.fiscalYearStart)),
    raw(h.accountLength),
    booking && h.from ? raw(ymd(h.from)) : null,
    booking && h.to ? raw(ymd(h.to)) : null,
    booking ? txt((h.description ?? "").slice(0, 30)) : null,
    txt(h.dictationCode?.slice(0, 2)),
    booking ? raw(1) : null, // Buchungstyp 1 = Finanzbuchführung
    booking ? raw(0) : null, // Rechnungslegungszweck
    booking ? raw(h.festschreibung ?? 0) : null,
    booking ? txt("EUR") : null,
    null, // reserviert
    null, // Derivatskennzeichen
    null, // reserviert
    null, // reserviert
    txt(h.chart === "SKR04" ? "04" : "03"),
    null, // ID der Branchenlösung
    null, // reserviert
    null, // reserviert
    null, // Anwendungsinformation
  ]);
}

/** A data row: column name → cell (columns not named stay empty). */
export type ExtfRow = Readonly<Record<string, ExtfCell>>;

export function extfRowLine(columns: readonly string[], row: ExtfRow): string {
  return extfLine(columns.map((name) => row[name]));
}

export interface ExtfFile {
  text: string;
  encoded: AnsiResult;
}

function file(header: string, columns: readonly string[], rows: readonly ExtfRow[]): ExtfFile {
  const text = `${[header, extfLine(columns.map((c) => txt(c))), ...rows.map((r) => extfRowLine(columns, r))].join("\r\n")}\r\n`;
  return { text, encoded: encodeCp1252(text) };
}

export function buchungsstapelFile(h: ExtfHeader, version: BookingFormatVersion, rows: readonly ExtfRow[]): ExtfFile {
  return file(
    extfHeaderLine({ ...h, category: 21, formatName: "Buchungsstapel", formatVersion: version }),
    bookingColumns(version),
    rows,
  );
}

export function debitorenKreditorenFile(h: ExtfHeader, rows: readonly ExtfRow[]): ExtfFile {
  return file(
    extfHeaderLine({ ...h, category: 16, formatName: "Debitoren/Kreditoren", formatVersion: 5 }),
    DEBITOREN_KREDITOREN_V5,
    rows,
  );
}

/** EXP-003: `EXTF_Buchungsstapel_<YYYYMMDD from>_<YYYYMMDD to>.csv` (+ `_<n>` for repeats). */
export function buchungsstapelFileName(from: string, to: string, repeat = 0): string {
  return `EXTF_Buchungsstapel_${ymd(from)}_${ymd(to)}${repeat > 0 ? `_${repeat + 1}` : ""}.csv`;
}

/** E-EXP-02: a range crossing a fiscal year is split into one range per fiscal year. */
export function splitByFiscalYear(
  from: string,
  to: string,
  startMonth: number,
): { from: string; to: string; fiscalYearStart: string }[] {
  const out: { from: string; to: string; fiscalYearStart: string }[] = [];
  let cur = from;
  while (cur <= to) {
    const y = Number(cur.slice(0, 4));
    const m = Number(cur.slice(5, 7));
    const fyStartYear = m >= startMonth ? y : y - 1;
    const fyStart = `${fyStartYear}-${String(startMonth).padStart(2, "0")}-01`;
    const nextStartYear = fyStartYear + 1;
    const nextStart = `${nextStartYear}-${String(startMonth).padStart(2, "0")}-01`;
    const fyEnd = previousDay(nextStart);
    const end = fyEnd < to ? fyEnd : to;
    out.push({ from: cur, to: end, fiscalYearStart: fyStart });
    cur = nextStart;
  }
  return out;
}

function previousDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** "YYYYMMDDHHMMSSFFF" in Europe/Berlin. */
export function extfTimestamp(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}${String(ms % 1000).padStart(3, "0")}`;
}
