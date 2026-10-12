/**
 * Pro-rata shares of a document's VAT (or gross) for partial settlements (F08 P1/P2, §4.4, E-TAX-03, UVA-06,
 * UST-40).
 *
 * Cumulative definition: the share settled up to the cumulative amount `x` of a payable `P` is
 *   F(x) = round_half_away(T × x / P)      (T = Σ totals; F(P) = T exactly)
 * split over the keys with `allocateExact` (largest remainder → largest group). A payment moving the settled
 * amount from `before` to `after` gets `F(after) − F(before)` per key. Because the definition is cumulative, the
 * sum over all payments of a fully settled document equals the totals per key exactly (the last payment absorbs
 * the rounding, TST-ACC-14), and the result does not depend on how earlier payments were split — the caller only
 * needs the net settled amount before the payment (RI-09).
 */
import { allocateExact, roundHalfAway } from "../money";

export function cumulativeShares(totals: readonly number[], payableCents: number, settledCents: number): number[] {
  if (totals.length === 0) return [];
  const total = totals.reduce((a, b) => a + BigInt(b), 0n);
  if (payableCents === 0) return totals.map(() => 0);
  const x = Math.max(0, Math.min(settledCents, payableCents));
  const amount = x === payableCents ? total : roundHalfAway(total * BigInt(x), BigInt(payableCents));
  return allocateExact(
    amount,
    totals.map((t) => BigInt(t)),
  ).map(Number);
}

/** Per-key share of a settlement moving the settled amount from `before` to `before + now`. */
export function shareOfSettlement(
  totals: readonly number[],
  payableCents: number,
  settledBeforeCents: number,
  settledNowCents: number,
): number[] {
  const after = cumulativeShares(totals, payableCents, settledBeforeCents + settledNowCents);
  const before = cumulativeShares(totals, payableCents, settledBeforeCents);
  return after.map((a, i) => a - (before[i] ?? 0));
}
