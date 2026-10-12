/**
 * Line amounts (F04 App. E.1/E.2 step 1, 02 §5 "Rounding").
 * The exact base is `quantityMilli × unitPriceMicros` in 10⁻⁷ currency units; cents = round_half_away(base / 10⁵).
 */
import { roundHalfAway } from "./rounding";
import { type Cents, toCents } from "./units";

/** Line discount: percent of the exact base (basis points) or an amount in cents (DOC-07). */
export type LineDiscount =
  | { readonly kind: "percent"; readonly bp: number }
  | { readonly kind: "amount"; readonly cents: number };

const BASE_TO_CENTS = 100_000n; // 10⁻⁷ → 10⁻²
const BP = 10_000n;

/** Exact line amount in cents (BigInt, unbounded). Works for net and gross prices alike. */
export function lineAmountExact(quantityMilli: number, unitPriceMicros: number, discount?: LineDiscount): bigint {
  const base = BigInt(quantityMilli) * BigInt(unitPriceMicros);
  if (discount?.kind === "percent") {
    return roundHalfAway(base * (BP - BigInt(discount.bp)), BASE_TO_CENTS * BP);
  }
  const amount = discount?.kind === "amount" ? BigInt(discount.cents) * BASE_TO_CENTS : 0n;
  return roundHalfAway(base - amount, BASE_TO_CENTS);
}

/** Line amount in cents; throws `amount_too_large` beyond 99.999.999.999,99. */
export const lineAmountCents = (quantityMilli: number, unitPriceMicros: number, discount?: LineDiscount): Cents =>
  toCents(lineAmountExact(quantityMilli, unitPriceMicros, discount));
