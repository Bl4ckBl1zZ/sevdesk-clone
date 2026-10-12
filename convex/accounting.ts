import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { appError } from "./lib/errors";
import {
  chartView,
  journalEntryView,
  openingStatus,
  postOpeningBalance,
  setBookkeepingStart,
  setRoleOverride,
} from "./model/accounting";

/**
 * Bookkeeping (F08 §6/§7, P1): read-only journal viewer, chart of accounts with „Rollen & Standardkonten“, role
 * overrides (owner), Buchungsbeginn and opening balances. There is no public function that posts arbitrary journal
 * entries: business slices call `postJournalEntry` from model/journal.ts inside their own mutations (ACC-002);
 * manual entries follow in P2 (ACC-011).
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
  args: { fiscalYear: v.number() },
  handler: async (ctx, { fiscalYear }) => openingStatus(ctx, fiscalYear),
});

const vOpeningReceivable = v.object({
  number: v.string(),
  documentDate: v.string(),
  dueDate: v.optional(v.string()),
  counterpartyName: v.string(),
  contactId: v.optional(v.string()),
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
