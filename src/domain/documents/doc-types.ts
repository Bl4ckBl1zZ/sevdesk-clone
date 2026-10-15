/**
 * Document-type facts shared by the model, the UI, REST and MCP (F04 §4.1): labels, the "letter" types that are not
 * invoices (quote, order confirmation, delivery note, proforma — no XML, no journal, no receivable, F04 §4.6.2) and
 * the UI route of each type (04 §3 route map).
 */
import { INVOICE_FAMILY_TYPES } from "./lifecycle";
import type { SalesDocType } from "./snapshot";

/** Non-invoice sales documents (F04 §3.2 QUO): PDF only, no journal, no receivable, not in revenue. */
export const LETTER_TYPES = ["quote", "order_confirmation", "delivery_note", "proforma"] as const;
export type LetterType = (typeof LETTER_TYPES)[number];

export const isLetterType = (type: string): type is LetterType => (LETTER_TYPES as readonly string[]).includes(type);

/** Invoice-family draft types of the editor (F04 §4.1); Storno is created finalised and never a draft. */
export const INVOICE_DRAFT_TYPES = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "correction",
] as const;
export type InvoiceDraftType = (typeof INVOICE_DRAFT_TYPES)[number];

export const isInvoiceDraftType = (type: string): type is InvoiceDraftType =>
  (INVOICE_DRAFT_TYPES as readonly string[]).includes(type);

/** Types whose drafts the shared editor creates (F04 §4.1). */
export const DRAFT_TYPES = [...INVOICE_DRAFT_TYPES, ...LETTER_TYPES] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

export const DOC_TYPE_LABEL_DE: Readonly<Record<SalesDocType, string>> = {
  quote: "Angebot",
  order_confirmation: "Auftragsbestätigung",
  delivery_note: "Lieferschein",
  proforma: "Proforma-Rechnung",
  invoice: "Rechnung",
  advance_invoice: "Abschlagsrechnung",
  partial_invoice: "Teilrechnung",
  final_invoice: "Schlussrechnung",
  cancellation: "Stornorechnung",
  correction: "Rechnungskorrektur",
  self_billing: "Gutschrift",
  reminder: "Mahnung",
};

export const DOC_TYPE_PLURAL_DE: Readonly<Record<SalesDocType, string>> = {
  quote: "Angebote",
  order_confirmation: "Auftragsbestätigungen",
  delivery_note: "Lieferscheine",
  proforma: "Proforma-Rechnungen",
  invoice: "Rechnungen",
  advance_invoice: "Rechnungen",
  partial_invoice: "Rechnungen",
  final_invoice: "Rechnungen",
  cancellation: "Rechnungen",
  correction: "Rechnungskorrekturen",
  self_billing: "Gutschriften",
  reminder: "Mahnungen",
};

const ROUTE: Partial<Record<SalesDocType, string>> = {
  quote: "/angebote",
  order_confirmation: "/auftraege",
  delivery_note: "/lieferscheine",
  reminder: "/mahnungen",
};

/** UI base route of a type (04 §3); every invoice type incl. proforma lives under /rechnungen. */
export const documentRoute = (type: SalesDocType): string => ROUTE[type] ?? "/rechnungen";

export const documentPath = (type: SalesDocType, id: string): string => `${documentRoute(type)}/${id}`;

/** Finalisation opens a receivable (`paymentStatus`, `openAmountCents`) only for the invoice family (03 §4). */
export const carriesReceivable = (type: SalesDocType): boolean => INVOICE_FAMILY_TYPES.includes(type);
