import type { Value } from "convex/values";
import {
  type BusinessEvent,
  isReversalEvent,
  type JournalSource,
  type ReversalEvent,
  reversedSourceOf,
  sourceOf,
} from "../../src/domain/accounting/events";
import {
  chartAt,
  type Dating,
  fiscalYearOf,
  fiscalYearStart,
  isBeforeBookkeepingStart,
  resolvePostingDate,
  taxationMethodAt,
} from "../../src/domain/accounting/period";
import {
  type Posting,
  type PostingContext,
  type PostingIssue,
  postEvent,
  reversalPosting,
} from "../../src/domain/accounting/post";
import { type ResolveContext, type ResolveIssue, resolveLines, resolveRole } from "../../src/domain/accounting/resolve";
import { cashNegativeIssue, firstNegativeBalance } from "../../src/domain/cash/check";
import type { Chart } from "../../src/domain/rules/accounting";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError, type ErrorCode } from "../lib/errors";
import { auditedInsert } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * The journal (F08 ACC-001…ACC-006, 03 §8). The only code that writes `journalEntries` and `journalLines`.
 *
 * Internal API for the other slices — call it **inside your own mutation**, after writing your business record,
 * so the record, its journal entry, the audit entries and the gapless `seq` commit in one transaction:
 *
 *   const r = await postJournalEntry(ctx, { kind: "invoice_finalised", documentId, … });
 *   if (r.status === "posted") journalEntryIds = r.entryIds;
 *
 * Steps: Buchungsbeginn (ACC-014) → posting engine (`src/domain/accounting/post.ts`) or mirror of the stored
 * entries for reversals (ACC-004) → period lock (ACC-006) → role → account resolution with the chart of the fiscal
 * year and the versioned mapping (ACC-007/ACC-008) → seq = head + 1 (Convex transactions are serialisable, so the
 * sequence is gapless and unique, GOBD-05) → audited insert (full content, AUD-002) + line read model → cash
 * never-negative check (CSH-026, RI-11). Any failure throws a structured `appError` and aborts the caller's mutation.
 */

export type PostJournalResult =
  | {
      status: "posted";
      entryIds: Id<"journalEntries">[];
      entries: { entryId: Id<"journalEntries">; seq: number; date: string; period: string; latePosting?: string }[];
    }
  | {
      status: "skipped";
      reason: "before_bookkeeping_start" | "advance_invoice" | "no_change" | "zero_amount" | "nothing_to_reverse";
    };

export interface PostJournalOptions {
  /** Override the event's default dating for the period-lock rule (ACC-006): `user` refuses, `external` moves. */
  dating?: Dating;
  /** Attachments (Eigenbeleg, Quittung) stored on the entry (ACC-005). */
  attachments?: Doc<"journalEntries">["attachments"];
  longText?: string;
}

const AUDIT_ACTION = { reversal: "journal.reverse", opening: "journal.opening_balance", post: "journal.post" };

function fail(code: ErrorCode, issueLike: { message: string; code?: string; params?: Record<string, unknown> }): never {
  const extra: Record<string, Value> = { reason: issueLike.code ?? code };
  for (const [k, v] of Object.entries(issueLike.params ?? {})) {
    if (typeof v === "string" || typeof v === "number") extra[k] = v;
  }
  throw appError(code, issueLike.message, extra);
}

const POSTING_ERROR: Record<PostingIssue["code"], ErrorCode> = {
  invalid_event: "invalid_input",
  rate_not_supported: "posting_rejected",
  tax_case_not_postable: "posting_rejected",
  vat_correction_required: "invalid_input",
  private_withdrawal_corporation: "posting_rejected",
};

const RESOLVE_ERROR: Record<ResolveIssue["code"], ErrorCode> = {
  role_unmapped: "role_unmapped",
  account_unknown: "account_unknown",
  account_archived: "account_unknown",
  rule_missing: "posting_rejected",
};

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

export async function journalHead(ctx: ReadCtx): Promise<Doc<"journalEntries"> | null> {
  return ctx.db.query("journalEntries").withIndex("by_seq").order("desc").first();
}

export async function entriesBySource(ctx: ReadCtx, source: JournalSource): Promise<Doc<"journalEntries">[]> {
  return ctx.db
    .query("journalEntries")
    .withIndex("by_source", (q) => q.eq("source.kind", source.kind).eq("source.id", source.id))
    .collect();
}

export async function reversalOf(ctx: ReadCtx, entryId: Id<"journalEntries">): Promise<Doc<"journalEntries"> | null> {
  return ctx.db
    .query("journalEntries")
    .withIndex("by_reversalOf", (q) => q.eq("reversalOfId", entryId))
    .first();
}

/** Closed periods for ACC-006: locked and locking (E-ACC-20) months. */
async function closedPeriods(ctx: ReadCtx): Promise<Set<string>> {
  const rows = await ctx.db.query("periods").collect();
  return new Set(rows.filter((p) => p.status !== "open").map((p) => p.period));
}

export async function roleOverrides(ctx: ReadCtx, chart: Chart) {
  const rows = await ctx.db.query("accountRoleMappings").collect();
  return rows
    .filter((r) => r.chart === chart && r.source === "override")
    .map((r) => ({
      chart: r.chart,
      role: r.role,
      account: r.account,
      validFrom: r.validFrom,
      mappingVersion: r.mappingVersion,
      ...(r.sourceText ? { sourceText: r.sourceText } : {}),
    }));
}

/** Resolution context for a posting date: chart of that fiscal year, overrides, bank ledger accounts. */
export async function resolveContextAt(ctx: ReadCtx, date: CalendarDate): Promise<ResolveContext> {
  const profile = await getCompanyProfile(ctx);
  const chart = chartAt(profile?.chartOfAccounts ?? [], profile?.fiscalYearStartMonth ?? 1, date);
  const banks = await ctx.db.query("bankAccounts").collect();
  return {
    chart,
    date,
    overrides: await roleOverrides(ctx, chart),
    bankAccounts: banks.map((b) => ({
      id: b._id,
      ledgerAccount: b.ledgerAccount,
      ...(b.archivedAt !== undefined ? { archived: true } : {}),
    })),
  };
}

// ── posting ─────────────────────────────────────────────────────────────────────────────────────────────

export async function postJournalEntry(
  ctx: ModelCtx,
  event: BusinessEvent,
  options: PostJournalOptions = {},
): Promise<PostJournalResult> {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  if (!isCalendarDate(event.date)) throw appError("invalid_input", "Ungültiges Buchungsdatum.");
  const today = berlinCalendarDate(ctx.now());
  if (event.kind !== "opening_balance" && isBeforeBookkeepingStart(event.date, profile.bookkeepingStartDate)) {
    return { status: "skipped", reason: "before_bookkeeping_start" };
  }
  const postingCtx: PostingContext = {
    taxationMethod: taxationMethodAt(profile.taxationMethod, event.date),
    legalForm: profile.legalForm,
    ustvaPeriod: profile.ustvaPeriod,
  };

  if (isReversalEvent(event)) return postReversal(ctx, event, postingCtx, today, options);

  const source = sourceOf(event);
  if (event.kind === "opening_balance") {
    const fyStart = fiscalYearStart(event.fiscalYear, profile.fiscalYearStartMonth);
    if (event.date !== fyStart && event.date !== profile.bookkeepingStartDate) {
      throw appError(
        "invalid_input",
        "Die Eröffnungsbilanz wird zum Beginn des Wirtschaftsjahres oder zum Buchungsbeginn erfasst.",
      );
    }
    if (fiscalYearOf(event.date, profile.fiscalYearStartMonth) !== event.fiscalYear) {
      throw appError("invalid_input", "Das Datum liegt nicht im angegebenen Wirtschaftsjahr.");
    }
  }
  const outcome = postEvent(event, postingCtx);
  if (!outcome.ok) fail(POSTING_ERROR[outcome.error.code], outcome.error);
  if (outcome.value.kind === "none") return { status: "skipped", reason: outcome.value.reason };
  const posting = outcome.value.posting;

  // One entry per source and matrix row (T5 has two legs with different rows), unless it was reversed (ACC-004).
  for (const existing of await entriesBySource(ctx, source)) {
    if (existing.reversalOfId || existing.explanation !== posting.explanation) continue;
    if (await reversalOf(ctx, existing._id)) continue;
    throw appError(
      "already_posted",
      event.kind === "opening_balance"
        ? `Für ${event.fiscalYear} sind bereits Saldenvorträge erfasst.`
        : "Für diesen Beleg wurde bereits gebucht.",
      { seq: existing.seq },
    );
  }
  const entry = await persist(ctx, posting, {
    today,
    dating: options.dating ?? posting.dating,
    action: event.kind === "opening_balance" ? AUDIT_ACTION.opening : AUDIT_ACTION.post,
    options,
    reversal: false,
  });
  return { status: "posted", entryIds: [entry.entryId], entries: [entry] };
}

async function postReversal(
  ctx: ModelCtx,
  event: ReversalEvent,
  postingCtx: PostingContext,
  today: CalendarDate,
  options: PostJournalOptions,
): Promise<PostJournalResult> {
  const originals = (await entriesBySource(ctx, reversedSourceOf(event)))
    .filter((e) => e.reversalOfId === undefined)
    .sort((a, b) => a.seq - b.seq);
  if (originals.length === 0) return { status: "skipped", reason: "nothing_to_reverse" };
  const open: Doc<"journalEntries">[] = [];
  for (const o of originals) if (!(await reversalOf(ctx, o._id))) open.push(o);
  // E-ACC-05: a reversal of a reversal is impossible (reversal entries are never originals) and nothing twice.
  if (open.length === 0) throw appError("already_reversed");
  const entries = [];
  for (const o of open) {
    const posting = reversalPosting(event, { lines: o.lines, text: o.text }, postingCtx);
    entries.push(
      await persist(ctx, posting, {
        today,
        dating: options.dating ?? posting.dating,
        action: AUDIT_ACTION.reversal,
        options,
        reversal: true,
        reversalOfId: o._id,
      }),
    );
  }
  return { status: "posted", entryIds: entries.map((e) => e.entryId), entries };
}

interface PersistArgs {
  today: CalendarDate;
  dating: Dating;
  action: string;
  options: PostJournalOptions;
  reversal: boolean;
  reversalOfId?: Id<"journalEntries">;
}

async function persist(ctx: ModelCtx, posting: Posting, a: PersistArgs) {
  const when = resolvePostingDate(posting.date, a.dating, await closedPeriods(ctx), a.today);
  if (!when.ok) fail("period_locked", when.error);
  const { date, period } = when.value;

  const rctx = await resolveContextAt(ctx, date);
  const resolved = resolveLines(posting.lines, rctx);
  if (!resolved.ok) fail(RESOLVE_ERROR[resolved.error.code], resolved.error);

  const seq = ((await journalHead(ctx))?.seq ?? 0) + 1;
  const lines = resolved.value.lines.map((l) => ({
    account: l.account,
    ...(l.role !== undefined ? { role: l.role } : {}),
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    ...(l.taxKey !== undefined ? { taxKey: l.taxKey } : {}),
    ...(l.contactId !== undefined ? { contactId: l.contactId } : {}),
    ...(l.taxPointDate !== undefined ? { taxPointDate: l.taxPointDate } : {}),
    ...(l.taxPeriod !== undefined ? { taxPeriod: l.taxPeriod } : {}),
  }));
  const value = {
    seq,
    date,
    period,
    ...(when.value.originalDate ? { originalDate: when.value.originalDate } : {}),
    ...(when.value.latePosting ? { latePosting: when.value.latePosting } : {}),
    lines,
    text: posting.text,
    ...(a.options.longText ? { longText: a.options.longText } : {}),
    source: posting.source,
    ...(a.options.attachments?.length ? { attachments: a.options.attachments } : {}),
    ruleVersion: posting.ruleVersion,
    roleMappingVersion: resolved.value.roleMappingVersion,
    explanation: posting.explanation,
    ...(a.reversalOfId ? { reversalOfId: a.reversalOfId } : {}),
    recordedAt: ctx.now(),
    actor: ctx.actor,
  };
  const entryId = await auditedInsert(ctx, "journalEntries", value, {
    action: a.action,
    label: `Buchung ${seq}`,
  });
  for (const [lineIndex, l] of lines.entries()) {
    await ctx.db.insert("journalLines", {
      entryId,
      lineIndex,
      seq,
      date,
      period,
      account: l.account,
      ...(l.role !== undefined ? { role: l.role } : {}),
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      ...(l.contactId !== undefined ? { contactId: l.contactId } : {}),
    });
  }
  await assertCashNeverNegative(ctx, rctx, lines, date, a.reversal);
  return {
    entryId,
    seq,
    date,
    period,
    ...(when.value.latePosting ? { latePosting: when.value.latePosting.reason } : {}),
  };
}

/** CSH-026 / RI-11: checked inside the posting transaction whenever an entry touches the cash account. */
async function assertCashNeverNegative(
  ctx: ModelCtx,
  rctx: ResolveContext,
  lines: readonly { account: string }[],
  date: string,
  reversal: boolean,
): Promise<void> {
  const cash = resolveRole("cash", rctx);
  const account = cash.ok ? cash.value.account : null;
  if (!account || !lines.some((l) => l.account === account)) return;
  const dip = firstNegativeBalance(
    (await cashLines(ctx, account)).map((l) => ({
      date: l.date,
      seq: l.seq,
      amountCents: l.debitCents - l.creditCents,
    })),
  );
  if (dip) fail("cash_negative", cashNegativeIssue(dip, date, reversal));
}

export async function cashLines(ctx: ReadCtx, account: string): Promise<Doc<"journalLines">[]> {
  return ctx.db
    .query("journalLines")
    .withIndex("by_account_date_seq", (q) => q.eq("account", account))
    .collect();
}

/** Number of journal entries per fiscal year (chart/fiscal-year locks SET-041/042, E-ACC-09/14). */
export async function journalFiscalYears(ctx: ReadCtx, fiscalYearStartMonth: number): Promise<number[]> {
  const first = await ctx.db.query("journalEntries").withIndex("by_seq").first();
  if (!first) return [];
  const years = new Set<number>();
  for (const e of await ctx.db.query("journalEntries").collect()) {
    years.add(fiscalYearOf(e.date, fiscalYearStartMonth));
  }
  return [...years].sort();
}

export const hasJournalEntries = async (ctx: ReadCtx): Promise<boolean> =>
  (await ctx.db.query("journalEntries").withIndex("by_seq").first()) !== null;
