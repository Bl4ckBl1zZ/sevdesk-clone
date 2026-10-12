/**
 * Exact rational rounding on BigInt (F04 App. E.1). No floating point anywhere.
 */
import { MoneyError } from "./units";

/**
 * `round(n / d)` with ties away from zero ("kaufmännisch", EN 16931 half-up for positive amounts).
 * Symmetric: `roundHalfAway(-n, d) === -roundHalfAway(n, d)`, so mirrored documents (Storno) are exact.
 */
export function roundHalfAway(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError("division_by_zero", "roundHalfAway");
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (2n * an + ad) / (2n * ad); // floor((an + ad/2) / ad) for non-negative values
  return negative ? -q : q;
}

/** `floor(n / d)` (BigInt `/` truncates towards zero). */
export function floorDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError("division_by_zero", "floorDiv");
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

export const absBig = (v: bigint): bigint => (v < 0n ? -v : v);
