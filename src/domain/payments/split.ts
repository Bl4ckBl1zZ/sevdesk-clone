/**
 * VAT split of payment differences (F05 PAY-021, PAY-025, PAY-027; UST-32, §17 UStG; golden S1/S2/S6).
 *
 * A difference (Skonto, price reduction, write-off) is split across the document's VAT groups **pro rata to their
 * gross share** with the largest-remainder method to the cent (the extra cents go to the groups with the largest
 * fractional part, ties to the larger group); per group `vat = round_half_up(gross × rate / (10000 + rate))` and
 * `net = gross − vat`. Groups without VAT (KU, exempt, reverse charge, …) get no VAT correction (EC-PAY-12).
 * Pure; integer cents only.
 */
import { roundHalfAway } from "../money";
import type { VatCategory } from "../tax/vat-category";

export interface GrossGroup {
  category: VatCategory;
  rateBp: number;
  grossCents: number;
}

export interface RateCorrection {
  rateBp: number;
  netCents: number;
  vatCents: number;
}

/** VAT contained in a gross amount: round_half_up(gross × rate / (10000 + rate)) (EN 16931 half-up). */
export function vatInGross(grossCents: number, rateBp: number): number {
  if (rateBp === 0 || grossCents === 0) return 0;
  return Number(roundHalfAway(BigInt(grossCents) * BigInt(rateBp), BigInt(10_000 + rateBp)));
}

/**
 * Largest-remainder allocation of `total` over `weights` (absolute weights; the sign of `total` is applied at the
 * end, so the split of −t mirrors the split of t). Σ result = total exactly. Σ weights = 0 → all to the first.
 */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const w = weights.map((x) => BigInt(Math.abs(x)));
  const sum = w.reduce((a, b) => a + b, 0n);
  const magnitude = BigInt(Math.abs(total));
  const sign = total < 0 ? -1 : 1;
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0));
  const shares = w.map((x) => (magnitude * x) / sum);
  const rest = w.map((x, i) => magnitude * x - (shares[i] as bigint) * sum);
  let residual = Number(magnitude - shares.reduce((a, b) => a + b, 0n));
  const order = w
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = rest[a] as bigint;
      const rb = rest[b] as bigint;
      if (ra !== rb) return ra > rb ? -1 : 1;
      const wa = w[a] as bigint;
      const wb = w[b] as bigint;
      if (wa !== wb) return wa > wb ? -1 : 1;
      return a - b;
    });
  for (const i of order) {
    if (residual <= 0) break;
    shares[i] = (shares[i] as bigint) + 1n;
    residual--;
  }
  return shares.map((s) => sign * Number(s));
}

/**
 * Splits `amountCents` over the groups (merged per rate; categories without VAT share rate 0) and returns the
 * correction per rate, omitting zero rows. Order follows the first appearance of each rate.
 */
export function splitDifferenceByVat(amountCents: number, groups: readonly GrossGroup[]): RateCorrection[] {
  if (amountCents === 0) return [];
  const merged: { rateBp: number; grossCents: number }[] = [];
  for (const g of groups) {
    const rateBp = g.category === "S" ? g.rateBp : 0;
    const m = merged.find((x) => x.rateBp === rateBp);
    if (m) m.grossCents += g.grossCents;
    else merged.push({ rateBp, grossCents: g.grossCents });
  }
  const live = merged.filter((m) => m.grossCents !== 0);
  if (live.length === 0) return [{ rateBp: 0, netCents: amountCents, vatCents: 0 }];
  const shares = largestRemainder(
    amountCents,
    live.map((m) => m.grossCents),
  );
  return live
    .map((m, i) => {
      const gross = shares[i] ?? 0;
      const vat = vatInGross(gross, m.rateBp);
      return { rateBp: m.rateBp, netCents: gross - vat, vatCents: vat };
    })
    .filter((r) => r.netCents !== 0 || r.vatCents !== 0);
}
