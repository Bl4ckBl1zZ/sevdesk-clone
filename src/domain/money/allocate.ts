/**
 * Pro-rata allocation without losing a cent (F04 App. E.1; 10 EC-053/EC-055).
 *
 * `share_i = floor(|total| × w_i / Σw)` (sign applied afterwards); the residual cents go to the weight with the
 * largest absolute value (ties → lowest position). Using |w| keeps the allocation exactly mirror-symmetric:
 * `allocate(−t, −w) = −allocate(t, w)` (Storno, RI-06).
 *
 * Spec gap resolved here: when Σw = 0 (weights cancel out or are all zero) a proportional split is undefined;
 * the whole total goes to the largest absolute weight, so the sum is still exact.
 */
import { absBig, floorDiv } from "./rounding";
import { type Cents, toCents } from "./units";

function largestAbsIndex(weights: readonly bigint[]): number {
  let best = 0;
  for (let i = 1; i < weights.length; i++) {
    if (absBig(weights[i] ?? 0n) > absBig(weights[best] ?? 0n)) best = i;
  }
  return best;
}

export function allocateExact(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0n);
  const target = largestAbsIndex(weights);
  if (sum === 0n) return weights.map((_, i) => (i === target ? total : 0n));
  const magnitude = absBig(total);
  const sign = total < 0n ? -1n : 1n;
  const shares = weights.map((w) => floorDiv(magnitude * w, sum));
  const residual = magnitude - shares.reduce((a, b) => a + b, 0n);
  shares[target] = (shares[target] ?? 0n) + residual;
  return shares.map((s) => s * sign);
}

/** Number-level convenience over `allocateExact` (cents in, cents out). */
export const allocate = (totalCents: number, weights: readonly (number | bigint)[]): Cents[] =>
  allocateExact(
    BigInt(totalCents),
    weights.map((w) => BigInt(w)),
  ).map(toCents);
