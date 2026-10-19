import { formatMoneyDe } from "../../src/domain/banking/amount";
import {
  categorizeOutcome,
  firstMatchingRule,
  type MatchingRule,
  modeForChannel,
  previewRule,
  RULE_MESSAGES,
  type RuleTx,
  validateRule,
} from "../../src/domain/banking/rules";
import type { Channel } from "../../src/domain/schemas/actor";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import { supplierKeys } from "../../src/domain/vouchers/supplier-key";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { requireTransaction } from "./bankTransactions";
import { upsertNotification } from "./salesDocuments";
import type { ModelCtx, ReadCtx } from "./types";
import { createVoucher, type DraftInput, finalizeVoucher, previewVoucher } from "./vouchers";

/**
 * Matching rules (F07 BNK-050…054) and vouchers from transactions (BNK-052, BNK-065). The only writer of
 * `matchingRules`. Rules run before scoring on booked rows only (pending rows are not in `bankTransactions`, BNK-111).
 */

export type RuleDoc = Doc<"matchingRules">;
export type RuleInput = Pick<RuleDoc, "name" | "priority" | "enabled" | "when" | "apply"> & { mode?: RuleDoc["mode"] };

export const toDomainRule = (r: RuleDoc): MatchingRule => ({
  id: r._id,
  name: r.name,
  priority: r.priority,
  enabled: r.enabled,
  mode: r.mode,
  when: r.when,
  apply: {
    ...r.apply,
    ...(r.apply.contactId ? { contactId: r.apply.contactId } : {}),
    ...(r.apply.transferTarget
      ? {
          transferTarget:
            r.apply.transferTarget.kind === "bank"
              ? { kind: "bank" as const, accountId: r.apply.transferTarget.accountId }
              : { kind: "cash" as const },
        }
      : {}),
  },
});

export const ruleTx = (t: Doc<"bankTransactions">): RuleTx => ({
  id: t._id,
  accountId: t.accountId,
  bookingDate: t.bookingDate,
  amountCents: t.amountCents,
  currency: t.currency,
  purpose: t.purpose,
  ...(t.reference ? { reference: t.reference } : {}),
  ...(t.counterpartyName ? { counterpartyName: t.counterpartyName } : {}),
  ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
  ...(t.source.merchantName ? { merchantName: t.source.merchantName } : {}),
  ...(t.source.mcc ? { mcc: t.source.mcc } : {}),
  ...(t.source.bankTransactionCode ? { bankTransactionCode: t.source.bankTransactionCode } : {}),
  ...(t.source.proprietaryCode ? { proprietaryCode: t.source.proprietaryCode } : {}),
});

export async function listRules(ctx: ReadCtx): Promise<RuleDoc[]> {
  return (await ctx.db.query("matchingRules").withIndex("by_priority").collect()).sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );
}

function assertValid(input: RuleInput, mode: RuleDoc["mode"]) {
  const issues = validateRule({ name: input.name, mode, when: input.when, apply: input.apply });
  if (issues.length > 0) {
    const first = issues[0];
    throw appError("invalid_input", issues.map((i) => i.message).join(" "), {
      reason: first?.code === "rule_regex_invalid" ? "RULE_REGEX_INVALID" : "RULE_INVALID",
      ...(first?.params?.field ? { field: String(first.params.field) } : {}),
    });
  }
}

const normalise = (input: RuleInput): RuleInput => ({
  ...input,
  name: input.name.trim(),
  when: Object.fromEntries(
    Object.entries(input.when).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)),
  ) as RuleDoc["when"],
});

/** BNK-050 / BNK-054: create; REST/MCP rules are always stored as `suggest` (EC-BNK-73 warning). */
export async function createRule(
  ctx: ModelCtx,
  raw: RuleInput,
  channel: Channel,
): Promise<{ id: Id<"matchingRules">; mode: RuleDoc["mode"]; warning: string | null }> {
  const input = normalise(raw);
  const { mode, warning } = modeForChannel(channel, input.mode);
  assertValid(input, mode);
  const id = await auditedInsert(
    ctx,
    "matchingRules",
    {
      name: input.name,
      priority: input.priority,
      enabled: input.enabled,
      mode,
      when: input.when,
      apply: input.apply,
      createdVia: channel,
      createdAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "bank.rule_create", label: input.name },
  );
  return { id, mode, warning: warning?.message ?? null };
}

/** BNK-054: switching a rule to `auto` requires the UI (signed-in member); API/MCP edits keep `suggest`. */
export async function updateRule(
  ctx: ModelCtx,
  id: Id<"matchingRules">,
  patch: Partial<RuleInput>,
  channel: Channel,
): Promise<{ mode: RuleDoc["mode"]; warning: string | null }> {
  const r = await ctx.db.get(id);
  if (!r) throw appError("not_found", "Die Regel existiert nicht.");
  const merged = normalise({
    name: patch.name ?? r.name,
    priority: patch.priority ?? r.priority,
    enabled: patch.enabled ?? r.enabled,
    when: patch.when ?? r.when,
    apply: patch.apply ?? r.apply,
  });
  let mode = patch.mode ?? r.mode;
  let warning: string | null = null;
  if (channel !== "ui" && mode === "auto" && r.mode !== "auto") {
    mode = "suggest";
    warning = RULE_MESSAGES.apiSuggestOnly;
  }
  // A rule changed through the API loses automation it had (the owner re-enables it in the UI).
  if (channel !== "ui" && r.mode === "auto" && (patch.when || patch.apply)) {
    mode = "suggest";
    warning = RULE_MESSAGES.apiSuggestOnly;
  }
  assertValid(merged, mode);
  await auditedPatch(
    ctx,
    "matchingRules",
    id,
    { ...merged, mode, updatedAt: ctx.now() },
    { action: "bank.rule_update", label: merged.name },
  );
  return { mode, warning };
}

export async function deleteRule(ctx: ModelCtx, id: Id<"matchingRules">) {
  const r = await ctx.db.get(id);
  if (!r) throw appError("not_found", "Die Regel existiert nicht.");
  await auditedDelete(ctx, "matchingRules", id, { action: "bank.rule_delete", label: r.name });
}

/** Booked transactions of the last 90 days (all accounts) for the preview and the hit counts. */
async function recentTransactions(ctx: ReadCtx, today: string): Promise<Doc<"bankTransactions">[]> {
  const from = addDays(today as CalendarDate, -90);
  const out: Doc<"bankTransactions">[] = [];
  for (const a of await ctx.db.query("bankAccounts").collect()) {
    out.push(
      ...(await ctx.db
        .query("bankTransactions")
        .withIndex("by_account_bookingDate", (q) => q.eq("accountId", a._id).gte("bookingDate", from))
        .collect()),
    );
  }
  return out;
}

/** BNK-051: „Diese Regel würde 14 Umsätze der letzten 90 Tage treffen“ with the list — no side effects. */
export async function previewRuleHits(ctx: ReadCtx, when: RuleDoc["when"], now: number) {
  const today = berlinCalendarDate(now);
  const txs = await recentTransactions(ctx, today);
  const byId = new Map(txs.map((t) => [t._id as string, t]));
  const p = previewRule({ when }, txs.map(ruleTx), today);
  return {
    count: p.count,
    message: p.message,
    hits: p.hits.slice(0, 50).map((h) => {
      const t = byId.get(h.id) as Doc<"bankTransactions">;
      return {
        id: t._id,
        accountId: t.accountId,
        bookingDate: t.bookingDate,
        amountCents: t.amountCents,
        currency: t.currency,
        counterpartyName: t.counterpartyName ?? null,
        purpose: t.purpose,
        status: t.status,
      };
    }),
  };
}

export async function rulesWithHits(ctx: ReadCtx, now: number) {
  const today = berlinCalendarDate(now);
  const txs = (await recentTransactions(ctx, today)).map(ruleTx);
  return (await listRules(ctx)).map((r) => ({
    ...r,
    hits90: previewRule({ when: r.when }, txs, today).count,
  }));
}

/** The rule that applies to a booked transaction (first match by priority), or null. */
export async function ruleFor(ctx: ReadCtx, txId: Id<"bankTransactions">) {
  const tx = await ctx.db.get(txId);
  if (!tx) return null;
  const rules = (await listRules(ctx)).map(toDomainRule);
  const rule = firstMatchingRule(rules, ruleTx(tx));
  return rule ? { rule, tx } : null;
}

const labelOf = (tx: Doc<"bankTransactions">) =>
  `${formatGermanDate(tx.bookingDate as CalendarDate)} ${formatMoneyDe(tx.amountCents, tx.currency)}`;

/** Suggested account/tax rule from the supplier profile of the counterparty (F06 VOU-010). */
async function supplierSuggestion(ctx: ReadCtx, tx: Doc<"bankTransactions">) {
  const keys = supplierKeys({
    ...(tx.counterpartyIban ? { iban: tx.counterpartyIban } : {}),
    ...(tx.counterpartyName || tx.source.merchantName
      ? { name: (tx.source.merchantName ?? tx.counterpartyName) as string }
      : {}),
  });
  for (const k of keys) {
    const row = await ctx.db
      .query("supplierProfiles")
      .withIndex("by_key", (q) => q.eq("key", k))
      .first();
    if (row?.lastAccount) return { account: row.lastAccount, taxRule: row.lastTaxRule };
  }
  return null;
}

/**
 * BNK-065 „+ Neuer Beleg“: a voucher draft prefilled from the transaction (date, amount, counterparty, reference,
 * currency / original amount, account suggestion from the supplier profile), linked to the transaction so that the
 * finalisation allocates it (`finalizeVoucher` → F06 bank payment).
 */
export async function voucherFromTransaction(
  ctx: ModelCtx,
  args: {
    transactionId: Id<"bankTransactions">;
    account?: string;
    taxRule?: DraftInput["taxRule"];
    ruleId?: Id<"matchingRules">;
    flags?: { statementIsBeleg?: true; receiptMissing?: true };
    /** Supplier when the row names no counterparty (bank fees/interest: the account's bank). */
    supplierFallback?: string;
  },
): Promise<Id<"vouchers">> {
  const tx = await requireTransaction(ctx, args.transactionId);
  if (tx.status !== "open" && tx.status !== "partially_matched")
    throw appError("invalid_input", "Der Umsatz ist bereits zugeordnet oder markiert.", { reason: "TX_NOT_OPEN" });
  const existing = (
    await ctx.db
      .query("vouchers")
      .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", tx._id))
      .collect()
  ).find((v) => v.status !== "cancelled");
  if (existing) return existing._id;
  const open = Math.abs(tx.amountCents) - tx.allocatedCents;
  const suggestion = args.account ? null : await supplierSuggestion(ctx, tx);
  const account = args.account ?? suggestion?.account;
  const instructed = tx.source.instructedAmount;
  const foreign = instructed && instructed.currency !== tx.currency;
  const name = tx.source.merchantName ?? tx.counterpartyName ?? args.supplierFallback;
  const description = [tx.reference, tx.purpose].filter(Boolean).join(" ").slice(0, 200) || undefined;
  const taxRule = args.taxRule ?? (suggestion?.taxRule as DraftInput["taxRule"] | undefined);
  const input: DraftInput = {
    direction: tx.amountCents < 0 ? "expense" : "income",
    documentDate: tx.bookingDate,
    currency: foreign ? instructed.currency : tx.currency,
    priceMode: "gross",
    ...(name ? { supplierName: name } : {}),
    ...(tx.counterpartyIban ? { supplierIban: tx.counterpartyIban } : {}),
    ...(tx.reference ? { documentNumber: tx.reference.slice(0, 60) } : {}),
    ...(taxRule ? { taxRule } : {}),
    ...(account
      ? {
          lines: [
            {
              account,
              ...(description ? { description } : {}),
              amountCents: foreign ? instructed.amountMinor : open,
              vatRateBp: 0,
            },
          ],
        }
      : {}),
    internalNote: `Aus Bankumsatz ${labelOf(tx)}${foreign ? ` (Originalbetrag ${formatMoneyDe(instructed.amountMinor, instructed.currency)})` : ""}`,
  };
  return createVoucher(ctx, {
    input,
    extra: {
      bankTransactionId: tx._id,
      ...(args.ruleId ? { ruleId: args.ruleId } : {}),
      ...(args.flags ?? {}),
    } as never,
  });
}

/**
 * BNK-052 `categorize`: a finalised voucher only for an `auto` rule with „Kontoauszug genügt als Beleg“ (and only if
 * the voucher validates without open warnings); otherwise a draft flagged „Beleg fehlt“ (F06 missing receipts,
 * EC-BNK-72 notification).
 */
export async function categorizeByRule(
  ctx: ModelCtx,
  args: { transactionId: Id<"bankTransactions">; ruleId: Id<"matchingRules"> },
): Promise<{ voucherId: Id<"vouchers">; finalised: boolean }> {
  const r = await ctx.db.get(args.ruleId);
  if (r?.apply.action !== "categorize" || !r.apply.account)
    throw appError("invalid_input", "Keine Kategorisierungsregel.");
  const tx = await requireTransaction(ctx, args.transactionId);
  const outcome = categorizeOutcome(r, tx);
  const voucherId = await voucherFromTransaction(ctx, {
    transactionId: tx._id,
    account: r.apply.account,
    ...(r.apply.taxRule ? { taxRule: r.apply.taxRule as DraftInput["taxRule"] } : {}),
    ruleId: r._id,
    supplierFallback: (await ctx.db.get(tx.accountId))?.name ?? "Bank",
    flags: outcome.kind === "finalised" ? { statementIsBeleg: true } : { receiptMissing: true },
  });
  if (outcome.kind === "finalised") {
    const p = await previewVoucher(ctx, { id: voucherId }, ctx.now());
    const blocked =
      p.check.errors.length > 0 || [...p.check.warnings, ...p.payment.warnings].some((w) => w.acknowledge);
    if (!blocked) {
      await finalizeVoucher(ctx, { id: voucherId });
      return { voucherId, finalised: true };
    }
    await auditedPatch(
      ctx,
      "vouchers",
      voucherId,
      { statementIsBeleg: undefined, receiptMissing: true },
      { action: "bank.rule_apply", label: r.name, reason: p.check.errors.map((e) => e.message).join(" ") || undefined },
    );
  }
  await upsertNotification(ctx, {
    kind: "bank.rule_receipt_missing",
    severity: "warning",
    title: RULE_MESSAGES.receiptMissing(
      formatGermanDate(tx.bookingDate as CalendarDate),
      formatMoneyDe(tx.amountCents, tx.currency),
    ),
    link: `/belege/${voucherId}`,
    entity: { table: "vouchers", id: voucherId },
    dedupeKey: `bank.rule_receipt_missing:${voucherId}`,
  });
  return { voucherId, finalised: false };
}
