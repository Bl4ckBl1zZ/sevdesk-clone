/**
 * Integer money units (02 §5, 03 §0, CLAUDE.md §4). Floats never represent money.
 *
 * - `Cents`       — amounts in minor units (2 decimals)
 * - `Micros`      — unit prices in 1/10,000 of the currency unit (4 decimals; the historical name is kept)
 * - `Milli`       — quantities in 1/1,000 (3 decimals)
 * - `BasisPoints` — percentages, 1900 = 19.00 % (may be negative, e.g. the Basiszinssatz)
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Cents = Brand<number, "Cents">;
export type Micros = Brand<number, "Micros">;
export type Milli = Brand<number, "Milli">;
export type BasisPoints = Brand<number, "BasisPoints">;

/** 99.999.999.999,99 — F04 §5.3 / `amount_too_large`. */
export const MAX_AMOUNT_CENTS = 9_999_999_999_999;
/** ±99.999.999,9999 — F03 PRD-014. */
export const MAX_UNIT_PRICE_MICROS = 999_999_999_999;
/** ±999.999.999,999 — F04 §5.3. */
export const MAX_QUANTITY_MILLI = 999_999_999_999;

export type MoneyErrorCode = "amount_invalid" | "amount_too_large" | "division_by_zero";

/** Thrown for programming errors (invalid constructor input). User input goes through the `parse*` Results. */
export class MoneyError extends RangeError {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MoneyError";
    this.code = code;
  }
}

function checked(value: number, max: number, unit: string): number {
  if (!Number.isSafeInteger(value)) throw new MoneyError("amount_invalid", `${unit} must be an integer, got ${value}`);
  if (Math.abs(value) > max) throw new MoneyError("amount_too_large", `${unit} ${value} exceeds ±${max}`);
  return value;
}

export const cents = (value: number): Cents => checked(value, MAX_AMOUNT_CENTS, "cents") as Cents;
export const micros = (value: number): Micros => checked(value, MAX_UNIT_PRICE_MICROS, "micros") as Micros;
export const milli = (value: number): Milli => checked(value, MAX_QUANTITY_MILLI, "milli") as Milli;
export const basisPoints = (value: number): BasisPoints =>
  checked(value, Number.MAX_SAFE_INTEGER, "basis points") as BasisPoints;

/** Converts an exact BigInt result to `Cents`, refusing anything beyond the amount limit. */
export function toCents(value: bigint): Cents {
  if (value > BigInt(MAX_AMOUNT_CENTS) || value < -BigInt(MAX_AMOUNT_CENTS)) {
    throw new MoneyError("amount_too_large", `${value} cents exceeds ±${MAX_AMOUNT_CENTS}`);
  }
  return Number(value) as Cents;
}

/** True if a BigInt amount fits the `Cents` limit. */
export const fitsCents = (value: bigint): boolean =>
  value <= BigInt(MAX_AMOUNT_CENTS) && value >= -BigInt(MAX_AMOUNT_CENTS);
