import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { decodeId, encodeId } from "@/domain/api/ids";
import { isoDate, prefixedId } from "@/domain/schemas/api/common";
import {
  cashTransferArgs,
  cashTransferWire,
  combinedPaymentArgs,
  combinedPaymentWire,
  invoicePaymentArgs,
  invoicePaymentWire,
  markArgs,
  markWire,
  matchArgs,
  matchSuggestionsOut,
  matchWire,
  openItemsOut,
  paymentOut,
  paymentPreviewOut,
  paymentSourceWire,
  reverseWire,
  serializeOpenItems,
  serializePayment,
  serializePaymentPreview,
  serializeSuggestions,
  sourceArgs,
} from "@/domain/schemas/api/payments";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, rawId } from "./shared";

/**
 * 05 §4.4 payments + open items and the F07 matching/cash endpoints of §4.6 (F05 §7.1, F07 §7). Handlers only map
 * wire ⇄ Convex; every rule (PAY-030 excess, cash dating, never-negative, period locks) is enforced by the model.
 * API keys need no confirm token (only the MCP channel does, 06 §2.3).
 */

const TAG = "Zahlungen";
const BANK_TAG = "Bank und Kasse";

export async function loadPayment(convex: ConvexCaller, id: string) {
  return serializePayment(await convex.query(api.payments.get, { id: id as never }));
}

export async function loadPayments(convex: ConvexCaller, ids: readonly string[]) {
  return Promise.all(ids.map((id) => loadPayment(convex, id)));
}

const notFound = (what: string) => new ApiProblem("not_found", { detail: `${what} nicht gefunden.` });

const recordResult = z
  .object({
    data: z.array(paymentOut),
    allocation_group_id: z.string().nullable(),
    unallocated_cents: z.number().int().nullable(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .meta({ id: "PaymentRecordResult" });

export function recordBody(
  payments: z.infer<typeof paymentOut>[],
  r: {
    allocationGroupId?: string | undefined;
    unallocatedCents?: number | undefined;
    warnings: readonly { code: string; message: string }[];
  },
) {
  return {
    data: payments,
    allocation_group_id: r.allocationGroupId ?? null,
    unallocated_cents: r.unallocatedCents ?? null,
    warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

const listQ = z.object({
  target_id: z.string().optional().meta({ description: "inv_…, opi_… oder con_… (Guthaben)" }),
  contact_id: prefixedId("contacts").optional(),
  source_kind: z.enum(["bank", "clearing", "cash", "credit", "adjustment"]).optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  reversed: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

function rawTarget(id: string): string {
  const raw = decodeId("invoices", id) ?? decodeId("openingItems", id) ?? decodeId("contacts", id);
  if (!raw) throw new ApiProblem("bad_request", { errors: [{ code: "invalid", field: "target_id", message: id }] });
  return raw;
}

const openItemsQ = z.object({
  as_of: isoDate.optional(),
  overdue_only: z.enum(["true", "false"]).optional(),
  bucket: z.string().max(20).optional().meta({ description: "not_due, 1-30, 31-60, 61-90, >90" }),
});

async function openItems(convex: ConvexCaller, q: z.infer<typeof openItemsQ>, contactId?: string) {
  const r = await convex.query(api.payments.openItems, {
    ...(q.as_of ? { asOf: q.as_of } : {}),
    ...(contactId ? { contactId: contactId as never } : {}),
    ...(q.overdue_only === "true" ? { overdueOnly: true } : {}),
    ...(q.bucket ? { bucket: q.bucket } : {}),
  });
  return serializeOpenItems(r);
}

const previewBody = z
  .union([combinedPaymentWire, invoicePaymentWire.extend({ invoice_id: prefixedId("invoices") })])
  .meta({
    id: "PaymentPreviewRequest",
    description: "Body von POST /payments oder POST /invoices/{id}/payments + invoice_id",
  });

const creditApplyBody = z
  .object({ invoice_id: prefixedId("invoices"), amount_cents: z.number().int().min(1), date: isoDate })
  .strict()
  .meta({ id: "CreditApplyRequest" });

const creditRefundBody = z
  .object({
    amount_cents: z.number().int().min(1),
    source: paymentSourceWire,
    date: isoDate,
    backdate_reason: z.string().max(500).optional(),
    note: z.string().max(500).optional(),
    acknowledge_warnings: z.array(z.string().max(60)).max(10).optional(),
  })
  .strict()
  .meta({ id: "CreditRefundRequest" });

const receiptOut = z
  .object({
    file_name: z.string(),
    copy: z.boolean().meta({ description: "true = „Kopie“ (das Original wurde beim ersten Druck archiviert)" }),
    content_type: z.literal("application/pdf"),
    content_base64: z.string(),
  })
  .meta({ id: "PaymentReceipt" });

const cashTransferOut = z.object({ id: z.string(), warning: z.string().nullable() }).meta({ id: "CashTransferResult" });

const reasonBody = z.object({ reason: z.string().min(5).max(500) }).strict();

export const paymentsResource = defineResource("payments", "Zahlungen, offene Posten, Bankabgleich und Kasse", [
  defineEndpoint({
    method: "GET",
    path: "/payments",
    operationId: "listPayments",
    summary: "Zahlungen auflisten",
    description: "Neueste zuerst; Stornozeilen (reversal_of_id) erscheinen als eigene Zahlungen.",
    tag: TAG,
    scope: "payments:read",
    query: listQ,
    response: { status: 200, schema: z.object({ data: z.array(paymentOut) }), description: "Zahlungen" },
    handler: async ({ convex, query }) => {
      const rows = await convex.query(api.payments.list, {
        ...(query.target_id ? { targetId: rawTarget(query.target_id) } : {}),
        ...(query.contact_id ? { contactId: rawId("contacts", query.contact_id) as never } : {}),
        ...(query.source_kind ? { sourceKind: query.source_kind } : {}),
        ...(query.date_from ? { dateFrom: query.date_from } : {}),
        ...(query.date_to ? { dateTo: query.date_to } : {}),
        ...(query.reversed ? { reversed: query.reversed === "true" } : {}),
        limit: query.limit,
      });
      return { body: { data: rows.map(serializePayment) } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/payments/{id}",
    operationId: "getPayment",
    summary: "Zahlung abrufen",
    tag: TAG,
    scope: "payments:read",
    params: idParams("payments"),
    response: { status: 200, schema: paymentOut, description: "Die Zahlung" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({ body: await loadPayment(convex, rawId("payments", params.id)) }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/invoices/{id}/payments",
    operationId: "recordInvoicePayment",
    summary: "Zahlung zu einer Rechnung buchen",
    description:
      "Quelle `bank` (gebuchter Umsatz), `clearing` (Konto ohne Umsatz) oder `cash` (Bar bezahlt: Datum ≤ heute, Hinweis bei > 1 Tag, `backdate_reason` ab > 10 Tagen). Ein Mehrbetrag braucht `excess` (PAY-030), sonst 422. ⚑-Hinweise sind über `acknowledge_warnings` zu bestätigen.",
    tag: TAG,
    scope: "payments:write",
    params: idParams("invoices"),
    body: invoicePaymentWire,
    response: { status: 201, schema: recordResult, description: "Die gebuchte(n) Zahlung(en)" },
    errors: ["not_found", "validation_failed", "period_locked", "cash_negative"],
    handler: async ({ convex, params, body }) => {
      const args = invoicePaymentArgs(params.id, body);
      if (!args) throw notFound("Rechnung oder Bankumsatz");
      const r = await convex.mutation(api.payments.recordForInvoice, args as never);
      return { status: 201, body: recordBody(await loadPayments(convex, r.paymentIds), r) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/payments",
    operationId: "recordPayment",
    summary: "Zahlung buchen (eine Quelle, mehrere Zuordnungen)",
    description:
      "Sammelzahlung (PAY-013): eine Quelle, Zuordnungen zu Rechnungen (`invoice`), offenen Posten der Eröffnungsbilanz (`opening_item`) oder als Guthaben (`credit`, id = Kontakt).",
    tag: TAG,
    scope: "payments:write",
    body: combinedPaymentWire,
    response: { status: 201, schema: recordResult, description: "Die gebuchten Zahlungen" },
    errors: ["not_found", "validation_failed", "period_locked", "cash_negative"],
    handler: async ({ convex, body }) => {
      const args = combinedPaymentArgs(body);
      if (!args) throw notFound("Ziel oder Quelle");
      const r = await convex.mutation(api.payments.record, args as never);
      return { status: 201, body: recordBody(await loadPayments(convex, r.paymentIds), r) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/payments/preview",
    operationId: "previewPayment",
    summary: "Zahlung prüfen (Trockenlauf)",
    description:
      "Gleiche Prüfungen wie das Buchen, schreibt nichts: Zuordnung, Differenzen mit USt-Korrektur, Buchungssätze, Hinweise.",
    tag: TAG,
    scope: "payments:read",
    body: previewBody,
    response: { status: 200, schema: paymentPreviewOut, description: "Die Vorschau" },
    errors: ["not_found", "validation_failed", "period_locked", "cash_negative"],
    handler: async ({ convex, body }) => {
      if ("invoice_id" in body) {
        const { invoice_id, ...rest } = body;
        const args = invoicePaymentArgs(invoice_id, rest);
        if (!args) throw notFound("Rechnung oder Bankumsatz");
        const r = await convex.query(api.payments.previewInvoicePayment, args as never);
        if (!r.ok) {
          throw new ApiProblem("validation_failed", {
            errors: [{ code: (r.reason ?? "invalid").toLowerCase(), message: r.message }],
          });
        }
        return { body: serializePaymentPreview(r) };
      }
      const args = combinedPaymentArgs(body);
      if (!args) throw notFound("Ziel oder Quelle");
      return { body: serializePaymentPreview(await convex.query(api.payments.preview, args as never)) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/payments/{id}/reverse",
    operationId: "reversePayment",
    summary: "Zahlung stornieren",
    description:
      "Erzeugt eine Gegenbuchung (PAY-040/041); die Zahlung selbst bleibt unverändert. Datum = ursprüngliches Datum bzw. erster offener Tag, wenn der Zeitraum festgeschrieben ist.",
    tag: TAG,
    scope: "payments:write",
    params: idParams("payments"),
    body: reverseWire,
    response: { status: 201, schema: z.object({ data: z.array(paymentOut) }), description: "Die Stornozeile(n)" },
    errors: ["not_found", "validation_failed", "conflict"],
    handler: async ({ convex, params, body }) => {
      const r = await convex.mutation(api.payments.reverse, {
        paymentId: rawId("payments", params.id) as never,
        reason: body.reason,
      });
      return { status: 201, body: { data: await loadPayments(convex, r.reversalIds) } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/payments/{id}/receipt",
    operationId: "getPaymentReceipt",
    summary: "Quittung einer Barzahlung",
    description:
      "Beim ersten Abruf wird die Quittung erzeugt und archiviert (SHA-256); jeder weitere Abruf liefert eine „Kopie“ aus denselben Daten (PAY-063).",
    tag: TAG,
    scope: "payments:read",
    params: idParams("payments"),
    response: { status: 200, schema: receiptOut, description: "PDF (Base64)" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params }) => {
      const r = await convex.action(api.payments.receipt, { paymentId: rawId("payments", params.id) as never });
      return {
        body: { file_name: r.name, copy: r.copy, content_type: "application/pdf", content_base64: r.pdfBase64 },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/contacts/{id}/credit/apply",
    operationId: "applyContactCredit",
    summary: "Guthaben auf eine Rechnung anrechnen",
    tag: TAG,
    scope: "payments:write",
    params: idParams("contacts"),
    body: creditApplyBody,
    response: { status: 201, schema: recordResult, description: "Die Anrechnung" },
    errors: ["not_found", "validation_failed", "period_locked"],
    handler: async ({ convex, params, body }) => {
      const r = await convex.mutation(api.payments.applyCredit, {
        contactId: rawId("contacts", params.id) as never,
        documentId: rawId("invoices", body.invoice_id) as never,
        amountCents: body.amount_cents,
        date: body.date,
      });
      return { status: 201, body: recordBody(await loadPayments(convex, r.paymentIds), r) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/contacts/{id}/credit/refund",
    operationId: "refundContactCredit",
    summary: "Guthaben erstatten",
    description: "Auszahlung eines Guthabens per Bank (gebuchter Ausgang), Konto oder bar (PAY-033/062).",
    tag: TAG,
    scope: "payments:write",
    params: idParams("contacts"),
    body: creditRefundBody,
    response: { status: 201, schema: recordResult, description: "Die Erstattung" },
    errors: ["not_found", "validation_failed", "period_locked", "cash_negative"],
    handler: async ({ convex, params, body }) => {
      const source = sourceArgs(body.source);
      if (!source) throw notFound("Bankumsatz oder Konto");
      const r = await convex.mutation(api.payments.refund, {
        contactId: rawId("contacts", params.id) as never,
        amountCents: body.amount_cents,
        source: source as never,
        date: body.date,
        ...(body.backdate_reason ? { backdateReason: body.backdate_reason } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.acknowledge_warnings?.length ? { acknowledgeWarnings: body.acknowledge_warnings } : {}),
      });
      return { status: 201, body: recordBody(await loadPayments(convex, [r.paymentId]), r) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/open-items",
    operationId: "listOpenItems",
    summary: "Offene Posten",
    description:
      "Offene Forderungen zum Stichtag `as_of` (Standard heute) mit Fälligkeitsbändern; überfällig wird beim Lesen berechnet (PAY-001…007).",
    tag: TAG,
    scope: "payments:read",
    query: openItemsQ.extend({ contact_id: prefixedId("contacts").optional() }),
    response: { status: 200, schema: openItemsOut, description: "Offene Posten" },
    handler: async ({ convex, query }) => ({
      body: await openItems(convex, query, query.contact_id ? rawId("contacts", query.contact_id) : undefined),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/contacts/{id}/open-items",
    operationId: "listContactOpenItems",
    summary: "Offene Posten eines Kontakts",
    tag: TAG,
    scope: "payments:read",
    params: idParams("contacts"),
    query: openItemsQ,
    response: { status: 200, schema: openItemsOut, description: "Offene Posten des Kontakts" },
    errors: ["not_found"],
    handler: async ({ convex, params, query }) => ({
      body: await openItems(convex, query, rawId("contacts", params.id)),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/bank-transactions/{id}/suggestions",
    operationId: "getBankMatchSuggestions",
    summary: "Zuordnungsvorschläge eines Bankumsatzes",
    description:
      "Kandidaten mit Punktzahl 0…1 und Gründen (Rechnungsnummer, Betrag, Name, IBAN, Datum; BNK-041/042). Leer, wenn der Umsatz bereits zugeordnet ist.",
    tag: BANK_TAG,
    scope: "banking:read",
    params: idParams("bankTransactions"),
    response: { status: 200, schema: matchSuggestionsOut, description: "Vorschläge" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({
      body: serializeSuggestions(
        await convex.query(api.matching.suggestions, {
          transactionId: rawId("bankTransactions", params.id) as never,
        }),
      ),
    }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/bank-transactions/{id}/match",
    operationId: "matchBankTransaction",
    summary: "Bankumsatz zuordnen",
    description:
      "Bucht die Zahlung(en) über F05 (Eingang → Rechnungen/offene Posten/Guthaben; Ausgang → Erstattung eines Guthabens; `payment` = vorhandene Kontozahlung abgleichen). Restbetrag eines Eingangs: `remainder`.",
    tag: BANK_TAG,
    scope: "banking:write",
    params: idParams("bankTransactions"),
    body: matchWire,
    response: { status: 201, schema: recordResult, description: "Die gebuchten Zahlungen" },
    errors: ["not_found", "validation_failed", "period_locked"],
    handler: async ({ convex, params, body }) => {
      const args = matchArgs(params.id, body);
      if (!args) throw notFound("Umsatz oder Ziel");
      const r = await convex.mutation(api.matching.confirm, args as never);
      if ("paymentIds" in r) return { status: 201, body: recordBody(await loadPayments(convex, r.paymentIds), r) };
      // Outgoing refund of a credit balance, or an existing clearing payment reconciled with the transaction.
      const ids = "refunded" in r ? [r.refunded] : [];
      return { status: 201, body: recordBody(await loadPayments(convex, ids), { warnings: [] }) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/bank-transactions/{id}/unmatch",
    operationId: "unmatchBankTransaction",
    summary: "Zuordnung aufheben",
    description: "Storniert die Zahlungen des Umsatzes (F05 PAY-040); der Umsatz ist danach wieder offen.",
    tag: BANK_TAG,
    scope: "payments:write",
    params: idParams("bankTransactions"),
    body: reasonBody.meta({ id: "BankUnmatchRequest" }),
    response: { status: 201, schema: z.object({ data: z.array(paymentOut) }), description: "Die Stornozeilen" },
    errors: ["not_found", "validation_failed", "conflict"],
    handler: async ({ convex, params, body }) => {
      const r = await convex.mutation(api.matching.unmatch, {
        transactionId: rawId("bankTransactions", params.id) as never,
        reason: body.reason,
      });
      return { status: 201, body: { data: await loadPayments(convex, r.reversalIds) } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/bank-transactions/{id}/mark",
    operationId: "markBankTransaction",
    summary: "Bankumsatz markieren",
    description:
      "`private` (Privatentnahme/-einlage), `transfer` (Geldtransit), `cash_withdrawal` (Bargeld in die Kasse), `ignored` (mit Grund). Erzeugt den Eigenbeleg und die Buchung (BNK-060/061/063, CSH-025).",
    tag: BANK_TAG,
    scope: "banking:write",
    params: idParams("bankTransactions"),
    body: markWire,
    response: { status: 200, schema: z.object({ status: z.string() }), description: "Neuer Status" },
    errors: ["not_found", "validation_failed", "period_locked", "cash_negative"],
    handler: async ({ convex, params, body }) => {
      const args = markArgs(params.id, body);
      if (!args) throw notFound("Umsatz");
      return { body: await convex.action(api.banking.mark, args as never) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/cash/transfers",
    operationId: "recordCashTransfer",
    summary: "Bargeld eingezahlt / entnommen",
    description:
      "Einzahlung auf ein Bankkonto oder Privatentnahme aus der Kasse mit Eigenbeleg; der Kassenbestand darf an keinem Tag negativ werden (CSH-024/026).",
    tag: BANK_TAG,
    scope: "banking:write",
    body: cashTransferWire,
    response: { status: 201, schema: cashTransferOut, description: "Die Kassenbewegung" },
    errors: ["not_found", "validation_failed", "period_locked", "cash_negative"],
    handler: async ({ convex, body }) => {
      const args = cashTransferArgs(body);
      if (!args) throw notFound("Bankkonto");
      const r = await convex.action(api.cash.recordTransfer, args as never);
      return { status: 201, body: { id: encodeId("cashTransfers", r.id), warning: r.warning ?? null } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/cash/transfers/{id}/reverse",
    operationId: "reverseCashTransfer",
    summary: "Kassenbewegung stornieren",
    tag: BANK_TAG,
    scope: "banking:write",
    params: idParams("cashTransfers"),
    body: reasonBody.meta({ id: "CashTransferReverseRequest" }),
    response: { status: 200, schema: z.object({ id: z.string() }), description: "Storniert" },
    errors: ["not_found", "validation_failed", "conflict", "cash_negative"],
    handler: async ({ convex, params, body }) => {
      await convex.mutation(api.cash.reverseTransfer, {
        id: rawId("cashTransfers", params.id) as never,
        reason: body.reason,
      });
      return { body: { id: params.id } };
    },
  }),
]);
