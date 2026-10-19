import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vActor, vChannel, vFileRef } from "./validators";

/**
 * Tables and validators of the Enable Banking feed and the matching rules (03 §1 `bankConnections`, §7
 * `bankPendingTransactions`, `matchingRules`; F07 BNK-050…054, BNK-100…117). Kept apart from schema.ts so the P2
 * banking slice stays separate.
 */

/** `bankAccounts.feed` (03 §1): the feed link of a currency account; uids are session-specific (BNK-104). */
export const vBankAccountFeed = v.object({
  connectionId: v.id("bankConnections"),
  identificationHash: v.optional(v.string()),
  providerAccountUid: v.optional(v.string()),
  lastPolledAt: v.optional(v.number()),
  backoffUntil: v.optional(v.number()),
  unattendedFetches: v.optional(v.object({ day: v.string(), transactions: v.number(), balances: v.number() })),
  /** The account is not part of the current consent (EC-BNK-92): it continues by statement import. */
  missingSince: v.optional(v.number()),
});

export const vConnectionStatus = v.union(
  v.literal("not_configured"),
  v.literal("pending_consent"),
  v.literal("active"),
  v.literal("reauth_required"),
  v.literal("error"),
  v.literal("disconnected"),
);

/** A session account waiting for the owner's mapping decision (BNK-104, SET-050a, EC-BNK-91). */
export const vPendingAccount = v.object({
  uid: v.string(),
  identificationHash: v.optional(v.string()),
  iban: v.optional(v.string()),
  currency: v.string(),
  name: v.optional(v.string()),
  holderName: v.optional(v.string()),
  localDetails: v.array(v.object({ scheme: v.string(), identification: v.string() })),
});

export const vEvaluationConfirmation = v.object({
  status: v.union(v.literal("pending"), v.literal("confirmed"), v.literal("quoted"), v.literal("declined")),
  recordedAt: v.optional(v.number()),
  note: v.optional(v.string()),
  file: v.optional(vFileRef),
});

export const vRuleWhen = v.object({
  accountId: v.optional(v.string()),
  direction: v.optional(v.union(v.literal("in"), v.literal("out"))),
  currency: v.optional(v.string()),
  bankTransactionCode: v.optional(v.string()),
  proprietaryCode: v.optional(v.string()),
  purposeContains: v.optional(v.string()),
  purposeRegex: v.optional(v.string()),
  counterpartyContains: v.optional(v.string()),
  ibanEquals: v.optional(v.string()),
  merchantContains: v.optional(v.string()),
  mccIn: v.optional(v.array(v.string())),
  amountMinCents: v.optional(v.number()),
  amountMaxCents: v.optional(v.number()),
});

/** The rule's action (03 `matchingRules.then`, stored as `apply`: an object with `then` is a thenable). */
export const vRuleApply = v.object({
  action: v.union(
    v.literal("categorize"),
    v.literal("private"),
    v.literal("transfer"),
    v.literal("link_contact"),
    v.literal("ignore"),
    v.literal("loan"),
  ),
  account: v.optional(v.string()),
  taxRule: v.optional(v.string()),
  contactId: v.optional(v.id("contacts")),
  transferTarget: v.optional(
    v.union(
      v.object({ kind: v.literal("bank"), accountId: v.id("bankAccounts") }),
      v.object({ kind: v.literal("cash") }),
    ),
  ),
  loanAccount: v.optional(v.string()),
  interestAccount: v.optional(v.string()),
  createVoucher: v.optional(v.boolean()),
  statementSufficesAsVoucher: v.optional(v.boolean()),
});

export const vRuleMode = v.union(v.literal("suggest"), v.literal("auto"));

export const bankFeedTables = {
  // bankConnections (03 §1) — one Enable Banking connection → several currency accounts. Not protected, audited.
  // Secrets (`encryptedPrivateKeyPem`, `encryptedSessionId`, `pendingAuth.stateHash`) never leave the model (BNK-013).
  bankConnections: defineTable({
    provider: v.literal("enable_banking"),
    environment: v.union(v.literal("production"), v.literal("sandbox")),
    applicationId: v.optional(v.string()),
    encryptedPrivateKeyPem: v.optional(v.string()),
    publicKeyPem: v.optional(v.string()),
    keySource: v.optional(v.union(v.literal("generated"), v.literal("uploaded"))),
    aspsp: v.optional(v.object({ name: v.string(), country: v.string() })),
    redirectUrl: v.string(),
    pendingAuth: v.optional(v.object({ stateHash: v.string(), expiresAt: v.number() })),
    encryptedSessionId: v.optional(v.string()),
    consentStartedAt: v.optional(v.number()),
    validUntil: v.optional(v.number()),
    consentReminders: v.array(v.object({ daysBefore: v.number(), notifiedAt: v.number() })),
    backfill: v.optional(
      v.object({
        startedAt: v.number(),
        finishedAt: v.optional(v.number()),
        from: v.string(),
        ok: v.boolean(),
        error: v.optional(v.string()),
        accounts: v.optional(v.number()),
        done: v.optional(v.number()),
        inserted: v.optional(v.number()),
      }),
    ),
    pendingAccounts: v.optional(v.array(vPendingAccount)),
    status: vConnectionStatus,
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    /** First failed poll of the current outage (EC-BNK-06 „nicht erreichbar seit …“). */
    outageSince: v.optional(v.number()),
    lastSuccessfulPollAt: v.optional(v.number()),
    lastBalanceCheck: v.optional(
      v.object({
        at: v.number(),
        ok: v.boolean(),
        diffs: v.array(v.object({ accountId: v.id("bankAccounts"), diffCents: v.number() })),
      }),
    ),
    evaluationConfirmation: vEvaluationConfirmation,
    /** BNK-117: feed access lost (restricted mode ended, consent not renewable) — statement import only. */
    feedLost: v.optional(v.object({ at: v.number(), reason: v.string() })),
    consentPeriods: v.optional(v.array(v.object({ from: v.number(), until: v.number() }))),
    disconnectedAt: v.optional(v.number()),
    createdAt: v.number(),
  }),

  // bankPendingTransactions (03 §7) — provisional PDNG rows, replaced every poll, never part of the books (BNK-111).
  bankPendingTransactions: defineTable({
    accountId: v.id("bankAccounts"),
    entryReference: v.optional(v.string()),
    bookingDate: v.optional(v.string()),
    amountCents: v.number(),
    currency: v.string(),
    counterpartyName: v.optional(v.string()),
    purpose: v.string(),
    fetchedAt: v.number(),
    rawSha256: v.string(),
  }).index("by_account", ["accountId"]),

  // matchingRules (03 §7, BNK-050) — configuration, audited. API/MCP rules are always `suggest` (BNK-054).
  matchingRules: defineTable({
    name: v.string(),
    priority: v.number(),
    enabled: v.boolean(),
    mode: vRuleMode,
    when: vRuleWhen,
    apply: vRuleApply,
    createdVia: vChannel,
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    actor: vActor,
  }).index("by_priority", ["priority"]),
};
