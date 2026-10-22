/**
 * Payment amount input (F05 EC-PAY-38, 04-ui-ux §8). Pure, never via floating point (GOBD-03).
 *
 *   „1.234,56“ / „1234,56“ → 123456 cents; „1234.56“ (one dot, ≤ 2 decimals, no comma) → decimal point → 123456;
 *   „1.234“ is ambiguous → German thousands separator → 123400 (the dialog shows the interpretation back);
 *   more than 2 decimals → rejected with „Bitte höchstens zwei Nachkommastellen angeben.“
 */
import { formatEuro } from "../money/format";
import { parseCents, parseDecimal } from "../money/parse";
import { MAX_AMOUNT_CENTS } from "../money/units";
import { err, type Issue, issue, ok, type Result } from "../result";

export const AMOUNT_PRECISION_MESSAGE = "Bitte höchstens zwei Nachkommastellen angeben.";
const INVALID_MESSAGE = "Bitte einen gültigen Betrag eingeben (z. B. 1.234,56).";

export interface ParsedAmount {
  cents: number;
  /** Set when the input was ambiguous („1.234“): the formatted interpretation to show next to the field. */
  interpretation?: string;
}

const DOT_DECIMAL = /^[+\-−]?\d+\.\d{1,2}$/;
const DOT_TOO_PRECISE = /^[+\-−]?\d+\.\d{4,}$|^[+\-−]?\d{4,}\.\d{3}$/;
const AMBIGUOUS_GROUPING = /^[+\-−]?\d{1,3}\.\d{3}$/;

export function parsePaymentAmount(input: string): Result<ParsedAmount, Issue<"amount_invalid" | "amount_precision">> {
  const s = input
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^€\s*/, "")
    .replace(/\s*€$/, "");
  if (DOT_DECIMAL.test(s)) {
    const r = parseDecimal(s, { scale: 2, decimalSeparator: ".", grouping: false, max: BigInt(MAX_AMOUNT_CENTS) });
    return r.ok ? ok({ cents: Number(r.value) }) : err(issue("amount_invalid", INVALID_MESSAGE));
  }
  if (DOT_TOO_PRECISE.test(s)) return err(issue("amount_precision", AMOUNT_PRECISION_MESSAGE));
  const r = parseCents(s);
  if (!r.ok) {
    return r.error.code === "amount_precision"
      ? err(issue("amount_precision", AMOUNT_PRECISION_MESSAGE))
      : err(issue("amount_invalid", r.error.code === "amount_too_large" ? r.error.message : INVALID_MESSAGE));
  }
  const cents = Number(r.value);
  return ok(AMBIGUOUS_GROUPING.test(s) ? { cents, interpretation: formatEuro(cents) } : { cents });
}
