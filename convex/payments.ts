import { v } from "convex/values";
import { REASON_LABEL_DE } from "../src/domain/banking/match";
import { isOverdue } from "../src/domain/payments/open-items";
import { quittungContent } from "../src/domain/payments/quittung";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { isCalendarDate } from "../src/domain/time/calendar-date";
import { renderQuittung } from "../src/pdf/quittung";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, actorMutation, mutation, query, vConfirmToken } from "./functions";
import { appError } from "./lib/errors";
import { getCompanyProfile } from "./model/companyProfile";
import {
  applyCredit as applyCreditModel,
  attachReceipt,
  creditBalance,
  documentSettlement,
  invoicePaymentArgs,
  openItemsAsOf,
  paymentsOfTarget,
  planCorrectionRefund,
  previewPayment,
  recordPayment,
  recordRecovery,
  refundCorrection as refundCorrectionModel,
  refundCredit,
  requirePayment,
  reversePayment,
} from "./model/payments";
import { displayStatusOf } from "./model/salesDocuments";
import type { ReadCtx } from "./model/types";
import { vAllocationInput, vDifferenceInput, vPaymentSource, vWriteOffReason } from "./paymentValidators";
import { vFileRef } from "./validators";

/**
 * Payments, open items, credit balances (F05 P1). Thin public functions over convex/model/payments.ts; the ⚠ acts
 * (record, reverse, refund, credit application, recovery) need a confirm token for `mcp:` actors (06 §2.3).
 */

// ── views ───────────────────────────────────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<Doc<"payments">["source"]["kind"], string> = {
  bank: "Bank",
  clearing: "Konto (manuell)",
  cash: "Bar",
  credit: "Guthaben",
  adjustment: "Ausbuchung",
  private: "Privat",
};

export async function paymentView(ctx: ReadCtx, p: Doc<"payments">) {
  const tx = p.bankTransactionId ? await ctx.db.get(p.bankTransactionId) : null;
  const account =
    p.source.kind === "clearing" ? await ctx.db.get(p.source.accountId) : tx ? await ctx.db.get(tx.accountId) : null;
  // A refund of a Rechnungskorrektur targets the correction (PAY-033 b): REST/MCP encode it as `cor_…`.
  const targetDoc = p.target.kind === "salesDocument" ? await ctx.db.get(p.target.id as Id<"salesDocuments">) : null;
  return {
    id: p._id,
    target: p.target,
    targetType: targetDoc?.type ?? null,
    number: p.number ?? null,
    contactId: p.contactId ?? null,
    date: p.date,
    amountCents: p.amountCents,
    settlesCents: p.amountCents + p.differences.reduce((s, d) => s + d.amountCents, 0),
    currency: p.currency,
    source: p.source.kind,
    sourceLabel: SOURCE_LABEL[p.source.kind],
    accountName: account?.name ?? null,
    bankTransactionId: p.bankTransactionId ?? null,
    bankTransaction: tx
      ? { bookingDate: tx.bookingDate, purpose: tx.purpose, counterpartyName: tx.counterpartyName ?? null }
      : null,
    differences: p.differences,
    allocationGroupId: p.allocationGroupId ?? null,
    reversalOfId: p.reversalOfId ?? null,
    reversedById: p.reversedById ?? null,
    reason: p.reason ?? null,
    note: p.note ?? null,
    backdateReason: p.backdateReason ?? null,
    reconciledTransactionId: p.reconciledTransactionId ?? null,
    match: p.match ? { ...p.match, labels: p.match.reasons.map((r) => REASON_LABEL_DE[r as never] ?? r) } : null,
    receipt: p.receiptFile ? { name: p.receiptFile.name, sha256: p.receiptFile.sha256 } : null,
    canPrintReceipt: p.source.kind === "cash" && p.amountCents > 0 && !p.reversalOfId,
    journalEntryIds: p.journalEntryIds,
    actor: p.actor,
    recordedAt: p.recordedAt,
  };
}

const recordArgs = {
  source: vPaymentSource,
  date: v.string(),
  allocations: v.array(vAllocationInput),
  backdateReason: v.optional(v.string()),
  note: v.optional(v.string()),
  acknowledgeWarnings: v.optional(v.array(v.string())),
};

const invoicePaymentFields = {
  documentId: v.id("salesDocuments"),
  source: vPaymentSource,
  date: v.string(),
  amountCents: v.number(),
  differences: v.optional(v.array(vDifferenceInput)),
  excess: v.optional(
    v.object({
      mode: v.union(v.literal("credit"), v.literal("allocate"), v.literal("fees"), v.literal("unallocated")),
      allocations: v.optional(v.array(v.object({ invoiceId: v.string(), amountCents: v.number() }))),
    }),
  ),
  backdateReason: v.optional(v.string()),
  note: v.optional(v.string()),
  acknowledgeWarnings: v.optional(v.array(v.string())),
};

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

/** Invoice detail „Zahlungen“ (F05 §6.2) and the defaults of the „Zahlung buchen“ dialog (§6.1). */
export const forDocument = query({
  permission: "payments.read",
  args: { documentId: v.id("salesDocuments") },
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) throw appError("not_found", "Die Rechnung existiert nicht.");
    const today = berlinCalendarDate(ctx.now());
    const rows = await paymentsOfTarget(ctx, { kind: "salesDocument", id: documentId });
    const snapshotSkonto =
      doc.snapshotId && doc.paymentTerms.skontoPercentBp
        ? (
            JSON.parse((await ctx.db.get(doc.snapshotId))?.json ?? "{}") as {
              payment?: { skonto?: { date: string; amountCents: number; percentBp: number } };
            }
          ).payment?.skonto
        : undefined;
    const accounts = (await ctx.db.query("bankAccounts").collect())
      .filter((a) => a.archivedAt === undefined && a.currency === "EUR")
      .map((a) => ({ id: a._id, name: a.name, isDefault: a.isDefaultForInvoices === true }));
    return {
      today,
      settlement: await documentSettlement(ctx, documentId),
      displayStatus: displayStatusOf(doc, today),
      overdue: isOverdue({ paymentStatus: doc.paymentStatus, dueDate: doc.dueDate }, today),
      skonto: snapshotSkonto ?? null,
      creditBalanceCents: doc.contactId ? await creditBalance(ctx, doc.contactId) : 0,
      accounts,
      payments: await Promise.all(rows.map((p) => paymentView(ctx, p))),
    };
  },
});

export const get = query({
  permission: "payments.read",
  args: { id: v.id("payments") },
  handler: async (ctx, { id }) => paymentView(ctx, await requirePayment(ctx, id)),
});

/** REST `GET /payments` filters (05 §4.4). */
export const list = query({
  permission: "payments.read",
  args: {
    targetId: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    sourceKind: v.optional(v.string()),
    dateFrom: v.optional(v.string()),
    dateTo: v.optional(v.string()),
    reversed: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const rows = a.contactId
      ? await ctx.db
          .query("payments")
          .withIndex("by_contact", (q) => q.eq("contactId", a.contactId))
          .collect()
      : await ctx.db
          .query("payments")
          .withIndex("by_date", (q) => q.gte("date", a.dateFrom ?? "0000-00-00").lte("date", a.dateTo ?? "9999-12-31"))
          .order("desc")
          .take(1000);
    const filtered = rows
      .filter((p) => !a.targetId || p.target.id === a.targetId)
      .filter((p) => !a.sourceKind || p.source.kind === a.sourceKind)
      .filter((p) => !a.dateFrom || p.date >= a.dateFrom)
      .filter((p) => !a.dateTo || p.date <= a.dateTo)
      .filter((p) => a.reversed === undefined || Boolean(p.reversedById || p.reversalOfId) === a.reversed)
      .sort((x, y) => y.date.localeCompare(x.date) || y._creationTime - x._creationTime)
      .slice(0, Math.min(Math.max(a.limit ?? 100, 1), 500));
    return Promise.all(filtered.map((p) => paymentView(ctx, p)));
  },
});

/** PAY-001…PAY-007 Offene Posten (global or per contact, as of a date). */
export const openItems = query({
  permission: "payments.read",
  args: {
    asOf: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    overdueOnly: v.optional(v.boolean()),
    bucket: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const today = berlinCalendarDate(ctx.now());
    const asOf = a.asOf && isCalendarDate(a.asOf) ? a.asOf : today;
    const r = await openItemsAsOf(ctx, { asOf, ...(a.contactId ? { contactId: a.contactId } : {}) });
    const items = r.items.filter((i) => (!a.overdueOnly || i.overdue) && (!a.bucket || i.bucket === a.bucket));
    return { ...r, items, today };
  },
});

export const contactCredit = query({
  permission: "payments.read",
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const rows = await paymentsOfTarget(ctx, { kind: "contactCredit", id: contactId });
    return {
      balanceCents: await creditBalance(ctx, contactId),
      rows: await Promise.all(rows.map((p) => paymentView(ctx, p))),
    };
  },
});

/** PAY-015 dry run of the „Zahlung buchen“ dialog: allocations, warnings, VAT corrections and booking lines. */
export const previewInvoicePayment = query({
  permission: "payments.read",
  args: invoicePaymentFields,
  handler: async (ctx, args) => {
    try {
      const p = await previewPayment(ctx, await invoicePaymentArgs(ctx, args), ctx.now());
      return { ok: true as const, ...p };
    } catch (e) {
      const data = (e as { data?: { message?: string; reason?: string; excessCents?: number } }).data;
      if (!data?.message) throw e;
      return {
        ok: false as const,
        message: data.message,
        reason: data.reason ?? null,
        excessCents: typeof data.excessCents === "number" ? data.excessCents : null,
      };
    }
  },
});

/** REST `POST /payments/preview` (combined body) and MCP `preview_action { action: "payment_record" }`. */
export const preview = query({
  permission: "payments.read",
  args: recordArgs,
  handler: async (ctx, args) => previewPayment(ctx, args, ctx.now()),
});

// ── ⚠ acts ──────────────────────────────────────────────────────────────────────────────────────────────

/** ⚠ PAY-010/013 combined payment (REST `POST /payments`, MCP `payment_record`). */
export const record = mutation({
  permission: "payments.write",
  args: { ...recordArgs, confirmToken: vConfirmToken },
  handler: async (ctx, args) => recordPayment(ctx, args),
});

/** ⚠ „Zahlung buchen“ on one invoice incl. the PAY-030 excess choice (REST `POST /invoices/{id}/payments`). */
export const recordForInvoice = mutation({
  permission: "payments.write",
  args: { ...invoicePaymentFields, confirmToken: vConfirmToken },
  handler: async (ctx, args) => recordPayment(ctx, await invoicePaymentArgs(ctx, args)),
});

/** ⚠ PAY-040 „Zahlung stornieren“ (reason ≥ 5 characters; dated per PAY-041). */
export const reverse = mutation({
  permission: "payments.reverse",
  args: { paymentId: v.id("payments"), reason: v.string(), confirmToken: vConfirmToken },
  handler: async (ctx, args) => reversePayment(ctx, args),
});

/** ⚠ PAY-025 write-off without cash (`source.kind = "adjustment"`). */
export const writeOff = mutation({
  permission: "payments.write",
  args: {
    documentId: v.id("salesDocuments"),
    date: v.string(),
    amountCents: v.number(),
    subReason: vWriteOffReason,
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, a) =>
    recordPayment(ctx, {
      source: { kind: "adjustment" },
      date: a.date,
      allocations: [
        {
          target: { kind: "salesDocument", id: a.documentId },
          amountCents: 0,
          differences: [{ reason: "write_off", amountCents: a.amountCents, subReason: a.subReason }],
        },
      ],
    }),
});

/** ⚠ PAY-032 apply credit (REST `POST /contacts/{id}/credit/apply`). */
export const applyCredit = mutation({
  permission: "payments.write",
  args: {
    contactId: v.id("contacts"),
    documentId: v.id("salesDocuments"),
    amountCents: v.number(),
    date: v.string(),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, a) => applyCreditModel(ctx, a),
});

/** ⚠ PAY-033/062 refund of a credit balance (REST `POST /contacts/{id}/credit/refund`). */
export const refund = mutation({
  permission: "payments.write",
  args: {
    contactId: v.id("contacts"),
    amountCents: v.number(),
    source: v.union(
      v.object({ kind: v.literal("bank"), transactionId: v.id("bankTransactions") }),
      v.object({ kind: v.literal("clearing"), accountId: v.id("bankAccounts") }),
      v.object({ kind: v.literal("cash") }),
    ),
    date: v.string(),
    backdateReason: v.optional(v.string()),
    note: v.optional(v.string()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, a) => refundCredit(ctx, a),
});

const vRefundSource = v.union(
  v.object({ kind: v.literal("bank"), transactionId: v.id("bankTransactions") }),
  v.object({ kind: v.literal("clearing"), accountId: v.id("bankAccounts") }),
  v.object({ kind: v.literal("cash") }),
);

const correctionRefundFields = {
  documentId: v.id("salesDocuments"),
  amountCents: v.number(),
  source: vRefundSource,
  date: v.string(),
  backdateReason: v.optional(v.string()),
  note: v.optional(v.string()),
  acknowledgeWarnings: v.optional(v.array(v.string())),
};

/** Live check of „Erstattung erfassen“ on a Rechnungskorrektur (PAY-033 b): date, warnings, open refund after. */
export const previewCorrectionRefund = query({
  permission: "payments.read",
  args: correctionRefundFields,
  handler: async (ctx, args) => {
    try {
      const p = await planCorrectionRefund(ctx, args, ctx.now());
      return {
        ok: true as const,
        date: p.date,
        warnings: p.warnings,
        openRefundCents: p.openRefundCents,
        openAfterCents: p.openAfterCents,
      };
    } catch (e) {
      const data = (e as { data?: { message?: string; reason?: string } }).data;
      if (!data?.message) throw e;
      return { ok: false as const, message: data.message, reason: data.reason ?? null };
    }
  },
});

/**
 * ⚠ PAY-033 (b) / PAY-062 refund of a credit correction (UI „Erstattung erfassen“, REST
 * `POST /corrections/{id}/refund`); an outgoing bank transaction is matched via `matching.confirm` as well.
 */
export const refundCorrection = mutation({
  permission: "payments.write",
  args: { ...correctionRefundFields, confirmToken: vConfirmToken },
  handler: async (ctx, a) => refundCorrectionModel(ctx, a),
});

/** ⚠ PAY-026 „Zahlungseingang auf abgeschriebene Forderung“. */
export const recordRecoveryPayment = mutation({
  permission: "payments.write",
  args: {
    documentId: v.id("salesDocuments"),
    source: vPaymentSource,
    date: v.string(),
    amountCents: v.number(),
    backdateReason: v.optional(v.string()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
    writeOffRest: v.optional(vWriteOffReason),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, a) =>
    recordRecovery(ctx, {
      documentId: a.documentId,
      payment: {
        source: a.source,
        date: a.date,
        amountCents: a.amountCents,
        ...(a.backdateReason ? { backdateReason: a.backdateReason } : {}),
        ...(a.acknowledgeWarnings ? { acknowledgeWarnings: a.acknowledgeWarnings } : {}),
      },
      ...(a.writeOffRest ? { writeOffRest: a.writeOffRest } : {}),
    }),
});

// ── Quittung (PAY-063, CSH-028) ─────────────────────────────────────────────────────────────────────────

export const receiptContext = query({
  permission: "payments.receipt",
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const p = await requirePayment(ctx, paymentId);
    if (p.source.kind !== "cash" || p.amountCents <= 0 || p.reversalOfId) {
      throw appError("invalid_input", "Eine Quittung gibt es nur für Barzahlungen.", { reason: "NOT_CASH" });
    }
    const profile = await getCompanyProfile(ctx);
    if (!profile) throw appError("setup_incomplete");
    const doc = p.target.kind === "salesDocument" ? await ctx.db.get(p.target.id as Id<"salesDocuments">) : null;
    const contact = p.contactId ? await ctx.db.get(p.contactId) : null;
    const a = profile.address;
    return {
      content: quittungContent({
        paymentId: p._id,
        date: p.date,
        amountCents: p.amountCents,
        payer: doc?.contactName ?? contact?.displayName ?? "",
        ...(doc?.number ? { invoiceNumber: doc.number } : {}),
        ...(doc?.documentDate ? { invoiceDate: doc.documentDate } : {}),
        company: {
          name: profile.name,
          address: a ? [a.street, `${a.postalCode} ${a.city}`].filter(Boolean).join(", ") : "",
          city: a?.city ?? "",
          ...(profile.taxNumber ? { taxNumber: profile.taxNumber } : {}),
          ...(profile.vatId ? { vatId: profile.vatId } : {}),
        },
      }),
      archived: p.receiptFile ?? null,
      archivedUrl: p.receiptFile ? await ctx.storage.getUrl(p.receiptFile.storageId) : null,
    };
  },
});

export const attachReceiptInternal = actorMutation({
  permission: "payments.receipt",
  args: { paymentId: v.id("payments"), file: vFileRef },
  handler: async (ctx, args) => {
    await attachReceipt(ctx, args);
    return null;
  },
});

const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * PAY-063 „Quittung drucken“: the first print is archived with sha256 (`receiptFile`, set once) and returned as the
 * original; every later print is rendered from the same immutable data with the „Kopie“ stamp (EC-PAY-51).
 */
export const receipt = action({
  permission: "payments.receipt",
  args: { paymentId: v.id("payments") },
  handler: async (
    ctx,
    { paymentId },
  ): Promise<{ copy: boolean; url: string | null; pdfBase64: string; name: string }> => {
    const c = await ctx.runQuery(api.payments.receiptContext, { paymentId });
    const base64 = (bytes: Uint8Array) => {
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    if (c.archived) {
      const bytes = await renderQuittung(c.content, { copy: true });
      return {
        copy: true,
        url: null,
        pdfBase64: base64(bytes),
        name: c.content.fileName.replace(/\.pdf$/, "-Kopie.pdf"),
      };
    }
    const bytes = await renderQuittung(c.content, { copy: false });
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    try {
      await ctx.runMutation(internal.payments.attachReceiptInternal, {
        actorContext: ctx.actorContext,
        paymentId,
        file: {
          storageId,
          sha256: await sha256Hex(bytes),
          bytes: bytes.byteLength,
          mime: "application/pdf",
          name: c.content.fileName,
        },
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      throw e;
    }
    return {
      copy: false,
      url: await ctx.storage.getUrl(storageId),
      pdfBase64: base64(bytes),
      name: c.content.fileName,
    };
  },
});
