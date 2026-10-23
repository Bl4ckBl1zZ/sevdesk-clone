/**
 * „Zinsforderung stellen“ (F05 DUN-028, MAHN-02, MAHN-03): after the principal was paid late, a reminder-type letter
 * claims only what is still owed for the default — § 288 interest from the default start until the payment, the
 * reminder fees claimed and the § 288 Abs. 5 flat fee (business debtors), less what was already received as dunning
 * fees/interest (PAY-024 differences). Pure; `date` is passed in.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import type { BasiszinssatzValue } from "../rules/basiszinssatz";
import { shiftToBusinessDay } from "../rules/holidays";
import type { RuleOverride } from "../rules/rule-table";
import { lookupVerzugSurcharges } from "../rules/thresholds";
import { addDays, type CalendarDate } from "../time/calendar-date";
import {
  de,
  eur,
  fileSafe,
  footerOf,
  type LetterCompany,
  type LetterContent,
  type LetterRecipient,
  recipientLines,
  senderLineOf,
} from "../receivables/letter";
import type { PrincipalHistory } from "./claim";
import { type DefaultStart, DEFAULT_ROUTE_LABEL_DE } from "./default-start";
import { computeInterest, type InterestSegment } from "./interest";

export const INTEREST_CLAIM_MESSAGES = {
  notPaid: "Die Hauptforderung ist noch offen. Bitte eine Mahnung erstellen – sie enthält Zinsen und Kosten.",
  notLate: "Die Rechnung wurde vor Verzugsbeginn bezahlt – es sind keine Verzugszinsen entstanden.",
  nothingOpen: "Zinsen und Kosten aus dem Verzug sind bereits beglichen.",
  eurOnly: "Eine Zinsforderung ist derzeit nur für Rechnungen in EUR möglich.",
} as const;

export interface InterestClaimInput {
  readonly date: CalendarDate;
  readonly currency: string;
  readonly isConsumer: boolean;
  readonly defaultStart: DefaultStart | null;
  /** Open principal now (must be 0) and the date the principal was settled in full. */
  readonly openAmountCents: number;
  readonly paidOn: CalendarDate | null;
  readonly history: PrincipalHistory;
  /** Σ fees of the issued (finalised or sent, not withdrawn) reminders. */
  readonly reminderFeesCents: number;
  /** Received as differences `dunning_fees` / `default_interest` (positive amounts). */
  readonly feesReceivedCents: number;
  readonly interestReceivedCents: number;
  /** Days until the new deadline (default 14), shifted to the next business day (§ 193 BGB). */
  readonly newDueDays?: number;
  readonly state?: string | undefined;
  readonly overrides?: readonly RuleOverride<BasiszinssatzValue>[];
}

export interface InterestClaim {
  readonly defaultStartDate: CalendarDate;
  readonly paidOn: CalendarDate;
  /** § 288 Abs. 1/2 surcharge over the Basiszinssatz (date-effective rule data), basis points. */
  readonly marginBp: number;
  readonly interestCents: number;
  readonly interestSegments: readonly InterestSegment[];
  readonly interestReceivedCents: number;
  readonly reminderFeesCents: number;
  readonly flatFee40Cents: number;
  readonly feesReceivedCents: number;
  readonly totalCents: number;
  readonly newDueDate: CalendarDate;
}

export type InterestClaimIssue = Issue<"not_paid" | "not_late" | "nothing_open" | "eur_only" | string>;

export function computeInterestClaim(i: InterestClaimInput): Result<InterestClaim, InterestClaimIssue> {
  if (i.currency !== "EUR") return err(issue("eur_only", INTEREST_CLAIM_MESSAGES.eurOnly));
  if (i.openAmountCents > 0 || !i.paidOn) return err(issue("not_paid", INTEREST_CLAIM_MESSAGES.notPaid));
  const start = i.defaultStart;
  if (!start || start.date > i.paidOn) return err(issue("not_late", INTEREST_CLAIM_MESSAGES.notLate));
  // The payment dated D reduces the principal from D on (interest.ts): interest runs on the open principal until then.
  const r = computeInterest({
    principalCents: i.history.principalCents,
    changes: i.history.changes,
    from: start.date,
    to: i.paidOn,
    margin: i.isConsumer ? "b2c" : "b2b",
    ...(i.overrides ? { overrides: i.overrides } : {}),
  });
  if (!r.ok) return err(r.error);
  const surcharges = lookupVerzugSurcharges(start.date);
  if (!surcharges.ok) return err(surcharges.error);
  const flatFee40Cents = i.isConsumer ? 0 : surcharges.value.value.flatFeeB2bCents;
  const marginBp = i.isConsumer ? surcharges.value.value.b2cBp : surcharges.value.value.b2bBp;
  const interestOpen = Math.max(0, r.value.totalCents - i.interestReceivedCents);
  const feesOpen = Math.max(0, i.reminderFeesCents + flatFee40Cents - i.feesReceivedCents);
  const totalCents = interestOpen + feesOpen;
  if (totalCents <= 0) return err(issue("nothing_open", INTEREST_CLAIM_MESSAGES.nothingOpen));
  return ok({
    defaultStartDate: start.date,
    paidOn: i.paidOn,
    marginBp,
    interestCents: r.value.totalCents,
    interestSegments: r.value.printable ? r.value.segments : [],
    interestReceivedCents: i.interestReceivedCents,
    reminderFeesCents: i.reminderFeesCents,
    flatFee40Cents,
    feesReceivedCents: i.feesReceivedCents,
    totalCents,
    newDueDate: shiftToBusinessDay(addDays(i.date, i.newDueDays ?? 14), i.state),
  });
}

const rate = (bp: number) => `${(bp / 100).toFixed(2).replace(".", ",")} %`;
/** 900 → „9“, 450 → „4,5“ */
export const percentPoints = (bp: number) => String(bp / 100).replace(".", ",");

export function interestClaimLetter(i: {
  claim: InterestClaim;
  invoice: { number: string; documentDate: string; payableCents: number };
  defaultRoute: DefaultStart["route"];
  isConsumer: boolean;
  salutation: string;
  company: LetterCompany;
  recipient: LetterRecipient;
  date: string;
}): LetterContent {
  const c = i.claim;
  const rows: string[][] = c.interestSegments.map((s) => [
    `${de(s.from)} – ${de(s.to)}`,
    String(s.days),
    eur(s.principalCents),
    rate(s.rateBp),
    eur(s.amountCents),
  ]);
  const sums: string[][] = [
    ["Verzugszinsen gesamt", "", "", "", eur(c.interestCents)],
    ...(c.interestReceivedCents > 0 ? [["abzüglich erhaltene Zinsen", "", "", "", `−${eur(c.interestReceivedCents)}`]] : []),
    ...(c.reminderFeesCents > 0 ? [["Mahngebühren", "", "", "", eur(c.reminderFeesCents)]] : []),
    ...(c.flatFee40Cents > 0 ? [["Pauschale nach § 288 Abs. 5 BGB", "", "", "", eur(c.flatFee40Cents)]] : []),
    ...(c.feesReceivedCents > 0 ? [["abzüglich erhaltene Kosten", "", "", "", `−${eur(c.feesReceivedCents)}`]] : []),
    ["Zu zahlen", "", "", "", eur(c.totalCents)],
  ];
  const all = [...rows, ...sums];
  return {
    kind: "interest_claim",
    title: "Zinsforderung",
    fileName: `Zinsforderung-${fileSafe(i.invoice.number)}-${i.date}.pdf`,
    date: i.date,
    senderLine: senderLineOf(i.company),
    recipient: recipientLines(i.recipient),
    meta: [
      ...(i.recipient.customerNumber ? ([["Kundennummer", i.recipient.customerNumber]] as const) : []),
      ["Rechnung", i.invoice.number],
      ["Datum", de(i.date)],
    ],
    subject: `Verzugszinsen und Kosten zur Rechnung ${i.invoice.number}`,
    paragraphs: [
      `${i.salutation},`,
      `vielen Dank für Ihre Zahlung zu unserer Rechnung ${i.invoice.number} vom ${de(i.invoice.documentDate)} über ${eur(i.invoice.payableCents)}. Die Zahlung ist erst am ${de(c.paidOn)} vollständig eingegangen; Sie befanden sich seit dem ${de(c.defaultStartDate)} in Verzug (${DEFAULT_ROUTE_LABEL_DE[i.defaultRoute]}).`,
      `Für die Dauer des Verzugs stehen uns Verzugszinsen in Höhe von ${percentPoints(c.marginBp)} Prozentpunkten über dem jeweiligen Basiszinssatz (§ 288 Abs. ${i.isConsumer ? "1" : "2"} BGB)${c.flatFee40Cents > 0 ? " sowie die Pauschale nach § 288 Abs. 5 BGB" : ""}${c.reminderFeesCents > 0 ? " und die angefallenen Mahngebühren" : ""} zu:`,
    ],
    table: {
      columns: [
        { label: "Zeitraum", width: 30 },
        { label: "Tage", align: "right", width: 9 },
        { label: "Betrag", align: "right", width: 20 },
        { label: "Zinssatz", align: "right", width: 15 },
        { label: "Zinsen", align: "right", width: 18 },
      ],
      rows: all,
      bold: [all.length - 1],
    },
    closing: [
      `Bitte überweisen Sie den Betrag von ${eur(c.totalCents)} bis zum ${de(c.newDueDate)}.`,
      "Mit freundlichen Grüßen",
      i.company.contact.name || i.company.name,
    ],
    footer: footerOf(i.company),
  };
}
