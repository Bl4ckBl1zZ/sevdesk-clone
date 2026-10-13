import type { Doc, Id } from "../_generated/dataModel";
import { auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Payment state of an invoice-family document or a credit correction as the Storno, correction and final-invoice
 * flows see it (F04 INV-07/10/11/15, 10 EC-070/071). **This is the single hook the payments slice (F05) replaces**:
 * today it derives everything from `salesDocuments.paymentStatus` / `openAmountCents` (the payments slice is their
 * source of truth) and the `creditAppliedCents` of finalised credits; F05 may read its `payments`/`allocations`
 * instead, as long as it returns the same shape.
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
  const credited = (await activeCredits(ctx, doc)).reduce((s, c) => s + (c.creditAppliedCents ?? 0), 0);
  const received = Math.max(0, payable - open - credited);
  return {
    payableCents: payable,
    openCents: open,
    creditedCents: credited,
    receivedCents: received,
    hasPayments: received > 0,
  };
}

/**
 * Stand-in for the payments slice (F05) in tests and E2E only: records `amountCents` as received on an invoice by
 * moving `openAmountCents`/`paymentStatus` (the fields this module reads). Callers guard with IS_TEST.
 */
export async function recordStandInPayment(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  amountCents: number,
): Promise<Settlement> {
  const doc = await ctx.db.get(id);
  if (!doc || doc.status === "draft" || doc.status === "cancelled") throw new Error("stand_in_payment_target");
  const open = Math.max(0, (doc.openAmountCents ?? doc.totals.payableCents) - amountCents);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { openAmountCents: open, paymentStatus: open === 0 ? "paid" : "partially_paid" },
    { action: "payment.record" },
  );
  return settlementOf(ctx, (await ctx.db.get(id)) as SalesDoc);
}
