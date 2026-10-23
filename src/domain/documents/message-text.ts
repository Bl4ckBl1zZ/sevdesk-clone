/**
 * F04 SND-19 „E-Mail-Text kopieren“: subject and body of the copyable e-mail text, resolved from the frozen snapshot
 * with the owner's `message_text` template (F01 SET-080…087) or the shipped default. Pure; the app never sends the
 * mail and nothing is logged — the user copies the text or opens a `mailto:` link (no attachments).
 */
import { formatCents } from "../money/format";
import { DEFAULT_TEXT_TEMPLATES } from "../templates/defaults";
import { renderTemplate, type TemplateKind } from "../templates/placeholders";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { htmlToPlainText, resolvePlainText } from "./finalize";
import type { DocumentSnapshot, SalesDocType } from "./snapshot";

export interface MessageTemplate {
  readonly kind: TemplateKind;
  readonly docTypes: readonly string[];
  readonly language: "de" | "en";
  readonly name: string;
  readonly subject?: string | undefined;
  readonly body: string;
  readonly isDefault: boolean;
}

const TYPE_LABEL: Record<"de" | "en", Partial<Record<SalesDocType, string>>> = {
  de: {
    invoice: "Rechnung",
    advance_invoice: "Abschlagsrechnung",
    partial_invoice: "Teilrechnung",
    final_invoice: "Schlussrechnung",
    cancellation: "Stornorechnung",
    correction: "Rechnungskorrektur",
    quote: "Angebot",
    order_confirmation: "Auftragsbestätigung",
    delivery_note: "Lieferschein",
    proforma: "Proforma-Rechnung",
    reminder: "Mahnung",
    self_billing: "Gutschrift",
  },
  en: {
    invoice: "Invoice",
    advance_invoice: "Advance invoice",
    partial_invoice: "Partial invoice",
    final_invoice: "Final invoice",
    cancellation: "Cancellation invoice",
    correction: "Corrected invoice",
    quote: "Quote",
    order_confirmation: "Order confirmation",
    delivery_note: "Delivery note",
    proforma: "Pro forma invoice",
    reminder: "Payment reminder",
    self_billing: "Self-billing invoice",
  },
};

/** Owner template of the document type and language: the default wins, else the first; null → shipped default. */
export function pickMessageTemplate(
  templates: readonly MessageTemplate[],
  docType: SalesDocType,
  language: "de" | "en",
): MessageTemplate | null {
  const fitting = templates.filter(
    (t) => t.kind === "message_text" && t.language === language && t.docTypes.includes(docType),
  );
  return fitting.find((t) => t.isDefault) ?? fitting[0] ?? null;
}

function shippedTemplate(docType: SalesDocType, language: "de" | "en"): MessageTemplate {
  const own = DEFAULT_TEXT_TEMPLATES.find(
    (t) => t.kind === "message_text" && t.language === language && (t.docTypes as string[]).includes(docType),
  );
  return (
    own ??
    (DEFAULT_TEXT_TEMPLATES.find(
      (t) => t.kind === "message_text" && t.language === language && t.docTypes[0] === "invoice",
    ) as MessageTemplate)
  );
}

/** Placeholder values of a finalised document, taken from its snapshot (plus the live open amount). */
export function messagePlaceholderValues(
  s: DocumentSnapshot,
  extra: { readonly today: string; readonly openAmountCents?: number | undefined },
): Record<string, string | boolean | undefined> {
  const de = (d: string | undefined) => (d ? formatGermanDate(d as CalendarDate) : undefined);
  const money = (c: number | undefined) =>
    c === undefined ? undefined : `${formatCents(c)} ${s.currency === "EUR" ? "€" : s.currency}`;
  const seller = s.issuer ?? s.seller;
  const supply = s.supplyDate;
  const skonto = s.payment.skonto;
  return {
    "company.name": seller.name,
    "company.tradeName": seller.tradeName,
    "company.street": seller.address.street,
    "company.postalCode": seller.address.postalCode,
    "company.city": seller.address.city,
    "company.contactName": seller.contact.name,
    "company.phone": seller.contact.phone,
    "company.email": seller.contact.email,
    "company.website": seller.contact.website,
    "company.vatId": seller.vatId,
    "company.taxNumber": seller.taxNumber,
    "company.iban": s.payment.bankAccount?.iban,
    "company.bic": s.payment.bankAccount?.bic,
    "company.bankName": s.payment.bankAccount?.bankName,
    "company.accountHolder": s.payment.bankAccount?.accountHolder,
    "contact.name": s.buyer.name,
    "contact.number": s.buyer.contactNumber,
    "contact.fullName": s.buyer.contactPerson?.name ?? s.buyer.name,
    "contact.email": s.buyer.invoiceEmail,
    "contact.street": s.buyer.address?.street,
    "contact.postalCode": s.buyer.address?.postalCode,
    "contact.city": s.buyer.address?.city,
    "contact.vatId": s.buyer.vatId,
    "contact.taxNumber": s.buyer.taxNumber,
    "contact.buyerReference": s.references.buyerReference,
    "contact.isConsumer": s.buyer.isConsumer,
    "contact.isPublicAuthority": s.buyer.isPublicAuthority,
    "contact.letterSalutation": s.language === "en" ? "Dear Sir or Madam," : "Sehr geehrte Damen und Herren,",
    "document.typeLabel": TYPE_LABEL[s.language][s.type],
    "document.number": s.number,
    "document.date": de(s.documentDate),
    "document.supplyDate":
      supply?.kind === "date"
        ? de(supply.date)
        : supply?.kind === "period"
          ? `${de(supply.from)} – ${de(supply.to)}`
          : supply?.month,
    "document.subject": s.texts.subject,
    "document.dueDate": de(s.dueDate),
    "document.dueDays": String(s.payment.dueDays),
    "document.validUntil": de(s.validUntil),
    "document.netTotal": money(s.totals.netCents),
    "document.vatTotal": money(s.totals.vatCents),
    "document.grossTotal": money(s.totals.grossCents),
    "document.payableAmount": money(s.totals.payableCents),
    "document.openAmount": money(extra.openAmountCents),
    "document.currency": s.currency,
    "document.skontoPercent": skonto ? formatCents(skonto.percentBp).replace(/,00$/, "") : undefined,
    "document.skontoDays": skonto ? String(skonto.days) : undefined,
    "document.skontoDate": de(skonto?.date),
    "document.skontoAmount": money(skonto?.amountCents),
    "document.paymentTermsText": s.payment.termsText,
    "document.paymentMethod": s.payment.methodText,
    "document.orderReference": s.references.orderReference,
    "document.buyerReference": s.references.buyerReference,
    "document.contractReference": s.references.contractReference,
    "document.hasSkonto": skonto !== undefined,
    "document.isKleinunternehmer": s.seller.kleinunternehmer,
    "date.today": de(extra.today),
    "date.year": extra.today.slice(0, 4),
  };
}

export interface MessageText {
  readonly subject: string;
  readonly body: string;
  /** Name of the owner template used; null = shipped default. */
  readonly templateName: string | null;
}

/** SND-19: plain-text subject and body for copying (placeholders resolved, HTML flattened). */
export function messageText(
  s: DocumentSnapshot,
  p: {
    readonly templates: readonly MessageTemplate[];
    readonly today: string;
    readonly openAmountCents?: number | undefined;
  },
): MessageText {
  const own = pickMessageTemplate(p.templates, s.type, s.language);
  const tpl = own ?? shippedTemplate(s.type, s.language);
  const values = messagePlaceholderValues(s, { today: p.today, openAmountCents: p.openAmountCents });
  return {
    subject: resolvePlainText(tpl.subject ?? "", values)
      .replace(/\s+/g, " ")
      .trim(),
    body: htmlToPlainText(renderTemplate(tpl.body, values)),
    templateName: own?.name ?? null,
  };
}

/** `mailto:` with recipients, subject and body only — attachments are not possible (and not wanted). */
export function mailtoHref(to: readonly string[], subject: string, body: string): string {
  const enc = (v: string) => encodeURIComponent(v);
  return `mailto:${to.map(enc).join(",")}?subject=${enc(subject)}&body=${enc(body.replace(/\r?\n/g, "\r\n"))}`;
}
