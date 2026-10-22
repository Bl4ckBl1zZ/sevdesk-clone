import { v } from "convex/values";

/** Validators of the payment tables (03 §5, F05 P1). Kept apart from validators.ts to keep the slices separate. */

export const vPaymentTargetKind = v.union(
  v.literal("salesDocument"),
  v.literal("opening_item"),
  v.literal("contactCredit"),
);
export const vPaymentTarget = v.object({ kind: vPaymentTargetKind, id: v.string() });

/** 03 §5 `payments.source` (P1 subset: no `provider`, no `private` on sales documents, EC-PAY-49). */
export const vPaymentSource = v.union(
  v.object({ kind: v.literal("bank"), transactionId: v.id("bankTransactions") }),
  v.object({ kind: v.literal("clearing"), accountId: v.id("bankAccounts") }),
  v.object({ kind: v.literal("cash") }),
  v.object({ kind: v.literal("credit") }),
  v.object({ kind: v.literal("adjustment") }),
);

/**
 * Stored `payments.target` / `payments.source` (03 §5): the input validators above plus the F06 voucher payables
 * (VOU-131…138) — target `voucher` and source `private` („Privat bezahlt“). Only convex/model/voucherPayments.ts writes
 * them; the F05 payment API keeps accepting the input validators only (no `private` on sales documents, EC-PAY-49).
 */
export const vStoredPaymentTarget = v.object({
  kind: v.union(vPaymentTargetKind, v.literal("voucher")),
  id: v.string(),
});
export const vStoredPaymentSource = v.union(vPaymentSource, v.object({ kind: v.literal("private") }));

export const vDifferenceReason = v.union(
  v.literal("skonto"),
  v.literal("bank_fees"),
  v.literal("dunning_fees"),
  v.literal("default_interest"),
  v.literal("write_off"),
  v.literal("other"),
);
export const vWriteOffReason = v.union(
  v.literal("insolvency"),
  v.literal("uncollectible"),
  v.literal("statute_barred"),
  v.literal("waiver"),
);

export const vRateCorrection = v.object({ rateBp: v.number(), netCents: v.number(), vatCents: v.number() });

/** A stored difference (the planned one, with the VAT split per rate, UST-32). */
export const vPaymentDifference = v.object({
  reason: vDifferenceReason,
  amountCents: v.number(),
  subReason: v.optional(vWriteOffReason),
  account: v.optional(v.string()),
  text: v.optional(v.string()),
  vatCorrection: v.optional(v.array(vRateCorrection)),
});

/** Difference as entered (dialog, REST, MCP): the split is computed by the domain. */
export const vDifferenceInput = v.object({
  reason: vDifferenceReason,
  amountCents: v.number(),
  subReason: v.optional(vWriteOffReason),
  account: v.optional(v.string()),
  text: v.optional(v.string()),
  withVat: v.optional(v.boolean()),
});

export const vAllocationInput = v.object({
  target: vPaymentTarget,
  amountCents: v.number(),
  differences: v.optional(v.array(vDifferenceInput)),
  /** PAY-018: EUR actually received for a foreign-currency target (EC-PAY-22). */
  eurAmountCents: v.optional(v.number()),
});

/** Provenance of a bank match (F07 BNK-042/043): score, reason chips and whether it was auto-applied. */
export const vMatchProvenance = v.object({
  score: v.number(),
  reasons: v.array(v.string()),
  auto: v.boolean(),
});
