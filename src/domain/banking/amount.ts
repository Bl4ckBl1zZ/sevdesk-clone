/**
 * Bank amounts (F07 BNK-021, EC-BNK-23/24): parsed from the decimal literal of the source into integer minor units
 * per ISO 4217 exponent — never via floating point. More decimals than the exponent → the row is rejected with the
 * German finding „Ungültiger Betrag in Bankdaten ({value}).“ (the import continues with the other rows).
 */
import { parseDecimal } from "../money/parse";
import { err, type Issue, issue, ok, type Result } from "../result";

/** ISO 4217 minor-unit exponents that differ from 2 (data, not logic; extend when a pocket needs it). */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  ISK: 0,
  CLP: 0,
  VND: 0,
  XOF: 0,
  XAF: 0,
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
  LYD: 3,
  IQD: 3,
};

export const currencyExponent = (currency: string): number => EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;

export type BankAmountIssue = Issue<"bank_amount_invalid">;

export function parseBankAmount(
  literal: string,
  currency: string,
  options: { decimalSeparator?: "." | "," } = {},
): Result<number, BankAmountIssue> {
  const value = literal.trim();
  const fail = () => err(issue("bank_amount_invalid", `Ungültiger Betrag in Bankdaten (${value}).`, { value }));
  // "12," (MT940: decimal comma without fraction digits) is valid.
  const normalised = value.endsWith(options.decimalSeparator ?? ".") ? value.slice(0, -1) : value;
  if (normalised === "" || /[eE]/.test(normalised)) return fail();
  const r = parseDecimal(normalised, {
    scale: currencyExponent(currency),
    decimalSeparator: options.decimalSeparator ?? ".",
    grouping: false,
    currencySymbol: false,
  });
  if (!r.ok) return fail();
  if (r.value > BigInt(Number.MAX_SAFE_INTEGER) || r.value < -BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return ok(Number(r.value));
}

/** Minor units → machine decimal literal ("-47.80", "1500", "1.250"). */
export function formatMinor(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(exp + 1, "0");
  if (exp === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** German display with currency code ("−1.234,56 USD"; EUR → „€“). */
export function formatMoneyDe(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const abs = String(Math.abs(minor)).padStart(exp + 1, "0");
  const int = (exp === 0 ? abs : abs.slice(0, -exp)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = exp === 0 ? "" : `,${abs.slice(-exp)}`;
  return `${minor < 0 ? "−" : ""}${int}${frac} ${currency === "EUR" ? "€" : currency}`;
}
