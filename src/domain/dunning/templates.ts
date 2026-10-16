/**
 * Default letter texts of the reminder documents and the „gegenstandslos“ notice (F05 DUN-050, §4.9). The texts use
 * the shared placeholder dictionary (`templates/placeholders.ts`, namespace `reminder`); they are stored on the reminder
 * draft with placeholders and resolved at finalisation, so amounts and deadlines always match the frozen claim.
 * No reminder e-mail templates (B2). The consumer texts never mention the 40 € flat fee.
 */
import { formatEuro } from "../money/format";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import type { Claim } from "./claim";

export type Lang = "de" | "en";

export interface ReminderTexts {
  readonly subject: string;
  readonly headText: string;
  readonly footText: string;
}

const SAL_DE = "<p>{{contact.letterSalutation}},</p>";
const REG_DE = "<p>Mit freundlichen Grüßen<br>{{company.contactName}}</p>";
const REG_EN = "<p>Kind regards<br>{{company.contactName}}</p>";

const DE: Readonly<Record<1 | 2 | 3, ReminderTexts>> = {
  1: {
    subject: "Zahlungserinnerung zur Rechnung {{reminder.invoiceNumber}}",
    headText: `${SAL_DE}<p>sicherlich ist es Ihrer Aufmerksamkeit entgangen, dass unsere Rechnung {{reminder.invoiceNumber}} vom {{reminder.invoiceDate}} noch offen ist.</p>`,
    footText: `<p>Bitte überweisen Sie den offenen Betrag von {{reminder.openAmount}} bis zum {{reminder.newDueDate}}. Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.</p>${REG_DE}`,
  },
  2: {
    subject: "1. Mahnung zur Rechnung {{reminder.invoiceNumber}}",
    headText: `${SAL_DE}<p>trotz unserer Zahlungserinnerung konnten wir bis heute keinen Zahlungseingang zu unserer Rechnung {{reminder.invoiceNumber}} vom {{reminder.invoiceDate}} feststellen.{{#reminder.defaultStartDate}} Sie befinden sich seit dem {{reminder.defaultStartDate}} in Verzug.{{/reminder.defaultStartDate}}</p>`,
    footText: `<p>Bitte überweisen Sie den Gesamtbetrag von {{reminder.totalDue}} bis zum {{reminder.newDueDate}}.</p>${REG_DE}`,
  },
  3: {
    subject: "Letzte Mahnung zur Rechnung {{reminder.invoiceNumber}}",
    headText: `${SAL_DE}<p>leider ist unsere Rechnung {{reminder.invoiceNumber}} vom {{reminder.invoiceDate}} trotz Erinnerung und Mahnung weiterhin offen.</p>`,
    footText: `<p>Sollte der Betrag von {{reminder.totalDue}} nicht bis zum {{reminder.newDueDate}} eingehen, werden wir die Forderung ohne weitere Ankündigung an ein Inkassounternehmen übergeben bzw. gerichtlich geltend machen.</p>${REG_DE}`,
  },
};

const EN: Readonly<Record<1 | 2 | 3, ReminderTexts>> = {
  1: {
    subject: "Payment reminder for invoice {{reminder.invoiceNumber}}",
    headText: `<p>{{contact.letterSalutation}},</p><p>you may have overlooked that our invoice {{reminder.invoiceNumber}} dated {{reminder.invoiceDate}} is still unpaid.</p>`,
    footText: `<p>Please transfer the outstanding amount of {{reminder.openAmount}} by {{reminder.newDueDate}}. If you have already paid, please disregard this letter.</p>${REG_EN}`,
  },
  2: {
    subject: "First dunning notice for invoice {{reminder.invoiceNumber}}",
    headText: `<p>{{contact.letterSalutation}},</p><p>despite our reminder we have not yet received payment for invoice {{reminder.invoiceNumber}} dated {{reminder.invoiceDate}}.{{#reminder.defaultStartDate}} You have been in default since {{reminder.defaultStartDate}}.{{/reminder.defaultStartDate}}</p>`,
    footText: `<p>Please transfer the total amount of {{reminder.totalDue}} by {{reminder.newDueDate}}.</p>${REG_EN}`,
  },
  3: {
    subject: "Final notice for invoice {{reminder.invoiceNumber}}",
    headText: `<p>{{contact.letterSalutation}},</p><p>unfortunately invoice {{reminder.invoiceNumber}} dated {{reminder.invoiceDate}} is still unpaid despite our reminder and dunning notice.</p>`,
    footText: `<p>If the amount of {{reminder.totalDue}} is not received by {{reminder.newDueDate}}, we will hand the claim over to a collection agency or take legal action without further notice.</p>${REG_EN}`,
  },
};

/** Default texts for a level; levels above 3 use the level-3 text. */
export function defaultReminderTexts(level: number, lang: Lang): ReminderTexts {
  const k = (level <= 1 ? 1 : level === 2 ? 2 : 3) as 1 | 2 | 3;
  return (lang === "en" ? EN : DE)[k];
}

export const VOID_NOTICE_DE = {
  subject: "Unsere Mahnung {{reminder.number}} ist gegenstandslos",
  body: "bitte betrachten Sie unsere Mahnung {{reminder.number}} vom {{reminder.date}} zur Rechnung {{reminder.invoiceNumber}} als gegenstandslos. Wir bitten das Versehen zu entschuldigen.",
} as const;

export interface ReminderValueInput {
  readonly claim: Claim;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceDueDate: string;
  readonly number?: string | undefined;
  readonly date?: string | undefined;
  readonly currency?: string | undefined;
}

const de = (s: string | undefined) => (s ? formatGermanDate(s as CalendarDate) : undefined);

/** Values of the `reminder.*` placeholders (resolved at finalisation, DUN-050). */
export function reminderPlaceholderValues(i: ReminderValueInput): Record<string, string | undefined> {
  const c = i.claim;
  return {
    "reminder.level": String(c.level),
    "reminder.title": c.title,
    "reminder.invoiceNumber": i.invoiceNumber,
    "reminder.invoiceDate": de(i.invoiceDate),
    "reminder.invoiceDueDate": de(i.invoiceDueDate),
    "reminder.openAmount": formatEuro(c.openAmountCents),
    "reminder.feeAmount": formatEuro(c.feeCents),
    "reminder.interestAmount": formatEuro(c.interestCents),
    "reminder.flatFee": c.flatFee40Cents ? formatEuro(c.flatFee40Cents) : undefined,
    "reminder.totalDue": formatEuro(c.totalCents),
    "reminder.newDueDate": de(c.newDueDate),
    "reminder.defaultStartDate": c.inDefault ? de(c.defaultStartDate) : undefined,
    "reminder.number": i.number,
    "reminder.date": de(i.date),
  };
}
