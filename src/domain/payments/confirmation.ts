/**
 * Payment confirmation letter „Zahlungseingang bestätigt“ (F05 PAY-048, MAIL-03). Pure. The text comes from a
 * template with `{placeholder}`s (default shipped in de/en, the owner may edit the text before the export); the
 * letter is exported, archived and marked sent like any document — never e-mailed by the app (B2). For cash payments
 * the Quittung (PAY-063) is the receipt; this letter only confirms the receipt of a payment.
 */
import {
  de,
  eur,
  fileSafe,
  fillPlaceholders,
  footerOf,
  type LetterCompany,
  type LetterContent,
  type LetterRecipient,
  recipientLines,
  senderLineOf,
} from "../receivables/letter";

export type ConfirmationLang = "de" | "en";

export interface ConfirmationTemplate {
  readonly subject: string;
  readonly body: string;
}

/** Placeholders: {anrede} {betrag} {zahlungsdatum} {rechnungsnummer} {rechnungsdatum} {offen} {firma} */
export const DEFAULT_CONFIRMATION_TEMPLATES: Readonly<Record<ConfirmationLang, ConfirmationTemplate>> = {
  de: {
    subject: "Bestätigung Ihres Zahlungseingangs zur Rechnung {rechnungsnummer}",
    body: "{anrede},\n\nwir bestätigen den Eingang Ihrer Zahlung über {betrag} vom {zahlungsdatum} zu unserer Rechnung {rechnungsnummer} vom {rechnungsdatum}.\n\n{restsatz}\n\nVielen Dank für Ihre Zahlung.",
  },
  en: {
    subject: "Confirmation of your payment for invoice {rechnungsnummer}",
    body: "{anrede},\n\nwe confirm receipt of your payment of {betrag} on {zahlungsdatum} for our invoice {rechnungsnummer} dated {rechnungsdatum}.\n\n{restsatz}\n\nThank you for your payment.",
  },
};

const REST: Readonly<Record<ConfirmationLang, { paid: string; open: (amount: string) => string }>> = {
  de: {
    paid: "Die Rechnung ist damit vollständig beglichen.",
    open: (a) => `Es verbleibt ein offener Betrag von ${a}.`,
  },
  en: {
    paid: "The invoice is now paid in full.",
    open: (a) => `An amount of ${a} remains outstanding.`,
  },
};

export interface ConfirmationInput {
  readonly paymentId: string;
  readonly paymentDate: string;
  /** EUR moved by the payment (> 0). */
  readonly amountCents: number;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  /** Open amount of the invoice after all payments up to now. */
  readonly openAfterCents: number;
  readonly salutation: string;
  readonly company: LetterCompany;
  readonly recipient: LetterRecipient;
  readonly date: string;
  readonly lang?: ConfirmationLang;
  /** Edited text (plain text, `{placeholder}`s allowed); default: the shipped template. */
  readonly template?: ConfirmationTemplate;
}

export type ConfirmationIssue = { code: "not_confirmable"; message: string };

export const CONFIRMATION_MESSAGES = {
  notConfirmable:
    "Eine Zahlungsbestätigung gibt es nur für erfasste, nicht stornierte Zahlungseingänge auf Rechnungen.",
} as const;

export function paymentConfirmationLetter(i: ConfirmationInput): LetterContent {
  const lang = i.lang ?? "de";
  const t = i.template ?? DEFAULT_CONFIRMATION_TEMPLATES[lang];
  const values = {
    anrede: i.salutation,
    betrag: eur(i.amountCents),
    zahlungsdatum: de(i.paymentDate),
    rechnungsnummer: i.invoiceNumber,
    rechnungsdatum: de(i.invoiceDate),
    offen: eur(i.openAfterCents),
    restsatz: i.openAfterCents > 0 ? REST[lang].open(eur(i.openAfterCents)) : REST[lang].paid,
    firma: i.company.name,
  };
  const paragraphs = fillPlaceholders(t.body, values)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    kind: "payment_confirmation",
    title: lang === "de" ? "Zahlungsbestätigung" : "Payment confirmation",
    fileName: `Zahlungsbestaetigung-${fileSafe(i.invoiceNumber)}-${i.paymentDate}.pdf`,
    date: i.date,
    senderLine: senderLineOf(i.company),
    recipient: recipientLines(i.recipient),
    meta: [
      ...(i.recipient.customerNumber
        ? ([[lang === "de" ? "Kundennummer" : "Customer no.", i.recipient.customerNumber]] as const)
        : []),
      [lang === "de" ? "Rechnung" : "Invoice", i.invoiceNumber],
      [lang === "de" ? "Datum" : "Date", de(i.date)],
    ],
    subject: fillPlaceholders(t.subject, values),
    paragraphs,
    closing: [lang === "de" ? "Mit freundlichen Grüßen" : "Kind regards", i.company.contact.name || i.company.name],
    footer: footerOf(i.company),
  };
}
