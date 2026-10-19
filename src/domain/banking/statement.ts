/**
 * Statement file entry point (F07 BNK-030/033): bytes → text (encoding auto-detect UTF-8 / Windows-1252, XML
 * declaration honoured) → format detection (CAMT.053, MT940, Revolut CSV) → the format's parser.
 */
import { err, type Result } from "../result";
import { retentionUntilFor } from "../rules/retention";
import { parseCamt053 } from "./sources/camt053";
import { parseMt940 } from "./sources/mt940";
import { parseRevolutCsv } from "./sources/revolut-csv";
import { type ParsedStatement, type StatementFormat, type UnreadableFile, unreadable } from "./types";

/** Windows-1252 code points for 0x80–0x9F (ISO-8859-1 elsewhere). */
const CP1252: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

function isUtf8(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] as number;
    const n = b < 0x80 ? 0 : (b & 0xe0) === 0xc0 ? 1 : (b & 0xf0) === 0xe0 ? 2 : (b & 0xf8) === 0xf0 ? 3 : -1;
    if (n < 0 || (n === 1 && b < 0xc2)) return false;
    for (let k = 1; k <= n; k++) if (((bytes[i + k] ?? 0) & 0xc0) !== 0x80) return false;
    i += n + 1;
  }
  return true;
}

/**
 * Bytes → text without relying on runtime code-page support (the Convex runtime decodes UTF-8 only): BOM/valid
 * UTF-8 → UTF-8, otherwise Windows-1252 (a superset of ISO-8859-1 for printable text; German bank exports).
 */
export function decodeStatement(bytes: Uint8Array): Result<string, UnreadableFile> {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return err(unreadable(1, "UTF-16 wird nicht unterstützt, bitte als UTF-8 speichern"));
  }
  if (isUtf8(bytes)) {
    const text = new TextDecoder("utf-8").decode(bytes);
    return { ok: true, value: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  }
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b >= 0x80 && b <= 0x9f ? (CP1252[b - 0x80] as number) : b);
  return { ok: true, value: text };
}

/**
 * Retention of an archived bank statement (F07 BNK-030: class `vouchers8`, bank statements are Buchungsbelege;
 * § 147 Abs. 3/4 AO: 8 years from the end of the calendar year of the period end).
 */
/** PRV-001: bank statements are Buchungsbelege (vouchers8, rule table `retention-2026.1`). */
export const statementRetentionUntil = (periodTo: string): string => retentionUntilFor("vouchers8", periodTo) as string;

export function detectStatementFormat(text: string, fileName = ""): StatementFormat | null {
  const head = text.slice(0, 4000).replace(/^﻿/, "");
  if (/camt\.053\.001\.\d{2}/.test(head) || /^\s*<\?xml/.test(head) || /\.xml$/i.test(fileName)) return "camt053";
  if (/(^|\n|\{4:\r?\n?):20:/.test(head) && /:25:/.test(head)) return "mt940";
  const firstLine = head.split(/\r?\n/, 1)[0] ?? "";
  if (/date (started|completed)/i.test(firstLine) || /\.csv$/i.test(fileName)) return "revolut_csv";
  return null;
}

export function parseStatement(
  text: string,
  options: { format?: StatementFormat; fileName?: string; currency?: string } = {},
): Result<ParsedStatement, UnreadableFile> {
  const format = options.format ?? detectStatementFormat(text, options.fileName);
  switch (format) {
    case "camt053":
      return parseCamt053(text);
    case "mt940":
      return parseMt940(text);
    case "revolut_csv":
      return parseRevolutCsv(text, options.currency ? { currency: options.currency } : {});
    default:
      return err(unreadable(1, "unbekanntes Dateiformat (erwartet CAMT.053, MT940 oder Revolut-CSV)"));
  }
}
