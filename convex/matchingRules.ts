import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { eigenbelegContent } from "../src/domain/banking/eigenbeleg";
import { renderEigenbeleg } from "../src/pdf/eigenbeleg";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { vRuleApply, vRuleMode, vRuleWhen } from "./bankFeedValidators";
import { action, actorMutation, mutation, query, systemAction, systemQuery } from "./functions";
import { appError } from "./lib/errors";
import type { FileRefValue } from "./model/bankImport";
import { markEigenbelegInput } from "./model/bankTransactions";
import {
  categorizeByRule,
  createRule,
  deleteRule,
  previewRuleHits,
  ruleFor,
  ruleSuggestionsFor,
  rulesWithHits,
  updateRule,
  voucherFromTransaction,
} from "./model/matchingRules";
import type { ActorContext } from "./model/types";

/**
 * F07 BNK-050…054 matching rules (Einstellungen › Bank › Regeln) and BNK-065 „+ Neuer Beleg“ from a transaction.
 * Rules run after every import/poll on the new booked rows (`afterImport`), before the BNK-043 auto-apply.
 */

const vRuleInput = {
  name: v.string(),
  priority: v.number(),
  enabled: v.boolean(),
  mode: v.optional(vRuleMode),
  when: vRuleWhen,
  apply: vRuleApply,
};

export const list = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => rulesWithHits(ctx, ctx.now()),
});

export const get = query({
  permission: "banking.read",
  args: { id: v.id("matchingRules") },
  handler: async (ctx, { id }) => (await rulesWithHits(ctx, ctx.now())).find((r) => r._id === id) ?? null,
});

/** BNK-051 live preview before saving (no side effects). */
export const preview = query({
  permission: "banking.read",
  args: { when: vRuleWhen },
  handler: async (ctx, { when }) => previewRuleHits(ctx, when, ctx.now()),
});

/** BNK-053: rules proposed after 3 identical manual classifications per counterparty (the owner saves them). */
export const suggestions = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => ruleSuggestionsFor(ctx, ctx.now()),
});

/** The rule that applies to a transaction (Zuordnungen chip „Regel: …“, suggest-mode rules). */
export const forTransaction = query({
  permission: "banking.read",
  args: { transactionId: v.id("bankTransactions") },
  handler: async (ctx, { transactionId }) => {
    const r = await ruleFor(ctx, transactionId);
    return r ? { id: r.rule.id, name: r.rule.name, mode: r.rule.mode, apply: r.rule.apply } : null;
  },
});

export const create = mutation({
  permission: "bankRules.write",
  args: vRuleInput,
  handler: async (ctx, args) => createRule(ctx, args, ctx.actorContext.channel),
});

export const update = mutation({
  permission: "bankRules.write",
  args: {
    id: v.id("matchingRules"),
    name: v.optional(v.string()),
    priority: v.optional(v.number()),
    enabled: v.optional(v.boolean()),
    mode: v.optional(vRuleMode),
    when: v.optional(vRuleWhen),
    apply: v.optional(vRuleApply),
  },
  handler: async (ctx, { id, ...patch }) => updateRule(ctx, id, patch, ctx.actorContext.channel),
});

export const remove = mutation({
  permission: "bankRules.write",
  args: { id: v.id("matchingRules") },
  handler: async (ctx, { id }) => deleteRule(ctx, id),
});

/** BNK-065 „+ Neuer Beleg“: a prefilled voucher draft linked to the transaction (allocated on finalisation). */
export const createVoucherFromTransaction = mutation({
  permission: "vouchers.write",
  args: { transactionId: v.id("bankTransactions"), account: v.optional(v.string()) },
  handler: async (ctx, args) => voucherFromTransaction(ctx, args),
});

// ── rule application (BNK-050/052) ─────────────────────────────────────────────────────────────────────

export const decisionInternal = systemQuery({
  job: "bank.rules",
  args: { transactionId: v.id("bankTransactions") },
  handler: async (ctx, { transactionId }) => {
    const r = await ruleFor(ctx, transactionId);
    if (!r || (r.tx.status !== "open" && r.tx.status !== "partially_matched") || r.tx.allocatedCents > 0) return null;
    return {
      ruleId: r.rule.id as Id<"matchingRules">,
      name: r.rule.name,
      mode: r.rule.mode,
      apply: r.rule.apply,
      amountCents: r.tx.amountCents,
    };
  },
});

export const markInputInternal = systemQuery({
  job: "bank.rules",
  args: {
    transactionId: v.id("bankTransactions"),
    as: v.union(v.literal("private"), v.literal("transfer"), v.literal("cash_withdrawal")),
    createdBy: v.string(),
  },
  handler: async (ctx, { transactionId, as, createdBy }) =>
    markEigenbelegInput(ctx, { transactionId, as }, createdBy, Date.now()),
});

export const categorizeInternal = actorMutation({
  permission: "bankRules.apply",
  args: { transactionId: v.id("bankTransactions"), ruleId: v.id("matchingRules") },
  handler: async (ctx, args) => categorizeByRule(ctx, args),
});

type MarkAs = "private" | "transfer" | "cash_withdrawal";

/** The mark a `private`/`transfer` rule performs (transfer to the cash account = ATM withdrawal into the till). */
function markFor(apply: { action: string; transferTarget?: { kind: string } }, amountCents: number): MarkAs | null {
  if (apply.action === "private") return "private";
  if (apply.action === "transfer")
    return apply.transferTarget?.kind === "cash" && amountCents < 0 ? "cash_withdrawal" : "transfer";
  return null;
}

/**
 * Applies the first matching rule to one transaction. `force` = the owner's explicit „Auf offene Umsätze anwenden“
 * (BNK-051); otherwise only `auto` rules act. `ignore` and `loan` never act automatically (BNK-063, BNK-062 P2 SHOULD:
 * manual split); `link_contact` works at scoring time.
 */
async function applyOne(
  ctx: ActionCtx,
  actorContext: ActorContext,
  transactionId: Id<"bankTransactions">,
  force: boolean,
  onlyRule?: Id<"matchingRules">,
): Promise<string | null> {
  const d = await ctx.runQuery(internal.matchingRules.decisionInternal, { transactionId });
  if (!d || (onlyRule && d.ruleId !== onlyRule) || (!force && d.mode !== "auto")) return null;
  if (d.apply.action === "categorize") {
    await ctx.runMutation(internal.matchingRules.categorizeInternal, { actorContext, transactionId, ruleId: d.ruleId });
    return "categorize";
  }
  const as = markFor(d.apply, d.amountCents);
  if (!as) return null;
  const input = await ctx.runQuery(internal.matchingRules.markInputInternal, {
    transactionId,
    as,
    createdBy: `Regel „${d.name}“`,
  });
  let eigenbeleg: FileRefValue | undefined;
  if (input) {
    const content = eigenbelegContent(input);
    const bytes = await renderEigenbeleg(content, input.company, Date.now());
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    eigenbeleg = {
      storageId,
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      mime: "application/pdf",
      name: content.fileName,
    };
  }
  try {
    await ctx.runMutation(internal.banking.applyMark, {
      actorContext,
      transactionId,
      as,
      ...(eigenbeleg ? { eigenbeleg } : {}),
    });
  } catch (e) {
    if (eigenbeleg) await ctx.storage.delete(eigenbeleg.storageId);
    throw e;
  }
  return as;
}

/** Scheduled after an import/poll commit: rules first, then the BNK-043 auto-apply for the remaining rows. */
export const afterImport = systemAction({
  job: "bank.rules",
  args: { transactionIds: v.array(v.id("bankTransactions")) },
  handler: async (ctx, { transactionIds }) => {
    const applied: string[] = [];
    for (const transactionId of transactionIds) {
      let done: string | null = null;
      try {
        done = await applyOne(ctx, ctx.actorContext, transactionId, false);
      } catch (e) {
        console.warn(`[bank-rules] rule failed for ${transactionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (done) {
        applied.push(transactionId);
        continue;
      }
      try {
        await ctx.runMutation(internal.matching.autoApplyInternal, { actorContext: ctx.actorContext, transactionId });
      } catch (e) {
        console.warn(
          `[bank-rules] auto-apply failed for ${transactionId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return { applied };
  },
});

/** BNK-051: the explicit act of applying a (new) rule to the existing open transactions it matches. */
export const applyToExisting = action({
  permission: "bankRules.apply",
  args: { ruleId: v.id("matchingRules"), transactionIds: v.array(v.id("bankTransactions")) },
  handler: async (ctx, { ruleId, transactionIds }) => {
    if (transactionIds.length > 200) throw appError("invalid_input", "Höchstens 200 Umsätze auf einmal.");
    const results: { transactionId: Id<"bankTransactions">; applied: string | null; error?: string }[] = [];
    for (const transactionId of transactionIds) {
      try {
        results.push({ transactionId, applied: await applyOne(ctx, ctx.actorContext, transactionId, true, ruleId) });
      } catch (e) {
        const message =
          (e as { data?: { message?: string } }).data?.message ?? (e instanceof Error ? e.message : String(e));
        results.push({ transactionId, applied: null, error: message });
      }
    }
    return { applied: results.filter((r) => r.applied).length, results };
  },
});
