/**
 * Customer account statement (Kontoauszug / Saldenbestätigung) for a period — F05 PAY-005. Pure.
 *
 * Balance from the customer's point of view: + = the customer owes us, − = credit in the customer's favour.
 * Opening balance = everything dated before `from`; then chronologically every invoice-like document (+ gross
 * payable), correction / Stornorechnung (their negative payable), payment (− cash), difference (− the amount it
 * settles: Skonto, Bankgebühren, Ausbuchung reduce; Mahngebühren/Zinsen received increase) and credit-balance movement
 * (− credit received, + credit refunded). Reversals carry their own date and negated amounts (PAY-003).
 */
import { type CalendarDate, compareDates } from "../time/calendar-date";
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
} from "./letter";

export type StatementDocKind =
  | "invoice"
  | "advance_invoice"
  | "partial_invoice"
  | "final_invoice"
  | "correction"
  | "cancellation"
  | "opening_item";

export interface StatementDocument {
  readonly id: string;
  readonly kind: StatementDocKind;
  readonly number: string;
  readonly date: string;
  /** Signed payable (corrections and Stornorechnungen negative). */
  readonly payableCents: number;
}

export interface StatementPayment {
  readonly id: string;
  readonly date: string;
  readonly targetKind: "salesDocument" | "opening_item" | "contactCredit";
  readonly number?: string | undefined;
  readonly amountCents: number;
  readonly differences: readonly { readonly reason: string; readonly amountCents: number }[];
  readonly reversal: boolean;
  /** `credit`: an application of the credit balance (pairs of rows that move nothing in total). */
  readonly sourceKind: string;
}

export type StatementEntryKind = "document" | "payment" | "difference" | "credit";

export interface StatementEntry {
  readonly date: string;
  readonly kind: StatementEntryKind;
  readonly text: string;
  readonly reference: string;
  /** + raises the balance (Soll), − lowers it (Haben). */
  readonly amountCents: number;
  readonly balanceCents: number;
}

export interface AccountStatement {
  readonly from: string;
  readonly to: string;
  readonly openingCents: number;
  readonly entries: readonly StatementEntry[];
  readonly closingCents: number;
}

const DOC_TEXT: Readonly<Record<StatementDocKind, string>> = {
  invoice: "Rechnung",
  advance_invoice: "Abschlagsrechnung",
  partial_invoice: "Teilrechnung",
  final_invoice: "Schlussrechnung",
  correction: "Rechnungskorrektur",
  cancellation: "Stornorechnung",
  opening_item: "Offener Posten (Eröffnungsbilanz)",
};

const DIFF_TEXT: Readonly<Record<string, string>> = {
  skonto: "Skonto",
  bank_fees: "Bankgebühren",
  dunning_fees: "Mahngebühren",
  default_interest: "Verzugszinsen",
  write_off: "Forderungsausfall",
  other: "Preisminderung",
  fx_difference: "Kursdifferenz",
};

interface RawEntry {
  date: string;
  kind: StatementEntryKind;
  text: string;
  reference: string;
  amountCents: number;
  order: number;
}

function entriesOf(documents: readonly StatementDocument[], payments: readonly StatementPayment[]): RawEntry[] {
  const out: RawEntry[] = [];
  for (const d of documents) {
    out.push({
      date: d.date,
      kind: "document",
      text: DOC_TEXT[d.kind],
      reference: d.number,
      amountCents: d.payableCents,
      order: 0,
    });
  }
  for (const p of payments) {
    const storno = p.reversal ? "Storno " : "";
    if (p.targetKind === "contactCredit") {
      // a credit application's credit row is matched by the document row of the same payment: show it once
      if (p.sourceKind === "credit") continue;
      out.push({
        date: p.date,
        kind: "credit",
        text: p.amountCents >= 0 ? `${storno}Guthaben erhalten` : `${storno}Guthaben erstattet`,
        reference: "",
        amountCents: -p.amountCents,
        order: 1,
      });
      continue;
    }
    if (p.amountCents !== 0) {
      out.push({
        date: p.date,
        kind: "payment",
        text:
          p.sourceKind === "credit"
            ? `${storno}Guthaben verrechnet`
            : p.amountCents < 0 && !p.reversal
              ? "Erstattung"
              : `${storno}Zahlung`,
        reference: p.number ?? "",
        amountCents: p.sourceKind === "credit" ? 0 : -p.amountCents,
        order: 1,
      });
    }
    for (const d of p.differences) {
      out.push({
        date: p.date,
        kind: "difference",
        text: `${storno}${DIFF_TEXT[d.reason] ?? "Differenz"}`,
        reference: p.number ?? "",
        amountCents: -d.amountCents,
        order: 2,
      });
    }
  }
  return out;
}

export function buildAccountStatement(i: {
  from: string;
  to: string;
  documents: readonly StatementDocument[];
  payments: readonly StatementPayment[];
}): AccountStatement {
  const all = entriesOf(i.documents, i.payments).filter((e) => e.date <= i.to);
  const openingCents = all.filter((e) => e.date < i.from).reduce((s, e) => s + e.amountCents, 0);
  let balance = openingCents;
  const entries = all
    .filter((e) => e.date >= i.from)
    .sort(
      (a, b) =>
        compareDates(a.date as CalendarDate, b.date as CalendarDate) ||
        a.order - b.order ||
        a.reference.localeCompare(b.reference),
    )
    .map((e) => {
      balance += e.amountCents;
      return {
        date: e.date,
        kind: e.kind,
        text: e.text,
        reference: e.reference,
        amountCents: e.amountCents,
        balanceCents: balance,
      };
    });
  return { from: i.from, to: i.to, openingCents, entries, closingCents: balance };
}

/** „Saldo zu unseren Gunsten …“ / „Guthaben zu Ihren Gunsten …“ / „ausgeglichen“. */
export function balanceSentence(closingCents: number, to: string): string {
  if (closingCents > 0) return `Zum ${de(to)} besteht ein offener Saldo zu unseren Gunsten von ${eur(closingCents)}.`;
  if (closingCents < 0) return `Zum ${de(to)} besteht ein Guthaben zu Ihren Gunsten von ${eur(-closingCents)}.`;
  return `Zum ${de(to)} ist Ihr Konto bei uns ausgeglichen.`;
}

const signed = (cents: number) => (cents === 0 ? "" : eur(Math.abs(cents)));

/** The PAY-005 letter: opening balance, chronological movements, closing balance, Saldenbestätigung text. */
export function accountStatementLetter(i: {
  statement: AccountStatement;
  company: LetterCompany;
  recipient: LetterRecipient;
  date: string;
  /** Saldenbestätigung: ask the customer to confirm the closing balance. */
  confirmationRequest?: boolean;
}): LetterContent {
  const s = i.statement;
  const rows: string[][] = [
    [de(s.from), "Anfangssaldo", "", "", "", eur(s.openingCents)],
    ...s.entries.map((e) => [
      de(e.date),
      e.text,
      e.reference,
      e.amountCents > 0 ? signed(e.amountCents) : "",
      e.amountCents < 0 ? signed(e.amountCents) : "",
      eur(e.balanceCents),
    ]),
    [de(s.to), "Endsaldo", "", "", "", eur(s.closingCents)],
  ];
  return {
    kind: "account_statement",
    title: i.confirmationRequest ? "Saldenbestätigung" : "Kontoauszug",
    fileName: `Kontoauszug-${fileSafe(i.recipient.customerNumber ?? i.recipient.name)}-${s.from}-${s.to}.pdf`,
    date: i.date,
    senderLine: senderLineOf(i.company),
    recipient: recipientLines(i.recipient),
    meta: [
      ...(i.recipient.customerNumber ? ([["Kundennummer", i.recipient.customerNumber]] as const) : []),
      ["Zeitraum", `${de(s.from)} – ${de(s.to)}`],
      ["Datum", de(i.date)],
    ],
    subject: `${i.confirmationRequest ? "Saldenbestätigung" : "Kontoauszug"} vom ${de(s.from)} bis ${de(s.to)}`,
    paragraphs: ["nachfolgend erhalten Sie eine Aufstellung Ihres Kundenkontos bei uns für den genannten Zeitraum."],
    table: {
      columns: [
        { label: "Datum", width: 11 },
        { label: "Vorgang", width: 24 },
        { label: "Beleg", width: 17 },
        { label: "Soll", align: "right", width: 15 },
        { label: "Haben", align: "right", width: 15 },
        { label: "Saldo", align: "right", width: 16 },
      ],
      rows,
      bold: [0, rows.length - 1],
    },
    closing: [
      balanceSentence(s.closingCents, s.to),
      ...(i.confirmationRequest
        ? [
            "Bitte prüfen Sie den Saldo und bestätigen Sie ihn uns. Abweichungen teilen Sie uns bitte unter Angabe der betroffenen Belege mit.",
          ]
        : ["Sollten Sie Abweichungen feststellen, teilen Sie uns diese bitte unter Angabe der Belege mit."]),
      "Mit freundlichen Grüßen",
      i.company.contact.name || i.company.name,
    ],
    footer: footerOf(i.company),
  };
}
