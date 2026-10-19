import { deriveVoucherStatus, VoucherOverpaidError } from "../../src/domain/vouchers/lifecycle";
import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedPatch } from "./audit";
import type { ModelCtx } from "./types";

/**
 * Re-derives `status`/`openAmountCents` of a booked voucher from **all** its payment rows (F06 VOU-130, PAY-043
 * mirrored for payables). Called after every payment or reversal of a voucher row — from voucherPayments.ts and from
 * `refreshTarget` in payments.ts (F05 reversal path). No imports from payments.ts (no cycle).
 */
export async function refreshVoucher(ctx: ModelCtx, id: Id<"vouchers">, action: string): Promise<void> {
  const v = await ctx.db.get(id);
  if (!v) throw appError("not_found", "Der Beleg existiert nicht.");
  if (v.status === "draft" || v.status === "cancelled") return;
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_target", (q) => q.eq("target.kind", "voucher").eq("target.id", id))
    .collect();
  let derived: ReturnType<typeof deriveVoucherStatus>;
  try {
    derived = deriveVoucherStatus({
      status: v.status,
      payableCents: v.totalsEur?.grossCents ?? v.totals.grossCents,
      rows: rows.map((r) => ({ amountCents: r.amountCents, differences: r.differences })),
      scheduled: v.status === "scheduled",
    });
  } catch (e) {
    if (e instanceof VoucherOverpaidError) {
      throw appError("invalid_input", e.message, { reason: "VOUCHER_OVERPAID" });
    }
    throw e;
  }
  await auditedPatch(
    ctx,
    "vouchers",
    id,
    { status: derived.status, openAmountCents: derived.openAmountCents },
    { action, ...(v.internalNumber ? { label: v.internalNumber } : {}) },
  );
}
