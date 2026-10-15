import { v } from "convex/values";
import { isSafe, REASON_LABEL_DE } from "../src/domain/banking/match";
import type { MatchCandidate } from "../src/domain/banking/match-types";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../src/domain/time/calendar-date";
import { actorMutation, mutation, query, vConfirmToken } from "./functions";
import { appError } from "./lib/errors";
import { requireTransaction, unmatchedTransactions } from "./model/bankTransactions";
import {
  autoApplyMatches,
  candidatesFor,
  confirmMatch,
  confirmSafeMatches,
  matchContext,
  rejectMatch,
  targetLabels,
} from "./model/matching";
import { reverseTransactionPayments } from "./model/payments";
import type { ReadCtx } from "./model/types";
import { paymentView } from "./payments";
import { vDifferenceInput } from "./paymentValidators";

/**
 * Bank matching (F07 BNK-040…BNK-048, 04 §4.6 „Zuordnungen“): suggestions computed on read, ✓ Bestätigen (⚠, runs
 * F05 `payments.record`), ✗ Ablehnen, „Alle sicheren bestätigen“, „Zuordnung aufheben“ (F05 reversal), bank
 * reversals (BNK-121) and auto-apply after an import (BNK-043).
 */

async function candidateView(ctx: ReadCtx, c: MatchCandidate) {
  return {
    kind: c.kind,
    score: c.score,
    safe: isSafe(c),
    reasons: c.reasons,
    labels: c.reasons.map((r) => REASON_LABEL_DE[r]),
    allocations: await targetLabels(ctx, c.allocations),
  };
}

/** „Zuordnungen“ page: open transactions with their best candidates, and the recently auto-applied matches. */
export const review = query({
  permission: "banking.read",
  args: { accountId: v.optional(v.id("bankAccounts")) },
  handler: async (ctx, args) => {
    const base = await matchContext(ctx);
    const txs = await unmatchedTransactions(ctx, {
      ...(args.accountId ? { accountId: args.accountId } : {}),
      limit: 200,
    });
    const rows = [];
    for (const tx of txs) {
      const candidates = await candidatesFor(ctx, tx, base);
      rows.push({ tx, candidates: await Promise.all(candidates.slice(0, 3).map((c) => candidateView(ctx, c))) });
    }
    const since = addDays(berlinCalendarDate(ctx.now()) as CalendarDate, -60);
    const auto = (
      await ctx.db
        .query("payments")
        .withIndex("by_date", (q) => q.gte("date", since))
        .collect()
    )
      .filter((p) => p.match?.auto && !p.reversalOfId)
      .sort((a, b) => b.recordedAt - a.recordedAt)
      .slice(0, 50);
    return {
      suggestions: rows.filter((r) => r.candidates.length > 0),
      withoutSuggestion: rows.filter((r) => r.candidates.length === 0).map((r) => r.tx),
      autoApplied: await Promise.all(auto.map((p) => paymentView(ctx, p))),
    };
  },
});

/** REST `GET /bank-transactions/{id}/suggestions`, MCP `bank_match_suggestions`. */
export const suggestions = query({
  permission: "banking.read",
  args: { transactionId: v.id("bankTransactions") },
  handler: async (ctx, { transactionId }) => {
    const tx = (await unmatchedTransactions(ctx, {})).find((t) => t.id === transactionId);
    if (!tx) {
      await requireTransaction(ctx, transactionId);
      return { transaction: null, candidates: [] };
    }
    const candidates = await candidatesFor(ctx, tx);
    return { transaction: tx, candidates: await Promise.all(candidates.map((c) => candidateView(ctx, c))) };
  },
});

/** ↔ „Andere wählen“: open documents and credit balances for a manual allocation, filtered by number/name. */
export const openTargets = query({
  permission: "banking.read",
  args: { q: v.optional(v.string()) },
  handler: async (ctx, { q }) => {
    const base = await matchContext(ctx);
    const needle = (q ?? "").trim().toLowerCase();
    const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
    return {
      documents: base.documents
        .filter((d) => hit(d.number) || hit(d.contactName))
        .slice(0, 50)
        .map((d) => ({
          kind: d.kind,
          id: d.id,
          number: d.number,
          contactName: d.contactName,
          openCents: d.openCents,
          dueDate: d.dueDate ?? null,
        })),
      credits: (base.credits ?? []).filter((c) => hit(c.contactName)),
    };
  },
});

const vConfirmAllocation = v.object({
  target: v.object({ kind: v.string(), id: v.string() }),
  amountCents: v.number(),
  differences: v.optional(v.array(vDifferenceInput)),
});

const confirmArgs = {
  transactionId: v.id("bankTransactions"),
  allocations: v.array(vConfirmAllocation),
  remainder: v.optional(v.union(v.literal("credit"), v.literal("unallocated"))),
  acknowledgeWarnings: v.optional(v.array(v.string())),
  score: v.optional(v.number()),
  reasons: v.optional(v.array(v.string())),
};

/** ⚠ BNK-046 ✓ Bestätigen (REST `POST /bank-transactions/{id}/match`, MCP `bank_match_confirm`). */
export const confirm = mutation({
  permission: "banking.match",
  args: { ...confirmArgs, confirmToken: vConfirmToken },
  handler: async (ctx, a) => {
    const { score, reasons, ...rest } = a;
    return confirmMatch(ctx, {
      ...rest,
      ...(score !== undefined ? { provenance: { score, reasons: reasons ?? [], auto: false } } : {}),
    });
  },
});

/** ⚠ „Alle sicheren bestätigen (≥ 0,95)“ — confirms the safe best candidate of each listed transaction. */
export const confirmSafe = mutation({
  permission: "banking.match",
  args: { transactionIds: v.array(v.id("bankTransactions")), confirmToken: vConfirmToken },
  handler: async (ctx, { transactionIds }) => ({ confirmed: await confirmSafeMatches(ctx, transactionIds) }),
});

/** BNK-046 ✗ Ablehnen. */
export const reject = mutation({
  permission: "banking.write",
  args: { transactionId: v.id("bankTransactions"), target: v.object({ kind: v.string(), id: v.string() }) },
  handler: async (ctx, args) => {
    await rejectMatch(ctx, args);
    return null;
  },
});

/** ⚠ BNK-047 „Zuordnung aufheben“ / „Rückgängig“ of an auto-applied match = F05 reversal (PAY-041 dating). */
export const unmatch = mutation({
  permission: "payments.reverse",
  args: { transactionId: v.id("bankTransactions"), reason: v.string(), confirmToken: vConfirmToken },
  handler: async (ctx, args) => reverseTransactionPayments(ctx, args),
});

/** BNK-043 auto-apply for freshly imported rows (scheduled by the import commit; a failure leaves a suggestion). */
export const autoApplyInternal = actorMutation({
  permission: "banking.write",
  args: { transactionId: v.id("bankTransactions") },
  handler: async (ctx, { transactionId }) => {
    const tx = await ctx.db.get(transactionId);
    if (!tx) throw appError("not_found");
    return { applied: await autoApplyMatches(ctx, [transactionId]) };
  },
});
