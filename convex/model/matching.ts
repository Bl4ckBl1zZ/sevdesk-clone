import { isCardRefund } from "../../src/domain/banking/links";
import {
  aliasToken,
  autoApplicable,
  type CreditBalanceCandidate,
  DEFAULT_THRESHOLDS,
  isSafe,
  type ManualPayment,
  type MatchInput,
  normaliseName,
  type OpenDocument,
  type OpenRefund,
  type OpenVoucher,
  scoreTransaction,
} from "../../src/domain/banking/match";
import type { MatchAllocation, MatchCandidate, UnmatchedTransaction } from "../../src/domain/banking/match-types";
import { MATCH_MESSAGES } from "../../src/domain/banking/matching-messages";
import { voucherFxDifference } from "../../src/domain/banking/voucher-fx";
import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import { isArchiveOnlyImport } from "../../src/domain/import/sevdesk/types";
import type { DifferenceInput } from "../../src/domain/payments/plan";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert } from "./audit";
import { linkReversal, requireTransaction, unmatchedTransactions } from "./bankTransactions";
import { notify } from "./notifications";
import {
  creditBalance,
  type RecordResult,
  reconcileManualPayment,
  recordPayment,
  refundCorrection,
  refundCredit,
  reverseTransactionPayments,
} from "./payments";
import type { ModelCtx, ReadCtx } from "./types";
import { recordVoucherPayment } from "./voucherPayments";

/**
 * Matching provider (F07 BNK-040…BNK-048): loads the open items, unreconciled manual payments, credit balances,
 * learned aliases and rejections, runs the pure scorer (`src/domain/banking/match.ts`) on read — suggestions are
 * never stale and need no storage — and confirms a candidate through F05 `recordPayment` with `source.kind = "bank"`
 * (the only path that allocates a transaction, BNK-122). Auto-apply (BNK-043) runs after a statement import.
 */

const OPEN_STATUSES = ["open", "partially_paid"] as const;

async function contactKeys(ctx: ReadCtx, contactId: Id<"contacts"> | undefined) {
  if (!contactId) return { ibans: [] as string[], aliases: [] as string[] };
  const contact = await ctx.db.get(contactId);
  const parent = contact?.parentId ? await ctx.db.get(contact.parentId) : null;
  const aliases = await ctx.db
    .query("contactAliases")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  return {
    ibans: [contact?.iban, parent?.iban, ...aliases.map((a) => a.iban)].filter((x): x is string => !!x),
    aliases: [parent?.displayName, ...aliases.map((a) => a.token)].filter((x): x is string => !!x),
  };
}

/** Everything the scorer needs except the rejections (per transaction). */
export async function matchContext(ctx: ReadCtx): Promise<Omit<MatchInput, "rejected">> {
  const documents: OpenDocument[] = [];
  const refunds: OpenRefund[] = [];
  const keys = new Map<string, { ibans: string[]; aliases: string[] }>();
  const keysOf = async (id: Id<"contacts"> | undefined) => {
    if (!id) return { ibans: [], aliases: [] };
    const k = keys.get(id) ?? (await contactKeys(ctx, id));
    keys.set(id, k);
    return k;
  };
  for (const status of OPEN_STATUSES) {
    const docs = await ctx.db
      .query("salesDocuments")
      .withIndex("by_paymentStatus_due", (q) => q.eq("paymentStatus", status))
      .collect();
    for (const d of docs) {
      if (d.status === "draft" || d.status === "cancelled" || !d.number || !d.documentDate) continue;
      // F09 IMP-007: an archived sevdesk invoice is matched through its opening item (listed below), never twice;
      // one posted at import (EC-204) is matched itself.
      if (isArchiveOnlyImport(d)) continue;
      const open = d.openAmountCents ?? d.totals.payableCents;
      if (d.type === "correction" && d.correctionKind === "credit") {
        // PAY-033 (b): a negative open amount is a refund the company owes — a candidate for outgoing debits.
        if (open >= 0) continue;
        const k = await keysOf(d.contactId);
        refunds.push({
          id: d._id,
          number: d.number,
          ...(d.contactId ? { contactId: d.contactId } : {}),
          contactName: d.contactName ?? "",
          ibans: k.ibans,
          aliases: k.aliases,
          documentDate: d.documentDate,
          ...(d.dueDate ? { dueDate: d.dueDate } : {}),
          openCents: -open,
          currency: d.currency,
        });
        continue;
      }
      if (open <= 0) continue;
      const snap = d.snapshotId ? await ctx.db.get(d.snapshotId) : null;
      const skonto = snap ? (JSON.parse(snap.json) as DocumentSnapshot).payment.skonto : undefined;
      const k = await keysOf(d.contactId);
      documents.push({
        kind: "salesDocument",
        id: d._id,
        number: d.number,
        ...(d.contactId ? { contactId: d.contactId } : {}),
        contactName: d.contactName ?? "",
        ibans: k.ibans,
        aliases: k.aliases,
        documentDate: d.documentDate,
        ...(d.dueDate ? { dueDate: d.dueDate } : {}),
        openCents: open,
        currency: d.currency,
        // Skonto is offered only while nothing was paid yet (the agreed amount refers to the full payable).
        skonto:
          skonto && open === d.totals.payableCents ? { deadline: skonto.date, agreedCents: skonto.amountCents } : null,
      });
    }
  }
  for (const item of await ctx.db.query("openingItems").collect()) {
    if (item.openAmountCents <= 0) continue;
    const k = await keysOf(item.contactId);
    documents.push({
      kind: "opening_item",
      id: item._id,
      number: item.number,
      ...(item.contactId ? { contactId: item.contactId } : {}),
      contactName: item.counterpartyName,
      ibans: k.ibans,
      aliases: k.aliases,
      documentDate: item.documentDate,
      ...(item.dueDate ? { dueDate: item.dueDate } : {}),
      openCents: item.openAmountCents,
      currency: "EUR",
      skonto: null,
    });
  }
  const manualPayments: ManualPayment[] = [];
  const creditContacts = new Set<string>();
  for (const p of await ctx.db.query("payments").collect()) {
    if (p.target.kind === "contactCredit") creditContacts.add(p.target.id);
    if (p.source.kind !== "clearing" || p.reversedById || p.reversalOfId || p.reconciledTransactionId) continue;
    if (p.amountCents <= 0) continue;
    manualPayments.push({
      paymentId: p._id,
      date: p.date,
      amountCents: p.amountCents,
      accountId: p.source.accountId,
      label: `Zahlung ${p.number ?? ""} vom ${p.date}`.replace("  ", " "),
    });
  }
  const credits: CreditBalanceCandidate[] = [];
  for (const contactId of creditContacts) {
    const balance = await creditBalance(ctx, contactId);
    if (balance <= 0) continue;
    const contact = await ctx.db.get(contactId as Id<"contacts">);
    const k = await keysOf(contactId as Id<"contacts">);
    credits.push({
      contactId,
      contactName: contact?.displayName ?? "",
      ibans: k.ibans,
      aliases: k.aliases,
      balanceCents: balance,
    });
  }
  return { documents, manualPayments, credits, refunds, vouchers: await openVouchers(ctx, keysOf) };
}

/** BNK-049: booked, open expense vouchers (F06) as candidates for outgoing debits. */
async function openVouchers(
  ctx: ReadCtx,
  keysOf: (id: Id<"contacts"> | undefined) => Promise<{ ibans: string[]; aliases: string[] }>,
): Promise<OpenVoucher[]> {
  const out: OpenVoucher[] = [];
  for (const status of ["open", "partially_paid"] as const) {
    for (const v of await ctx.db
      .query("vouchers")
      .withIndex("by_status_date", (q) => q.eq("status", status))
      .collect()) {
      if (v.direction !== "expense" || v.openAmountCents <= 0 || !v.documentDate) continue;
      const k = await keysOf(v.supplierContactId);
      const unpaid = v.totalsEur ? v.openAmountCents === v.totalsEur.grossCents : true;
      out.push({
        id: v._id,
        ...(v.documentNumber ? { documentNumber: v.documentNumber } : {}),
        ...(v.internalNumber ? { internalNumber: v.internalNumber } : {}),
        supplierName: v.supplierName ?? "",
        ibans: [v.supplierIban, v.payee?.iban, ...k.ibans].filter((x): x is string => !!x),
        aliases: k.aliases,
        documentDate: v.documentDate,
        ...(v.dueDate ? { dueDate: v.dueDate } : {}),
        openCents: v.openAmountCents,
        currency: "EUR",
        ...(v.currency !== "EUR" && unpaid
          ? { currency: v.currency, billOpenMinor: Math.abs(v.totals.grossCents) }
          : {}),
        ...(v.recurringVoucherId ? { recurring: true } : {}),
      });
    }
  }
  return out;
}

async function rejectedFor(ctx: ReadCtx, txId: Id<"bankTransactions">): Promise<Set<string>> {
  const rows = await ctx.db
    .query("matchRejections")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txId))
    .collect();
  return new Set(rows.map((r) => `${r.target.kind}:${r.target.id}`));
}

/** Candidates for one transaction (manual payments only on the same account, PAY-047). */
export async function candidatesFor(
  ctx: ReadCtx,
  tx: UnmatchedTransaction,
  base?: Omit<MatchInput, "rejected">,
): Promise<MatchCandidate[]> {
  const input = base ?? (await matchContext(ctx));
  return scoreTransaction(tx, {
    ...input,
    manualPayments: (input.manualPayments ?? []).filter((m) => m.accountId === tx.accountId),
    rejected: await rejectedFor(ctx, tx.id as Id<"bankTransactions">),
  });
}

/** Display data of a candidate's targets (number, contact, open amount) for the review cards (F07 §6.3). */
export async function targetLabels(ctx: ReadCtx, allocations: readonly MatchAllocation[]) {
  const out = [];
  for (const a of allocations) {
    if (a.target.kind === "salesDocument") {
      const d = await ctx.db.get(a.target.id as Id<"salesDocuments">);
      // PAY-033 (b): an outgoing debit refunds a credit correction; its open refund is shown as a positive amount.
      const refund = d?.type === "correction";
      out.push({
        ...a,
        label: refund ? `Erstattung zu Rechnungskorrektur ${d?.number ?? ""}`.trim() : (d?.number ?? "Rechnung"),
        contactName: d?.contactName ?? "",
        openCents: refund ? Math.max(0, -(d?.openAmountCents ?? 0)) : (d?.openAmountCents ?? 0),
        dueDate: d?.dueDate ?? null,
        docType: d?.type ?? null,
      });
    } else if (a.target.kind === "opening_item") {
      const i = await ctx.db.get(a.target.id as Id<"openingItems">);
      out.push({
        ...a,
        label: i?.number ?? "Offener Posten",
        contactName: i?.counterpartyName ?? "",
        openCents: i?.openAmountCents ?? 0,
        dueDate: i?.dueDate ?? null,
        docType: null,
      });
    } else if (a.target.kind === "contactCredit") {
      const c = await ctx.db.get(a.target.id as Id<"contacts">);
      out.push({
        ...a,
        label: "Guthaben",
        contactName: c?.displayName ?? "",
        openCents: await creditBalance(ctx, a.target.id),
        dueDate: null,
        docType: null,
      });
    } else if (a.target.kind === "payment") {
      const p = await ctx.db.get(a.target.id as Id<"payments">);
      out.push({
        ...a,
        label: `Bereits erfasste Zahlung ${p?.number ?? ""}`.trim(),
        contactName: "",
        openCents: p?.amountCents ?? 0,
        dueDate: null,
        docType: null,
      });
    } else if (a.target.kind === "voucher") {
      const v = await ctx.db.get(a.target.id as Id<"vouchers">);
      out.push({
        ...a,
        label: `Beleg ${v?.internalNumber ?? v?.documentNumber ?? ""}`.trim(),
        contactName: v?.supplierName ?? "",
        openCents: v?.openAmountCents ?? 0,
        dueDate: v?.dueDate ?? null,
        docType: null,
      });
    } else {
      out.push({ ...a, label: a.target.kind, contactName: "", openCents: 0, dueDate: null, docType: null });
    }
  }
  return out;
}

/** Scorer allocations → confirm input (the scorer proposes only Skonto/bank-fee differences, BNK-045). */
const confirmAllocations = (allocations: readonly MatchAllocation[]): ConfirmArgs["allocations"] =>
  allocations.map((a) => ({
    target: a.target,
    amountCents: a.amountCents,
    ...(a.differences?.length
      ? {
          differences: a.differences.map((d) => ({
            reason: d.reason as DifferenceInput["reason"],
            amountCents: d.amountCents,
          })),
        }
      : {}),
  }));

export interface ConfirmArgs {
  transactionId: Id<"bankTransactions">;
  allocations: { target: { kind: string; id: string }; amountCents: number; differences?: DifferenceInput[] }[];
  /** PAY-030: the remainder of an incoming transaction goes to the contact's credit balance (else unallocated). */
  remainder?: "credit" | "unallocated";
  acknowledgeWarnings?: string[];
  provenance?: { score: number; reasons: string[]; auto: boolean };
}

/**
 * BNK-046 ✓ Bestätigen: runs F05 `recordPayment` (incoming), `refundCredit` (outgoing to a credit balance) or the
 * PAY-047 reconciliation of an existing manual payment, then learns the counterparty alias (BNK-048).
 */
/** EC-BNK-25: only bank-fee/other differences carry over to a voucher payment (no write-offs on purchase vouchers). */
function voucherDifferences(diffs: DifferenceInput[] | undefined) {
  const out = (diffs ?? []).map((d) => {
    if (d.reason !== "bank_fees" && d.reason !== "skonto" && d.reason !== "other")
      throw appError("invalid_input", "Diese Differenz ist bei Belegen nicht möglich.", {
        reason: "DIFFERENCE_REASON",
      });
    return { reason: d.reason, amountCents: d.amountCents, ...(d.account ? { account: d.account } : {}) };
  });
  return out.length ? { differences: out } : {};
}

/**
 * EC-BNK-76: a foreign card payment that settles a foreign-currency voucher in full carries the realised exchange
 * difference (PAY-018 mirrored) — computed here from stored data, never trusted from the client.
 */
async function withVoucherFx(
  ctx: ReadCtx,
  tx: Doc<"bankTransactions">,
  a: { target: { id: string }; amountCents: number; differences?: DifferenceInput[] },
) {
  const base = voucherDifferences(a.differences);
  const v = await ctx.db.get(a.target.id as Id<"vouchers">);
  if (!v || v.currency === "EUR") return base;
  const own = base.differences ?? [];
  const fx = voucherFxDifference({
    voucherCurrency: v.currency,
    billGrossMinor: Math.abs(v.totals.grossCents),
    openEurCents: v.openAmountCents,
    unpaid: v.totalsEur ? v.openAmountCents === v.totalsEur.grossCents : true,
    paidEurCents: a.amountCents + own.reduce((sum, d) => sum + d.amountCents, 0),
    ...(tx.source.instructedAmount ? { instructed: tx.source.instructedAmount } : {}),
  });
  if (!fx) return base;
  // Posted on fx_loss / fx_gain by the voucher posting (role from the sign, like BNK-028 / PAY-018).
  return { differences: [...own, { reason: "fx_difference" as const, amountCents: fx.amountCents }] };
}

export async function confirmMatch(
  ctx: ModelCtx,
  args: ConfirmArgs,
): Promise<RecordResult | { reconciled: true } | { refunded: Id<"payments"> }> {
  const tx = await requireTransaction(ctx, args.transactionId);
  if (args.allocations.length === 0) throw appError("invalid_input", "Bitte mindestens eine Zuordnung angeben.");
  // EC-BNK-62: another confirmation (other tab, auto-apply, MCP) allocated this transaction in the meantime. Convex
  // mutations are serialisable, so the later one sees the allocation and is refused before anything is written.
  const requested = args.allocations.reduce((s, a) => s + a.amountCents, 0);
  if (tx.allocatedCents > 0 && requested > Math.abs(tx.amountCents) - tx.allocatedCents) {
    throw appError("conflict", MATCH_MESSAGES.concurrent, { reason: "TX_ALREADY_ALLOCATED" });
  }
  const [first] = args.allocations;
  if (first && first.target.kind === "payment") {
    if (args.allocations.length !== 1)
      throw appError("invalid_input", "Eine erfasste Zahlung wird allein abgeglichen.");
    await reconcileManualPayment(ctx, { paymentId: first.target.id as Id<"payments">, transactionId: tx._id });
    return { reconciled: true };
  }
  if (tx.amountCents < 0 && first?.target.kind === "voucher") {
    // BNK-049: an outgoing debit pays an open purchase voucher (F06 bank payment, VOU-131).
    if (args.allocations.length !== 1)
      throw appError("invalid_input", "Ein Bankumsatz wird hier genau einem Beleg zugeordnet.", {
        reason: "TARGET_KIND",
      });
    const r = await recordVoucherPayment(ctx, {
      voucherId: first.target.id as Id<"vouchers">,
      method: "bank",
      transactionId: tx._id,
      amountCents: first.amountCents,
      ...(await withVoucherFx(ctx, tx, first)),
      ...(args.acknowledgeWarnings ? { acknowledgeWarnings: args.acknowledgeWarnings } : {}),
      ...(args.provenance ? { match: args.provenance } : {}),
    });
    return { refunded: r.paymentId };
  }
  if (tx.amountCents < 0) {
    // PAY-033 (b): an outgoing transaction refunds a credit correction (open refund, EC-PAY-33 checked there).
    if (args.allocations.length === 1 && first?.target.kind === "salesDocument") {
      const documentId = first.target.id as Id<"salesDocuments">;
      const r = await refundCorrection(ctx, {
        documentId,
        amountCents: first.amountCents,
        source: { kind: "bank", transactionId: tx._id },
        date: tx.bookingDate,
        ...(args.provenance ? { match: args.provenance } : {}),
      });
      const contactId = (await ctx.db.get(documentId))?.contactId;
      if (contactId) await learn(ctx, tx, contactId);
      return { refunded: r.paymentId };
    }
    if (args.allocations.length !== 1 || first?.target.kind !== "contactCredit") {
      throw appError(
        "invalid_input",
        "Ausgehende Umsätze können nur einem Kundenguthaben oder einer Rechnungskorrektur (Erstattung) zugeordnet werden.",
        { reason: "TX_DIRECTION" },
      );
    }
    const r = await refundCredit(ctx, {
      contactId: first.target.id as Id<"contacts">,
      amountCents: first.amountCents,
      source: { kind: "bank", transactionId: tx._id },
      date: tx.bookingDate,
      ...(args.provenance ? { match: args.provenance } : {}),
    });
    await learn(ctx, tx, first.target.id as Id<"contacts">);
    return { refunded: r.paymentId };
  }
  for (const a of args.allocations) {
    if (!["salesDocument", "opening_item", "contactCredit"].includes(a.target.kind)) {
      throw appError("invalid_input", "Diese Zuordnung ist nicht möglich.", { reason: "TARGET_KIND" });
    }
  }
  const allocations = args.allocations.map((a) => ({
    target: { kind: a.target.kind as "salesDocument" | "opening_item" | "contactCredit", id: a.target.id },
    amountCents: a.amountCents,
    ...(a.differences?.length ? { differences: a.differences } : {}),
  }));
  const open = Math.abs(tx.amountCents) - tx.allocatedCents;
  const sum = allocations.reduce((s, a) => s + a.amountCents, 0);
  let contactId: string | undefined;
  for (const a of allocations) {
    if (a.target.kind === "contactCredit") contactId ??= a.target.id;
    else if (a.target.kind === "salesDocument") {
      contactId ??= (await ctx.db.get(a.target.id as Id<"salesDocuments">))?.contactId;
    } else contactId ??= (await ctx.db.get(a.target.id as Id<"openingItems">))?.contactId;
  }
  if (args.remainder === "credit" && sum < open) {
    if (!contactId) throw appError("invalid_input", "Für ein Guthaben fehlt der Kunde.", { reason: "NO_CONTACT" });
    const existing = allocations.find((a) => a.target.kind === "contactCredit");
    if (existing) existing.amountCents += open - sum;
    else allocations.push({ target: { kind: "contactCredit", id: contactId }, amountCents: open - sum });
  }
  const r = await recordPayment(ctx, {
    source: { kind: "bank", transactionId: tx._id },
    date: tx.bookingDate,
    allocations,
    ...(args.acknowledgeWarnings ? { acknowledgeWarnings: args.acknowledgeWarnings } : {}),
    ...(args.provenance ? { match: args.provenance } : {}),
  });
  if (contactId) await learn(ctx, tx, contactId as Id<"contacts">);
  return r;
}

/** BNK-048: the normalised counterparty name and IBAN become aliases of the contact (once). */
async function learn(ctx: ModelCtx, tx: Doc<"bankTransactions">, contactId: Id<"contacts">) {
  const token = aliasToken({ ...(tx.counterpartyName ? { counterpartyName: tx.counterpartyName } : {}) });
  const iban = tx.counterpartyIban?.replace(/\s+/g, "").toUpperCase();
  if (!token && !iban) return;
  const contact = await ctx.db.get(contactId);
  if (!contact) return;
  const known = await ctx.db
    .query("contactAliases")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const sameName = token && normaliseName(contact.displayName) === token;
  if (known.some((a) => (token ? a.token === token : true) && (iban ? a.iban === iban : true))) return;
  if (sameName && (!iban || contact.iban?.replace(/\s+/g, "").toUpperCase() === iban)) return;
  await auditedInsert(
    ctx,
    "contactAliases",
    {
      contactId,
      token: token ?? normaliseName(contact.displayName),
      ...(iban ? { iban } : {}),
      source: "match_confirmed",
      createdAt: ctx.now(),
    },
    { action: "bank.alias_learn", label: contact.displayName },
  );
}

/** BNK-046 ✗ Ablehnen: the pair is stored and not suggested again. */
export async function rejectMatch(
  ctx: ModelCtx,
  args: { transactionId: Id<"bankTransactions">; target: { kind: string; id: string } },
): Promise<void> {
  await requireTransaction(ctx, args.transactionId);
  const existing = await rejectedFor(ctx, args.transactionId);
  if (existing.has(`${args.target.kind}:${args.target.id}`)) return;
  await auditedInsert(
    ctx,
    "matchRejections",
    { transactionId: args.transactionId, target: args.target, at: ctx.now(), actor: ctx.actor },
    { action: "bank.match_reject" },
  );
}

/**
 * BNK-043 auto-apply after an import: booked rows only, the account's toggle on, a unique candidate with the number
 * or RF reference and the exact open amount (`autoApplicable`). Returns the transactions that were applied.
 */
export async function autoApplyMatches(
  ctx: ModelCtx,
  txIds: readonly Id<"bankTransactions">[],
): Promise<Id<"bankTransactions">[]> {
  if (txIds.length === 0) return [];
  const wanted = new Set<string>(txIds);
  const accounts = new Map((await ctx.db.query("bankAccounts").collect()).map((a) => [a._id as string, a]));
  const base = await matchContext(ctx);
  const applied: Id<"bankTransactions">[] = [];
  for (const tx of await unmatchedTransactions(ctx, {})) {
    if (!wanted.has(tx.id) || accounts.get(tx.accountId)?.autoApplyMatches === false) continue;
    const [best] = await candidatesFor(ctx, tx, base);
    if (!best || !autoApplicable(best, DEFAULT_THRESHOLDS)) continue;
    await confirmMatch(ctx, {
      transactionId: tx.id as Id<"bankTransactions">,
      allocations: confirmAllocations(best.allocations),
      provenance: { score: best.score, reasons: best.reasons, auto: true },
    });
    applied.push(tx.id as Id<"bankTransactions">);
    // The confirmed document is settled now; refresh the context for the next transaction.
    Object.assign(base, await matchContext(ctx));
  }
  return applied;
}

/** „Alle sicheren bestätigen (≥ 0,95)“ (04 §4.6): confirms every safe, unambiguous best candidate. */
export async function confirmSafeMatches(ctx: ModelCtx, txIds: readonly Id<"bankTransactions">[]) {
  const wanted = new Set<string>(txIds);
  let base = await matchContext(ctx);
  const confirmed: Id<"bankTransactions">[] = [];
  for (const tx of await unmatchedTransactions(ctx, {})) {
    if (!wanted.has(tx.id)) continue;
    const [best] = await candidatesFor(ctx, tx, base);
    if (!best || !isSafe(best) || best.allocations.some((a) => a.target.kind === "payment")) continue;
    await confirmMatch(ctx, {
      transactionId: tx.id as Id<"bankTransactions">,
      allocations: confirmAllocations(best.allocations),
      provenance: { score: best.score, reasons: best.reasons, auto: false },
    });
    confirmed.push(tx.id as Id<"bankTransactions">);
    base = await matchContext(ctx);
  }
  return confirmed;
}

/**
 * BNK-121 / EC-PAY-24 „Als Rückbuchung verknüpfen“: links the counter-entry (`reversalOfId`) and, if the original was
 * allocated, reverses its payments (reason „Rückbuchung durch die Bank“) dated the counter-entry's booking date if
 * that period is open, else today (PAY-041); the reversal rows carry the counter-entry (allocated), so both bank rows
 * stay accounted for and the invoice reopens. Never automatic: only on the owner's confirmation.
 */
export async function linkBankReversal(
  ctx: ModelCtx,
  args: { counterId: Id<"bankTransactions">; originalId: Id<"bankTransactions"> },
) {
  const original = await requireTransaction(ctx, args.originalId);
  const counter = await requireTransaction(ctx, args.counterId);
  await linkReversal(ctx, args);
  if (original.allocatedCents <= 0) return { reversalIds: [] as Id<"payments">[], warnings: [] as string[] };
  // EC-BNK-27: a merchant's card refund reuses the bank-return flow but says what happened.
  const cardRefund = isCardRefund(
    {
      amountCents: counter.amountCents,
      ...(counter.source.merchantName ? { merchantName: counter.source.merchantName } : {}),
    },
    original.source.merchantName ? { merchantName: original.source.merchantName } : {},
  );
  const r = await reverseTransactionPayments(ctx, {
    transactionId: original._id,
    reason: cardRefund ? MATCH_MESSAGES.cardRefundReason : "Rückbuchung durch die Bank",
    preferredDate: counter.bookingDate,
    counterTransactionId: counter._id,
  });
  // F08 E-ACC-24 / EC-BNK-14: the owner learns which document is open again.
  for (const reversalId of r.reversalIds) {
    const reversal = await ctx.db.get(reversalId);
    const originalPayment = reversal?.reversalOfId ? await ctx.db.get(reversal.reversalOfId) : null;
    if (!reversal || !originalPayment) continue;
    const doc =
      reversal.target.kind === "salesDocument"
        ? await ctx.db.get(reversal.target.id as Id<"salesDocuments">)
        : reversal.target.kind === "voucher"
          ? await ctx.db.get(reversal.target.id as Id<"vouchers">)
          : null;
    const number = doc && "number" in doc ? doc.number : doc && "internalNumber" in doc ? doc.internalNumber : null;
    const label =
      reversal.target.kind === "salesDocument"
        ? `Rechnung ${number ?? ""}`.trim()
        : reversal.target.kind === "voucher"
          ? `Beleg ${number ?? ""}`.trim()
          : "Guthaben";
    await notify(ctx, {
      kind: "bank.reversal",
      severity: "warning",
      title: (cardRefund ? MATCH_MESSAGES.cardRefunded : MATCH_MESSAGES.bankReturned)(originalPayment.date, label),
      link: "/bank/zuordnungen",
      entity: { table: "payments", id: reversalId },
      dedupeKey: `bank.reversal|${reversalId}`,
    });
  }
  return {
    reversalIds: r.reversalIds,
    warnings: r.warnings.map((w) => (w.code === "reversal_period_locked" ? MATCH_MESSAGES.reversalLocked : w.message)),
  };
}

/** BNK-047 „Zuordnung aufheben“ / „Rückgängig“: F05 reversal with the F07 wording for a locked period (EC-BNK-74). */
export async function unmatchTransaction(
  ctx: ModelCtx,
  args: { transactionId: Id<"bankTransactions">; reason: string },
): Promise<Awaited<ReturnType<typeof reverseTransactionPayments>>> {
  const r = await reverseTransactionPayments(ctx, args);
  return {
    ...r,
    warnings: r.warnings.map((w) =>
      w.code === "reversal_period_locked" ? { ...w, message: MATCH_MESSAGES.unmatchLocked } : w,
    ),
  };
}
