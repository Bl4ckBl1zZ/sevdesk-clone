import { v } from "convex/values";

/** Validators of the banking tables (03 §7, F07 P1). Kept apart from validators.ts to keep the slices separate. */
export const vStatementFormat = v.union(v.literal("camt053"), v.literal("mt940"), v.literal("revolut_csv"));

export const vBankSourceKind = v.union(
  v.literal("enable_banking"),
  v.literal("camt053"),
  v.literal("mt940"),
  v.literal("revolut_csv"),
  v.literal("csv"),
);

export const vBankTransactionStatus = v.union(
  v.literal("open"),
  v.literal("matched"),
  v.literal("partially_matched"),
  v.literal("booked"),
  v.literal("private"),
  v.literal("transfer"),
  v.literal("ignored"),
);

/** `bankTransactions.source` — the first source that delivered the row (BNK-120). */
export const vBankTransactionSource = v.object({
  kind: vBankSourceKind,
  entryReference: v.optional(v.string()),
  providerTransactionId: v.optional(v.string()),
  bankTransactionCode: v.optional(v.string()),
  proprietaryCode: v.optional(v.string()),
  merchantName: v.optional(v.string()),
  mcc: v.optional(v.string()),
  feeCents: v.optional(v.number()),
  exchangeRate: v.optional(v.string()),
  instructedAmount: v.optional(v.object({ amountMinor: v.number(), currency: v.string() })),
  balanceAfterCents: v.optional(v.number()),
  bookedAtRaw: v.optional(v.string()),
  importId: v.optional(v.id("bankImports")),
  line: v.optional(v.number()),
  rawSha256: v.string(),
});

/** `bankTransactions.sources[]` — every further delivery of the same booking (BNK-110, append-only). */
export const vBankSourceRef = v.object({
  kind: v.string(),
  importId: v.optional(v.id("bankImports")),
  entryReference: v.optional(v.string()),
  providerTransactionId: v.optional(v.string()),
  rawSha256: v.string(),
  at: v.number(),
});
