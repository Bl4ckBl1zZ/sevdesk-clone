import type { Doc } from "../_generated/dataModel";
import type { ReadCtx } from "./types";

/**
 * Payment state of an invoice-family document or a credit correction as the Storno, correction and final-invoice
 * flows see it (F04 INV-07/10/11/15, 10 EC-070/071). Invoices read the F05 `payments` rows (net of reversals,
 * incl. accepted differences, RI-09) and the `creditAppliedCents` of their finalised credits; `openAmountCents` is the
 * value the payments slice derived from both (PAY-043).
 */
export interface Settlement {
  /** Payable amount of the snapshot (BT-115). */
  readonly payableCents: number;
  /** `openAmountCents` (> 0 = still owed by the customer; < 0 = refund owed on a credit correction). */
  readonly openCents: number;
  /** Part of the payable settled by finalised, non-cancelled Rechnungskorrekturen (no cash). */
  readonly creditedCents: number;
  /**
   * Cash/offsets allocated, net of reversals: for an invoice the payments received; for a credit correction the
   * refund/offset paid out. Never negative.
   */
  readonly receivedCents: number;
  /** INV-10/11/15: any allocation exists (blocks the Storno). */
  readonly hasPayments: boolean;
  /** Date of the last payment, if known (BT-22 deduction line of the final invoice). */
  readonly paidOn?: string | undefined;
}

type SalesDoc = Doc<"salesDocuments">;

/** Finalised, non-cancelled credit corrections of `doc`. */
export async function activeCredits(ctx: ReadCtx, doc: Pick<SalesDoc, "_id">): Promise<SalesDoc[]> {
  return (
    await ctx.db
      .query("salesDocuments")
      .withIndex("by_correctsId", (q) => q.eq("correctsId", doc._id))
      .collect()
  ).filter(
    (d) => d.type === "correction" && d.correctionKind === "credit" && d.status !== "draft" && d.status !== "cancelled",
  );
}

/**
 * Part of `doc`'s payable settled by its credit corrections (Σ `creditAppliedCents`), optionally only credits dated
 * on or before `asOf` (open items as-of view, PAY-002). Input of the F05 status derivation (PAY-043).
 */
export async function creditedCentsOf(ctx: ReadCtx, doc: Pick<SalesDoc, "_id">, asOf?: string): Promise<number> {
  return (await activeCredits(ctx, doc))
    .filter((c) => asOf === undefined || (c.documentDate !== undefined && c.documentDate <= asOf))
    .reduce((s, c) => s + (c.creditAppliedCents ?? 0), 0);
}

export async function settlementOf(ctx: ReadCtx, doc: SalesDoc): Promise<Settlement> {
  const payable = doc.totals.payableCents;
  const open = doc.openAmountCents ?? payable;
  if (doc.type === "correction") {
    // A credit starts with open = applied − |credit| (≤ 0); refunds/offsets move it towards 0.
    const credit = Math.abs(payable);
    const initialOpen = (doc.creditAppliedCents ?? 0) - credit;
    const refunded = Math.max(0, open - initialOpen);
    return {
      payableCents: payable,
      openCents: open,
      creditedCents: 0,
      receivedCents: refunded,
      hasPayments: refunded > 0,
    };
  }
  if (doc.status === "cancelled") {
    // Storno only for unpaid documents (INV-10): nothing was received; the receivable is closed.
    return { payableCents: payable, openCents: 0, creditedCents: 0, receivedCents: 0, hasPayments: false };
  }
  const credited = await creditedCentsOf(ctx, doc);
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_target", (q) => q.eq("target.kind", "salesDocument").eq("target.id", doc._id))
    .collect();
  const active = rows.filter((r) => !r.reversedById && !r.reversalOfId);
  const settled = rows.reduce((s, r) => s + r.amountCents + r.differences.reduce((d, x) => d + x.amountCents, 0), 0);
  const paidOn = active
    .map((r) => r.date)
    .sort()
    .at(-1);
  return {
    payableCents: payable,
    openCents: doc.openAmountCents ?? payable - credited - settled,
    creditedCents: credited,
    receivedCents: Math.max(0, settled),
    hasPayments: active.length > 0,
    ...(paidOn ? { paidOn } : {}),
  };
}
