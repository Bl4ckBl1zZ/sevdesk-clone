/**
 * Eigenbeleg content for movements without an external voucher (F07 BNK-060 „Privatentnahme laut Kontoauszug“,
 * BNK-061 Geldtransit, CSH-024 „Bargeld eingezahlt / entnommen“, CSH-025 Bargeldabhebung in die Kasse; GOBD-07:
 * every booking needs a voucher — where none exists, the business documents the movement itself). Pure: the PDF
 * renderer (`src/pdf/eigenbeleg.ts`) lays these lines out; the Convex action archives the PDF with its sha256.
 */
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { formatMoneyDe } from "./amount";

export type EigenbelegKind =
  | "private_withdrawal"
  | "private_deposit"
  | "shareholder_withdrawal"
  | "shareholder_deposit"
  | "transfer"
  | "atm_to_cash"
  | "cash_deposit_to_bank"
  | "cash_private_withdrawal"
  | "cash_shareholder_withdrawal";

export const EIGENBELEG_TITLE: Readonly<Record<EigenbelegKind, string>> = {
  private_withdrawal: "Privatentnahme laut Kontoauszug",
  private_deposit: "Privateinlage laut Kontoauszug",
  shareholder_withdrawal: "Auszahlung an Gesellschafter laut Kontoauszug",
  shareholder_deposit: "Einzahlung durch Gesellschafter laut Kontoauszug",
  transfer: "Geldtransit laut Kontoauszug",
  atm_to_cash: "Bargeldabhebung in die Kasse",
  cash_deposit_to_bank: "Bareinzahlung auf das Bankkonto",
  cash_private_withdrawal: "Privatentnahme aus der Kasse",
  cash_shareholder_withdrawal: "Barauszahlung an Gesellschafter",
};

export interface EigenbelegInput {
  kind: EigenbelegKind;
  /** Booking date of the movement (Europe/Berlin). */
  date: string;
  amountCents: number;
  currency: string;
  feeCents?: number;
  company: { name: string; address?: string };
  /** Bank account label „Revolut EUR (LT44 …)“. */
  account?: string;
  counterpartyName?: string;
  purpose?: string;
  /** Bank reference / transaction ID or the cash-transfer ID — ties the voucher to the booking. */
  reference: string;
  shareholder?: { name: string; note: string };
  note?: string;
  backdateReason?: string;
  /** Date the voucher is created (Europe/Berlin, passed in). */
  createdOn: string;
  createdBy: string;
}

export interface EigenbelegContent {
  title: string;
  fileName: string;
  rows: readonly (readonly [string, string])[];
  statement: string;
}

export function eigenbelegContent(input: EigenbelegInput): EigenbelegContent {
  const title = EIGENBELEG_TITLE[input.kind];
  const rows: [string, string][] = [
    ["Datum", formatGermanDate(input.date as CalendarDate)],
    ["Betrag", formatMoneyDe(Math.abs(input.amountCents), input.currency)],
  ];
  if (input.feeCents) rows.push(["davon Bankgebühr", formatMoneyDe(input.feeCents, input.currency)]);
  if (input.account) rows.push(["Konto", input.account]);
  if (input.counterpartyName) rows.push(["Gegenpartei", input.counterpartyName]);
  if (input.purpose) rows.push(["Verwendungszweck", input.purpose]);
  if (input.shareholder) {
    rows.push(["Gesellschafter", input.shareholder.name]);
    rows.push(["Vermerk", input.shareholder.note]);
  }
  if (input.note) rows.push(["Notiz", input.note]);
  if (input.backdateReason) rows.push(["Grund der späten Erfassung", input.backdateReason]);
  rows.push(["Referenz", input.reference]);
  rows.push(["Erstellt am", `${formatGermanDate(input.createdOn as CalendarDate)} von ${input.createdBy}`]);
  return {
    title,
    fileName: `Eigenbeleg-${input.date}-${input.reference.replace(/[^A-Za-z0-9-]/g, "").slice(-12)}.pdf`,
    rows,
    statement:
      "Für diesen Vorgang liegt kein Fremdbeleg vor. Der Eigenbeleg wurde automatisch aus den unveränderbar gespeicherten Bank- bzw. Kassendaten erstellt (GoBD, Belegfunktion).",
  };
}

/** Eigenbeleg kind of a bank mark (BNK-060/061, CSH-025). */
export function markEigenbelegKind(
  mark: "private" | "transfer" | "cash_withdrawal",
  amountCents: number,
  corporation: boolean,
): EigenbelegKind {
  if (mark === "transfer") return "transfer";
  if (mark === "cash_withdrawal") return "atm_to_cash";
  if (corporation) return amountCents < 0 ? "shareholder_withdrawal" : "shareholder_deposit";
  return amountCents < 0 ? "private_withdrawal" : "private_deposit";
}
