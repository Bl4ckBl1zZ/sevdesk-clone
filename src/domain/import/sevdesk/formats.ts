/**
 * sevdesk export import (F09 §4.3, IMP-016, E-IMP-26): header normalisation and per-file number/date format
 * detection. German CSV exports use `1.234,56` and `31.12.2025`; the format is detected from all values of a
 * column set and never guessed silently — an ambiguous file needs the owner's choice.
 *
 * Pure: strings in, integer cents / calendar dates out (money via src/domain/money, never floats).
 */
import { parseDecimal } from "../../money/parse";
import { err, type Issue, issue, ok, type Result } from "../../result";
import { type CalendarDate, isCalendarDate } from "../../time/calendar-date";

/** F09 §4.3.1: case, umlauts (ä→ae, both spellings meet), punctuation and whitespace; `%` stays a token. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/%/g, " % ")
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type NumberFormat = "de" | "en";
export type DateFormat = "dmy" | "mdy";

/** Result of a format detection: decided, or ambiguous with the options the owner chooses from. */
export type Detection<T> = { readonly kind: "decided"; readonly value: T } | { readonly kind: "ambiguous" };

const clean = (raw: string) =>
  raw
    .replace(/\s+/g, "")
    .replace(/^(EUR|€)|(EUR|€)$/i, "")
    .replace(/^[-−+]/, "");

/**
 * E-IMP-26 number format of a file from all amount values: a comma decimal („12,50“, „1.234,56“) is German, a dot
 * with one or two decimals („12.50“) or comma grouping („1,234.56“) is English; „1.234“ / „1,234“ alone fit both.
 * Integers fit both and default to German.
 */
export function detectNumberFormat(values: readonly string[]): Detection<NumberFormat> {
  let de = false;
  let en = false;
  let unclear = false;
  for (const raw of values) {
    const v = clean(raw);
    if (v === "" || /^\d+$/.test(v)) continue;
    if (/^\d+,\d{1,2}$/.test(v) || /^\d{1,3}(\.\d{3})+,\d+$/.test(v) || /^\d{1,3}(\.\d{3}){2,}$/.test(v)) de = true;
    else if (/^\d+\.\d{1,2}$/.test(v) || /^\d{1,3}(,\d{3})+\.\d+$/.test(v) || /^\d{1,3}(,\d{3}){2,}$/.test(v)) {
      en = true;
    } else if (/^\d{1,3}[.,]\d{3}$/.test(v)) unclear = true;
    else if (/^\d+,\d+$/.test(v)) de = true;
    else if (/^\d+\.\d+$/.test(v)) en = true;
  }
  if (de && en) return { kind: "ambiguous" };
  if (de) return { kind: "decided", value: "de" };
  if (en) return { kind: "decided", value: "en" };
  return unclear ? { kind: "ambiguous" } : { kind: "decided", value: "de" };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+Z?)?$/;
const DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?: [\d:]+)?$/;
const SLASHED = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?: [\d:]+)?$/;

/**
 * E-IMP-26 date format of a file: ISO and dotted dates (`31.12.2025`, the German convention) are unambiguous;
 * slashed dates are day-first if a first part exceeds 12, month-first if a second part does, else ambiguous.
 */
export function detectDateFormat(values: readonly string[]): Detection<DateFormat> {
  let dmy = false;
  let mdy = false;
  let unclear = false;
  for (const raw of values) {
    const v = raw.trim();
    if (v === "" || ISO.test(v)) continue;
    if (DOTTED.test(v)) {
      dmy = true;
      continue;
    }
    const m = SLASHED.exec(v);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) dmy = true;
    else if (b > 12) mdy = true;
    else unclear = true;
  }
  if (dmy && mdy) return { kind: "ambiguous" };
  if (dmy) return { kind: "decided", value: "dmy" };
  if (mdy) return { kind: "decided", value: "mdy" };
  return unclear ? { kind: "ambiguous" } : { kind: "decided", value: "dmy" };
}

export type ValueIssueCode = "amount_invalid" | "date_invalid" | "rate_invalid";

/** Amount in the file's number format → integer cents; empty → `undefined`. At most two decimals. */
export function parseAmountCents(raw: string, format: NumberFormat): Result<number | undefined, Issue<ValueIssueCode>> {
  const v = raw.replace(/\s+/g, "").replace(/^EUR|EUR$/i, "");
  if (v === "") return ok(undefined);
  const r = parseDecimal(v, { scale: 2, decimalSeparator: format === "de" ? "," : ".", grouping: true });
  if (!r.ok) return err(issue("amount_invalid", `Betrag „${raw.trim()}“ ist ungültig.`));
  return ok(Number(r.value));
}

/** VAT rate „19“, „19 %“, „19,00“, „7.0“ → basis points; empty → `undefined`. */
export function parseRateBp(raw: string): Result<number | undefined, Issue<ValueIssueCode>> {
  const v = raw.replace(/[\s%]+/g, "");
  if (v === "") return ok(undefined);
  const r = parseDecimal(v, { scale: 2, decimalSeparator: v.includes(",") ? "," : ".", grouping: false });
  if (!r.ok || r.value < 0n || r.value > 10_000n)
    return err(issue("rate_invalid", `Steuersatz „${raw.trim()}“ ist ungültig.`));
  return ok(Number(r.value));
}

/** Date in the file's date format (ISO always accepted) → calendar date; empty → `undefined`. */
export function parseImportDate(
  raw: string,
  format: DateFormat,
): Result<CalendarDate | undefined, Issue<ValueIssueCode>> {
  const v = raw.trim();
  if (v === "") return ok(undefined);
  const bad = err(issue("date_invalid" as const, `Datum „${v}“ ist ungültig.`));
  let y: string | undefined;
  let mo: string | undefined;
  let d: string | undefined;
  const iso = ISO.exec(v);
  if (iso) [, y, mo, d] = iso;
  else {
    const m = DOTTED.exec(v) ?? SLASHED.exec(v);
    if (!m) return bad;
    const dottedOrDayFirst = DOTTED.test(v) || format === "dmy";
    d = dottedOrDayFirst ? m[1] : m[2];
    mo = dottedOrDayFirst ? m[2] : m[1];
    y = m[3];
  }
  if (!y || !mo || !d) return bad;
  const year = y.length === 2 ? `20${y}` : y;
  const date = `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isCalendarDate(date) ? ok(date) : bad;
}
