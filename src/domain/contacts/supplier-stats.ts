/**
 * F02 CON-152: supplier view — spend this calendar year and all time (net in EUR of booked expense vouchers, credit
 * notes negative) and open payables (Σ open amounts of unpaid vouchers). Drafts and cancelled vouchers do not count.
 */
export interface SupplierVoucher {
  readonly direction: "expense" | "income";
  readonly status: "draft" | "open" | "scheduled" | "partially_paid" | "paid" | "cancelled";
  readonly documentDate?: string | undefined;
  /** Net in EUR cents (totalsEur, or totals for EUR vouchers). */
  readonly netEurCents: number;
  /** Open amount in EUR cents. */
  readonly openEurCents: number;
}

export interface SupplierStats {
  readonly spendThisYearCents: number;
  readonly spendAllTimeCents: number;
  readonly openPayablesCents: number;
  readonly voucherCount: number;
}

export function supplierStats(vouchers: readonly SupplierVoucher[], today: string): SupplierStats {
  const year = today.slice(0, 4);
  let thisYear = 0;
  let allTime = 0;
  let open = 0;
  let count = 0;
  for (const v of vouchers) {
    if (v.direction !== "expense" || v.status === "draft" || v.status === "cancelled") continue;
    count++;
    allTime += v.netEurCents;
    if (v.documentDate?.startsWith(year)) thisYear += v.netEurCents;
    if (v.status === "open" || v.status === "scheduled" || v.status === "partially_paid") open += v.openEurCents;
  }
  return { spendThisYearCents: thisYear, spendAllTimeCents: allTime, openPayablesCents: open, voucherCount: count };
}
