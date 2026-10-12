/**
 * Decimal string → scaled integer, never via floating point (GOBD-03, F07 BNK-021).
 * German input by default ("1.234,56"); machine formats (CAMT, feed) use `decimalSeparator: "."` and `grouping: false`.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import {
  type BasisPoints,
  type Cents,
  MAX_AMOUNT_CENTS,
  MAX_QUANTITY_MILLI,
  MAX_UNIT_PRICE_MICROS,
  type Micros,
  type Milli,
} from "./units";

export type AmountIssueCode = "amount_invalid" | "amount_precision" | "amount_too_large";

export interface ParseDecimalOptions {
  /** Number of decimals of the target unit (2 = cents, 4 = micros, 3 = milli, 0/3 for other ISO 4217 exponents). */
  scale: number;
  /** "," (German, default) or "." (international / machine formats). */
  decimalSeparator?: "," | ".";
  /** Accept thousands separators (the other symbol, in groups of three). Default true. */
  grouping?: boolean;
  /** Accept a leading or trailing "€" (and "%" for percentages). Default true. */
  currencySymbol?: boolean;
  /** Absolute maximum of the scaled value. Default: none. */
  max?: bigint;
}

const MINUS = /^[-−]/; // ASCII hyphen-minus or U+2212

function messageFor(code: AmountIssueCode, scale: number): string {
  switch (code) {
    case "amount_precision":
      return `Der Betrag darf höchstens ${scale} Nachkommastellen haben.`;
    case "amount_too_large":
      return "Der Betrag ist zu groß.";
    default:
      return "Bitte einen gültigen Betrag eingeben (z. B. 1.234,56).";
  }
}

export function parseDecimal(input: string, options: ParseDecimalOptions): Result<bigint, Issue<AmountIssueCode>> {
  const { scale, decimalSeparator = ",", grouping = true, currencySymbol = true, max } = options;
  const fail = (code: AmountIssueCode) => err(issue(code, messageFor(code, scale)));
  let s = input.replace(/[\s  ]+/g, " ").trim();
  if (currencySymbol) s = s.replace(/^[€%]\s*/, "").replace(/\s*[€%]$/, "");
  let negative = false;
  if (MINUS.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const groupSep = decimalSeparator === "," ? "." : ",";
  const g = groupSep === "." ? "\\." : ",";
  const d = decimalSeparator === "," ? "," : "\\.";
  const intPart = grouping ? `(\\d{1,3}(?:${g}\\d{3})+|\\d+)` : "(\\d+)";
  const match = new RegExp(`^${intPart}(?:${d}(\\d+))?$`).exec(s);
  if (!match) return fail("amount_invalid");
  const integerDigits = (match[1] ?? "").split(groupSep).join("");
  const fraction = match[2] ?? "";
  if (fraction.length > scale) return fail("amount_precision");
  const scaled = BigInt(integerDigits + fraction.padEnd(scale, "0"));
  if (max !== undefined && scaled > max) return fail("amount_too_large");
  return ok(negative ? -scaled : scaled);
}

function parseScaled<T>(input: string, scale: number, max: number): Result<T, Issue<AmountIssueCode>> {
  const r = parseDecimal(input, { scale, max: BigInt(max) });
  return r.ok ? ok(Number(r.value) as T) : r;
}

/** "1.234,56" → 123456 cents; at most 99.999.999.999,99. */
export const parseCents = (input: string) => parseScaled<Cents>(input, 2, MAX_AMOUNT_CENTS);
/** Unit price with ≤ 4 decimals → 1/10,000 units (F03 PRD-014). */
export const parseMicros = (input: string) => parseScaled<Micros>(input, 4, MAX_UNIT_PRICE_MICROS);
/** Quantity with ≤ 3 decimals → thousandths. */
export const parseMilli = (input: string) => parseScaled<Milli>(input, 3, MAX_QUANTITY_MILLI);
/** Percentage with ≤ 2 decimals ("19,00 %") → basis points. */
export const parseBasisPoints = (input: string) => parseScaled<BasisPoints>(input, 2, 100_000_000);
