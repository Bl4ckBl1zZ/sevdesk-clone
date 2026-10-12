/**
 * Seeded default text templates (F01 SET-086): German and English head, foot and copyable e-mail text
 * (`message_text`, F04 SND-19) for every numbered sales document type. Stored on setup completion or via
 * „Standardvorlagen wiederherstellen“; afterwards they are ordinary, editable templates.
 */
import { type LayoutDocType, SALES_DOC_TYPES } from "../documents/layout";
import { NUMBERED_TYPE_LABEL_DE } from "../numbering/register";
import type { TemplateKind } from "./placeholders";

export const TEMPLATE_KINDS = [
  "document_head",
  "document_foot",
  "message_text",
] as const satisfies readonly TemplateKind[];
export const TEMPLATE_LANGUAGES = ["de", "en"] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

export const TEMPLATE_KIND_LABEL_DE: Readonly<Record<TemplateKind, string>> = {
  document_head: "Kopftext",
  document_foot: "Fußtext",
  message_text: "E-Mail-Text",
};

export interface DefaultTextTemplate {
  kind: TemplateKind;
  docTypes: LayoutDocType[];
  language: TemplateLanguage;
  name: string;
  subject?: string;
  body: string;
  isDefault: true;
}

const SAL = "<p>{{contact.letterSalutation}}</p>";

const HEAD_DE: Record<LayoutDocType, string> = {
  quote: "vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:",
  order_confirmation: "vielen Dank für Ihren Auftrag, den wir hiermit wie folgt bestätigen:",
  delivery_note: "wie vereinbart liefern wir Ihnen:",
  proforma: "wie gewünscht erhalten Sie folgende Proforma-Rechnung:",
  invoice: "vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:",
  advance_invoice: "vereinbarungsgemäß berechnen wir Ihnen folgende Abschlagszahlung:",
  partial_invoice: "wir berechnen Ihnen folgende Teilleistungen:",
  final_invoice:
    "nach Abschluss der Arbeiten berechnen wir Ihnen wie folgt; bereits geleistete Abschlagszahlungen sind abgezogen:",
  cancellation: "hiermit stornieren wir die Rechnung {{document.correctedNumber}} vom {{document.correctedDate}}.",
  correction:
    "hiermit korrigieren wir die Rechnung {{document.correctedNumber}} vom {{document.correctedDate}} wie folgt:",
  reminder:
    "sicher haben Sie übersehen, dass unsere Rechnung {{reminder.invoiceNumber}} vom {{reminder.invoiceDate}} noch offen ist.",
};

const HEAD_EN: Record<LayoutDocType, string> = {
  quote: "Thank you for your enquiry. We are pleased to submit the following quotation:",
  order_confirmation: "Thank you for your order, which we hereby confirm as follows:",
  delivery_note: "As agreed, we deliver the following:",
  proforma: "As requested, please find our pro forma invoice below:",
  invoice: "Thank you for your order. We invoice the following services:",
  advance_invoice: "As agreed, we invoice the following advance payment:",
  partial_invoice: "We invoice the following partial services:",
  final_invoice: "Following completion of the work we invoice as follows; advance payments already made are deducted:",
  cancellation: "We hereby cancel invoice {{document.correctedNumber}} dated {{document.correctedDate}}.",
  correction: "We hereby correct invoice {{document.correctedNumber}} dated {{document.correctedDate}} as follows:",
  reminder:
    "You may have overlooked that our invoice {{reminder.invoiceNumber}} dated {{reminder.invoiceDate}} is still unpaid.",
};

const INVOICE_LIKE = new Set<LayoutDocType>([
  "proforma",
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
]);

function footBody(docType: LayoutDocType, language: TemplateLanguage): string {
  const de = language === "de";
  const regards = de
    ? "<p>Mit freundlichen Grüßen<br>{{company.contactName}}</p>"
    : "<p>Kind regards<br>{{company.contactName}}</p>";
  if (INVOICE_LIKE.has(docType)) return `<p>{{document.paymentTermsText}}</p>${regards}`;
  if (docType === "quote") {
    return de
      ? `<p>Dieses Angebot ist gültig bis {{document.validUntil}}. Wir freuen uns auf Ihren Auftrag.</p>${regards}`
      : `<p>This quotation is valid until {{document.validUntil}}. We look forward to your order.</p>${regards}`;
  }
  if (docType === "reminder") {
    return de
      ? `<p>Bitte überweisen Sie den Betrag von {{reminder.totalDue}} bis {{reminder.newDueDate}}. Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.</p>${regards}`
      : `<p>Please transfer {{reminder.totalDue}} by {{reminder.newDueDate}}. If you have already paid, please disregard this letter.</p>${regards}`;
  }
  return regards;
}

/** „unsere Rechnung“, „unser Angebot“, „unseren Lieferschein“ … (accusative, for the e-mail text). */
const OUR_DE: Record<LayoutDocType, string> = {
  quote: "unser Angebot",
  order_confirmation: "unsere Auftragsbestätigung",
  delivery_note: "unseren Lieferschein",
  proforma: "unsere Proforma-Rechnung",
  invoice: "unsere Rechnung",
  advance_invoice: "unsere Abschlagsrechnung",
  partial_invoice: "unsere Teilrechnung",
  final_invoice: "unsere Schlussrechnung",
  cancellation: "unsere Stornorechnung",
  correction: "unsere Rechnungskorrektur",
  reminder: "unsere Zahlungserinnerung",
};

const OUR_EN: Record<LayoutDocType, string> = {
  quote: "our quotation",
  order_confirmation: "our order confirmation",
  delivery_note: "our delivery note",
  proforma: "our pro forma invoice",
  invoice: "our invoice",
  advance_invoice: "our advance invoice",
  partial_invoice: "our partial invoice",
  final_invoice: "our final invoice",
  cancellation: "our cancellation invoice",
  correction: "our corrected invoice",
  reminder: "our payment reminder",
};

function messageBody(docType: LayoutDocType, language: TemplateLanguage): string {
  if (language === "de") {
    return `${SAL}<p>anbei erhalten Sie ${OUR_DE[docType]} {{document.number}} vom {{document.date}}.</p><p>Mit freundlichen Grüßen<br>{{company.contactName}}<br>{{company.name}}</p>`;
  }
  return `${SAL}<p>Please find attached ${OUR_EN[docType]} {{document.number}} dated {{document.date}}.</p><p>Kind regards<br>{{company.contactName}}<br>{{company.name}}</p>`;
}

const KIND_NAME: Record<TemplateKind, string> = {
  document_head: "Kopftext",
  document_foot: "Fußtext",
  message_text: "E-Mail-Text",
};

export const DEFAULT_TEXT_TEMPLATES: readonly DefaultTextTemplate[] = SALES_DOC_TYPES.flatMap((docType) =>
  TEMPLATE_KINDS.flatMap((kind) =>
    TEMPLATE_LANGUAGES.map((language): DefaultTextTemplate => {
      const name = `Standard ${KIND_NAME[kind]} ${NUMBERED_TYPE_LABEL_DE[docType] ?? docType} (${language.toUpperCase()})`;
      const base = { kind, docTypes: [docType], language, name, isDefault: true as const };
      if (kind === "document_head") {
        return { ...base, body: `${SAL}<p>${(language === "de" ? HEAD_DE : HEAD_EN)[docType]}</p>` };
      }
      if (kind === "document_foot") return { ...base, body: footBody(docType, language) };
      return {
        ...base,
        subject: "{{document.typeLabel}} {{document.number}} – {{company.name}}",
        body: messageBody(docType, language),
      };
    }),
  ),
);
