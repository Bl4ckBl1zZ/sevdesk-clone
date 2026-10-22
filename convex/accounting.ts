import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { calendarDate } from "../src/domain/time/calendar-date";
import { mutation, query } from "./functions";
import { appError } from "./lib/errors";
import {
  chartView,
  journalEntryView,
  journalReport as journalReportRows,
  openingStatus,
  postOpeningBalance,
  searchJournal as searchJournalEntries,
  setBookkeepingStart,
  setRoleOverride,
} from "./model/accounting";
import { resolveContextAt } from "./model/journal";
import { createLedgerAccount, removeLedgerAccount } from "./model/ledgerAccounts";
import { setupShareholderClearing, shareholderClearingStatus } from "./model/shareholderClearing";

/**
 * Bookkeeping (F08 §6/§7, P1): read-only journal viewer, chart of accounts with „Rollen & Standardkonten“, role
 * overrides (owner), Buchungsbeginn and opening balances, journal search and the Buchungsjournal (ACC-025, RPT-008).
 * There is no public function that posts arbitrary journal entries: business slices call `postJournalEntry` from
 * model/journal.ts inside their own mutations (ACC-002); manual entries live in convex/manualEntries.ts (ACC-011).
 */

/** Journal by `seq`, newest first, optionally one month (ACC-001, ACC-025 subset). */
export const listJournal = query({
  permission: "accounting.read",
  args: { paginationOpts: paginationOptsValidator, period: v.optional(v.string()) },
  handler: async (ctx, { paginationOpts, period }) => {
    if (period !== undefined && !/^\d{4}-\d{2}$/.test(period)) throw appError("invalid_input", "Ungültiger Zeitraum.");
    const q = period
      ? ctx.db.query("journalEntries").withIndex("by_period", (i) => i.eq("period", period))
      : ctx.db.query("journalEntries").withIndex("by_seq");
    const res = await q.order("desc").paginate(paginationOpts);
    return { ...res, page: await Promise.all(res.page.map((e) => journalEntryView(ctx, e))) };
  },
});

const vJournalFilter = {
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  account: v.optional(v.string()),
  contactId: v.optional(v.string()),
  sourceKind: v.optional(v.string()),
  text: v.optional(v.string()),
  minCents: v.optional(v.number()),
  maxCents: v.optional(v.number()),
  late: v.optional(v.boolean()),
  reversals: v.optional(v.union(v.literal("only"), v.literal("exclude"))),
  actor: v.optional(v.string()),
  sort: v.optional(v.union(v.literal("seq_desc"), v.literal("seq_asc"), v.literal("date_desc"), v.literal("date_asc"))),
};

/** ACC-025 journal search: filters (period, account, contact, source kind, text, amount, late, reversals, actor). */
export const searchJournal = query({
  permission: "accounting.read",
  args: { ...vJournalFilter, offset: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => searchJournalEntries(ctx, args),
});

/** RPT-008 Buchungsjournal rows (by `seq`, with reversals and late postings) for the CSV export. */
export const journalReport = query({
  permission: "accounting.read",
  args: vJournalFilter,
  handler: async (ctx, args) => journalReportRows(ctx, args),
});

/** One entry with lines, source, rule versions and the „Warum dieses Konto?“ explanation (ACC-003). */
export const getJournalEntry = query({
  permission: "accounting.read",
  args: { entryId: v.id("journalEntries") },
  handler: async (ctx, { entryId }) => {
    const e = await ctx.db.get(entryId);
    return e ? journalEntryView(ctx, e) : null;
  },
});

/** Chart of accounts of a fiscal year with balances and the role mapping (ACC-007, ACC-008). */
export const chartOfAccounts = query({
  permission: "accounting.read",
  args: { fiscalYear: v.optional(v.number()) },
  handler: async (ctx, { fiscalYear }) => chartView(ctx, ctx.now(), fiscalYear),
});

/** Owner override of a role's account, effective from `validFrom` (ACC-008; audited with source text). */
export const setRoleMapping = mutation({
  permission: "accounting.roles",
  args: { role: v.string(), account: v.string(), validFrom: v.string(), sourceText: v.string() },
  handler: async (ctx, args) => {
    await setRoleOverride(ctx, args);
  },
});

/** Buchungsbeginn (ACC-014): events before it produce no journal entries; frozen after the first posting. */
export const setBookkeepingStartDate = mutation({
  permission: "settings.ownerOnly",
  args: { date: v.string() },
  handler: async (ctx, { date }) => setBookkeepingStart(ctx, date),
});

/** Opening balance wizard state for a fiscal year (F08 §6 /buchhaltung/eroeffnung). */
export const openingBalanceStatus = query({
  permission: "accounting.read",
  args: { fiscalYear: v.optional(v.number()) },
  handler: async (ctx, { fiscalYear }) => openingStatus(ctx, ctx.now(), fiscalYear),
});

const vOpeningReceivable = v.object({
  number: v.string(),
  documentDate: v.string(),
  dueDate: v.optional(v.string()),
  counterpartyName: v.string(),
  contactId: v.optional(v.id("contacts")),
  grossCents: v.number(),
  openCents: v.number(),
  taxedAs: v.union(v.literal("soll"), v.literal("ist")),
  notDueVat: v.optional(v.array(v.object({ rateBp: v.number(), vatCents: v.number() }))),
});

/** ACC-013 P1 subset: cash, bank account or open receivables — one entry per part and fiscal year (E-ACC-13). */
export const postOpeningBalancePart = mutation({
  permission: "accounting.openingBalance",
  args: {
    fiscalYear: v.number(),
    part: v.union(
      v.object({ kind: v.literal("cash"), amountCents: v.number() }),
      v.object({ kind: v.literal("bank"), bankAccountId: v.id("bankAccounts"), amountCents: v.number() }),
      v.object({ kind: v.literal("receivables"), items: v.array(vOpeningReceivable) }),
    ),
  },
  handler: async (ctx, { fiscalYear, part }) => {
    const r = await postOpeningBalance(ctx, fiscalYear, part);
    return r.status === "posted"
      ? { status: r.status, seq: r.entries[0]?.seq ?? null }
      : { status: r.status, seq: null };
  },
});

const vAccountType = v.union(
  v.literal("asset"),
  v.literal("liability"),
  v.literal("equity"),
  v.literal("revenue"),
  v.literal("expense"),
  v.literal("neutral"),
);

/** ACC-009: a custom Sachkonto in the chart of the current fiscal year (range per type, E-ACC-07). */
export const createAccount = mutation({
  permission: "accounting.write",
  args: {
    number: v.string(),
    name: v.string(),
    type: vAccountType,
    euerKey: v.optional(v.string()),
    taxKeyDefault: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rctx = await resolveContextAt(ctx, calendarDate(berlinCalendarDate(ctx.now())));
    await createLedgerAccount(ctx, { ...args, chart: rctx.chart });
  },
});

/** ACC-009 „Entfernen“: unused custom accounts are deleted, everything else archived (E-ACC-06). */
export const removeAccount = mutation({
  permission: "accounting.write",
  args: { number: v.string() },
  handler: async (ctx, { number }) => {
    const rctx = await resolveContextAt(ctx, calendarDate(berlinCalendarDate(ctx.now())));
    return removeLedgerAccount(ctx, { chart: rctx.chart, number, resolve: rctx });
  },
});

/** F01 SET-045a: is the „Verrechnungskonto Gesellschafter“ step shown (corporations only) and is the role mapped? */
export const shareholderClearing = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => shareholderClearingStatus(ctx, ctx.now()),
});

/** F01 SET-045a: one custom account per shareholder, role `shareholder.clearing` mapped to the first (audited). */
export const setupShareholderAccounts = mutation({
  permission: "accounting.roles",
  args: { shareholders: v.array(v.object({ name: v.string(), number: v.optional(v.string()) })) },
  handler: async (ctx, args) => setupShareholderClearing(ctx, args),
});
