import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import { isoDate, prefixedId } from "@/domain/schemas/api/common";
import {
  cashTransferArgs,
  cashTransferWire,
  combinedPaymentArgs,
  combinedPaymentWire,
  markArgs,
  matchArgs,
  serializeOpenItems,
  serializePayment,
  serializeSuggestions,
} from "@/domain/schemas/api/payments";
import { ApiProblem } from "../../api/http";
import { loadPayments, recordBody } from "../../api/resources/payments";
import { rawId } from "../../api/resources/shared";
import { confirmTokenArg, defineTool } from "../tool";
import { bankMarkParams, bankMatchParams, paymentReverseParams } from "./payment-previews";

/**
 * 06 §3.5 receivables/payments and §3.7 bank/cash tools (F05/F07 P1). ⚠ tools pass the confirm token to the guarded
 * Convex function, which consumes it in the transaction of the act (06 §2.3). Never invent payments: the tool
 * descriptions tell Claude to record only what the owner stated.
 */

const notFound = (what: string) => new ApiProblem("not_found", { detail: `${what} nicht gefunden.` });

const openItemsInput = z.object({
  as_of: isoDate.optional().meta({ description: "Stichtag (Standard heute)" }),
  overdue_only: z.boolean().optional(),
});

export const paymentTools = [
  defineTool({
    name: "receivables_open_items",
    title: "Offene Posten",
    description:
      "Offene Forderungen zum Stichtag mit Fälligkeit, Tagen überfällig und Fälligkeitsbändern; Guthaben der Kunden. Überfällig wird beim Lesen berechnet.",
    kind: "read",
    scopes: ["payments:read"],
    input: openItemsInput,
    handler: async ({ as_of, overdue_only }, { convex }) =>
      serializeOpenItems(
        await convex.query(api.payments.openItems, {
          ...(as_of ? { asOf: as_of } : {}),
          ...(overdue_only ? { overdueOnly: true } : {}),
        }),
      ),
  }),
  defineTool({
    name: "contact_open_items",
    title: "Offene Posten eines Kontakts",
    description: "Offene Rechnungen und Guthaben eines Kontakts (con_…) zum Stichtag.",
    kind: "read",
    scopes: ["payments:read"],
    input: openItemsInput.extend({ contact_id: prefixedId("contacts") }),
    handler: async ({ contact_id, as_of, overdue_only }, { convex }) =>
      serializeOpenItems(
        await convex.query(api.payments.openItems, {
          contactId: rawId("contacts", contact_id) as never,
          ...(as_of ? { asOf: as_of } : {}),
          ...(overdue_only ? { overdueOnly: true } : {}),
        }),
      ),
  }),
  defineTool({
    name: "payment_list",
    title: "Zahlungen",
    description:
      "Zahlungen, neueste zuerst; Filter invoice_id (inv_…), contact_id, source_kind (bank, clearing, cash, credit, adjustment), Zeitraum. Stornozeilen haben reversal_of_id.",
    kind: "read",
    scopes: ["payments:read"],
    input: z.object({
      invoice_id: prefixedId("invoices").optional(),
      contact_id: prefixedId("contacts").optional(),
      source_kind: z.enum(["bank", "clearing", "cash", "credit", "adjustment"]).optional(),
      date_from: isoDate.optional(),
      date_to: isoDate.optional(),
      limit: z.number().int().min(1).max(200).optional().meta({ description: "Standard 50" }),
    }),
    handler: async (a, { convex }) => ({
      data: (
        await convex.query(api.payments.list, {
          ...(a.invoice_id ? { targetId: rawId("invoices", a.invoice_id) } : {}),
          ...(a.contact_id ? { contactId: rawId("contacts", a.contact_id) as never } : {}),
          ...(a.source_kind ? { sourceKind: a.source_kind } : {}),
          ...(a.date_from ? { dateFrom: a.date_from } : {}),
          ...(a.date_to ? { dateTo: a.date_to } : {}),
          limit: a.limit ?? 50,
        })
      ).map(serializePayment),
    }),
  }),
  defineTool({
    name: "payment_record",
    title: "Zahlung buchen ⚠",
    description:
      '⚠ Bucht eine Zahlung (Body wie REST POST /payments): source bank (gebuchter Umsatz btx_…), clearing (Konto bac_…) oder cash (bar: Datum ≤ heute, ab > 10 Tagen backdate_reason). Erfinde nie Zahlungen – nur was der Nutzer genannt hat. Erst preview_action {action:"payment_record", params} aufrufen, Auswirkung zeigen, bestätigen lassen, dann mit confirm_token und denselben params.',
    kind: "danger",
    confirmIntent: "payment_record",
    scopes: ["payments:write"],
    input: combinedPaymentWire.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, ...params }, { convex }) => {
      const args = combinedPaymentArgs(params);
      if (!args) throw notFound("Ziel oder Quelle");
      const r = await convex.mutation(api.payments.record, { ...args, confirmToken: confirm_token } as never);
      return recordBody(await loadPayments(convex, r.paymentIds), r);
    },
  }),
  defineTool({
    name: "payment_reverse",
    title: "Zahlung stornieren ⚠",
    description:
      '⚠ Storniert eine Zahlung (pay_…) per Gegenbuchung; die Zahlung bleibt sichtbar. Erst preview_action {action:"payment_reverse", params:{id, reason}}, bestätigen lassen, dann mit confirm_token.',
    kind: "danger",
    confirmIntent: "payment_reverse",
    scopes: ["payments:write"],
    input: paymentReverseParams.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, id, reason }, { convex }) => {
      const r = await convex.mutation(api.payments.reverse, {
        paymentId: rawId("payments", id) as never,
        reason,
        confirmToken: confirm_token,
      });
      return { data: await loadPayments(convex, r.reversalIds), date: r.date };
    },
  }),
  defineTool({
    name: "bank_match_suggestions",
    title: "Zuordnungsvorschläge",
    description:
      "Kandidaten für einen offenen Bankumsatz (btx_…) mit Punktzahl 0…1 und Gründen (Rechnungsnummer, Betrag, Name, IBAN, Datum).",
    kind: "read",
    scopes: ["banking:read"],
    input: z.object({ transaction_id: prefixedId("bankTransactions") }),
    handler: async ({ transaction_id }, { convex }) =>
      serializeSuggestions(
        await convex.query(api.matching.suggestions, {
          transactionId: rawId("bankTransactions", transaction_id) as never,
        }),
      ),
  }),
  defineTool({
    name: "bank_match_confirm",
    title: "Bankumsatz zuordnen ⚠",
    description:
      '⚠ Ordnet einen Bankumsatz Rechnungen (invoice), offenen Posten (opening_item), einem Guthaben (credit, id = con_…), einer Rechnungskorrektur mit offener Erstattung (correction, nur Ausgang, id = cor_…) oder einer vorhandenen Kontozahlung (payment) zu und bucht die Zahlung. Erst preview_action {action:"bank_match_confirm", params}, bestätigen lassen, dann mit confirm_token.',
    kind: "danger",
    confirmIntent: "bank_match_confirm",
    scopes: ["banking:write"],
    input: bankMatchParams.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, transaction_id, ...wire }, { convex }) => {
      const args = matchArgs(transaction_id, wire);
      if (!args) throw notFound("Umsatz oder Ziel");
      const r = await convex.mutation(api.matching.confirm, { ...args, confirmToken: confirm_token } as never);
      if ("paymentIds" in r) return recordBody(await loadPayments(convex, r.paymentIds), r);
      const ids = "refunded" in r ? [r.refunded] : [];
      return recordBody(await loadPayments(convex, ids), { warnings: [] });
    },
  }),
  defineTool({
    name: "bank_transaction_mark",
    title: "Bankumsatz markieren ⚠",
    description:
      '⚠ Markiert einen Umsatz als private, transfer (Geldtransit), cash_withdrawal (Bargeld in die Kasse) oder ignored (mit reason). Erzeugt Eigenbeleg und Buchung. Erst preview_action {action:"bank_transaction_mark", params}, bestätigen lassen, dann mit confirm_token.',
    kind: "danger",
    confirmIntent: "bank_transaction_mark",
    scopes: ["banking:write"],
    input: bankMarkParams.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, transaction_id, ...wire }, { convex }) => {
      const args = markArgs(transaction_id, wire);
      if (!args) throw notFound("Umsatz");
      return convex.action(api.banking.mark, { ...args, confirmToken: confirm_token } as never);
    },
  }),
  defineTool({
    name: "cash_transfer_record",
    title: "Bargeld eingezahlt / entnommen ⚠",
    description:
      '⚠ Kassenbewegung ohne Rechnung: deposit_to_bank (Einzahlung auf ein Bankkonto) oder private_withdrawal. Der Kassenbestand darf nie negativ werden; Bareinnahmen sind payment_record mit source cash. Erst preview_action {action:"cash_transfer_record", params}, bestätigen lassen, dann mit confirm_token.',
    kind: "danger",
    confirmIntent: "cash_transfer_record",
    scopes: ["banking:write"],
    input: cashTransferWire.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, ...params }, { convex }) => {
      const args = cashTransferArgs(params);
      if (!args) throw notFound("Bankkonto");
      const r = await convex.action(api.cash.recordTransfer, { ...args, confirmToken: confirm_token } as never);
      return { id: encodeId("cashTransfers", r.id), warning: r.warning ?? null };
    },
  }),
];
