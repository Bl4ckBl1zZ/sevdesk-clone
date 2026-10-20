/**
 * Project profitability (F11 PRJ-004, PRJ-016). Pure.
 *
 * revenue = Σ net of the project's finalised invoices, corrections and Stornos (Storno nets are negative);
 * costs   = Σ voucher net with the project (+ non-deductible VAT) + Σ minutes × internal cost rate (all entries);
 * margin  = revenue − costs; margin % = margin / revenue (net revenue after Stornos and corrections).
 * Basis: accrual (document date) or cash (payment allocations) — the caller selects the rows by basis and period.
 */
import { roundHalfAway } from "../money";

export type ProfitBasis = "accrual" | "cash";

export interface RevenueRow {
  readonly id: string;
  readonly kind: "invoice" | "correction" | "cancellation" | "other";
  /** Signed net in cents (Storno/credit negative). */
  readonly netCents: number;
}

export interface CostRow {
  readonly id: string;
  readonly netCents: number;
  readonly nonDeductibleVatCents?: number | undefined;
}

export interface TimeCostRow {
  readonly durationMinutes: number;
}

export interface Profitability {
  readonly revenueCents: number;
  readonly voucherCostCents: number;
  readonly timeCostCents: number;
  readonly costsCents: number;
  readonly marginCents: number;
  /** margin / revenue in basis points (half-up); null without revenue. */
  readonly marginBp: number | null;
  readonly minutes: number;
}

export function computeProfitability(input: {
  revenue: readonly RevenueRow[];
  costs: readonly CostRow[];
  time: readonly TimeCostRow[];
  internalCostRateMicros?: number | undefined;
}): Profitability {
  const revenueCents = input.revenue.reduce((s, r) => s + r.netCents, 0);
  const voucherCostCents = input.costs.reduce((s, c) => s + c.netCents + (c.nonDeductibleVatCents ?? 0), 0);
  const minutes = input.time.reduce((s, t) => s + t.durationMinutes, 0);
  const rate = input.internalCostRateMicros ?? 0;
  const timeCostCents = Number(roundHalfAway(BigInt(minutes) * BigInt(rate), 6000n));
  const costsCents = voucherCostCents + timeCostCents;
  const marginCents = revenueCents - costsCents;
  const marginBp =
    revenueCents === 0 ? null : Number(roundHalfAway(BigInt(marginCents) * 10_000n, BigInt(revenueCents)));
  return { revenueCents, voucherCostCents, timeCostCents, costsCents, marginCents, marginBp, minutes };
}
