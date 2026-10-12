/**
 * de-DE formatting of scaled integers (own implementation: deterministic, independent of ICU data).
 * Output is accepted by `parse.ts`, so `parse(format(x)) === x`.
 */
import { MoneyError } from "./units";

export interface FormatDecimalOptions {
  /** Minimum decimals shown; trailing zeros beyond it are trimmed. Default: `scale`. */
  minFractionDigits?: number;
}

export function formatDecimal(value: number | bigint, scale: number, options: FormatDecimalOptions = {}): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new MoneyError("amount_invalid", `cannot format ${value}`);
  }
  const v = BigInt(value);
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(scale + 1, "0");
  const intDigits = digits.slice(0, digits.length - scale);
  let fraction = digits.slice(digits.length - scale);
  const min = options.minFractionDigits ?? scale;
  while (fraction.length > min && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  const grouped = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

/** 123456 → "1.234,56" */
export const formatCents = (value: number): string => formatDecimal(value, 2);
/** 629 → "6,29 €" (no-break space before the sign, as de-DE) */
export const formatEuro = (value: number): string => `${formatCents(value)} €`;
/** Unit price: 2–4 decimals ("16,80", "10,005"). */
export const formatMicros = (value: number): string => formatDecimal(value, 4, { minFractionDigits: 2 });
/** Quantity: 0–3 decimals ("3", "2,5"). */
export const formatMilli = (value: number): string => formatDecimal(value, 3, { minFractionDigits: 0 });
/** Percentage without the sign: 1900 → "19", 250 → "2,5". */
export const formatBasisPoints = (value: number): string => formatDecimal(value, 2, { minFractionDigits: 0 });
