/**
 * VAT per group (BR-CO-17, UST-10, RI-05) and the gross-mode inversion (F04 App. E.3, 10 EC-053).
 */
import { roundHalfAway } from "./rounding";
import { type Cents, toCents } from "./units";

const BP = 10_000n;

/** VAT = round_half_away(base × rate). Always — never adjusted to hit a gross amount. */
export const vatExact = (base: bigint, rateBp: number): bigint => roundHalfAway(base * BigInt(rateBp), BP);

export const vatCents = (baseCents: number, rateBp: number): Cents => toCents(vatExact(BigInt(baseCents), rateBp));

export interface NetFromGross {
  readonly net: bigint;
  readonly vat: bigint;
  /** `G − (net + vat)`: 0, or exactly 1 cent (sign of G) if G is unreachable → warning `gross_rounding_deviation`. */
  readonly deviation: bigint;
}

/**
 * Largest net that fits the entered gross G: `N(G) = max { n : n + round(n × r) ≤ G }`; negative G: `−N(−G)`.
 * Start at `floor(G × 10⁴ / (10⁴ + r)) + 2` (provably too large) and step down; `n + vat(n)` is strictly increasing.
 */
export function largestNetThatFits(gross: bigint, rateBp: number): NetFromGross {
  if (gross < 0n) {
    const m = largestNetThatFits(-gross, rateBp);
    return { net: -m.net, vat: -m.vat, deviation: -m.deviation };
  }
  let n = (gross * BP) / (BP + BigInt(rateBp)) + 2n;
  while (n + vatExact(n, rateBp) > gross) n -= 1n;
  const vat = vatExact(n, rateBp);
  return { net: n, vat, deviation: gross - n - vat };
}
