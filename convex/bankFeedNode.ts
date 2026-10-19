"use node";

import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { parseBankAmount } from "../src/domain/banking/amount";
import {
  classifyFeedError,
  consentValidUntil,
  type FeedErrorKind,
  redirectUrlFor,
  STATE_TTL_MS,
} from "../src/domain/banking/feed/consent";
import { FEED_MESSAGES } from "../src/domain/banking/feed/messages";
import { isPollSlot, MAX_TRANSIENT_RETRIES, olderGap, unattendedAllowed } from "../src/domain/banking/feed/polling";
import { redactForLog, redactText } from "../src/domain/banking/feed/redact";
import type { EbAccount, EbTransaction } from "../src/domain/banking/sources/enable-banking";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../src/domain/time/calendar-date";
import { createEnableBankingProvider } from "../src/server/bank/enable-banking";
import { type BankFeedProvider, FeedHttpError, type PsuHeaders } from "../src/server/bank/feed";
import { generateApplicationKey, publicKeyOf } from "../src/server/bank/keys";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, systemAction } from "./functions";
import { baseDomain, env, isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { decryptSecret, encryptSecret } from "./lib/secrets";
import type { MappedAccount } from "./model/bankFeed";
import type { ActorContext } from "./model/types";

/**
 * F07 P2 Enable Banking feed — the HTTP side (BNK-011, BNK-100…117; F01 SET-049). Runs in Node actions; every
 * database write goes through the actorMutations of convex/bankFeed.ts with the caller's actor. Polling only — there
 * is no inbound bank endpoint (BNK-108). Logs and stored error texts are redacted (BNK-013).
 */

type Ctx = ActionCtx & { actorContext: ActorContext; now: () => number };

/** Callback backfill budget inside the action (Convex actions run ≤ 10 min; Revolut's window is minutes, BNK-103). */
const BACKFILL_BUDGET_MS = 4 * 60_000;
const DAY_BATCH = 200;

/** BNK-013: the only logger of the feed — everything passes the redactor. */
function log(event: string, data: Record<string, unknown> = {}, secrets: string[] = []) {
  console.log(`[bank-feed] ${event}`, JSON.stringify(redactForLog(data, secrets)));
}

async function providerFor(ctx: ActionCtx): Promise<{ provider: BankFeedProvider; sessionId: string | null }> {
  const s = await ctx.runQuery(internal.bankFeed.secretsInternal, {});
  if (!s) throw appError("not_configured", FEED_MESSAGES.notConfigured);
  const provider = createEnableBankingProvider({
    applicationId: s.applicationId,
    privateKeyPem: await decryptSecret(s.encryptedPrivateKeyPem),
    ...(env("ENABLE_BANKING_API_URL") ? { baseUrl: env("ENABLE_BANKING_API_URL") as string } : {}),
  });
  return { provider, sessionId: s.encryptedSessionId ? await decryptSecret(s.encryptedSessionId) : null };
}

const kindOf = (e: unknown): FeedErrorKind =>
  e instanceof FeedHttpError
    ? classifyFeedError({
        ...(e.status ? { status: e.status } : {}),
        ...(e.error ? { error: e.error } : {}),
        message: e.message,
      })
    : "transient";

const randomState = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
};

/** Whole booking days per batch (identical same-day rows need one batch for the dedupe ordinal, BNK-109). */
function dayBatches(rows: readonly EbTransaction[]): EbTransaction[][] {
  const booked = rows
    .filter((r) => r.status === "BOOK")
    .sort((a, b) =>
      String(a.booking_date ?? a.value_date ?? "").localeCompare(String(b.booking_date ?? b.value_date ?? "")),
    );
  const out: EbTransaction[][] = [];
  let cur: EbTransaction[] = [];
  let curDay = "";
  for (const r of booked) {
    const day = String(r.booking_date ?? r.value_date ?? "");
    if (cur.length >= DAY_BATCH && day !== curDay) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
    curDay = day;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function ingest(ctx: Ctx, accountId: Id<"bankAccounts">, rows: EbTransaction[]) {
  let inserted = 0;
  let earliest: string | undefined;
  for (const batch of dayBatches(rows)) {
    const r = await ctx.runMutation(internal.bankFeed.ingestInternal, {
      actorContext: ctx.actorContext,
      accountId,
      rows: batch,
    });
    inserted += r.insertedIds.length;
    if (r.earliest && (!earliest || r.earliest < earliest)) earliest = r.earliest;
  }
  await ctx.runMutation(internal.bankFeed.ingestInternal, {
    actorContext: ctx.actorContext,
    accountId,
    rows: rows.filter((r) => r.status === "PDNG"),
    replacePending: true,
  });
  return { inserted, earliest };
}

/**
 * BNK-103: backfill inside the callback (`strategy=longest`, all pages) for every mapped account. On timeout/error the
 * callback still completes; the next polls fetch ≤ 90 days and an older gap becomes a statement to-do (EC-BNK-88).
 */
async function backfill(ctx: Ctx, provider: BankFeedProvider, mapped: MappedAccount[]) {
  const deadline = ctx.now() + BACKFILL_BUDGET_MS;
  const today = berlinCalendarDate(ctx.now());
  const gaps: { accountId: Id<"bankAccounts">; from: string; to: string }[] = [];
  let inserted = 0;
  let error: string | undefined;
  for (const [i, m] of mapped.entries()) {
    let complete = false;
    let earliest: string | undefined;
    try {
      const r = await provider.fetchTransactions(m.uid, { dateFrom: m.dateFrom, strategy: "longest", deadline });
      complete = r.complete;
      const ing = await ingest(ctx, m.accountId, r.transactions);
      inserted += ing.inserted;
      earliest = ing.earliest;
      await ctx.runMutation(internal.bankFeed.fetchRecordedInternal, {
        actorContext: ctx.actorContext,
        accountId: m.accountId,
        endpoint: "transactions",
        unattended: false,
        ok: true,
      });
    } catch (e) {
      error = redactText(e instanceof Error ? e.message : String(e));
      log("backfill_failed", { accountId: m.accountId, error });
    }
    const gap = olderGap({ start: m.dateFrom, today, ...(earliest ? { earliestDelivered: earliest } : {}), complete });
    if (gap) gaps.push({ accountId: m.accountId, ...gap });
    await ctx.runMutation(internal.bankFeed.backfillProgressInternal, {
      actorContext: ctx.actorContext,
      done: i + 1,
      inserted: 0,
    });
  }
  await ctx.runMutation(internal.bankFeed.backfillProgressInternal, {
    actorContext: ctx.actorContext,
    inserted,
    finished: { ok: error === undefined && gaps.length === 0, ...(error ? { error } : {}) },
  });
  await ctx.runMutation(internal.bankFeed.pollOutcomeInternal, { actorContext: ctx.actorContext, outcome: "ok", gaps });
  return { inserted, gaps: gaps.length };
}

/**
 * BNK-106/107 one poll run over the mapped accounts. `unattended` fetches respect the 4/day budget and the 6 h
 * backoff; owner-present fetches send the PSU headers and do not count (without a PSU IP they count, Q-06).
 */
async function poll(ctx: Ctx, opts: { accountId?: Id<"bankAccounts">; psu?: PsuHeaders }) {
  const targets = await ctx.runQuery(
    internal.bankFeed.pollTargetsInternal,
    opts.accountId ? { accountId: opts.accountId } : {},
  );
  if (!targets.connection || !targets.connection.polling) return { skipped: "inactive" as const, accounts: [] };
  const { provider, sessionId } = await providerFor(ctx);
  const secrets = [sessionId ?? "", opts.psu?.ipAddress ?? "", opts.psu?.userAgent ?? ""];
  const unattended = !opts.psu?.ipAddress;
  const now = ctx.now();
  const day = berlinCalendarDate(now);
  const today = day;
  const results: { accountId: Id<"bankAccounts">; inserted: number; skipped?: string }[] = [];
  const gaps: { accountId: Id<"bankAccounts">; from: string; to: string }[] = [];
  let transientFailures = 0;
  const record = (
    accountId: Id<"bankAccounts">,
    endpoint: "transactions" | "balances",
    ok: boolean,
    rateLimited = false,
  ) =>
    ctx.runMutation(internal.bankFeed.fetchRecordedInternal, {
      actorContext: ctx.actorContext,
      accountId,
      endpoint,
      unattended,
      ok,
      ...(rateLimited ? { rateLimited: true } : {}),
    });
  for (const a of targets.accounts) {
    let feed = { ...a.feed };
    const allowed = unattended ? unattendedAllowed(feed, "transactions", now, day) : { ok: true as const };
    if (!allowed.ok) {
      results.push({ accountId: a.accountId, inserted: 0, skipped: allowed.reason });
      continue;
    }
    let inserted = 0;
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        const r = await provider.fetchTransactions(a.uid, {
          dateFrom: a.dateFrom,
          strategy: "default",
          ...(opts.psu ? { psu: opts.psu } : {}),
        });
        await record(a.accountId, "transactions", true);
        inserted = (await ingest(ctx, a.accountId, r.transactions)).inserted;
        break;
      } catch (e) {
        const kind = kindOf(e);
        log(
          "fetch_failed",
          { accountId: a.accountId, kind, message: e instanceof Error ? e.message : String(e) },
          secrets,
        );
        await record(a.accountId, "transactions", false, kind === "rate_limited");
        if (kind === "reauth" || kind === "jwt_rejected") {
          await ctx.runMutation(internal.bankFeed.pollOutcomeInternal, {
            actorContext: ctx.actorContext,
            outcome: kind === "reauth" ? "reauth" : "jwt_rejected",
          });
          return { skipped: kind, accounts: results };
        }
        if (kind === "transient") {
          feed = {
            ...feed,
            unattendedFetches: {
              day,
              transactions:
                (feed.unattendedFetches?.day === day ? feed.unattendedFetches.transactions : 0) + (unattended ? 1 : 0),
              balances: feed.unattendedFetches?.day === day ? feed.unattendedFetches.balances : 0,
            },
          };
          const again = !unattended || unattendedAllowed(feed, "transactions", ctx.now(), day).ok;
          if (attempt < MAX_TRANSIENT_RETRIES && again) continue;
          transientFailures++;
        }
        break;
      }
    }
    results.push({ accountId: a.accountId, inserted });
    // EC-BNK-06: a gap older than 90 days can no longer come from the feed → statement to-do.
    if (a.lastBooked) {
      const gap = olderGap({ start: addDays(a.lastBooked as CalendarDate, 1), today, complete: false });
      if (gap) gaps.push({ accountId: a.accountId, ...gap });
    }
    // Balances at most once per day unattended (BNK-106) → continuity check (BNK-035, EC-BNK-18).
    if (!unattended || unattendedAllowed(feed, "balances", ctx.now(), day).ok) {
      try {
        const balances = await provider.fetchBalances(a.uid, opts.psu);
        await record(a.accountId, "balances", true);
        const b = balances.find((x) => x.balanceType === "CLBD") ?? balances[0];
        if (b?.balanceAmount) {
          const cents = parseBankAmount(b.balanceAmount.amount, b.balanceAmount.currency);
          if (cents.ok)
            await ctx.runMutation(internal.bankFeed.balanceCheckInternal, {
              actorContext: ctx.actorContext,
              accountId: a.accountId,
              providerCents: cents.value,
              currency: b.balanceAmount.currency.toUpperCase(),
            });
        }
      } catch (e) {
        await record(a.accountId, "balances", false, kindOf(e) === "rate_limited");
      }
    }
  }
  await ctx.runMutation(internal.bankFeed.pollOutcomeInternal, {
    actorContext: ctx.actorContext,
    outcome: transientFailures > 0 && transientFailures === targets.accounts.length ? "transient" : "ok",
    gaps,
  });
  return { skipped: null, accounts: results };
}

// ── setup (BNK-101) ────────────────────────────────────────────────────────────────────────────────────

/**
 * BNK-101 step 2/4: stores the application ID and the private key (generated here as RSA-2048 or uploaded),
 * AES-GCM encrypted with APP_ENCRYPTION_KEY. Returns only the public key for the Control Panel upload.
 */
export const saveSetup = action({
  permission: "bankFeed.setup",
  args: {
    applicationId: v.string(),
    privateKeyPem: v.optional(v.string()),
    generateKey: v.optional(v.boolean()),
    environment: v.optional(v.union(v.literal("production"), v.literal("sandbox"))),
  },
  handler: async (ctx, args): Promise<{ publicKeyPem: string | null; redirectUrl: string }> => {
    const domain = baseDomain();
    if (!domain) throw appError("not_configured", "BASE_DOMAIN fehlt – die Weiterleitungs-URL ist unbekannt.");
    const redirectUrl = redirectUrlFor(domain);
    let key: { encryptedPrivateKeyPem: string; publicKeyPem: string; keySource: "generated" | "uploaded" } | null =
      null;
    if (args.generateKey) {
      const k = await generateApplicationKey();
      key = {
        encryptedPrivateKeyPem: await encryptSecret(k.privateKeyPem),
        publicKeyPem: k.publicKeyPem,
        keySource: "generated",
      };
    } else if (args.privateKeyPem?.trim()) {
      let publicKeyPem: string;
      try {
        publicKeyPem = await publicKeyOf(args.privateKeyPem);
      } catch (e) {
        throw appError("invalid_input", (e as Error).message, { field: "privateKey" });
      }
      key = {
        encryptedPrivateKeyPem: await encryptSecret(args.privateKeyPem.trim()),
        publicKeyPem,
        keySource: "uploaded",
      };
    }
    await ctx.runMutation(internal.bankFeed.saveSetupInternal, {
      actorContext: ctx.actorContext,
      applicationId: args.applicationId,
      redirectUrl,
      ...(key ?? {}),
      ...(args.environment ? { environment: args.environment } : {}),
    });
    log("setup_saved", { keySource: key?.keySource ?? "unchanged" });
    return { publicKeyPem: key?.publicKeyPem ?? null, redirectUrl };
  },
});

/** BNK-102: banks offered by Enable Banking for business accounts (Revolut: LT entry, DE branch if listed). */
export const listAspsps = action({
  permission: "bankFeed.setup",
  args: { country: v.optional(v.string()) },
  handler: async (ctx, { country }) => {
    const { provider } = await providerFor(ctx);
    try {
      return await provider.listAspsps(country);
    } catch (e) {
      throw feedError(e);
    }
  },
});

function feedError(e: unknown) {
  const kind = kindOf(e);
  const message =
    kind === "jwt_rejected" ? FEED_MESSAGES.jwtRejected : redactText(e instanceof Error ? e.message : String(e));
  return appError("bank_feed_error", message, { reason: kind.toUpperCase() });
}

/**
 * BNK-102: `POST /auth` with `psu_type: business`, `valid_until` = min(max validity, 180 days), the redirect URL and a
 * single-use `state` (stored hashed, 10 min). Returns the bank's approval URL for the owner's browser.
 */
export const startConsent = action({
  permission: "bankFeed.setup",
  args: { aspsp: v.optional(v.object({ name: v.string(), country: v.string() })) },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const s = await ctx.runQuery(internal.bankFeed.secretsInternal, {});
    if (!s) throw appError("not_configured", FEED_MESSAGES.notConfigured);
    const { provider } = await providerFor(ctx);
    const want = args.aspsp ?? { name: "Revolut", country: "LT" };
    try {
      const list = await provider.listAspsps(want.country);
      const aspsp = list.find((a) => a.name.toLowerCase() === want.name.toLowerCase() && a.country === want.country);
      if (!aspsp)
        throw appError("invalid_input", `${want.name} (${want.country}) wird von Enable Banking nicht angeboten.`);
      const state = randomState();
      const now = ctx.now();
      const { url } = await provider.startConsent({
        aspsp: { name: aspsp.name, country: aspsp.country },
        validUntil: consentValidUntil(now, aspsp.maximumConsentValidity),
        redirectUrl: s.redirectUrl,
        state,
        psuType: "business",
      });
      await ctx.runMutation(internal.bankFeed.consentStartInternal, {
        actorContext: ctx.actorContext,
        stateHash: await sha256Hex(state),
        expiresAt: now + STATE_TTL_MS,
        aspsp: { name: aspsp.name, country: aspsp.country },
      });
      log("consent_started", { aspsp: aspsp.name, country: aspsp.country });
      return { url };
    } catch (e) {
      if (e instanceof FeedHttpError) {
        if (kindOf(e) === "jwt_rejected")
          await ctx.runMutation(internal.bankFeed.pollOutcomeInternal, {
            actorContext: ctx.actorContext,
            outcome: "jwt_rejected",
          });
        throw feedError(e);
      }
      throw e;
    }
  },
});

/**
 * BNK-102/103/104 the consent callback: verifies and consumes `state` (EC-BNK-80), `POST /sessions { code }`, stores
 * the session encrypted, re-maps the accounts and backfills inside this action (strategy=longest, all pages).
 */
export const completeConsent = action({
  permission: "bankFeed.consent",
  args: { code: v.optional(v.string()), state: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ mapped: number; pendingAccounts: number; missing: number; inserted: number; gaps: number }> => {
    if (args.error || !args.code || !args.state) {
      // Only the bank's own error ends the pending authorisation; a callback without code/state is just refused.
      if (args.error)
        await ctx.runMutation(internal.bankFeed.consentFailedInternal, {
          actorContext: ctx.actorContext,
          message: FEED_MESSAGES.authAborted,
        });
      throw appError("invalid_input", args.error ? FEED_MESSAGES.authAborted : FEED_MESSAGES.callbackInvalid, {
        reason: args.error ? "CONSENT_ABORTED" : "CONSENT_STATE_INVALID",
      });
    }
    await ctx.runMutation(internal.bankFeed.consumeStateInternal, {
      actorContext: ctx.actorContext,
      stateHash: await sha256Hex(args.state),
    });
    const { provider } = await providerFor(ctx);
    let session: Awaited<ReturnType<BankFeedProvider["completeConsent"]>>;
    try {
      session = await provider.completeConsent(args.code);
    } catch (e) {
      const kind = kindOf(e);
      const message = kind === "jwt_rejected" ? FEED_MESSAGES.jwtRejected : FEED_MESSAGES.authAborted;
      log("consent_failed", { kind, message: e instanceof Error ? e.message : String(e) }, [args.code]);
      await ctx.runMutation(internal.bankFeed.consentFailedInternal, { actorContext: ctx.actorContext, message });
      throw appError("invalid_input", message, {
        reason: kind === "jwt_rejected" ? "JWT_REJECTED" : "CONSENT_ABORTED",
      });
    }
    const r: { mapped: MappedAccount[]; pendingAccounts: number; missing: number } = await ctx.runMutation(
      internal.bankFeed.consentCompletedInternal,
      {
        actorContext: ctx.actorContext,
        encryptedSessionId: await encryptSecret(session.sessionId),
        sessionAccounts: session.accounts as EbAccount[],
        validUntil: session.validUntil ?? consentValidUntil(ctx.now(), null),
        ...(session.aspsp ? { aspsp: session.aspsp } : {}),
      },
    );
    log("consent_completed", { accounts: session.accounts.length, mapped: r.mapped.length });
    const b = await backfill(ctx, provider, r.mapped);
    return { mapped: r.mapped.length, pendingAccounts: r.pendingAccounts, missing: r.missing, ...b };
  },
});

/** EC-BNK-91 / SET-050a: map (or create) a new pocket of the consent and backfill it right away. */
export const mapAccount = action({
  permission: "bankFeed.consent",
  args: {
    uid: v.string(),
    accountId: v.optional(v.id("bankAccounts")),
    name: v.optional(v.string()),
    openingBalance: v.optional(v.object({ date: v.string(), amountCents: v.number() })),
  },
  handler: async (ctx, args): Promise<{ accountId: Id<"bankAccounts">; inserted: number; gaps: number }> => {
    const m: MappedAccount = await ctx.runMutation(internal.bankFeed.mapAccountInternal, {
      actorContext: ctx.actorContext,
      ...args,
    });
    const { provider } = await providerFor(ctx);
    return { accountId: m.accountId, ...(await backfill(ctx, provider, [m])) };
  },
});

/**
 * BNK-107 „Jetzt abrufen“: only from the UI for a signed-in member (scope null: no API key or MCP can call it; any
 * other channel → `owner_presence_required`). The Next Server Action forwards the PSU IP/User-Agent.
 */
export const syncNow = action({
  permission: "bankFeed.fetch",
  args: {
    accountId: v.optional(v.id("bankAccounts")),
    psuIpAddress: v.optional(v.string()),
    psuUserAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (ctx.actorContext.channel !== "ui") throw appError("owner_presence_required");
    const psu: PsuHeaders = {
      ...(args.psuIpAddress ? { ipAddress: args.psuIpAddress } : {}),
      ...(args.psuUserAgent ? { userAgent: args.psuUserAgent } : {}),
    };
    return poll(ctx, { ...(args.accountId ? { accountId: args.accountId } : {}), psu });
  },
});

/**
 * BNK-011 / BNK-117: revokes the session (`DELETE /sessions/{id}` when reachable), deletes the session data and on
 * request the private key; transactions, revisions and statements stay, the accounts continue by statement import.
 */
export const disconnect = action({
  permission: "bankFeed.setup",
  args: { deleteKey: v.boolean(), feedLost: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let revoked = false;
    try {
      const { provider, sessionId } = await providerFor(ctx);
      if (sessionId) {
        await provider.revokeSession(sessionId);
        revoked = true;
      }
    } catch (e) {
      log("revoke_failed", { message: e instanceof Error ? e.message : String(e) });
    }
    await ctx.runMutation(internal.bankFeed.disconnectInternal, {
      actorContext: ctx.actorContext,
      deleteKey: args.deleteKey,
      revoked,
      ...(args.feedLost?.trim() ? { feedLost: args.feedLost.trim() } : {}),
    });
    return { revoked };
  },
});

// ── cron bank.sync (BNK-106) ───────────────────────────────────────────────────────────────────────────

export const syncCron = systemAction({
  job: "cron.bank.sync",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    const now = new Date(ctx.now());
    const hour = Number(
      new Intl.DateTimeFormat("de-DE", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }).format(now),
    );
    if (!force && (isTest() || !isPollSlot({ hour, minute: now.getUTCMinutes() }))) return null;
    const secrets = await ctx.runQuery(internal.bankFeed.secretsInternal, {});
    if (!secrets) return null;
    return poll(ctx, {});
  },
});
