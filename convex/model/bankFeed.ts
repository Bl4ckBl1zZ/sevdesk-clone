import { encodeId } from "../../src/domain/api/ids";
import { sha256Hex } from "../../src/domain/audit/chain";
import { formatMoneyDe } from "../../src/domain/banking/amount";
import { dedupeKeys, identicalHashGroups, planImport, toCandidates } from "../../src/domain/banking/dedupe";
import {
  CONNECTION_STATUS_LABEL_DE,
  type ConnectionStatus,
  dueReminder,
  expiryBanner,
  nextConnectionStatus,
  pollingActive,
  redirectUrlFor,
  validityLabel,
} from "../../src/domain/banking/feed/consent";
import { FEED_MESSAGES } from "../../src/domain/banking/feed/messages";
import {
  backfillStart,
  countFetch,
  type FeedEndpoint,
  nextPollAt,
  pollDateFrom,
  RATE_LIMIT_BACKOFF_MS,
  remainingUnattended,
  UNATTENDED_LIMIT,
  usedToday,
} from "../../src/domain/banking/feed/polling";
import { redactText } from "../../src/domain/banking/feed/redact";
import { type MappingProposal, remapAccounts, type SessionAccountView } from "../../src/domain/banking/feed/remap";
import {
  type EbAccount,
  type EbTransaction,
  mapEnableBankingTransactions,
} from "../../src/domain/banking/sources/enable-banking";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { baseDomain } from "../lib/env";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { addStatementAccount, defaultInvoiceAccount } from "./bankAccounts";
import { applyPlan, existingFor, existingRow } from "./bankImport";
import { getCompanyProfile } from "./companyProfile";
import { upsertNotification } from "./salesDocuments";
import type { ModelCtx, ReadCtx } from "./types";
import { emitEvent } from "./webhooks";

/**
 * Enable Banking feed model (F07 BNK-011…117, F01 SET-049…050c). The only writer of `bankConnections`,
 * `bankPendingTransactions` and `bankAccounts.feed`. HTTP calls live in convex/bankFeedNode.ts; everything that
 * touches the database is here. Secrets (`encryptedPrivateKeyPem`, `encryptedSessionId`, `pendingAuth.stateHash`)
 * never leave this module except to the Node actions through `feedSecrets` (BNK-013).
 */

const ERRORS = {
  notConfigured: FEED_MESSAGES.notConfigured,
  callbackInvalid: FEED_MESSAGES.callbackInvalid,
  noConnection: "Es besteht keine Bankverbindung.",
} as const;

export type Connection = Doc<"bankConnections">;

/** The connection row (one per installation; the newest if a sandbox row exists too). */
export async function getConnection(ctx: ReadCtx): Promise<Connection | null> {
  const all = await ctx.db.query("bankConnections").collect();
  return all.filter((c) => c.environment === "production").at(-1) ?? all.at(-1) ?? null;
}

export async function requireConnection(ctx: ReadCtx): Promise<Connection> {
  const c = await getConnection(ctx);
  if (!c) throw appError("not_configured", ERRORS.noConnection);
  return c;
}

const fmtTime = (at: number) => {
  const d = new Date(at);
  const hm = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(
    d,
  );
  return `${formatGermanDate(berlinCalendarDate(at))} ${hm} Uhr`;
};

async function setStatus(ctx: ModelCtx, c: Connection, next: ConnectionStatus | null, extra: Partial<Connection> = {}) {
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    { ...(next && next !== c.status ? { status: next } : {}), ...extra },
    { action: "bank.feed_status", label: next ?? c.status },
  );
}

// ── setup (BNK-101, BNK-013) ───────────────────────────────────────────────────────────────────────────────

export async function saveSetup(
  ctx: ModelCtx,
  args: {
    applicationId: string;
    encryptedPrivateKeyPem?: string;
    publicKeyPem?: string;
    keySource?: "generated" | "uploaded";
    redirectUrl: string;
    environment?: "production" | "sandbox";
  },
): Promise<Id<"bankConnections">> {
  const applicationId = args.applicationId.trim();
  if (!/^[A-Za-z0-9._-]{4,100}$/.test(applicationId))
    throw appError("invalid_input", "Bitte eine gültige Anwendungs-ID von Enable Banking angeben.", {
      field: "applicationId",
    });
  const c = await getConnection(ctx);
  const key: { encryptedPrivateKeyPem?: string; publicKeyPem?: string; keySource?: "generated" | "uploaded" } =
    args.encryptedPrivateKeyPem && args.publicKeyPem
      ? {
          encryptedPrivateKeyPem: args.encryptedPrivateKeyPem,
          publicKeyPem: args.publicKeyPem,
          ...(args.keySource ? { keySource: args.keySource } : {}),
        }
      : {};
  if (!c) {
    if (!key.encryptedPrivateKeyPem) throw appError("invalid_input", ERRORS.notConfigured, { field: "privateKey" });
    return auditedInsert(
      ctx,
      "bankConnections",
      {
        provider: "enable_banking",
        environment: args.environment ?? "production",
        applicationId,
        ...key,
        redirectUrl: args.redirectUrl,
        consentReminders: [],
        status: "pending_consent",
        evaluationConfirmation: { status: "pending" },
        createdAt: ctx.now(),
      },
      { action: "bank.feed_setup", label: "Enable Banking" },
    );
  }
  if (!key.encryptedPrivateKeyPem && !c.encryptedPrivateKeyPem)
    throw appError("invalid_input", ERRORS.notConfigured, { field: "privateKey" });
  // EC-BNK-29: sandbox and production never share a live connection — switch only when disconnected.
  if (
    args.environment &&
    args.environment !== c.environment &&
    (c.status === "active" || c.status === "error" || c.status === "reauth_required")
  )
    throw appError("invalid_input", FEED_MESSAGES.environmentSwitch, { field: "environment" });
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      applicationId,
      ...key,
      redirectUrl: args.redirectUrl,
      ...(args.environment ? { environment: args.environment } : {}),
      status: nextConnectionStatus(c.status, "setup_saved") ?? c.status,
      ...(c.status === "error" ? { status: "pending_consent" as const, lastError: undefined } : {}),
    },
    { action: "bank.feed_setup", label: "Enable Banking" },
  );
  return c._id;
}

/** Encrypted secrets for the Node actions only (never returned by a public function). */
export async function feedSecrets(ctx: ReadCtx) {
  const c = await getConnection(ctx);
  if (!c?.applicationId || !c.encryptedPrivateKeyPem) return null;
  return {
    connectionId: c._id,
    status: c.status,
    applicationId: c.applicationId,
    encryptedPrivateKeyPem: c.encryptedPrivateKeyPem,
    encryptedSessionId: c.encryptedSessionId ?? null,
    redirectUrl: c.redirectUrl,
  };
}

// ── consent (BNK-102, EC-BNK-80) ───────────────────────────────────────────────────────────────────────────

export async function recordConsentStart(
  ctx: ModelCtx,
  args: { stateHash: string; expiresAt: number; aspsp: { name: string; country: string } },
) {
  const c = await requireConnection(ctx);
  if (!c.applicationId || !c.encryptedPrivateKeyPem) throw appError("invalid_input", ERRORS.notConfigured);
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      pendingAuth: { stateHash: args.stateHash, expiresAt: args.expiresAt },
      aspsp: args.aspsp,
      consentStartedAt: ctx.now(),
      status: nextConnectionStatus(c.status, "consent_started") ?? c.status,
    },
    { action: "bank.feed_consent_start", label: `${args.aspsp.name} (${args.aspsp.country})` },
  );
}

/** EC-BNK-80: the `state` must match the stored hash and be unexpired; it is consumed (single use). */
export async function consumeState(ctx: ModelCtx, stateHash: string): Promise<void> {
  const c = await requireConnection(ctx);
  const p = c.pendingAuth;
  if (!p || p.stateHash !== stateHash || p.expiresAt < ctx.now()) {
    throw appError("invalid_input", ERRORS.callbackInvalid, { reason: "CONSENT_STATE_INVALID" });
  }
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    { pendingAuth: undefined },
    { action: "bank.feed_consent_start", label: "state consumed" },
  );
}

/** T-SET-104: an aborted/expired authorisation keeps `pending_consent` with the German error. */
export async function recordConsentFailure(ctx: ModelCtx, message: string) {
  const c = await getConnection(ctx);
  if (!c) return;
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    { lastError: redactText(message), lastErrorAt: ctx.now(), pendingAuth: undefined },
    { action: "bank.feed_consent_failed" },
  );
}

const lastBooked = async (ctx: ReadCtx, accountId: Id<"bankAccounts">): Promise<string | undefined> =>
  (
    await ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (q) => q.eq("accountId", accountId))
      .order("desc")
      .first()
  )?.bookingDate;

async function fallbackStart(ctx: ReadCtx): Promise<string> {
  const profile = await getCompanyProfile(ctx);
  const start = profile?.bookkeepingStartDate;
  return start ?? `${berlinCalendarDate(Date.now()).slice(0, 4)}-01-01`;
}

/** Fetch window of a mapped account: a new account → backfill start (BNK-103); a renewal → 10 days overlap (BNK-105). */
export async function fetchStartFor(ctx: ReadCtx, account: Doc<"bankAccounts">): Promise<string> {
  const last = await lastBooked(ctx, account._id);
  const fallback = await fallbackStart(ctx);
  if (last) return pollDateFrom(last, account.openingBalance?.date ?? "0000-01-01");
  return backfillStart({
    ...(account.openingBalance ? { openingBalanceDate: account.openingBalance.date } : {}),
    fallback,
  });
}

export interface MappedAccount {
  accountId: Id<"bankAccounts">;
  uid: string;
  dateFrom: string;
}

/**
 * BNK-102/104, SET-050a/050c: stores the session, re-maps the consent's accounts (IBAN → identification hash, never
 * uid), parks unknown pockets for the owner (EC-BNK-91), warns about missing ones (EC-BNK-92), applies IBAN/holder
 * changes for future documents and archives accounts the bank reports closed. Returns the accounts to backfill.
 */
export async function completeConsent(
  ctx: ModelCtx,
  args: {
    encryptedSessionId: string;
    sessionAccounts: EbAccount[];
    validUntil: number;
    aspsp?: { name: string; country: string };
  },
): Promise<{ mapped: MappedAccount[]; pendingAccounts: number; missing: number }> {
  const c = await requireConnection(ctx);
  const accounts = await ctx.db.query("bankAccounts").collect();
  const r = remapAccounts({
    connectionId: c._id,
    sessionAccounts: args.sessionAccounts,
    existing: accounts.map((a) => ({
      id: a._id,
      name: a.name,
      currency: a.currency,
      ...(a.iban ? { iban: a.iban } : {}),
      accountHolder: a.accountHolder,
      ...(a.archivedAt !== undefined ? { archived: true } : {}),
      ...(a.feed
        ? {
            feed: {
              connectionId: a.feed.connectionId,
              ...(a.feed.identificationHash ? { identificationHash: a.feed.identificationHash } : {}),
            },
          }
        : {}),
    })),
  });
  const now = ctx.now();
  const mapped: MappedAccount[] = [];
  for (const p of r.proposals) {
    if (p.kind !== "matched") continue;
    const account = accounts.find((a) => a._id === p.accountId) as Doc<"bankAccounts">;
    await linkAccount(ctx, account, c._id, p.account);
    if (!r.closed.includes(p.accountId))
      mapped.push({ accountId: account._id, uid: p.uid, dateFrom: await fetchStartFor(ctx, account) });
  }
  for (const ch of r.changes) await applyAccountChange(ctx, ch.accountId as Id<"bankAccounts">, ch.field, ch.after);
  for (const id of r.closed) await closeAccount(ctx, id as Id<"bankAccounts">);
  for (const m of r.missing) {
    const a = accounts.find((x) => x._id === m.accountId) as Doc<"bankAccounts">;
    if (a.feed) {
      await auditedPatch(
        ctx,
        "bankAccounts",
        a._id,
        { feed: { ...a.feed, providerAccountUid: undefined, missingSince: now } },
        { action: "bank.feed_account_map", label: a.name },
      );
    }
    await upsertNotification(ctx, {
      kind: "bank.feed_account_missing",
      severity: "warning",
      title: m.message,
      link: "/einstellungen/bank/verbindung",
      entity: { table: "bankAccounts", id: a._id },
      dedupeKey: `bank.feed_account_missing:${a._id}:${now}`,
    });
  }
  const pendingAccounts = r.proposals
    .filter((p): p is Extract<MappingProposal, { kind: "new" }> => p.kind === "new")
    .map((p) => pendingView(p.account));
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      encryptedSessionId: args.encryptedSessionId,
      validUntil: args.validUntil,
      ...(args.aspsp ? { aspsp: args.aspsp } : {}),
      consentReminders: [],
      consentPeriods: [...(c.consentPeriods ?? []), { from: now, until: args.validUntil }],
      pendingAccounts,
      status: nextConnectionStatus(c.status, "consent_completed") ?? "active",
      lastError: undefined,
      lastErrorAt: undefined,
      outageSince: undefined,
      feedLost: undefined,
      disconnectedAt: undefined,
      backfill: {
        startedAt: now,
        from: mapped.map((m) => m.dateFrom).sort()[0] ?? berlinCalendarDate(now),
        ok: false,
        accounts: mapped.length,
        done: 0,
        inserted: 0,
      },
    },
    { action: "bank.connect", label: args.aspsp?.name ?? c.aspsp?.name ?? "Enable Banking" },
  );
  // Resolve a pending renewal reminder / reauth banner.
  for (const n of await ctx.db
    .query("notifications")
    .withIndex("by_entity", (q) => q.eq("entity.table", "bankConnections").eq("entity.id", c._id))
    .collect()) {
    if (n.resolvedAt === undefined)
      await auditedPatch(ctx, "notifications", n._id, { resolvedAt: now }, { action: "notification.resolve" });
  }
  return { mapped, pendingAccounts: pendingAccounts.length, missing: r.missing.length };
}

const pendingView = (a: SessionAccountView) => ({
  uid: a.uid,
  ...(a.identificationHash ? { identificationHash: a.identificationHash } : {}),
  ...(a.iban ? { iban: a.iban } : {}),
  currency: a.currency,
  ...(a.name ? { name: a.name } : {}),
  ...(a.holderName ? { holderName: a.holderName } : {}),
  localDetails: a.localDetails,
});

async function linkAccount(
  ctx: ModelCtx,
  account: Doc<"bankAccounts">,
  connectionId: Id<"bankConnections">,
  a: Pick<SessionAccountView, "uid" | "identificationHash">,
) {
  await auditedPatch(
    ctx,
    "bankAccounts",
    account._id,
    {
      feed: {
        connectionId,
        providerAccountUid: a.uid,
        ...(a.identificationHash
          ? { identificationHash: a.identificationHash }
          : account.feed?.identificationHash
            ? { identificationHash: account.feed.identificationHash }
            : {}),
        ...(account.feed?.lastPolledAt ? { lastPolledAt: account.feed.lastPolledAt } : {}),
        ...(account.feed?.backoffUntil ? { backoffUntil: account.feed.backoffUntil } : {}),
        ...(account.feed?.unattendedFetches ? { unattendedFetches: account.feed.unattendedFetches } : {}),
      },
    },
    { action: "bank.feed_account_map", label: account.name },
  );
}

/** SET-050c: an IBAN / holder change from the bank updates the account for future documents (snapshots keep theirs). */
async function applyAccountChange(
  ctx: ModelCtx,
  id: Id<"bankAccounts">,
  field: "iban" | "accountHolder",
  value: string,
) {
  const a = await ctx.db.get(id);
  if (!a) return;
  await auditedPatch(ctx, "bankAccounts", id, { [field]: value } as Partial<Doc<"bankAccounts">>, {
    action: "bank.feed_account_update",
    label: a.name,
    reason: field === "iban" ? "IBAN laut Bank geändert" : "Kontoinhaber laut Bank geändert",
  });
}

/**
 * SET-050c / EC-114: a closed account is archived and removed as invoice default; the next account of the currency
 * becomes the default; the owner is notified (with the hint on Rechnungsberichtigungen for open invoices).
 */
async function closeAccount(ctx: ModelCtx, id: Id<"bankAccounts">) {
  const a = await ctx.db.get(id);
  if (!a || a.archivedAt !== undefined) return;
  await auditedPatch(
    ctx,
    "bankAccounts",
    id,
    { archivedAt: ctx.now(), isDefaultForInvoices: false, showOnInvoices: false },
    { action: "bank.feed_account_update", label: a.name, reason: "Konto laut Bank geschlossen" },
  );
  if (a.isDefaultForInvoices) {
    const next = (await ctx.db.query("bankAccounts").collect()).find(
      (x) => x._id !== id && x.archivedAt === undefined && x.currency === a.currency && x.showOnInvoices && x.iban,
    );
    if (next)
      await auditedPatch(
        ctx,
        "bankAccounts",
        next._id,
        { isDefaultForInvoices: true },
        { action: "bank.feed_account_update", label: next.name },
      );
  }
  const openInvoices = (
    await ctx.db
      .query("salesDocuments")
      .withIndex("by_paymentStatus_due", (q) => q.eq("paymentStatus", "open"))
      .collect()
  ).filter((d) => d.type === "invoice" && d.status !== "draft" && d.status !== "cancelled");
  await upsertNotification(ctx, {
    kind: "bank.account_closed",
    severity: "warning",
    title: FEED_MESSAGES.accountClosed(a.name),
    ...(openInvoices.length
      ? { body: `${openInvoices.length} offene Rechnung(en) nennen möglicherweise noch dieses Konto.` }
      : {}),
    link: "/rechnungen",
    entity: { table: "bankAccounts", id },
    dedupeKey: `bank.account_closed:${id}`,
  });
  if (!(await defaultInvoiceAccount(ctx, a.currency)) && a.showOnInvoices) {
    await upsertNotification(ctx, {
      kind: "bank.invoice_account_missing",
      severity: "warning",
      title: FEED_MESSAGES.onlyInvoiceAccountClosed(a.currency),
      link: "/einstellungen/bank",
      dedupeKey: `bank.invoice_account_missing:${a.currency}`,
    });
  }
}

/**
 * EC-BNK-91 / SET-050a: the owner maps a new pocket to an existing account or creates a `bank` account for it (IBAN
 * and holder from the bank, never typed; no IBAN → local details in the name, not printable on invoices).
 */
export async function mapPendingAccount(
  ctx: ModelCtx,
  args: {
    uid: string;
    target:
      | { accountId: Id<"bankAccounts"> }
      | { create: { name?: string; openingBalance?: { date: string; amountCents: number } } };
  },
): Promise<MappedAccount> {
  const c = await requireConnection(ctx);
  const p = (c.pendingAccounts ?? []).find((x) => x.uid === args.uid);
  if (!p) throw appError("not_found", "Dieses Konto wartet nicht auf eine Zuordnung.");
  let account: Doc<"bankAccounts">;
  if ("accountId" in args.target) {
    const a = await ctx.db.get(args.target.accountId);
    if (!a || a.archivedAt !== undefined) throw appError("not_found", "Das Bankkonto existiert nicht.");
    if (a.currency !== p.currency)
      throw appError("invalid_input", `Das Konto führt ${a.currency}, die Bank meldet ${p.currency}.`);
    account = a;
  } else {
    const profile = await getCompanyProfile(ctx);
    const local = p.localDetails.map((d) => `${d.scheme} ${d.identification}`).join(", ");
    const name =
      args.target.create.name?.trim() || `Revolut ${p.currency}${!p.iban && local ? ` (${local})` : ""}`.slice(0, 100);
    const id = await addStatementAccount(
      ctx,
      {
        name,
        currency: p.currency,
        iban: p.iban ?? "",
        bic: "",
        accountHolder: p.holderName ?? profile?.name ?? name,
        showOnInvoices: false,
        // Defaults of addStatementAccount: next free bank ledger account; the opening balance is booked below.
        kind: "bank",
        ledgerAccount: "",
        openingDate: "",
        openingAmount: "",
      },
      profile?.chartOfAccounts.at(-1)?.chart ?? "SKR03",
    );
    if (args.target.create.openingBalance)
      await auditedPatch(
        ctx,
        "bankAccounts",
        id,
        { openingBalance: args.target.create.openingBalance },
        { action: "bank.feed_account_map", label: name },
      );
    account = (await ctx.db.get(id)) as Doc<"bankAccounts">;
  }
  await linkAccount(ctx, account, c._id, p);
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    { pendingAccounts: (c.pendingAccounts ?? []).filter((x) => x.uid !== args.uid) },
    { action: "bank.feed_account_map", label: account.name },
  );
  const fresh = (await ctx.db.get(account._id)) as Doc<"bankAccounts">;
  return { accountId: account._id, uid: args.uid, dateFrom: await fetchStartFor(ctx, fresh) };
}

// ── ingest (BNK-109/110/111/113) ───────────────────────────────────────────────────────────────────────────

export interface IngestResult {
  insertedIds: Id<"bankTransactions">[];
  counts: {
    total: number;
    new: number;
    duplicates: number;
    merged: number;
    conflicts: number;
    possibleDuplicates: number;
  };
  rejected: number;
  earliest?: string;
}

/**
 * Booked feed rows run through the same dedupe plan as statement files (BNK-109/110): `entry_reference` keys,
 * content hash + ordinal otherwise, cross-source merge with CAMT/CSV rows, differing re-deliveries as
 * `applied: false` revisions (BNK-113). The caller passes whole booking days (identical same-day rows must be in one
 * batch for the ordinal).
 */
export async function ingestFeedRows(
  ctx: ModelCtx,
  args: { accountId: Id<"bankAccounts">; rows: EbTransaction[] },
): Promise<IngestResult> {
  const account = await ctx.db.get(args.accountId);
  if (!account) throw appError("not_found");
  const mapped = mapEnableBankingTransactions(args.rows, account.currency);
  const booked = mapped.booked.filter((t) => t.currency === account.currency);
  // EC-BNK-29: sandbox data never enters the books (no rows, no revisions, no reports).
  if ((await getConnection(ctx))?.environment === "sandbox") {
    return {
      insertedIds: [],
      counts: { total: booked.length, new: 0, duplicates: 0, merged: 0, conflicts: 0, possibleDuplicates: 0 },
      rejected: 0,
    };
  }
  const candidates = await toCandidates(account._id, booked);
  const keys = dedupeKeys(account._id, candidates);
  const existing = (await existingFor(ctx, account._id, candidates, keys)).map(existingRow);
  const plan = planImport({ accountId: account._id, kind: "enable_banking", candidates, existing });
  const dates = booked.map((t) => t.bookingDate).sort();
  const changed = plan.counts.new + plan.counts.merged + plan.counts.conflicts + plan.counts.possibleDuplicates;
  let importId: Id<"bankImports"> | undefined;
  const now = ctx.now();
  if (changed > 0 || mapped.issues.length > 0) {
    importId = await auditedInsert(
      ctx,
      "bankImports",
      {
        accountId: account._id,
        source: "enable_banking",
        periodFrom: dates[0] ?? berlinCalendarDate(now),
        periodTo: dates.at(-1) ?? berlinCalendarDate(now),
        counts: {
          total: plan.counts.total,
          inserted: plan.counts.new,
          duplicates: plan.counts.duplicates,
          mergedCrossSource: plan.counts.merged,
          possibleDuplicates: plan.counts.possibleDuplicates,
          conflicts: plan.counts.conflicts,
          rejected: mapped.issues.length,
        },
        at: now,
        actor: ctx.actor,
      },
      { action: "bank.feed_poll", label: account.name },
    );
  }
  const applied = await applyPlan(ctx, { account, plan, keys, kind: "enable_banking", importId, now });
  if (importId) {
    await auditedPatch(
      ctx,
      "bankImports",
      importId,
      { rowIds: applied.rowIds as Id<"bankTransactions">[] },
      { action: "bank.feed_poll", label: account.name },
    );
  }
  return {
    insertedIds: applied.insertedIds,
    counts: plan.counts,
    rejected: mapped.issues.length,
    ...(dates[0] ? { earliest: dates[0] } : {}),
  };
}

/** BNK-111: the account's provisional rows are replaced by the PDNG rows of this poll (never booked or matched). */
export async function replacePendingRows(ctx: ModelCtx, accountId: Id<"bankAccounts">, rows: EbTransaction[]) {
  const account = await ctx.db.get(accountId);
  if (!account) throw appError("not_found");
  const { pending } = mapEnableBankingTransactions(rows, account.currency);
  for (const old of await ctx.db
    .query("bankPendingTransactions")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect()) {
    await auditedDelete(ctx, "bankPendingTransactions", old._id, { action: "bank.feed_pending" });
  }
  const now = ctx.now();
  for (const p of pending) {
    await auditedInsert(
      ctx,
      "bankPendingTransactions",
      {
        accountId,
        ...(p.entryReference ? { entryReference: p.entryReference } : {}),
        ...(p.bookingDate ? { bookingDate: p.bookingDate } : {}),
        amountCents: p.amountCents,
        currency: p.currency,
        ...(p.counterpartyName ? { counterpartyName: p.counterpartyName } : {}),
        purpose: p.purpose,
        fetchedAt: now,
        rawSha256: await sha256Hex(p.raw),
      },
      { action: "bank.feed_pending", label: `${p.bookingDate ?? ""} ${p.amountCents}` },
    );
  }
  return pending.length;
}

// ── polling state (BNK-106/107, EC-BNK-06/82/86) ──────────────────────────────────────────────────────────

/** Accounts the poll fetches: linked to the connection, current uid, not archived. */
export async function pollTargets(ctx: ReadCtx, accountId?: Id<"bankAccounts">) {
  const c = await getConnection(ctx);
  if (!c) return { connection: null, accounts: [] };
  const all = await ctx.db.query("bankAccounts").collect();
  const accounts = [];
  for (const a of all) {
    if (a.archivedAt !== undefined || a.feed?.connectionId !== c._id || !a.feed.providerAccountUid) continue;
    if (accountId && a._id !== accountId) continue;
    accounts.push({
      accountId: a._id,
      name: a.name,
      currency: a.currency,
      uid: a.feed.providerAccountUid,
      feed: { backoffUntil: a.feed.backoffUntil, unattendedFetches: a.feed.unattendedFetches },
      dateFrom: await fetchStartFor(ctx, a),
      lastBooked: (await lastBooked(ctx, a._id)) ?? null,
      openingBalance: a.openingBalance ?? null,
    });
  }
  return { connection: { id: c._id, status: c.status, polling: pollingActive(c.status) }, accounts };
}

/** Counts one logical fetch (unattended only) and records 429 backoff (BNK-106, EC-BNK-86). */
export async function recordFetch(
  ctx: ModelCtx,
  args: {
    accountId: Id<"bankAccounts">;
    endpoint: FeedEndpoint;
    unattended: boolean;
    rateLimited?: boolean;
    ok: boolean;
  },
) {
  const a = await ctx.db.get(args.accountId);
  if (!a?.feed) return;
  const now = ctx.now();
  const day = berlinCalendarDate(now);
  const feed = {
    ...a.feed,
    ...(args.unattended ? { unattendedFetches: countFetch(a.feed, args.endpoint, day) } : {}),
    ...(args.ok ? { lastPolledAt: now } : {}),
    ...(args.rateLimited ? { backoffUntil: now + RATE_LIMIT_BACKOFF_MS } : {}),
  };
  await auditedPatch(ctx, "bankAccounts", a._id, { feed }, { action: "bank.feed_poll", label: a.name });
  if (args.rateLimited) {
    await upsertNotification(ctx, {
      kind: "bank.feed_rate_limited",
      severity: "info",
      title: FEED_MESSAGES.rateLimited(fmtTime(now + RATE_LIMIT_BACKOFF_MS)),
      link: "/bank",
      entity: { table: "bankAccounts", id: a._id },
      dedupeKey: `bank.feed_rate_limited:${a._id}:${day}`,
    });
  }
}

/** The outcome of a poll run → status (§4.1) and the EC-BNK-06/81/82 notices. */
export async function recordPollOutcome(
  ctx: ModelCtx,
  args: {
    outcome: "ok" | "reauth" | "jwt_rejected" | "transient";
    message?: string;
    gaps?: { accountId: Id<"bankAccounts">; from: string; to: string }[];
  },
) {
  const c = await getConnection(ctx);
  if (!c) return;
  const now = ctx.now();
  if (args.outcome === "ok") {
    await setStatus(ctx, c, nextConnectionStatus(c.status, "poll_ok"), {
      lastSuccessfulPollAt: now,
      outageSince: undefined,
      ...(c.status === "error" ? { lastError: undefined } : {}),
    });
  } else if (args.outcome === "reauth") {
    await setStatus(ctx, c, nextConnectionStatus(c.status, "reauth"), {
      lastError: FEED_MESSAGES.reauth(fmtTime(now)),
      lastErrorAt: now,
    });
    await upsertNotification(ctx, {
      kind: "bank.feed_reauth",
      severity: "warning",
      title: FEED_MESSAGES.reauth(fmtTime(now)),
      link: "/einstellungen/bank/verbindung",
      entity: { table: "bankConnections", id: c._id },
      dedupeKey: `bank.feed_reauth:${c._id}:${c.validUntil ?? 0}`,
    });
  } else if (args.outcome === "jwt_rejected") {
    await setStatus(ctx, c, nextConnectionStatus(c.status, "jwt_rejected"), {
      lastError: FEED_MESSAGES.jwtRejected,
      lastErrorAt: now,
    });
  } else {
    const since = c.outageSince ?? now;
    await setStatus(ctx, c, nextConnectionStatus(c.status, "transient"), {
      outageSince: since,
      lastError: FEED_MESSAGES.outage(fmtTime(since)),
      lastErrorAt: now,
    });
  }
  for (const g of args.gaps ?? []) await gapTodo(ctx, g);
}

/** EC-BNK-88 / EC-BNK-06: history the feed cannot deliver any more → statement-import to-do. */
export async function gapTodo(ctx: ModelCtx, g: { accountId: Id<"bankAccounts">; from: string; to: string }) {
  const a = await ctx.db.get(g.accountId);
  await upsertNotification(ctx, {
    kind: "bank.statement_gap",
    severity: "warning",
    title: FEED_MESSAGES.backfillGap(formatGermanDate(g.from as CalendarDate), formatGermanDate(g.to as CalendarDate)),
    ...(a ? { body: a.name } : {}),
    link: `/bank/${g.accountId}`,
    entity: { table: "bankAccounts", id: g.accountId },
    dedupeKey: `bank.statement_gap:${g.accountId}:${g.from}:${g.to}`,
  });
}

export async function recordBackfillProgress(
  ctx: ModelCtx,
  args: { done?: number; inserted?: number; finished?: { ok: boolean; error?: string } },
) {
  const c = await requireConnection(ctx);
  if (!c.backfill) return;
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      backfill: {
        ...c.backfill,
        ...(args.done !== undefined ? { done: args.done } : {}),
        ...(args.inserted !== undefined ? { inserted: (c.backfill.inserted ?? 0) + args.inserted } : {}),
        ...(args.finished
          ? {
              finishedAt: ctx.now(),
              ok: args.finished.ok,
              ...(args.finished.error ? { error: redactText(args.finished.error) } : {}),
            }
          : {}),
      },
    },
    { action: "bank.feed_backfill" },
  );
}

/** BNK-035 / EC-BNK-18: the bank's booked balance vs opening balance + Σ booked rows (pending excluded). */
export async function recordBalanceCheck(
  ctx: ModelCtx,
  args: { accountId: Id<"bankAccounts">; providerCents: number; currency: string },
) {
  const a = await ctx.db.get(args.accountId);
  const c = await getConnection(ctx);
  if (!a || !c || c.environment === "sandbox" || !a.openingBalance || args.currency !== a.currency) return null;
  const rows = await ctx.db
    .query("bankTransactions")
    .withIndex("by_account_bookingDate", (q) =>
      q.eq("accountId", a._id).gt("bookingDate", a.openingBalance?.date ?? ""),
    )
    .collect();
  const ours =
    a.openingBalance.amountCents +
    rows.filter((r) => r.ignoredReason !== "import_rolled_back").reduce((s, r) => s + r.amountCents, 0);
  const diff = args.providerCents - ours;
  const prev = c.lastBalanceCheck?.diffs.filter((d) => d.accountId !== a._id) ?? [];
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      lastBalanceCheck: {
        at: ctx.now(),
        ok: diff === 0 && prev.every((d) => d.diffCents === 0),
        diffs: [...prev, { accountId: a._id, diffCents: diff }],
      },
    },
    { action: "bank.feed_poll", label: a.name },
  );
  if (diff !== 0) {
    await upsertNotification(ctx, {
      kind: "bank.balance_mismatch",
      severity: "warning",
      title: FEED_MESSAGES.balanceMismatch(
        formatMoneyDe(args.providerCents, a.currency),
        formatMoneyDe(ours, a.currency),
      ),
      body: a.name,
      link: `/bank/${a._id}`,
      entity: { table: "bankAccounts", id: a._id },
      dedupeKey: `bank.balance_mismatch:${a._id}:${berlinCalendarDate(ctx.now())}`,
    });
    // EC-BNK-89: identical rows without a bank reference are the first suspects when the count is not confirmed.
    for (const g of identicalHashGroups(rows.filter((r) => r.ignoredReason !== "import_rolled_back"))) {
      await upsertNotification(ctx, {
        kind: "bank.identical_rows",
        severity: "warning",
        title: FEED_MESSAGES.identicalRows(g.count, formatGermanDate(g.bookingDate as CalendarDate)),
        body: a.name,
        link: `/bank/${a._id}`,
        entity: { table: "bankAccounts", id: a._id },
        dedupeKey: `bank.identical_rows:${a._id}:${g.contentHash}:${g.count}`,
      });
    }
  }
  return diff;
}

// ── reminders (BNK-105, EC-BNK-83) ─────────────────────────────────────────────────────────────────────────

/** 05 §5.3 bank consent events: the connection and the consent end — no session or account data. */
const consentObject = (id: Id<"bankConnections">, validUntil: number, at: number) => ({
  id: encodeId("bankConnections", id),
  object: "bank_consent",
  valid_until: new Date(validUntil).toISOString(),
  updated_at: new Date(at).toISOString(),
});

export async function remindConsentExpiry(ctx: ModelCtx): Promise<{ notified: number | null; expired: boolean }> {
  const c = await getConnection(ctx);
  if (!c || c.validUntil === undefined || (c.status !== "active" && c.status !== "error"))
    return { notified: null, expired: false };
  const now = ctx.now();
  if (c.validUntil <= now) {
    await recordPollOutcome(ctx, { outcome: "reauth" });
    // BNK-080 (once: the connection leaves `active`, so the next run returns early)
    await emitEvent(ctx, "bank_consent.expired", consentObject(c._id, c.validUntil, now));
    return { notified: null, expired: true };
  }
  const due = dueReminder(
    c.validUntil,
    now,
    c.consentReminders.map((r) => r.daysBefore),
  );
  if (!due) return { notified: null, expired: false };
  await upsertNotification(ctx, {
    kind: "bank.consent_expiring",
    severity: due.daysBefore === 0 ? "error" : "warning",
    title: due.message,
    link: "/einstellungen/bank/verbindung",
    entity: { table: "bankConnections", id: c._id },
    dedupeKey: `bank.consent_expiring:${c._id}:${c.validUntil}:${due.daysBefore}`,
  });
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      consentReminders: [
        ...c.consentReminders,
        ...[due.daysBefore, ...due.alsoHandled].map((d) => ({ daysBefore: d, notifiedAt: now })),
      ],
    },
    { action: "bank.feed_reminder", label: `T−${due.daysBefore}` },
  );
  // BNK-080 bank_consent.expiring at T−14 / T−3 / T−0
  await emitEvent(ctx, "bank_consent.expiring", {
    ...consentObject(c._id, c.validUntil, now),
    days_before: due.daysBefore,
  });
  return { notified: due.daysBefore, expired: false };
}

// ── disconnect, feed loss, provider record (BNK-011, BNK-116, BNK-117) ─────────────────────────────────────

export async function disconnect(
  ctx: ModelCtx,
  args: { deleteKey: boolean; revoked: boolean; feedLost?: string },
): Promise<void> {
  const c = await requireConnection(ctx);
  const now = ctx.now();
  for (const a of await ctx.db.query("bankAccounts").collect()) {
    if (a.feed?.connectionId !== c._id || !a.feed.providerAccountUid) continue;
    await auditedPatch(
      ctx,
      "bankAccounts",
      a._id,
      { feed: { ...a.feed, providerAccountUid: undefined } },
      { action: "bank.disconnect", label: a.name },
    );
  }
  for (const a of await ctx.db.query("bankAccounts").collect()) {
    for (const p of await ctx.db
      .query("bankPendingTransactions")
      .withIndex("by_account", (q) => q.eq("accountId", a._id))
      .collect())
      await auditedDelete(ctx, "bankPendingTransactions", p._id, { action: "bank.disconnect" });
  }
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      status: "disconnected",
      encryptedSessionId: undefined,
      pendingAuth: undefined,
      pendingAccounts: undefined,
      disconnectedAt: now,
      ...(args.deleteKey ? { encryptedPrivateKeyPem: undefined, publicKeyPem: undefined, keySource: undefined } : {}),
      ...(args.feedLost ? { feedLost: { at: now, reason: args.feedLost.slice(0, 500) } } : {}),
    },
    {
      action: args.feedLost ? "bank.feed_lost" : "bank.disconnect",
      label: "Enable Banking",
      reason: [
        args.revoked ? "Sitzung widerrufen" : "Sitzung nicht erreichbar",
        args.deleteKey ? "Schlüssel gelöscht" : "",
      ]
        .filter(Boolean)
        .join(", "),
    },
  );
  if (args.feedLost) {
    await upsertNotification(ctx, {
      kind: "bank.feed_lost",
      severity: "warning",
      title: FEED_MESSAGES.feedLost,
      link: "/bank",
      entity: { table: "bankConnections", id: c._id },
      dedupeKey: `bank.feed_lost:${c._id}:${now}`,
    });
  }
}

export async function recordConfirmation(
  ctx: ModelCtx,
  args: {
    status: "pending" | "confirmed" | "quoted" | "declined";
    note?: string;
    file?: Doc<"bankConnections">["evaluationConfirmation"]["file"];
  },
) {
  const c = await requireConnection(ctx);
  await auditedPatch(
    ctx,
    "bankConnections",
    c._id,
    {
      evaluationConfirmation: {
        status: args.status,
        recordedAt: ctx.now(),
        ...(args.note?.trim() ? { note: args.note.trim().slice(0, 1000) } : {}),
        ...(args.file
          ? { file: args.file }
          : c.evaluationConfirmation.file
            ? { file: c.evaluationConfirmation.file }
            : {}),
      },
    },
    { action: "bank.feed_confirmation", label: args.status },
  );
}

// ── views (SET-049a, BNK-101, BNK-116) ─────────────────────────────────────────────────────────────────────

const CONFIRMATION_LABEL_DE = {
  pending: "Angefragt, Antwort ausstehend",
  confirmed: "Schriftlich bestätigt",
  quoted: "Preisangebot erhalten",
  declined: "Abgelehnt",
} as const;

/** The connection card/page model — never contains a secret (BNK-013). */
export async function connectionView(ctx: ReadCtx, now: number) {
  const c = await getConnection(ctx);
  const accounts = (await ctx.db.query("bankAccounts").collect()).filter(
    (a) => a.archivedAt === undefined && c && a.feed?.connectionId === c._id,
  );
  const day = berlinCalendarDate(now);
  const pending = new Map<string, number>();
  for (const a of accounts) {
    pending.set(
      a._id,
      (
        await ctx.db
          .query("bankPendingTransactions")
          .withIndex("by_account", (q) => q.eq("accountId", a._id))
          .collect()
      ).length,
    );
  }
  const status: ConnectionStatus = c?.status ?? "not_configured";
  const domain = baseDomain();
  const keyStored = !!c?.encryptedPrivateKeyPem;
  const configured = !!c?.applicationId && keyStored;
  const hadConsent = (c?.consentPeriods?.length ?? 0) > 0;
  const confirmation = c?.evaluationConfirmation ?? { status: "pending" as const };
  return {
    status,
    statusLabel: CONNECTION_STATUS_LABEL_DE[status],
    configured,
    environment: c?.environment ?? "production",
    applicationId: c?.applicationId ?? null,
    keyStored,
    keySource: c?.keySource ?? null,
    publicKeyPem: c?.publicKeyPem ?? null,
    // BNK-101 step 3: the owner whitelists this URL in the Control Panel before entering the application ID, so it
    // is shown before the setup is saved (from BASE_DOMAIN, like saveSetup).
    redirectUrl: c?.redirectUrl ?? (domain ? redirectUrlFor(domain) : null),
    aspsp: c?.aspsp ?? null,
    validUntil: c?.validUntil ?? null,
    remindersSent: (c?.consentReminders ?? []).map((r) => r.daysBefore),
    validity: c?.validUntil && status === "active" ? validityLabel(c.validUntil, now) : null,
    banner: status === "active" || status === "error" ? (c?.validUntil ? expiryBanner(c.validUntil, now) : null) : null,
    lastSuccessfulPollAt: c?.lastSuccessfulPollAt ?? null,
    nextPollAt: pollingActive(status) ? nextPollAt(now) : null,
    lastError: c?.lastError ?? null,
    backfill: c?.backfill ?? null,
    pendingAccounts: (c?.pendingAccounts ?? []).map((p) => ({
      ...p,
      message: FEED_MESSAGES.newAccount(p.currency),
      printable: !!p.iban,
    })),
    feedLost: c?.feedLost ?? null,
    feedLostMessage: c?.feedLost || status === "disconnected" ? FEED_MESSAGES.feedLost : null,
    sandboxNotice: c?.environment === "sandbox" ? FEED_MESSAGES.sandbox : null,
    confirmation: {
      status: confirmation.status,
      label: CONFIRMATION_LABEL_DE[confirmation.status],
      recordedAt: confirmation.recordedAt ?? null,
      note: confirmation.note ?? null,
      fileName: confirmation.file?.name ?? null,
    },
    evaluationNotice: confirmation.status === "pending" && configured ? FEED_MESSAGES.evaluationPending : null,
    checklist: [
      {
        step: "app",
        label: "Anwendung im Enable Banking Control Panel (eingeschränkter Modus) anlegen",
        done: !!c?.applicationId,
      },
      { step: "key", label: "Schlüsselpaar erzeugen oder privaten Schlüssel hochladen", done: keyStored },
      { step: "redirect", label: "Weiterleitungs-URL in der Anwendung freigeben", done: hadConsent },
      { step: "appId", label: "Anwendungs-ID eintragen", done: !!c?.applicationId },
      {
        step: "link",
        label: "Eigene Revolut-Business-Konten verknüpfen",
        done: accounts.some((a) => !!a.feed?.providerAccountUid),
      },
      {
        step: "confirmation",
        label: "Schriftliche Bestätigung von Enable Banking erfassen",
        done: confirmation.status !== "pending",
      },
    ],
    accounts: accounts.map((a) => ({
      id: a._id,
      name: a.name,
      currency: a.currency,
      iban: a.iban ?? null,
      linked: !!a.feed?.providerAccountUid,
      missing: a.feed?.missingSince !== undefined && !a.feed.providerAccountUid,
      lastPolledAt: a.feed?.lastPolledAt ?? null,
      unattendedToday: usedToday(a.feed ?? {}, day).transactions,
      unattendedLimit: UNATTENDED_LIMIT,
      remaining: remainingUnattended(a.feed ?? {}, day),
      backoffUntil: a.feed?.backoffUntil && a.feed.backoffUntil > now ? a.feed.backoffUntil : null,
      pending: pending.get(a._id) ?? 0,
    })),
  };
}

/** BNK-116: data of the Verfahrensdokumentation section „Bankdaten“ (F12). */
export async function bankdatenChapter(ctx: ReadCtx) {
  const c = await getConnection(ctx);
  const accounts = (await ctx.db.query("bankAccounts").collect()).filter((a) => a.kind === "bank");
  return {
    provider: c
      ? "Enable Banking Oy (Kontoinformationsdienst, eingeschränkter Modus mit eigenen verknüpften Konten)"
      : null,
    applicationId: c?.applicationId ?? null,
    status: c ? CONNECTION_STATUS_LABEL_DE[c.status] : null,
    consentPeriods: (c?.consentPeriods ?? []).map((p) => ({
      from: berlinCalendarDate(p.from),
      until: berlinCalendarDate(p.until),
    })),
    confirmation: c
      ? {
          status: c.evaluationConfirmation.status,
          label: CONFIRMATION_LABEL_DE[c.evaluationConfirmation.status],
          recordedAt: c.evaluationConfirmation.recordedAt
            ? berlinCalendarDate(c.evaluationConfirmation.recordedAt)
            : null,
          note: c.evaluationConfirmation.note ?? null,
          fileName: c.evaluationConfirmation.file?.name ?? null,
        }
      : null,
    feedLost: c?.feedLost ? { at: berlinCalendarDate(c.feedLost.at), reason: c.feedLost.reason } : null,
    accounts: accounts.map((a) => ({
      name: a.name,
      currency: a.currency,
      iban: a.iban ?? null,
      source: a.feed?.providerAccountUid ? "Enable Banking + Kontoauszug-Import" : "Kontoauszug-Import",
      archived: a.archivedAt !== undefined,
    })),
  };
}
