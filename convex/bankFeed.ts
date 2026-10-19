import { v } from "convex/values";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { vEvaluationConfirmation } from "./bankFeedValidators";
import { actorMutation, mutation, query, systemMutation, systemQuery } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { berlinParts } from "./lib/time";
import {
  bankdatenChapter,
  completeConsent,
  connectionView,
  consumeState,
  disconnect,
  feedSecrets,
  ingestFeedRows,
  mapPendingAccount,
  pollTargets,
  recordBackfillProgress,
  recordBalanceCheck,
  recordConfirmation,
  recordConsentFailure,
  recordConsentStart,
  recordFetch,
  recordPollOutcome,
  remindConsentExpiry,
  replacePendingRows,
  saveSetup,
} from "./model/bankFeed";
import { fileRefFromStorage } from "./model/bankImport";

/**
 * F07 P2 Enable Banking feed — database side (BNK-011…117, F01 SET-049…050c). HTTP calls run in
 * convex/bankFeedNode.ts and write through the actorMutations below with the caller's actor (owner in the UI,
 * `system:cron.bank.sync` for the poll). No public function returns a secret (BNK-013).
 */

const vEbRows = v.array(v.any());

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** SET-049a connection card / BNK-101 checklist (no secrets). */
export const connection = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => connectionView(ctx, ctx.now()),
});

/** BNK-111 „Vorgemerkt (nicht gebucht)“ of an account. */
export const pending = query({
  permission: "banking.read",
  args: { accountId: v.id("bankAccounts") },
  handler: async (ctx, { accountId }) =>
    (
      await ctx.db
        .query("bankPendingTransactions")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .collect()
    )
      .map((p) => ({
        id: p._id,
        bookingDate: p.bookingDate ?? null,
        amountCents: p.amountCents,
        currency: p.currency,
        counterpartyName: p.counterpartyName ?? null,
        purpose: p.purpose,
        fetchedAt: p.fetchedAt,
      }))
      .sort((a, b) => (b.bookingDate ?? "").localeCompare(a.bookingDate ?? "")),
});

/** BNK-116: Verfahrensdokumentation section „Bankdaten“. */
export const verfahrensdoku = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => ({ today: berlinCalendarDate(ctx.now()), ...(await bankdatenChapter(ctx)) }),
});

/** Encrypted secrets for the Node actions (internal; BNK-013). */
export const secretsInternal = systemQuery({
  job: "bank.feed",
  args: {},
  handler: async (ctx) => feedSecrets(ctx),
});

export const pollTargetsInternal = systemQuery({
  job: "bank.feed",
  args: { accountId: v.optional(v.id("bankAccounts")) },
  handler: async (ctx, { accountId }) => pollTargets(ctx, accountId),
});

// ── setup and consent (owner) ──────────────────────────────────────────────────────────────────────────

export const saveSetupInternal = actorMutation({
  permission: "bankFeed.setup",
  args: {
    applicationId: v.string(),
    encryptedPrivateKeyPem: v.optional(v.string()),
    publicKeyPem: v.optional(v.string()),
    keySource: v.optional(v.union(v.literal("generated"), v.literal("uploaded"))),
    redirectUrl: v.string(),
    environment: v.optional(v.union(v.literal("production"), v.literal("sandbox"))),
  },
  handler: async (ctx, args) => saveSetup(ctx, args),
});

export const consentStartInternal = actorMutation({
  permission: "bankFeed.setup",
  args: {
    stateHash: v.string(),
    expiresAt: v.number(),
    aspsp: v.object({ name: v.string(), country: v.string() }),
  },
  handler: async (ctx, args) => recordConsentStart(ctx, args),
});

export const consumeStateInternal = actorMutation({
  permission: "bankFeed.consent",
  args: { stateHash: v.string() },
  handler: async (ctx, { stateHash }) => consumeState(ctx, stateHash),
});

export const consentFailedInternal = actorMutation({
  permission: "bankFeed.consent",
  args: { message: v.string() },
  handler: async (ctx, { message }) => recordConsentFailure(ctx, message),
});

export const consentCompletedInternal = actorMutation({
  permission: "bankFeed.consent",
  args: {
    encryptedSessionId: v.string(),
    sessionAccounts: v.array(v.any()),
    validUntil: v.number(),
    aspsp: v.optional(v.object({ name: v.string(), country: v.string() })),
  },
  handler: async (ctx, args) => completeConsent(ctx, args),
});

export const mapAccountInternal = actorMutation({
  permission: "bankFeed.consent",
  args: {
    uid: v.string(),
    accountId: v.optional(v.id("bankAccounts")),
    name: v.optional(v.string()),
    openingBalance: v.optional(v.object({ date: v.string(), amountCents: v.number() })),
  },
  handler: async (ctx, args) =>
    mapPendingAccount(ctx, {
      uid: args.uid,
      target: args.accountId
        ? { accountId: args.accountId }
        : {
            create: {
              ...(args.name ? { name: args.name } : {}),
              ...(args.openingBalance ? { openingBalance: args.openingBalance } : {}),
            },
          },
    }),
});

export const backfillProgressInternal = actorMutation({
  permission: "bankFeed.consent",
  args: {
    done: v.optional(v.number()),
    inserted: v.optional(v.number()),
    finished: v.optional(v.object({ ok: v.boolean(), error: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => recordBackfillProgress(ctx, args),
});

// ── polling (BNK-103/106/107/111) ──────────────────────────────────────────────────────────────────────

/**
 * One batch of booked + pending rows of an account (whole booking days). New booked rows go through the rules and
 * the BNK-043 auto-apply afterwards (scheduled: a failing match never undoes the poll).
 */
export const ingestInternal = actorMutation({
  permission: "bankFeed.fetch",
  args: { accountId: v.id("bankAccounts"), rows: vEbRows, replacePending: v.optional(v.boolean()) },
  handler: async (ctx, { accountId, rows, replacePending }) => {
    const r = await ingestFeedRows(ctx, { accountId, rows });
    if (replacePending) await replacePendingRows(ctx, accountId, rows);
    if (r.insertedIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.matchingRules.afterImport, { transactionIds: r.insertedIds });
    }
    return r;
  },
});

export const fetchRecordedInternal = actorMutation({
  permission: "bankFeed.fetch",
  args: {
    accountId: v.id("bankAccounts"),
    endpoint: v.union(v.literal("transactions"), v.literal("balances")),
    unattended: v.boolean(),
    rateLimited: v.optional(v.boolean()),
    ok: v.boolean(),
  },
  handler: async (ctx, args) => recordFetch(ctx, args),
});

export const pollOutcomeInternal = actorMutation({
  permission: "bankFeed.fetch",
  args: {
    outcome: v.union(v.literal("ok"), v.literal("reauth"), v.literal("jwt_rejected"), v.literal("transient")),
    message: v.optional(v.string()),
    gaps: v.optional(v.array(v.object({ accountId: v.id("bankAccounts"), from: v.string(), to: v.string() }))),
  },
  handler: async (ctx, args) => recordPollOutcome(ctx, args),
});

export const balanceCheckInternal = actorMutation({
  permission: "bankFeed.fetch",
  args: { accountId: v.id("bankAccounts"), providerCents: v.number(), currency: v.string() },
  handler: async (ctx, args) => recordBalanceCheck(ctx, args),
});

// ── disconnect, feed loss, provider record ─────────────────────────────────────────────────────────────

export const disconnectInternal = actorMutation({
  permission: "bankFeed.setup",
  args: { deleteKey: v.boolean(), revoked: v.boolean(), feedLost: v.optional(v.string()) },
  handler: async (ctx, args) => disconnect(ctx, args),
});

/** BNK-116: status of the owner's request to Enable Banking for written confirmation or a price (+ optional file). */
export const recordEvaluationConfirmation = mutation({
  permission: "bankFeed.setup",
  args: {
    status: vEvaluationConfirmation.fields.status,
    note: v.optional(v.string()),
    fileStorageId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const file = args.fileStorageId
      ? await fileRefFromStorage(ctx, args.fileStorageId, args.fileName ?? "Bestaetigung-Enable-Banking.pdf")
      : undefined;
    await recordConfirmation(ctx, {
      status: args.status,
      ...(args.note ? { note: args.note } : {}),
      ...(file ? { file } : {}),
    });
  },
});

export const generateUploadUrl = mutation({
  permission: "bankFeed.setup",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

// ── reminders (cron bank.consentExpiryReminder, daily 08:00 Europe/Berlin) ─────────────────────────────

export const consentExpiryReminderCron = systemMutation({
  job: "cron.bank.consentExpiryReminder",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (!force && (isTest() || berlinParts(ctx.now()).hour !== 8)) return null;
    return remindConsentExpiry(ctx);
  },
});

/** Guard used by the Node actions: an `Id` that must exist (typed helper). */
export const requireAccountInternal = systemQuery({
  job: "bank.feed",
  args: { accountId: v.id("bankAccounts") },
  handler: async (ctx, { accountId }) => {
    const a = await ctx.db.get(accountId);
    if (!a) throw appError("not_found", "Das Bankkonto existiert nicht.");
    return { id: a._id as Id<"bankAccounts">, currency: a.currency };
  },
});
