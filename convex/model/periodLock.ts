import { endOfMonth, fiscalYearOf, fiscalYearStart, periodOf } from "../../src/domain/accounting/period";
import {
  type ChecklistItem,
  type LockChecklist,
  type LockReason,
  lockChecklist,
  lockSuggestion,
  monthsBetween,
  planLock,
} from "../../src/domain/accounting/period-lock";
import { resolveRole } from "../../src/domain/accounting/resolve";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate, calendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { resolveContextAt } from "./journal";
import { notify } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";
import { emitEvent } from "./webhooks";

/**
 * Period lock / Festschreibung (F08 ACC-015…ACC-017, §4.7; GOBD-06). The only writer of `periods` besides nothing
 * else: a lock sets `periods.status = locked` for every month of the plan („lückenlos“, ACC-016) and `lockedAt` on
 * every journal entry, payment, voucher, sales document, bank transaction and cash transfer of those months in the
 * same transaction; afterwards the immutability matrix and the posting path (ACC-006) refuse changes. Locks are
 * irreversible (no unlock function exists).
 *
 * Checklist blockers (1) drafts, (2) pending artifacts, (2a) bank ledger ≠ statement balance abort the lock; the
 * warnings (3) are shown in the dialog and never block.
 */

export interface PeriodRow {
  period: string;
  status: "open" | "locking" | "locked";
  lockedAt?: number;
  lockedBy?: string;
  reason?: LockReason;
}

export async function periodRows(ctx: ReadCtx): Promise<Doc<"periods">[]> {
  return ctx.db.query("periods").collect();
}

/** ACC-018: suggestion from the first booked month (Buchungsbeginn or first journal entry) to today. */
export async function periodLockSuggestion(ctx: ReadCtx, now: number) {
  const profile = await getCompanyProfile(ctx);
  const first = await ctx.db.query("journalEntries").withIndex("by_seq").first();
  const today = berlinCalendarDate(now);
  const firstMonth = periodOf(profile?.bookkeepingStartDate ?? first?.date ?? today);
  return lockSuggestion({ periods: await periodRows(ctx), today, firstMonth });
}

/** ACC-018 `deadlines.notify` part: one reminder per month while an open month is older than 2 months. */
export async function notifyPeriodLock(ctx: ModelCtx): Promise<number> {
  const s = await periodLockSuggestion(ctx, ctx.now());
  if (!s.reminder) return 0;
  await notify(ctx, {
    kind: "deadline.period_lock",
    severity: "warning",
    title: "Festschreibung empfohlen",
    body: s.reminder,
    link: "/buchhaltung/festschreibung",
    dedupeKey: `period_lock|${s.overdue[0] ?? ""}|${berlinCalendarDate(ctx.now()).slice(0, 7)}`,
  });
  return 1;
}

/** Month grid of a fiscal year (F08 §6 /buchhaltung/festschreibung). */
export async function periodsOverview(ctx: ReadCtx, now: number, fiscalYear?: number) {
  const profile = await getCompanyProfile(ctx);
  const fyStartMonth = profile?.fiscalYearStartMonth ?? 1;
  const today = berlinCalendarDate(now);
  const fy = fiscalYear ?? fiscalYearOf(today, fyStartMonth);
  const start = periodOf(fiscalYearStart(fy, fyStartMonth));
  const end = periodOf(fiscalYearStart(fy + 1, fyStartMonth));
  const months = monthsBetween(start, end).slice(0, 12);
  const rows = new Map((await periodRows(ctx)).map((r) => [r.period, r]));
  return {
    fiscalYear: fy,
    currentPeriod: periodOf(today),
    suggestion: await periodLockSuggestion(ctx, now),
    months: months.map((p) => {
      const r = rows.get(p);
      return {
        period: p,
        status: r?.status ?? ("open" as const),
        ...(r?.lockedAt !== undefined ? { lockedAt: r.lockedAt } : {}),
        ...(r?.lockedBy ? { lockedBy: r.lockedBy } : {}),
        ...(r?.reason ? { reason: r.reason } : {}),
      };
    }),
  };
}

const inMonths = (date: string | undefined, months: ReadonlySet<string>) =>
  date !== undefined && months.has(date.slice(0, 7));

const INVOICE_TYPES = new Set([
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
  "self_billing",
]);

async function ledgerBalanceUpTo(ctx: ReadCtx, account: string, date: string): Promise<number> {
  const lines = await ctx.db
    .query("journalLines")
    .withIndex("by_account_date_seq", (q) => q.eq("account", account).lte("date", date))
    .collect();
  return lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
}

/** ACC-017 checklist counts for the months of a lock plan. */
export async function checklistFor(ctx: ReadCtx, months: readonly string[], now: number): Promise<LockChecklist> {
  const set = new Set(months);
  const last = months[months.length - 1];
  if (!last) return lockChecklist(emptyInput());
  const lastDay = endOfMonth(last);

  // (1) drafts of bookkeeping-relevant documents and vouchers dated in the months
  const sales = await ctx.db.query("salesDocuments").collect();
  const vouchers = await ctx.db.query("vouchers").collect();
  const drafts =
    sales.filter((d) => d.status === "draft" && INVOICE_TYPES.has(d.type) && inMonths(d.documentDate, set)).length +
    vouchers.filter((v) => v.status === "draft" && inMonths(v.documentDate, set)).length;
  // (2) finalised documents whose PDF/XML pipeline has not finished
  const pending = sales.filter((d) => d.artifactStatus === "pending" && inMonths(d.documentDate, set)).length;

  // (2a) bank ledger vs statement closing balance at each month end (RI-27, E-ACC-33); (3) missing statements
  const banks = (await ctx.db.query("bankAccounts").collect()).filter((b) => b.archivedAt === undefined);
  const statements = (await ctx.db.query("bankStatements").collect()).filter((s) => !s.rolledBack);
  const bankDifferences: { account: string; date: string; diffCents: number }[] = [];
  const missingStatements: { account: string; month: string }[] = [];
  for (const b of banks.filter((x) => x.kind === "bank")) {
    for (const m of months) {
      const monthEnd = endOfMonth(m);
      const covering = statements
        .filter((s) => s.accountId === b._id && s.periodFrom <= monthEnd && s.periodTo >= monthEnd)
        .sort((a, c) => c.uploadedAt - a.uploadedAt)[0];
      if (!covering) {
        missingStatements.push({ account: b.name, month: m });
        continue;
      }
      if (covering.closingBalanceCents === undefined || covering.periodTo !== monthEnd || b.currency !== "EUR") {
        continue;
      }
      const ledger = await ledgerBalanceUpTo(ctx, b.ledgerAccount, monthEnd);
      const diff = ledger - covering.closingBalanceCents;
      if (diff !== 0)
        bankDifferences.push({ account: `${b.ledgerAccount} ${b.name}`, date: monthEnd, diffCents: diff });
    }
  }

  // (3) warnings
  const inbox = await ctx.db.query("inboxItems").collect();
  const unbookedInboxItems = inbox.filter(
    (i) =>
      (i.status === "new" || i.status === "processing" || i.status === "needs_review") &&
      set.has(berlinCalendarDate(i.receivedAt).slice(0, 7)),
  ).length;
  let unmatched = 0;
  for (const b of banks) {
    const rows = await ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (q) =>
        q.eq("accountId", b._id).gte("bookingDate", `${months[0]}-01`).lte("bookingDate", lastDay),
      )
      .collect();
    unmatched += rows.filter((t) => t.status === "open" || t.status === "partially_matched").length;
  }
  const vouchersWithoutAttachment = vouchers.filter(
    (v) =>
      v.status !== "draft" &&
      v.status !== "cancelled" &&
      inMonths(v.documentDate, set) &&
      v.originalFiles.length === 0 &&
      !v.eigenbeleg,
  ).length;
  const rctx = await resolveContextAt(ctx, lastDay);
  const transit = resolveRole("transit", rctx);
  const transitBalanceCents =
    transit.ok && transit.value.account ? await ledgerBalanceUpTo(ctx, transit.value.account, lastDay) : 0;
  const backdatedCash: { label: string; date: string; recordedOn: string }[] = [];
  const late = (date: string, recordedAt: number) => {
    const recordedOn = berlinCalendarDate(recordedAt);
    return recordedOn > addDays(calendarDate(date), 10) ? recordedOn : null;
  };
  for (const c of await ctx.db.query("cashTransfers").collect()) {
    if (!set.has(c.date.slice(0, 7))) continue;
    const r = late(c.date, c.recordedAt);
    if (r) backdatedCash.push({ label: CASH_LABEL[c.kind], date: c.date, recordedOn: r });
  }
  for (const p of await ctx.db.query("payments").collect()) {
    if (p.source.kind !== "cash" || !set.has(p.date.slice(0, 7))) continue;
    const r = late(p.date, p.recordedAt);
    if (r) backdatedCash.push({ label: `Barzahlung ${p.number ?? ""}`.trim(), date: p.date, recordedOn: r });
  }
  void now;
  return lockChecklist({
    draftsInPeriod: drafts,
    pendingArtifacts: pending,
    bankDifferences,
    unbookedInboxItems,
    unmatchedBankTransactions: unmatched,
    missingStatements,
    vouchersWithoutAttachment,
    transitBalanceCents,
    backdatedCash,
  });
}

const CASH_LABEL: Record<Doc<"cashTransfers">["kind"], string> = {
  deposit_to_bank: "Bargeld eingezahlt",
  private_withdrawal: "Bargeld entnommen",
  bank_withdrawal_to_cash: "Bargeldabhebung in die Kasse",
};

function emptyInput() {
  return {
    draftsInPeriod: 0,
    pendingArtifacts: 0,
    bankDifferences: [],
    unbookedInboxItems: 0,
    unmatchedBankTransactions: 0,
    missingStatements: [],
    vouchersWithoutAttachment: 0,
    transitBalanceCents: 0,
    backdatedCash: [],
  };
}

export interface LockPreview {
  months: string[];
  gapNotice?: string;
  checklist: LockChecklist;
}

async function plan(ctx: ReadCtx, target: string) {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const r = planLock({
    target,
    fiscalYearStartMonth: profile.fiscalYearStartMonth,
    bookkeepingStartDate: profile.bookkeepingStartDate,
    periods: await periodRows(ctx),
  });
  if (!r.ok) throw appError(r.error.code === "already_locked" ? "period_locked" : "invalid_input", r.error.message);
  return r.value;
}

/** Dialog data: the months the lock would cover (E-ACC-15) and the checklist (ACC-017). */
export async function previewLock(ctx: ReadCtx, target: string, now: number): Promise<LockPreview> {
  const p = await plan(ctx, target);
  return { ...p, checklist: await checklistFor(ctx, p.months, now) };
}

/** Throws `period_lock_blocked` with the blocker texts (409 in the REST mapping, E-ACC-16/17/33). */
function assertNoBlockers(blockers: readonly ChecklistItem[]): void {
  if (blockers.length === 0) return;
  throw appError("period_lock_blocked", blockers.map((b) => b.message).join(" "), {
    reasons: blockers.map((b) => b.code).join(","),
  });
}

export interface LockResult {
  months: string[];
  lockedRecords: number;
}

/**
 * Locks `target` and every open earlier month of its fiscal year (ACC-015/016). `reason` = `manual` from the
 * Festschreibung page; the submission records pass `ustva_submitted` / `zm_submitted` (they check the blockers
 * themselves before writing the filing, E-UVA-03).
 */
export async function lockThrough(ctx: ModelCtx, target: string, reason: LockReason): Promise<LockResult> {
  const p = await plan(ctx, target);
  assertNoBlockers((await checklistFor(ctx, p.months, ctx.now())).blockers);
  return lockMonths(ctx, p.months, reason);
}

/**
 * Locks exactly `months` (already planned, blockers already checked). Months that are locked already are skipped;
 * a month is `locking` while its records are stamped (E-ACC-20) and `locked` at the end of the same transaction.
 */
export async function lockMonths(ctx: ModelCtx, months: readonly string[], reason: LockReason): Promise<LockResult> {
  const now = ctx.now();
  const rows = new Map((await periodRows(ctx)).map((r) => [r.period, r]));
  const todo = months.filter((m) => rows.get(m)?.status !== "locked");
  const ids: Id<"periods">[] = [];
  for (const m of todo) {
    const row = rows.get(m);
    if (!row) {
      ids.push(
        await auditedInsert(ctx, "periods", { period: m, status: "locking" }, { action: "period.lock", label: m }),
      );
    } else {
      if (row.status === "open") {
        await auditedPatch(ctx, "periods", row._id, { status: "locking" }, { action: "period.lock", label: m });
      }
      ids.push(row._id);
    }
  }
  const set = new Set(todo);
  const lockedRecords = await stampRecords(ctx, set, now);
  for (const [i, id] of ids.entries()) {
    await auditedPatch(
      ctx,
      "periods",
      id,
      { status: "locked", lockedAt: now, lockedBy: ctx.actor, reason },
      { action: "period.lock", label: todo[i] as string, reason },
    );
    // F08 §7 period.locked (one per month)
    await emitEvent(ctx, "period.locked", {
      id: `period_${todo[i]}`,
      object: "period",
      period: todo[i],
      status: "locked",
      reason,
      updated_at: new Date(now).toISOString(),
    });
  }
  return { months: todo, lockedRecords };
}

type LockableTable =
  | "journalEntries"
  | "payments"
  | "vouchers"
  | "salesDocuments"
  | "bankTransactions"
  | "cashTransfers";

async function stamp(ctx: ModelCtx, table: LockableTable, id: Id<LockableTable>, now: number): Promise<boolean> {
  const doc = (await ctx.db.get(id)) as { lockedAt?: number } | null;
  if (!doc || doc.lockedAt !== undefined) return false;
  await auditedPatch(ctx, table as TableNames, id as never, { lockedAt: now } as never, { action: "period.lock" });
  return true;
}

const SOURCE_TABLE: Partial<Record<string, LockableTable>> = {
  salesDocument: "salesDocuments",
  voucher: "vouchers",
  payment: "payments",
  bankTransaction: "bankTransactions",
  cashTransfer: "cashTransfers",
};

/** ACC-015: `lockedAt` on every record of the months (journal period, or the record's own date if unposted). */
async function stampRecords(ctx: ModelCtx, months: ReadonlySet<string>, now: number): Promise<number> {
  let n = 0;
  const sources = new Map<string, LockableTable>();
  for (const m of months) {
    const entries = await ctx.db
      .query("journalEntries")
      .withIndex("by_period", (q) => q.eq("period", m))
      .collect();
    for (const e of entries) {
      if (await stamp(ctx, "journalEntries", e._id, now)) n++;
      const table = SOURCE_TABLE[e.source.kind];
      if (table) sources.set(e.source.id, table);
    }
  }
  for (const [id, table] of sources) {
    const ref = ctx.db.normalizeId(table, id);
    if (ref && (await stamp(ctx, table, ref, now))) n++;
  }
  // Records without a posting in the journal (before the Buchungsbeginn, KU without entry …) by their own date.
  for (const p of await ctx.db.query("payments").collect()) {
    if (inMonths(p.date, months) && (await stamp(ctx, "payments", p._id, now))) n++;
  }
  for (const c of await ctx.db.query("cashTransfers").collect()) {
    if (inMonths(c.date, months) && (await stamp(ctx, "cashTransfers", c._id, now))) n++;
  }
  for (const d of await ctx.db.query("salesDocuments").collect()) {
    if (d.status === "draft" || !inMonths(d.documentDate, months)) continue;
    const posted = await ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "salesDocument").eq("source.id", d._id))
      .first();
    if (posted) continue; // posted documents follow their journal period above
    if (await stamp(ctx, "salesDocuments", d._id, now)) n++;
  }
  for (const v of await ctx.db.query("vouchers").collect()) {
    if (v.status === "draft" || v.journalEntryIds.length > 0 || !inMonths(v.documentDate, months)) continue;
    if (await stamp(ctx, "vouchers", v._id, now)) n++;
  }
  for (const b of await ctx.db.query("bankAccounts").collect()) {
    for (const m of months) {
      const rows = await ctx.db
        .query("bankTransactions")
        .withIndex("by_account_bookingDate", (q) =>
          q.eq("accountId", b._id).gte("bookingDate", `${m}-01`).lte("bookingDate", endOfMonth(m)),
        )
        .collect();
      for (const t of rows) if (await stamp(ctx, "bankTransactions", t._id, now)) n++;
    }
  }
  return n;
}

/** Closed months (locked or locking) for read models. */
export async function closedMonths(ctx: ReadCtx): Promise<Set<string>> {
  return new Set((await periodRows(ctx)).filter((r) => r.status !== "open").map((r) => r.period));
}

export const monthEnd = (p: string): CalendarDate => endOfMonth(p);
