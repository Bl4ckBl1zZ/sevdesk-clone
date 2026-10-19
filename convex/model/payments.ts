import type {
  BusinessEvent,
  IstVatBasis,
  PaymentDifference,
  PaymentMeans,
  RateAmount,
} from "../../src/domain/accounting/events";
import { taxationMethodAt } from "../../src/domain/accounting/period";
import { derivePaymentStatus, NEGATIVE_OPEN_MESSAGE, type StatusRow } from "../../src/domain/documents/payment-status";
import { isArchiveOnlyImport } from "../../src/domain/import/sevdesk/types";
import { formatEuro } from "../../src/domain/money/format";
import { PAY_MESSAGES } from "../../src/domain/payments/messages";
import { computeOpenItems, type OpenItemDocument, type SettlementRow } from "../../src/domain/payments/open-items";
import {
  type AllocationInput,
  allocationsForInvoice,
  type DifferenceInput,
  type ExcessMode,
  type PaymentInput,
  type PaymentPlan,
  type PaymentWarning,
  type PlannedRow,
  planPayment,
  type SourceFacts,
  type SourceInput,
  type TargetFacts,
  type TargetRef,
  targetKey,
  unacknowledged,
} from "../../src/domain/payments/plan";
import { planRefund, planReversal } from "../../src/domain/payments/reversal";
import type { SkontoTerms } from "../../src/domain/payments/skonto";
import type { GrossGroup } from "../../src/domain/payments/split";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { settleOpeningItem } from "./accounting";
import { auditedInsert, auditedPatch } from "./audit";
import { applyAllocation, requireTransaction } from "./bankTransactions";
import { cashOpeningDate } from "./cash";
import { getCompanyProfile } from "./companyProfile";
import { onSettlementChanged as dunningOnSettlementChanged } from "./dunning";
import { entriesBySource, postJournalEntry, previewJournal } from "./journal";
import { notifyKind } from "./notifications";
import { snapshotOf } from "./salesDocuments";
import { creditedCentsOf } from "./settlement";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Payments (F05 PAY-010…PAY-063, 03 §5) — the only writer of `payments`. Every payment row, its journal entry
 * (F08 posting matrix P1–P12, S10), the target's `openAmountCents`/`paymentStatus`, the bank allocation
 * (`applyAllocation`, BNK-122) and the audit entries are written in **one** Convex transaction (PAY-016). The pure
 * planning lives in src/domain/payments (planPayment, planReversal, planRefund); this module loads the facts and
 * writes exactly the planned rows.
 *
 * Internal API for other slices (call inside your own mutation):
 *   recordPayment(ctx, args)            → rows, journal, status, bank allocation
 *   reversePayment(ctx, { paymentId, reason, preferredDate? })
 *   reverseTransactionPayments(ctx, { transactionId, reason, preferredDate? })   (BNK-047, BNK-121)
 *   documentSettlement(ctx, documentId) → payable/received/open/fullySettled/paidOn (advances, RI-08)
 *   creditBalance(ctx, contactId)       → current Guthaben (PAY-031)
 *   paymentsOfTarget(ctx, ref)          → all rows incl. reversals (history, dunning)
 */

export type PaymentDoc = Doc<"payments">;
export type PaymentTargetRef = { kind: "salesDocument" | "opening_item" | "contactCredit"; id: string };

export type SourceArg =
  | { kind: "bank"; transactionId: Id<"bankTransactions"> }
  | { kind: "clearing"; accountId: Id<"bankAccounts"> }
  | { kind: "cash" }
  | { kind: "credit" }
  | { kind: "adjustment" };

export interface RecordArgs {
  source: SourceArg;
  date: string;
  allocations: AllocationInput[];
  backdateReason?: string;
  note?: string;
  acknowledgeWarnings?: string[];
  /** BNK-042/043 provenance of a confirmed bank match. */
  match?: { score: number; reasons: string[]; auto: boolean };
  /** PAY-026 recovery wizard only. */
  allowWrittenOff?: boolean;
}

export interface RecordResult {
  paymentIds: Id<"payments">[];
  allocationGroupId?: string;
  date: string;
  warnings: PaymentWarning[];
  unallocatedCents?: number;
}

const PAYABLE_TYPES = new Set(["invoice", "advance_invoice", "partial_invoice", "final_invoice"]);

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

export async function requirePayment(ctx: ReadCtx, id: Id<"payments">): Promise<PaymentDoc> {
  const p = await ctx.db.get(id);
  if (!p) throw appError("not_found", "Die Zahlung existiert nicht.");
  return p;
}

export async function paymentsOfTarget(ctx: ReadCtx, ref: PaymentTargetRef): Promise<PaymentDoc[]> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_target", (q) => q.eq("target.kind", ref.kind).eq("target.id", ref.id))
    .collect();
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

export async function paymentsOfTransaction(ctx: ReadCtx, id: Id<"bankTransactions">): Promise<PaymentDoc[]> {
  return ctx.db
    .query("payments")
    .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", id))
    .collect();
}

/** Net settlement value of a row (RI-09): cash allocated plus accepted differences. */
export const settlesOf = (p: Pick<PaymentDoc, "amountCents" | "differences">): number =>
  p.amountCents + p.differences.reduce((s, d) => s + d.amountCents, 0);

const statusRow = (p: PaymentDoc): StatusRow => ({
  amountCents: p.amountCents,
  differences: p.differences,
  cash: p.source.kind !== "adjustment",
  ...(p.reversedById ? { reversed: true } : {}),
  ...(p.reversalOfId ? { reversal: true } : {}),
});

/** PAY-031: the contact's credit balance = Σ of its contactCredit rows (overpayments +, applications/refunds −). */
export async function creditBalance(ctx: ReadCtx, contactId: string): Promise<number> {
  const rows = await paymentsOfTarget(ctx, { kind: "contactCredit", id: contactId });
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

/**
 * Settlement of one sales document — for the advances slice (UST-41, RI-08: the final invoice deducts exactly the
 * received amounts) and the dunning slice. `receivedCents` = money received (Σ non-reversed `amountCents`, no
 * differences); `settledCents` = net settled incl. differences (RI-09); `paidOn` = date of the latest active row.
 */
export async function documentSettlement(ctx: ReadCtx, documentId: Id<"salesDocuments">) {
  const doc = await ctx.db.get(documentId);
  if (!doc) throw appError("not_found", "Das Dokument existiert nicht.");
  const rows = await paymentsOfTarget(ctx, { kind: "salesDocument", id: documentId });
  const active = rows.filter((r) => !r.reversedById && !r.reversalOfId);
  const payableCents = doc.totals.payableCents;
  const receivedCents = active.filter((r) => r.source.kind !== "adjustment").reduce((s, r) => s + r.amountCents, 0);
  const settledCents = active.reduce((s, r) => s + settlesOf(r), 0);
  const openAmountCents = doc.openAmountCents ?? payableCents - settledCents;
  const paidOn = active
    .map((r) => r.date)
    .sort()
    .at(-1);
  return {
    documentId,
    payableCents,
    receivedCents,
    settledCents,
    openAmountCents,
    fullySettled: doc.status !== "draft" && openAmountCents === 0,
    ...(paidOn ? { paidOn } : {}),
    ...(doc.paymentStatus ? { paymentStatus: doc.paymentStatus } : {}),
  };
}

async function closedPeriods(ctx: ReadCtx): Promise<Set<string>> {
  const rows = await ctx.db.query("periods").collect();
  return new Set(rows.filter((p) => p.status !== "open").map((p) => p.period));
}

const NOTDUE = /^vat\.output\.notdue\.(19|7)$/;

/** Ist basis (UVA-06): the VAT the target's finalisation posted as „nicht fällig“, per rate. */
async function notDueVatOf(ctx: ReadCtx, documentId: string): Promise<{ rateBp: number; vatCents: number }[]> {
  const out = new Map<number, number>();
  for (const e of await entriesBySource(ctx, { kind: "salesDocument", id: documentId })) {
    if (e.reversalOfId) continue;
    for (const l of e.lines) {
      const m = l.role ? NOTDUE.exec(l.role) : null;
      if (!m) continue;
      const rate = m[1] === "19" ? 1900 : 700;
      out.set(rate, (out.get(rate) ?? 0) + l.creditCents - l.debitCents);
    }
  }
  return [...out.entries()].map(([rateBp, vatCents]) => ({ rateBp, vatCents })).filter((v) => v.vatCents !== 0);
}

const IMPORTED_PAYMENT_MESSAGE =
  "Diese Rechnung stammt aus dem sevdesk-Import und hat keinen offenen Posten in der Eröffnungsbilanz – eine Zahlung kann nicht zugeordnet werden.";

/**
 * F09 IMP-007: an allocation to an archived sevdesk invoice goes to its F08 opening item (the receivable with the
 * Ist VAT split); the document follows through `syncImportedDocument`.
 */
async function redirectImported(ctx: ReadCtx, allocations: RecordArgs["allocations"]) {
  const out: RecordArgs["allocations"] = [];
  for (const a of allocations) {
    if (a.target.kind !== "salesDocument") {
      out.push(a);
      continue;
    }
    const id = ctx.db.normalizeId("salesDocuments", a.target.id);
    const doc = id ? await ctx.db.get(id) : null;
    // EC-204: a document posted at import (E-IMP-10) is settled like an own invoice.
    if (!id || !doc || !isArchiveOnlyImport(doc)) {
      out.push(a);
      continue;
    }
    const item = await ctx.db
      .query("openingItems")
      .withIndex("by_document", (q) => q.eq("documentId", id))
      .first();
    if (!item) throw appError("invalid_input", IMPORTED_PAYMENT_MESSAGE, { reason: "IMPORTED_DOCUMENT_PAYMENT" });
    out.push({ ...a, target: { kind: "opening_item", id: item._id } });
  }
  return out;
}

interface LoadedTarget {
  facts: TargetFacts;
  doc?: Doc<"salesDocuments">;
  opening?: Doc<"openingItems">;
  notDueVat?: { rateBp: number; vatCents: number }[];
  advanceGroups?: RateAmount[];
  counterpartyName?: string;
}

async function loadTarget(ctx: ReadCtx, ref: TargetRef, date: string): Promise<LoadedTarget | null> {
  const profile = await getCompanyProfile(ctx);
  const methodOnDate = taxationMethodAt(profile?.taxationMethod ?? [], date);
  if (ref.kind === "salesDocument") {
    const id = ctx.db.normalizeId("salesDocuments", ref.id);
    const doc = id ? await ctx.db.get(id) : null;
    if (!doc) return null;
    if (isArchiveOnlyImport(doc)) {
      // F09 IMP-007 / EC-201: an archived sevdesk invoice was never posted; its receivable is the F08 opening item
      // (redirected in `planFor`). Without one (paid in sevdesk, or created before the link) nothing can be settled.
      // A document posted at import (EC-204) takes the normal path below.
      throw appError("invalid_input", IMPORTED_PAYMENT_MESSAGE, { reason: "IMPORTED_DOCUMENT_PAYMENT" });
    }
    const snapshot = await snapshotOf(ctx, doc);
    const payable = doc.totals.payableCents;
    const groups: GrossGroup[] = doc.totals.byGroup.map((g) => ({
      category: g.category,
      rateBp: g.rateBp,
      grossCents: g.netCents + g.vatCents,
    }));
    const s = snapshot?.payment.skonto;
    const skonto: SkontoTerms | null = s
      ? { percentBp: s.percentBp, deadline: s.date, agreedCents: s.amountCents }
      : null;
    const notDueVat = doc.status === "draft" ? [] : await notDueVatOf(ctx, doc._id);
    return {
      doc,
      notDueVat,
      ...(snapshot?.buyer.name ? { counterpartyName: snapshot.buyer.name } : {}),
      advanceGroups: doc.totals.byGroup.map((g) => ({ rateBp: g.rateBp, netCents: g.netCents, vatCents: g.vatCents })),
      facts: {
        ref,
        ...(doc.contactId ? { contactId: doc.contactId } : {}),
        ...(doc.number ? { number: doc.number } : {}),
        docType: doc.type,
        status: doc.status,
        ...(doc.paymentStatus ? { paymentStatus: doc.paymentStatus } : {}),
        currency: doc.currency,
        ...(doc.documentDate ? { documentDate: doc.documentDate } : {}),
        ...(doc.dueDate ? { dueDate: doc.dueDate } : {}),
        payableCents: payable,
        openAmountCents: doc.openAmountCents ?? payable,
        groups,
        skonto,
        taxedAs: notDueVat.length > 0 ? "ist" : "soll",
        methodOnDate,
        claimedFeesCents: 0,
        claimedInterestCents: 0,
      },
    };
  }
  if (ref.kind === "opening_item") {
    const id = ctx.db.normalizeId("openingItems", ref.id);
    const item = id ? await ctx.db.get(id) : null;
    if (!item) return null;
    return {
      opening: item,
      counterpartyName: item.counterpartyName,
      ...(item.taxedAs === "ist" && item.notDueVat ? { notDueVat: item.notDueVat } : {}),
      facts: {
        ref,
        ...(item.contactId ? { contactId: item.contactId } : {}),
        number: item.number,
        currency: "EUR",
        documentDate: item.documentDate,
        ...(item.dueDate ? { dueDate: item.dueDate } : {}),
        payableCents: item.openCents,
        openAmountCents: item.openAmountCents,
        taxedAs: item.taxedAs,
        methodOnDate,
      },
    };
  }
  const contactId = ctx.db.normalizeId("contacts", ref.id);
  const contact = contactId ? await ctx.db.get(contactId) : null;
  if (!contact) return null;
  return {
    counterpartyName: contact.displayName,
    facts: {
      ref,
      contactId: contact._id,
      currency: "EUR",
      payableCents: 0,
      openAmountCents: 0,
      creditBalanceCents: await creditBalance(ctx, contact._id),
    },
  };
}

async function sourceFacts(
  ctx: ReadCtx,
  source: SourceArg,
): Promise<{ facts: SourceFacts; tx?: Doc<"bankTransactions"> }> {
  if (source.kind === "bank") {
    const tx = await requireTransaction(ctx, source.transactionId);
    if (tx.currency !== "EUR") throw appError("invalid_input", PAY_MESSAGES.fxDeferred, { reason: "FX_DEFERRED" });
    return {
      tx,
      facts: {
        kind: "bank",
        bank: {
          bookingDate: tx.bookingDate,
          amountCents: tx.amountCents,
          allocatedCents: tx.allocatedCents,
          currency: tx.currency,
          status: tx.status,
        },
      },
    };
  }
  if (source.kind === "clearing") {
    const a = await ctx.db.get(source.accountId);
    if (!a) throw appError("not_found", "Das Bankkonto existiert nicht.");
    if (a.currency !== "EUR") throw appError("invalid_input", PAY_MESSAGES.fxDeferred, { reason: "FX_DEFERRED" });
    return {
      facts: { kind: "clearing", clearing: { currency: a.currency, ...(a.archivedAt ? { archived: true } : {}) } },
    };
  }
  if (source.kind === "cash") {
    const opening = await cashOpeningDate(ctx);
    return { facts: { kind: "cash", ...(opening ? { cashOpeningDate: opening } : {}) } };
  }
  return { facts: { kind: source.kind } };
}

const domainSource = (s: SourceArg): SourceInput =>
  s.kind === "bank"
    ? { kind: "bank", transactionId: s.transactionId }
    : s.kind === "clearing"
      ? { kind: "clearing", accountId: s.accountId }
      : { kind: s.kind };

/** Domain issue → structured app error (REST 422/409, MCP verbatim message). */
function rejected(e: { code: string; message: string; params?: Record<string, string | number> }): never {
  if (e.code === "period_locked") throw appError("period_locked", e.message, { reason: "PERIOD_LOCKED" });
  const extra: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(e.params ?? {})) extra[k === "reason" ? "cause" : k] = v;
  extra.reason = e.code.toUpperCase();
  throw appError("invalid_input", e.message, extra);
}

export interface PlannedPayment {
  plan: PaymentPlan;
  targets: Map<string, LoadedTarget>;
  tx?: Doc<"bankTransactions">;
}

/** Loads the facts and runs the pure planner (shared by the preview and the act). Throws structured errors. */
export async function planFor(ctx: ReadCtx, original: RecordArgs, now: number): Promise<PlannedPayment> {
  const args = { ...original, allocations: await redirectImported(ctx, original.allocations) };
  const { facts, tx } = await sourceFacts(ctx, args.source);
  const date = tx ? tx.bookingDate : args.date;
  const targets = new Map<string, LoadedTarget>();
  for (const a of args.allocations) {
    const t = await loadTarget(ctx, a.target, date);
    if (t) targets.set(targetKey(a.target), t);
  }
  const input: PaymentInput = {
    source: domainSource(args.source),
    date: args.date,
    allocations: args.allocations,
    ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
    ...(args.note ? { note: args.note } : {}),
  };
  const contactIds = new Set(
    [...targets.values()].map((t) => t.facts.contactId).filter((c): c is string => c !== undefined),
  );
  if (contactIds.size > 1 && args.source.kind !== "bank" && args.source.kind !== "clearing") {
    throw appError("invalid_input", PAY_MESSAGES.contactMismatch, { reason: "CONTACT_MISMATCH" });
  }
  const r = planPayment(input, {
    today: berlinCalendarDate(now),
    closedPeriods: await closedPeriods(ctx),
    source: facts,
    targets: new Map([...targets.entries()].map(([k, t]) => [k, t.facts])),
    ...(args.allowWrittenOff ? { allowWrittenOff: true } : {}),
  });
  if (!r.ok) rejected(r.error);
  return { plan: r.value, targets, ...(tx ? { tx } : {}) };
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────────────

const meansOf = (s: SourceArg | PaymentDoc["source"]): PaymentMeans => {
  switch (s.kind) {
    case "bank":
      return { kind: "bank_account", bankAccountId: "" };
    case "clearing":
      return { kind: "bank_account", bankAccountId: s.accountId };
    case "cash":
      return { kind: "cash" };
    case "credit":
      return { kind: "customer_credit" };
    case "adjustment":
      return { kind: "none" };
  }
};

const eventDifferences = (row: PlannedRow): PaymentDifference[] =>
  row.differences.map((d) => ({
    reason: d.reason,
    amountCents: d.amountCents,
    ...(d.vatCorrection ? { vatCorrection: d.vatCorrection } : {}),
    ...(d.account ? { account: d.account } : {}),
    ...(d.text ? { text: d.text } : {}),
  }));

function eventFor(
  paymentId: Id<"payments">,
  row: PlannedRow,
  plan: PaymentPlan,
  source: SourceArg,
  means: PaymentMeans,
  loaded: LoadedTarget,
): BusinessEvent | null {
  // The negative credit row of a credit application has no entry of its own: P12 on the document row covers it.
  if (row.target.kind === "contactCredit" && source.kind === "credit") return null;
  const contactId = row.contactId ?? loaded.facts.contactId;
  if (!contactId) throw appError("invalid_input", "Die Zahlung braucht einen Kunden (Debitor).");
  const common = {
    paymentId,
    date: plan.date,
    means,
    contactId,
    ...(loaded.counterpartyName ? { counterpartyName: loaded.counterpartyName } : {}),
  };
  const settledBefore = loaded.facts.payableCents - loaded.facts.openAmountCents;
  if (loaded.doc?.type === "advance_invoice") {
    return {
      kind: "advance_payment_received",
      ...common,
      amountCents: row.amountCents,
      advance: {
        documentId: loaded.doc._id,
        ...(loaded.doc.number ? { number: loaded.doc.number } : {}),
        vatGroups: loaded.advanceGroups ?? [],
        payableCents: loaded.facts.payableCents,
        settledBeforeCents: settledBefore,
      },
    };
  }
  const ist: IstVatBasis | undefined =
    loaded.notDueVat && loaded.notDueVat.length > 0
      ? { notDueVat: loaded.notDueVat, payableCents: loaded.facts.payableCents, settledBeforeCents: settledBefore }
      : undefined;
  return {
    kind: "payment_received",
    ...common,
    amountCents: row.amountCents,
    target: { kind: row.target.kind, id: row.target.id, ...(row.number ? { number: row.number } : {}) },
    ...(row.differences.length ? { differences: eventDifferences(row) } : {}),
    ...(ist ? { ist } : {}),
  };
}

/**
 * The settlement without money that enters the open amount (PAY-043): for an invoice the applied Rechnungskorrekturen
 * (Σ `creditAppliedCents`, optionally up to `asOf`); for a credit correction itself −`creditAppliedCents`, the part
 * of its (negative) payable the corrected invoice absorbed — only the rest is refunded (PAY-033 b).
 */
export async function creditedOf(ctx: ReadCtx, doc: Doc<"salesDocuments">, asOf?: string): Promise<number> {
  if (doc.type === "correction") return -(doc.creditAppliedCents ?? 0);
  return creditedCentsOf(ctx, doc, asOf);
}

/**
 * Re-derives `openAmountCents`/`paymentStatus` of a sales document from all its payment rows (PAY-043, §4.3) and
 * returns the change for the dunning hook. EC-PAY-45: a negative open amount aborts the mutation.
 */
async function refreshDocument(ctx: ModelCtx, id: Id<"salesDocuments">, action: string) {
  const doc = await ctx.db.get(id);
  if (!doc) throw appError("not_found");
  const rows = await paymentsOfTarget(ctx, { kind: "salesDocument", id });
  let derived: ReturnType<typeof derivePaymentStatus>;
  try {
    derived = derivePaymentStatus({
      payableCents: doc.totals.payableCents,
      creditedCents: await creditedOf(ctx, doc),
      rows: rows.map(statusRow),
      cancelled: doc.status === "cancelled",
    });
  } catch {
    throw appError("invalid_input", NEGATIVE_OPEN_MESSAGE, { reason: "NEGATIVE_OPEN" });
  }
  const before = { paymentStatus: doc.paymentStatus, openAmountCents: doc.openAmountCents };
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      openAmountCents: derived.openAmountCents,
      ...(derived.paymentStatus ? { paymentStatus: derived.paymentStatus } : {}),
    },
    { action, ...(doc.number ? { label: doc.number } : {}) },
  );
  await onSettlementChanged(ctx, {
    documentId: id,
    before,
    after: { paymentStatus: derived.paymentStatus, openAmountCents: derived.openAmountCents },
  });
}

export interface SettlementChange {
  documentId: Id<"salesDocuments">;
  before: { paymentStatus?: string; openAmountCents?: number };
  after: { paymentStatus?: string; openAmountCents: number };
}

/**
 * Extension point (F05 §4.1 step 8–9): called in the payment transaction after every change of a document's
 * settlement. The dunning slice pauses/closes/reopens its case here (DUN-034/035); the webhook outbox
 * (`invoice.paid`, `invoice.partially_paid`, `payment.recorded`, PAY-060) attaches here once it exists.
 */
export async function onSettlementChanged(ctx: ModelCtx, change: SettlementChange): Promise<void> {
  await dunningOnSettlementChanged(ctx, change);
  // NTF-007 (F12 §4.8 `invoice.paid`): raised here, so payments recorded via UI, REST, MCP or bank matching notify.
  if (change.after.paymentStatus === "paid" && change.before.paymentStatus !== "paid") {
    const doc = await ctx.db.get(change.documentId);
    await notifyKind(ctx, "invoice.paid", {
      title: doc?.number ? `Rechnung ${doc.number} ist vollständig bezahlt` : "Rechnung vollständig bezahlt",
      link: `/rechnungen/${change.documentId}`,
      entity: { table: "salesDocuments", id: change.documentId },
    });
  }
}

async function refreshTarget(ctx: ModelCtx, row: { target: PaymentTargetRef }, settles: number, action: string) {
  if (row.target.kind === "salesDocument") {
    await refreshDocument(ctx, row.target.id as Id<"salesDocuments">, action);
  } else if (row.target.kind === "opening_item" && settles !== 0) {
    const id = row.target.id as Id<"openingItems">;
    const { openAmountCents } = await settleOpeningItem(ctx, id, settles);
    const item = await ctx.db.get(id);
    if (item?.documentId) await syncImportedDocument(ctx, item.documentId, openAmountCents, action);
  }
}

/**
 * F09 IMP-007: an archived sevdesk invoice mirrors the open amount of its F08 opening item — the item is the
 * receivable (journal, Ist VAT), the document is the archive record that dunning and the document views read.
 */
async function syncImportedDocument(
  ctx: ModelCtx,
  documentId: Id<"salesDocuments">,
  openAmountCents: number,
  action: string,
) {
  const doc = await ctx.db.get(documentId);
  if (!doc) return;
  const paymentStatus =
    openAmountCents === 0 ? "paid" : openAmountCents >= doc.totals.grossCents ? "open" : "partially_paid";
  const before = { paymentStatus: doc.paymentStatus, openAmountCents: doc.openAmountCents };
  await auditedPatch(
    ctx,
    "salesDocuments",
    documentId,
    { openAmountCents, paymentStatus },
    { action, ...(doc.number ? { label: doc.number } : {}) },
  );
  await onSettlementChanged(ctx, { documentId, before, after: { paymentStatus, openAmountCents } });
}

const auditLabel = (row: { number?: string; target: PaymentTargetRef }) =>
  row.target.kind === "contactCredit" ? "Guthaben" : (row.number ?? "Zahlung");

/** Allocation group id for a combined payment (deterministic inside a Convex mutation). */
const groupId = (now: number) => `pg_${now.toString(36)}_${Math.floor(Math.random() * 2 ** 32).toString(36)}`;

/**
 * F05 §4.1: record a payment (one or more allocations from one source). Throws `invalid_input` with the domain
 * reason, `period_locked`, or `invalid_input`/`WARNINGS_UNACKNOWLEDGED` when a ⚑ warning was not acknowledged.
 */
export async function recordPayment(ctx: ModelCtx, args: RecordArgs): Promise<RecordResult> {
  const { plan, targets, tx } = await planFor(ctx, args, ctx.now());
  const missing = unacknowledged(plan, args.acknowledgeWarnings ?? []);
  if (missing.length > 0) {
    throw appError("invalid_input", missing.map((w) => w.message).join(" "), {
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: missing.map((w) => w.code).join(","),
    });
  }
  const means: PaymentMeans =
    args.source.kind === "bank" && tx ? { kind: "bank_account", bankAccountId: tx.accountId } : meansOf(args.source);
  const group = plan.rows.length > 1 ? groupId(ctx.now()) : undefined;
  const ids: Id<"payments">[] = [];
  for (const row of plan.rows) {
    const loaded = targets.get(targetKey(row.target)) as LoadedTarget;
    const contactId = row.contactId ?? loaded.facts.contactId;
    const id = await auditedInsert(
      ctx,
      "payments",
      {
        target: { kind: row.target.kind, id: row.target.id },
        ...(contactId ? { contactId: contactId as Id<"contacts"> } : {}),
        ...(row.number ? { number: row.number } : {}),
        date: plan.date,
        amountCents: row.amountCents,
        currency: "EUR",
        source: args.source,
        ...(args.source.kind === "bank" ? { bankTransactionId: args.source.transactionId } : {}),
        differences: row.differences.map((d) => ({
          reason: d.reason,
          amountCents: d.amountCents,
          ...(d.subReason ? { subReason: d.subReason } : {}),
          ...(d.account ? { account: d.account } : {}),
          ...(d.text ? { text: d.text } : {}),
          ...(d.vatCorrection ? { vatCorrection: d.vatCorrection } : {}),
        })),
        ...(group ? { allocationGroupId: group } : {}),
        journalEntryIds: [],
        ...(args.backdateReason?.trim() && args.source.kind === "cash"
          ? { backdateReason: args.backdateReason.trim() }
          : {}),
        ...(args.note?.trim() ? { note: args.note.trim() } : {}),
        ...(args.match ? { match: args.match } : {}),
        actor: ctx.actor,
        recordedAt: ctx.now(),
      },
      {
        action: "payment.record",
        label: auditLabel(row),
        ...(args.backdateReason?.trim() && args.source.kind === "cash" ? { reason: args.backdateReason.trim() } : {}),
      },
    );
    ids.push(id);
    const event = eventFor(id, row, plan, args.source, means, loaded);
    if (event) {
      const r = await postJournalEntry(ctx, event);
      if (r.status === "posted") {
        await auditedPatch(ctx, "payments", id, { journalEntryIds: r.entryIds }, { action: "payment.record" });
      }
    }
    await refreshTarget(ctx, row, row.settlesCents, "payment.record");
  }
  if (args.source.kind === "bank" && plan.totalCents > 0) {
    await applyAllocation(ctx, { transactionId: args.source.transactionId, deltaCents: plan.totalCents });
  }
  // NTF-007 `payment.received` (info, in-app): one per recorded payment source and day.
  if (plan.totalCents > 0 && ids[0]) {
    await notifyKind(ctx, "payment.received", {
      title: `Zahlung über ${formatEuro(plan.totalCents)} erfasst`,
      link: plan.rows[0]?.target.kind === "salesDocument" ? `/rechnungen/${plan.rows[0].target.id}` : "/bank",
      entity: { table: "payments", id: ids[0] },
    });
  }
  return {
    paymentIds: ids,
    ...(group ? { allocationGroupId: group } : {}),
    date: plan.date,
    warnings: plan.warnings,
    ...(plan.unallocatedCents !== undefined ? { unallocatedCents: plan.unallocatedCents } : {}),
  };
}

/**
 * PAY-040…042: „Zahlung stornieren“ — a reversal row with negated amounts and differences, `reversedById` on the
 * original, the Generalumkehr of its journal entries, the target re-derived and the bank allocation released. A
 * credit application (source `credit`) is reversed as a pair with its credit row (PAY-032). Dated per PAY-041.
 */
export async function reversePayment(
  ctx: ModelCtx,
  args: {
    paymentId: Id<"payments">;
    reason: string;
    preferredDate?: string;
    /** BNK-121 / EC-PAY-24: the bank counter-entry that carries the reversal (allocated instead of a release). */
    counterTransactionId?: Id<"bankTransactions">;
  },
): Promise<{ reversalIds: Id<"payments">[]; date: string; warnings: PaymentWarning[] }> {
  const row = await requirePayment(ctx, args.paymentId);
  const today = berlinCalendarDate(ctx.now());
  const plan = planReversal({
    row: {
      date: row.date,
      ...(row.reversedById ? { reversedById: row.reversedById } : {}),
      ...(row.reversalOfId ? { reversalOfId: row.reversalOfId } : {}),
    },
    reason: args.reason,
    today,
    closedPeriods: await closedPeriods(ctx),
    ...(args.preferredDate ? { preferredDate: args.preferredDate } : {}),
  });
  if (!plan.ok) rejected(plan.error);
  const rows =
    row.source.kind === "credit" && row.allocationGroupId
      ? (
          await ctx.db
            .query("payments")
            .withIndex("by_allocationGroup", (q) => q.eq("allocationGroupId", row.allocationGroupId))
            .collect()
        ).filter((r) => !r.reversedById && !r.reversalOfId)
      : [row];
  // A credit balance that was already applied or refunded cannot be reversed below zero (EC-PAY-32).
  for (const r of rows) {
    if (r.target.kind !== "contactCredit" || r.amountCents <= 0) continue;
    const balance = await creditBalance(ctx, r.target.id);
    if (balance - r.amountCents < 0) {
      throw appError(
        "invalid_input",
        `Das Guthaben wurde bereits verwendet (${(balance / 100).toFixed(2).replace(".", ",")} € übrig). Bitte zuerst die Verrechnung bzw. Erstattung stornieren.`,
        { reason: "CREDIT_IN_USE" },
      );
    }
  }
  const reason = args.reason.trim();
  const ids: Id<"payments">[] = [];
  for (const r of rows) {
    const reversalId = await auditedInsert(
      ctx,
      "payments",
      {
        target: r.target,
        ...(r.contactId ? { contactId: r.contactId } : {}),
        ...(r.number ? { number: r.number } : {}),
        date: plan.value.date,
        amountCents: -r.amountCents,
        currency: r.currency,
        ...(args.counterTransactionId && r.bankTransactionId
          ? {
              source: { kind: "bank" as const, transactionId: args.counterTransactionId },
              bankTransactionId: args.counterTransactionId,
            }
          : { source: r.source, ...(r.bankTransactionId ? { bankTransactionId: r.bankTransactionId } : {}) }),
        differences: r.differences.map((d) => ({
          ...d,
          amountCents: -d.amountCents,
          ...(d.vatCorrection
            ? {
                vatCorrection: d.vatCorrection.map((c) => ({
                  rateBp: c.rateBp,
                  netCents: -c.netCents,
                  vatCents: -c.vatCents,
                })),
              }
            : {}),
        })),
        ...(r.allocationGroupId ? { allocationGroupId: r.allocationGroupId } : {}),
        journalEntryIds: [],
        reversalOfId: r._id,
        reason,
        actor: ctx.actor,
        recordedAt: ctx.now(),
      },
      { action: "payment.reverse", label: auditLabel(r), reason },
    );
    await auditedPatch(ctx, "payments", r._id, { reversedById: reversalId }, { action: "payment.reverse", reason });
    const posted = await postJournalEntry(ctx, {
      kind: "payment_reversed",
      paymentId: reversalId,
      originalPaymentId: r._id,
      date: plan.value.date,
      reason,
    });
    if (posted.status === "posted") {
      await auditedPatch(
        ctx,
        "payments",
        reversalId,
        { journalEntryIds: posted.entryIds },
        { action: "payment.reverse" },
      );
    }
    await refreshTarget(ctx, r, -settlesOf(r), "payment.reverse");
    if (r.bankTransactionId && r.amountCents !== 0) {
      await applyAllocation(
        ctx,
        args.counterTransactionId
          ? { transactionId: args.counterTransactionId, deltaCents: Math.abs(r.amountCents) }
          : { transactionId: r.bankTransactionId, deltaCents: -Math.abs(r.amountCents) },
      );
    }
    ids.push(reversalId);
  }
  return { reversalIds: ids, date: plan.value.date, warnings: plan.value.warnings };
}

/** BNK-047 „Zuordnung aufheben“ / BNK-121 bank reversal: reverses every active allocation of a transaction. */
export async function reverseTransactionPayments(
  ctx: ModelCtx,
  args: {
    transactionId: Id<"bankTransactions">;
    reason: string;
    preferredDate?: string;
    counterTransactionId?: Id<"bankTransactions">;
  },
): Promise<{ reversalIds: Id<"payments">[]; warnings: PaymentWarning[] }> {
  const rows = (await paymentsOfTransaction(ctx, args.transactionId)).filter((r) => !r.reversedById && !r.reversalOfId);
  const reconciled = await ctx.db
    .query("payments")
    .withIndex("by_reconciled", (q) => q.eq("reconciledTransactionId", args.transactionId))
    .collect();
  if (rows.length === 0 && reconciled.length === 0) {
    throw appError("invalid_input", "Dieser Umsatz ist keiner Zahlung zugeordnet.", { reason: "NOT_MATCHED" });
  }
  if (reconciled.length > 0) {
    throw appError(
      "invalid_input",
      "Der Umsatz ist mit einer bereits erfassten Zahlung abgeglichen. Bitte diese Zahlung stornieren.",
      { reason: "RECONCILED_MANUAL_PAYMENT" },
    );
  }
  const ids: Id<"payments">[] = [];
  const warnings: PaymentWarning[] = [];
  for (const r of rows) {
    const fresh = await requirePayment(ctx, r._id);
    if (fresh.reversedById) continue;
    const res = await reversePayment(ctx, {
      paymentId: r._id,
      reason: args.reason,
      ...(args.preferredDate ? { preferredDate: args.preferredDate } : {}),
      ...(args.counterTransactionId ? { counterTransactionId: args.counterTransactionId } : {}),
    });
    ids.push(...res.reversalIds);
    for (const w of res.warnings) if (!warnings.some((x) => x.code === w.code)) warnings.push(w);
  }
  return { reversalIds: ids, warnings };
}

export type RefundSource =
  | { kind: "bank"; transactionId: Id<"bankTransactions"> }
  | { kind: "clearing"; accountId: Id<"bankAccounts"> }
  | { kind: "cash" };

/** PAY-033/PAY-062: refund of a credit balance (outgoing bank transaction, „Bar erstattet“ or clearing). */
export async function refundCredit(
  ctx: ModelCtx,
  args: {
    contactId: Id<"contacts">;
    amountCents: number;
    source: RefundSource;
    date: string;
    backdateReason?: string;
    note?: string;
    acknowledgeWarnings?: string[];
    match?: { score: number; reasons: string[]; auto: boolean };
  },
): Promise<{ paymentId: Id<"payments">; date: string; warnings: PaymentWarning[] }> {
  const contact = await ctx.db.get(args.contactId);
  if (!contact) throw appError("not_found", "Der Kontakt existiert nicht.");
  const tx = args.source.kind === "bank" ? await requireTransaction(ctx, args.source.transactionId) : undefined;
  if (tx && !["open", "partially_matched", "matched"].includes(tx.status)) {
    throw appError("invalid_input", PAY_MESSAGES.txNotAllocatable, { reason: "TX_NOT_ALLOCATABLE" });
  }
  const plan = planRefund({
    sourceKind: args.source.kind,
    amountCents: args.amountCents,
    openRefundCents: await creditBalance(ctx, args.contactId),
    date: args.date,
    today: berlinCalendarDate(ctx.now()),
    closedPeriods: await closedPeriods(ctx),
    ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
    ...(tx
      ? { bank: { bookingDate: tx.bookingDate, amountCents: tx.amountCents, allocatedCents: tx.allocatedCents } }
      : {}),
  });
  if (!plan.ok) rejected(plan.error);
  const missing = unacknowledged(plan.value, args.acknowledgeWarnings ?? []);
  if (missing.length > 0) {
    throw appError("invalid_input", missing.map((w) => w.message).join(" "), {
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: missing.map((w) => w.code).join(","),
    });
  }
  const backdate = args.source.kind === "cash" && args.backdateReason?.trim() ? args.backdateReason.trim() : undefined;
  const id = await auditedInsert(
    ctx,
    "payments",
    {
      target: { kind: "contactCredit", id: args.contactId },
      contactId: args.contactId,
      date: plan.value.date,
      amountCents: -args.amountCents,
      currency: "EUR",
      source: args.source,
      ...(args.source.kind === "bank" ? { bankTransactionId: args.source.transactionId } : {}),
      differences: [],
      journalEntryIds: [],
      ...(backdate ? { backdateReason: backdate } : {}),
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(args.match ? { match: args.match } : {}),
      actor: ctx.actor,
      recordedAt: ctx.now(),
    },
    { action: "payment.refund", label: "Erstattung Guthaben", ...(backdate ? { reason: backdate } : {}) },
  );
  const posted = await postJournalEntry(ctx, {
    kind: "customer_refund",
    paymentId: id,
    date: plan.value.date,
    means:
      args.source.kind === "cash"
        ? { kind: "cash" }
        : { kind: "bank_account", bankAccountId: tx ? tx.accountId : (args.source as { accountId: string }).accountId },
    amountCents: args.amountCents,
    contactId: args.contactId,
    counterpartyName: contact.displayName,
  });
  if (posted.status === "posted") {
    await auditedPatch(ctx, "payments", id, { journalEntryIds: posted.entryIds }, { action: "payment.refund" });
  }
  if (args.source.kind === "bank") {
    await applyAllocation(ctx, { transactionId: args.source.transactionId, deltaCents: args.amountCents });
  }
  return { paymentId: id, date: plan.value.date, warnings: plan.value.warnings };
}

export interface CorrectionRefundArgs {
  documentId: Id<"salesDocuments">;
  amountCents: number;
  source: RefundSource;
  date: string;
  backdateReason?: string;
  note?: string;
  acknowledgeWarnings?: string[];
  match?: { score: number; reasons: string[]; auto: boolean };
}

/**
 * PAY-033 (b) planning, shared by the preview and the act: the refundable correction (finalised credit, not cancelled,
 * EUR), the open refund (= −open amount), the source (an outgoing transaction for `bank`) and the dating rules
 * (PAY-061/062). Throws structured errors (EC-PAY-33 `REFUND_EXCEEDS`, `TX_DIRECTION`, `NOT_REFUNDABLE`, …).
 */
export async function planCorrectionRefund(ctx: ReadCtx, args: CorrectionRefundArgs, now: number) {
  const doc = await ctx.db.get(args.documentId);
  if (!doc) throw appError("not_found", "Die Rechnungskorrektur existiert nicht.");
  if (doc.type !== "correction" || doc.correctionKind !== "credit") {
    throw appError("invalid_input", "Erstattungen sind nur auf Rechnungskorrekturen (Gutschriften) möglich.", {
      reason: "NOT_REFUNDABLE",
    });
  }
  if (doc.status === "draft") throw appError("invalid_input", PAY_MESSAGES.draft, { reason: "DRAFT" });
  if (doc.status === "cancelled") throw appError("invalid_input", PAY_MESSAGES.cancelled, { reason: "CANCELLED" });
  if (doc.currency !== "EUR") throw appError("invalid_input", PAY_MESSAGES.fxDeferred, { reason: "FX_DEFERRED" });
  if (!doc.contactId) throw appError("invalid_input", "Die Erstattung braucht einen Kunden (Debitor).");
  const tx = args.source.kind === "bank" ? await requireTransaction(ctx, args.source.transactionId) : undefined;
  if (tx && !["open", "partially_matched", "matched"].includes(tx.status)) {
    throw appError("invalid_input", PAY_MESSAGES.txNotAllocatable, { reason: "TX_NOT_ALLOCATABLE" });
  }
  if (args.source.kind === "clearing") {
    const account = await ctx.db.get(args.source.accountId);
    if (!account) throw appError("not_found", "Das Bankkonto existiert nicht.");
    if (account.currency !== "EUR") throw appError("invalid_input", PAY_MESSAGES.fxDeferred, { reason: "FX_DEFERRED" });
  }
  const openCents = doc.openAmountCents ?? doc.totals.payableCents;
  const plan = planRefund({
    sourceKind: args.source.kind,
    amountCents: args.amountCents,
    openRefundCents: -openCents,
    date: args.date,
    today: berlinCalendarDate(now),
    closedPeriods: await closedPeriods(ctx),
    ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
    ...(tx
      ? { bank: { bookingDate: tx.bookingDate, amountCents: tx.amountCents, allocatedCents: tx.allocatedCents } }
      : {}),
  });
  if (!plan.ok) rejected(plan.error);
  return {
    doc,
    tx,
    date: plan.value.date,
    warnings: plan.value.warnings,
    openRefundCents: -openCents,
    openAfterCents: openCents + args.amountCents,
  };
}

/**
 * PAY-033 (b) / PAY-062: refund of a credit correction (outgoing bank transaction, „Bar erstattet“ or clearing). One
 * payment row on the correction with the negative amount, the P11 entry (receivable S · bank/cash H; under Ist also
 * the release of the correction's parked VAT share, P11-ist), the correction's open amount/status re-derived, the
 * bank allocation — all in this transaction. A cash refund is subject to the never-negative check (RI-11, EC-PAY-28).
 */
export async function refundCorrection(
  ctx: ModelCtx,
  args: CorrectionRefundArgs,
): Promise<{ paymentId: Id<"payments">; date: string; warnings: PaymentWarning[] }> {
  const p = await planCorrectionRefund(ctx, args, ctx.now());
  const missing = unacknowledged({ warnings: p.warnings }, args.acknowledgeWarnings ?? []);
  if (missing.length > 0) {
    throw appError("invalid_input", missing.map((w) => w.message).join(" "), {
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: missing.map((w) => w.code).join(","),
    });
  }
  const doc = p.doc;
  const contactId = doc.contactId as Id<"contacts">;
  const label = `Erstattung ${doc.number ?? ""}`.trim();
  const backdate = args.source.kind === "cash" && args.backdateReason?.trim() ? args.backdateReason.trim() : undefined;
  const id = await auditedInsert(
    ctx,
    "payments",
    {
      target: { kind: "salesDocument", id: doc._id },
      contactId,
      ...(doc.number ? { number: doc.number } : {}),
      date: p.date,
      amountCents: -args.amountCents,
      currency: "EUR",
      source: args.source,
      ...(args.source.kind === "bank" ? { bankTransactionId: args.source.transactionId } : {}),
      differences: [],
      journalEntryIds: [],
      ...(backdate ? { backdateReason: backdate } : {}),
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(args.match ? { match: args.match } : {}),
      actor: ctx.actor,
      recordedAt: ctx.now(),
    },
    { action: "payment.refund", label, ...(backdate ? { reason: backdate } : {}) },
  );
  // P11-ist basis: the correction's parked VAT (negative on notdue) as magnitudes; settled before = absorbed by the
  // invoice + refunded earlier = |payable| − |open|.
  const notDue = (await notDueVatOf(ctx, doc._id))
    .map((v) => ({ rateBp: v.rateBp, vatCents: Math.abs(v.vatCents) }))
    .filter((v) => v.vatCents !== 0);
  const payable = Math.abs(doc.totals.payableCents);
  const posted = await postJournalEntry(ctx, {
    kind: "customer_refund",
    paymentId: id,
    date: p.date,
    means:
      args.source.kind === "cash"
        ? { kind: "cash" }
        : {
            kind: "bank_account",
            bankAccountId: p.tx ? p.tx.accountId : (args.source as { accountId: string }).accountId,
          },
    amountCents: args.amountCents,
    contactId,
    ...(doc.contactName ? { counterpartyName: doc.contactName } : {}),
    target: { kind: "salesDocument", id: doc._id, ...(doc.number ? { number: doc.number } : {}) },
    ...(notDue.length > 0
      ? { ist: { notDueVat: notDue, payableCents: payable, settledBeforeCents: payable - p.openRefundCents } }
      : {}),
  });
  if (posted.status === "posted") {
    await auditedPatch(ctx, "payments", id, { journalEntryIds: posted.entryIds }, { action: "payment.refund" });
  }
  await refreshDocument(ctx, doc._id, "payment.refund");
  if (args.source.kind === "bank") {
    await applyAllocation(ctx, { transactionId: args.source.transactionId, deltaCents: args.amountCents });
  }
  return { paymentId: id, date: p.date, warnings: p.warnings };
}

/** PAY-032: apply the contact's credit balance to one of its open invoices (pair in one transaction). */
export async function applyCredit(
  ctx: ModelCtx,
  args: { contactId: Id<"contacts">; documentId: Id<"salesDocuments">; amountCents: number; date: string },
): Promise<RecordResult> {
  return recordPayment(ctx, {
    source: { kind: "credit" },
    date: args.date,
    allocations: [
      { target: { kind: "contactCredit", id: args.contactId }, amountCents: -args.amountCents },
      { target: { kind: "salesDocument", id: args.documentId }, amountCents: args.amountCents },
    ],
  });
}

/**
 * PAY-026 „Zahlungseingang auf abgeschriebene Forderung“: (1) reverse the write-off(s) dated today (VAT re-raised in
 * the current period), (2) record the payment, (3) optionally write off the remainder again, dated today.
 */
export async function recordRecovery(
  ctx: ModelCtx,
  args: {
    documentId: Id<"salesDocuments">;
    payment: Omit<RecordArgs, "allocations"> & { amountCents: number };
    writeOffRest?: "insolvency" | "uncollectible" | "statute_barred" | "waiver";
  },
): Promise<{ payment: RecordResult; reversalIds: Id<"payments">[]; writeOff?: RecordResult }> {
  const doc = await ctx.db.get(args.documentId);
  if (!doc) throw appError("not_found", "Die Rechnung existiert nicht.");
  if (doc.paymentStatus !== "written_off") {
    throw appError("invalid_input", "Die Rechnung ist nicht abgeschrieben.", { reason: "NOT_WRITTEN_OFF" });
  }
  const today = berlinCalendarDate(ctx.now());
  const rows = (await paymentsOfTarget(ctx, { kind: "salesDocument", id: doc._id })).filter(
    (r) => !r.reversedById && !r.reversalOfId && r.differences.some((d) => d.reason === "write_off"),
  );
  const reversalIds: Id<"payments">[] = [];
  for (const r of rows) {
    const res = await reversePayment(ctx, {
      paymentId: r._id,
      reason: "Zahlungseingang auf abgeschriebene Forderung",
      preferredDate: today,
    });
    reversalIds.push(...res.reversalIds);
  }
  const { amountCents, ...rest } = args.payment;
  const payment = await recordPayment(ctx, {
    ...rest,
    allocations: [{ target: { kind: "salesDocument", id: doc._id }, amountCents }],
  });
  if (!args.writeOffRest) return { payment, reversalIds };
  const after = await ctx.db.get(doc._id);
  const open = after?.openAmountCents ?? 0;
  if (open <= 0) return { payment, reversalIds };
  const writeOff = await recordPayment(ctx, {
    source: { kind: "adjustment" },
    date: today,
    allocations: [
      {
        target: { kind: "salesDocument", id: doc._id },
        amountCents: 0,
        differences: [{ reason: "write_off", amountCents: open, subReason: args.writeOffRest }],
      },
    ],
  });
  return { payment, reversalIds, writeOff };
}

/**
 * PAY-047 / EC-PAY-41: an imported bank transaction is the bank side of an earlier manual (`clearing`) payment on the
 * same account: link it once (`reconciledTransactionId`) and allocate the transaction — no second payment.
 */
export async function reconcileManualPayment(
  ctx: ModelCtx,
  args: { paymentId: Id<"payments">; transactionId: Id<"bankTransactions"> },
): Promise<void> {
  const p = await requirePayment(ctx, args.paymentId);
  const tx = await requireTransaction(ctx, args.transactionId);
  if (p.source.kind !== "clearing" || p.reversedById || p.reversalOfId || p.reconciledTransactionId) {
    throw appError("invalid_input", "Diese Zahlung kann nicht mit einem Bankumsatz abgeglichen werden.", {
      reason: "NOT_RECONCILABLE",
    });
  }
  if (p.source.accountId !== tx.accountId || p.amountCents !== tx.amountCents - tx.allocatedCents) {
    throw appError("invalid_input", "Konto oder Betrag des Umsatzes passen nicht zur erfassten Zahlung.", {
      reason: "RECONCILE_MISMATCH",
    });
  }
  await auditedPatch(
    ctx,
    "payments",
    p._id,
    { reconciledTransactionId: tx._id },
    { action: "payment.reconcile", label: p.number ?? "Zahlung" },
  );
  await applyAllocation(ctx, { transactionId: tx._id, deltaCents: p.amountCents });
}

/** PAY-063: the Quittung PDF is archived once (`receiptFile`). */
export async function attachReceipt(
  ctx: ModelCtx,
  args: { paymentId: Id<"payments">; file: NonNullable<PaymentDoc["receiptFile"]> },
): Promise<void> {
  const p = await requirePayment(ctx, args.paymentId);
  if (p.source.kind !== "cash" || p.amountCents <= 0 || p.reversalOfId) {
    throw appError("invalid_input", "Eine Quittung gibt es nur für Barzahlungen.", { reason: "NOT_CASH" });
  }
  if (p.receiptFile) return;
  await auditedPatch(
    ctx,
    "payments",
    p._id,
    { receiptFile: args.file },
    { action: "payment.receipt", label: p.number },
  );
}

export { closedPeriods };

// ── previews and the single-invoice shape ───────────────────────────────────────────────────────────────

/** PAY-015 / 05 `POST /payments/preview` / MCP `preview_action`: plan + booking lines per row, nothing written. */
export async function previewPayment(ctx: ReadCtx, args: RecordArgs, now: number) {
  const { plan, targets, tx } = await planFor(ctx, args, now);
  const means: PaymentMeans =
    args.source.kind === "bank" && tx ? { kind: "bank_account", bankAccountId: tx.accountId } : meansOf(args.source);
  const postings = [];
  for (const [i, row] of plan.rows.entries()) {
    const loaded = targets.get(targetKey(row.target)) as LoadedTarget;
    const event = eventFor(`preview${i}` as Id<"payments">, row, plan, args.source, means, loaded);
    postings.push(event ? await previewJournal(ctx, event) : { status: "skipped" as const });
  }
  return { plan, postings, unacknowledged: unacknowledged(plan, args.acknowledgeWarnings ?? []) };
}

export interface InvoicePaymentInput {
  documentId: Id<"salesDocuments">;
  source: SourceArg;
  date: string;
  amountCents: number;
  differences?: DifferenceInput[];
  excess?: { mode: ExcessMode; allocations?: { invoiceId: string; amountCents: number }[] };
  backdateReason?: string;
  note?: string;
  acknowledgeWarnings?: string[];
}

/** „Zahlung buchen“ / REST `POST /invoices/{id}/payments`: one invoice + PAY-030 excess choice → allocations. */
export async function invoicePaymentArgs(ctx: ReadCtx, input: InvoicePaymentInput): Promise<RecordArgs> {
  const doc = await ctx.db.get(input.documentId);
  if (!doc) throw appError("not_found", "Die Rechnung existiert nicht.");
  if (doc.paymentStatus === "written_off") {
    throw appError("invalid_input", PAY_MESSAGES.writtenOff, { reason: "WRITTEN_OFF" });
  }
  // EC-201: the receivable of an archived sevdesk invoice is its opening item (`redirectImported`).
  if (isArchiveOnlyImport(doc)) {
    await redirectImported(ctx, [{ target: { kind: "salesDocument", id: doc._id }, amountCents: 0 }]);
  }
  const r = allocationsForInvoice({
    invoice: {
      id: doc._id,
      ...(doc.contactId ? { contactId: doc.contactId } : {}),
      openAmountCents: doc.openAmountCents ?? doc.totals.payableCents,
    },
    sourceKind: input.source.kind,
    amountCents: input.amountCents,
    ...(input.differences ? { differences: input.differences } : {}),
    ...(input.excess ? { excess: input.excess } : {}),
  });
  if (!r.ok) rejected(r.error);
  return {
    source: input.source,
    date: input.date,
    allocations: r.value,
    ...(input.backdateReason ? { backdateReason: input.backdateReason } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.acknowledgeWarnings ? { acknowledgeWarnings: input.acknowledgeWarnings } : {}),
  };
}

// ── open items (PAY-001…PAY-007) ───────────────────────────────────────────────────────────────────────

const OPEN_ITEM_STATUSES = ["finalized", "sent"] as const;

/**
 * OPOS as of a date (PAY-003): invoice-like documents with `documentDate ≤ asOf` (cancelled ones excluded — a Storno
 * is only possible without payments, EC-074), opening items, and every payment row dated `≤ asOf` (reversal rows
 * carry their own date). Overdue is derived here, never stored (PAY-043/044).
 */
export async function openItemsAsOf(
  ctx: ReadCtx,
  args: { asOf: string; contactId?: Id<"contacts">; edges?: readonly number[] },
) {
  const documents: OpenItemDocument[] = [];
  // PAY-001: every invoice-like document and correction with an open amount ≠ 0 (credit corrections: refund owed).
  for (const type of [...PAYABLE_TYPES, "correction"]) {
    for (const status of OPEN_ITEM_STATUSES) {
      const docs = await ctx.db
        .query("salesDocuments")
        .withIndex("by_type_status_date", (q) =>
          q
            .eq("type", type as Doc<"salesDocuments">["type"])
            .eq("status", status)
            .lte("documentDate", args.asOf),
        )
        .collect();
      for (const d of docs) {
        if (args.contactId && d.contactId !== args.contactId) continue;
        if (!d.number || !d.documentDate) continue;
        // F09 IMP-007: an archived sevdesk invoice is a receivable only through its opening item (listed below);
        // one posted at import (EC-204) is listed itself.
        if (isArchiveOnlyImport(d)) continue;
        documents.push({
          id: d._id,
          kind: "salesDocument",
          number: d.number,
          ...(d.contactId ? { contactId: d.contactId } : {}),
          contactName: d.contactName ?? "",
          documentDate: d.documentDate,
          ...(d.dueDate ? { dueDate: d.dueDate } : {}),
          payableCents: d.totals.payableCents,
          // Rechnungskorrekturen dated up to the as-of date reduce the receivable like a settlement (F04 §4.2.5);
          // a credit correction carries the part its invoice absorbed (only the rest is refunded, PAY-033 b).
          creditedCents: await creditedOf(ctx, d, args.asOf),
          currency: d.currency,
          ...(d.type === "correction" ? { docType: "correction" } : {}),
        });
      }
    }
  }
  for (const item of await ctx.db.query("openingItems").collect()) {
    if (args.contactId && item.contactId !== args.contactId) continue;
    if (item.documentDate > args.asOf) continue;
    documents.push({
      id: item._id,
      kind: "opening_item",
      number: item.number,
      ...(item.contactId ? { contactId: item.contactId } : {}),
      contactName: item.counterpartyName,
      documentDate: item.documentDate,
      ...(item.dueDate ? { dueDate: item.dueDate } : {}),
      payableCents: item.openCents,
      currency: "EUR",
    });
  }
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_date", (q) => q.lte("date", args.asOf))
    .collect();
  const rows: SettlementRow[] = payments
    .filter((p) => !args.contactId || p.contactId === args.contactId)
    .map((p) => ({
      targetKind: p.target.kind,
      targetId: p.target.id,
      date: p.date,
      settlesCents: p.target.kind === "contactCredit" ? p.amountCents : settlesOf(p),
      amountCents: p.amountCents,
    }));
  const names = new Map<string, string>();
  for (const p of payments) {
    if (p.target.kind !== "contactCredit" || names.has(p.target.id)) continue;
    const c = await ctx.db.get(p.target.id as Id<"contacts">);
    names.set(p.target.id, c?.displayName ?? "");
  }
  return computeOpenItems({
    documents,
    rows,
    asOf: args.asOf,
    ...(args.edges ? { edges: args.edges } : {}),
    contactNames: names,
  });
}
