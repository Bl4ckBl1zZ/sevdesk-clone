/**
 * CSV reading and writing for imports and exports (F02 CON-140/143, F03 PRD-080/085, GOBD-03). Pure: bytes in, rows
 * out. Encoding detection (UTF-8 with/without BOM, Windows-1252, ISO-8859-15), separator detection (`;`, `,`, tab),
 * RFC 4180 quoting; exports are UTF-8 with BOM and `;`.
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export type CsvEncoding = "utf-8" | "windows-1252" | "iso-8859-15";
export type CsvSeparator = ";" | "," | "\t";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 20_000;

const IMPORT_ENCODING_MESSAGE = "Die Zeichenkodierung konnte nicht erkannt werden. Bitte als UTF-8 speichern.";

/** Detects the encoding of `bytes` (BOM, strict UTF-8, then the two Latin code pages). */
export function detectEncoding(bytes: Uint8Array): Result<CsvEncoding, Issue<"IMPORT_ENCODING">> {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return err(issue("IMPORT_ENCODING", IMPORT_ENCODING_MESSAGE));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return ok("utf-8");
  let nul = 0;
  for (const b of bytes.subarray(0, 4096)) if (b === 0) nul++;
  if (nul > 0) return err(issue("IMPORT_ENCODING", IMPORT_ENCODING_MESSAGE));
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return ok("utf-8");
  } catch {
    // not UTF-8
  }
  // 0x80–0x9F are printable in Windows-1252 (€, „, “, …) but control characters in ISO-8859-15.
  let c1 = false;
  let euro15 = false;
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) c1 = true;
    if (b === 0xa4) euro15 = true;
  }
  return ok(!c1 && euro15 ? "iso-8859-15" : "windows-1252");
}

export function decodeCsv(
  bytes: Uint8Array,
): Result<{ text: string; encoding: CsvEncoding }, Issue<"IMPORT_ENCODING">> {
  const enc = detectEncoding(bytes);
  if (!enc.ok) return enc;
  let text = new TextDecoder(enc.value).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return ok({ text, encoding: enc.value });
}

/** Separator of the header line: the most frequent of `;`, `,`, tab outside quotes (ties prefer `;`). */
export function detectSeparator(text: string): CsvSeparator {
  const counts: Record<CsvSeparator, number> = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && (ch === ";" || ch === "," || ch === "\t")) counts[ch]++;
  }
  const order: CsvSeparator[] = [";", "\t", ","];
  return order.reduce((best, s) => (counts[s] > counts[best] ? s : best), ";" as CsvSeparator);
}

/** One CSV record with the physical file line it starts on (1-based; quoted line breaks span several lines). */
export interface CsvRecord {
  readonly line: number;
  readonly cells: string[];
}

/**
 * RFC 4180 parser (quotes, doubled quotes, CRLF/LF, separators inside quotes) that keeps the file line of every
 * record, so row errors can name the line the user sees in an editor (F09 E-IMP-16). Blank lines are dropped.
 */
export function parseCsvRecords(text: string, separator: CsvSeparator = detectSeparator(text)): CsvRecord[] {
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const push = () => {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) records.push({ line: start, cells: row });
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push();
      line++;
      start = line;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) push();
  return records;
}

/** RFC 4180 parser (quotes, doubled quotes, CRLF/LF, separators inside quotes). Empty trailing lines are dropped. */
export function parseCsv(text: string, separator: CsvSeparator = detectSeparator(text)): string[][] {
  return parseCsvRecords(text, separator).map((r) => r.cells);
}

export interface CsvTable {
  readonly headers: string[];
  readonly rows: string[][];
  readonly encoding: CsvEncoding;
  readonly separator: CsvSeparator;
}

/** Bytes → header + rows with the size limits of CON-140 / PRD-080 (`IMPORT_TOO_LARGE`). */
export function readCsv(
  bytes: Uint8Array,
): Result<CsvTable, Issue<"IMPORT_ENCODING" | "IMPORT_TOO_LARGE" | "IMPORT_EMPTY">> {
  const tooLarge = issue("IMPORT_TOO_LARGE", "Die Datei ist zu groß (max. 10 MB bzw. 20.000 Zeilen).");
  if (bytes.length > IMPORT_MAX_BYTES) return err(tooLarge);
  const decoded = decodeCsv(bytes);
  if (!decoded.ok) return decoded;
  const separator = detectSeparator(decoded.value.text);
  const all = parseCsv(decoded.value.text, separator);
  const [headers, ...rows] = all;
  if (!headers) return err(issue("IMPORT_EMPTY", "Die Datei enthält keine Daten."));
  if (rows.length > IMPORT_MAX_ROWS) return err(tooLarge);
  return ok({ headers: headers.map((h) => h.trim()), rows, encoding: decoded.value.encoding, separator });
}

export interface CsvRecordTable {
  readonly headers: string[];
  /** Data records with their file line (the header is line 1 unless blank lines precede it). */
  readonly records: CsvRecord[];
  readonly encoding: CsvEncoding;
  readonly separator: CsvSeparator;
}

/** Like `readCsv`, but keeps the file line of every data record (F09 import preview, E-IMP-16). */
export function readCsvRecords(
  bytes: Uint8Array,
): Result<CsvRecordTable, Issue<"IMPORT_ENCODING" | "IMPORT_TOO_LARGE" | "IMPORT_EMPTY">> {
  const tooLarge = issue("IMPORT_TOO_LARGE", "Die Datei ist zu groß (max. 10 MB bzw. 20.000 Zeilen).");
  if (bytes.length > IMPORT_MAX_BYTES) return err(tooLarge);
  const decoded = decodeCsv(bytes);
  if (!decoded.ok) return decoded;
  const separator = detectSeparator(decoded.value.text);
  const [header, ...records] = parseCsvRecords(decoded.value.text, separator);
  if (!header) return err(issue("IMPORT_EMPTY", "Die Datei enthält keine Daten."));
  if (records.length > IMPORT_MAX_ROWS) return err(tooLarge);
  return ok({ headers: header.cells.map((h) => h.trim()), records, encoding: decoded.value.encoding, separator });
}

const needsQuotes = (v: string, sep: string) => v.includes(sep) || /["\r\n]/.test(v) || /^\s|\s$/.test(v);

/** Formula injection guard for spreadsheet apps (=, +, -, @ at the start of a text cell). */
function guardFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) && !/^-?\d+([.,]\d+)?$/.test(v) ? `'${v}` : v;
}

/** CON-143 / PRD-085: UTF-8 with BOM, `;`, CRLF. */
export function writeCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  const sep = ";";
  const cell = (v: string | number | null | undefined) => {
    const s = guardFormula(v === null || v === undefined ? "" : String(v));
    return needsQuotes(s, sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(sep)).join("\r\n")}\r\n`;
}

/** SHA-256 is computed by the caller (WebCrypto is async and not "pure"); this builds the idempotency key. */
export const importRowKey = (fileSha256: string, rowNumber: number): string => `${fileSha256}:${rowNumber}`;
