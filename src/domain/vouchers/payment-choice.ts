/**
 * „Bezahlt mit“ at booking and later (F06 VOU-131, VOU-136…139; F07 CSH-022/023; EC-VOU-39…44).
 *
 *  - `bank` (default): the voucher stays `open` and is matched later from a bank transaction (F07 BNK-049);
 *  - `card_pending`: „Kartenzahlung/Lastschrift – Bankumsatz folgt“ → `scheduled` until the bank transaction arrives;
 *  - `cash` („Bar bezahlt“): payment `source.kind = "cash"`, dating rules of CSH-021 (date ≤ today; > 1 day back →
 *    ⚑ warning citing § 146 Abs. 1 S. 2 AO; > 10 days back → reason mandatory), never in a locked period; the
 *    never-negative check (CSH-026) runs inside the posting transaction;
 *  - `private` („Privat bezahlt“, Privateinlage): no cash or bank movement; corporations post against the
 *    shareholder clearing account (EC-VOU-42). Income vouchers offer `bank` and `cash` only.
 * The OCR payment hint and the supplier profile only preselect a method (`preselectPaymentMethod`). Pure.
 */
import { CASH_REASON_DAYS, CASH_REASON_MIN_LENGTH } from "../cash/dating";
import { formatEuro } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import { type CalendarDate, daysBetween, formatGermanDate, isCalendarDate } from "../time/calendar-date";
import type { VoucherDirection } from "./types";

export const PAYMENT_METHODS = ["bank", "card_pending", "cash", "private"] as const;
export type VoucherPaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_DE: Readonly<Record<VoucherPaymentMethod, string>> = {
  bank: "Offen – Zahlung per Bank folgt",
  card_pending: "Kartenzahlung/Lastschrift – Bankumsatz folgt",
  cash: "Bar bezahlt",
  private: "Privat bezahlt",
};

/** Labels for the „Buchen“ button (F06 §6.3). */
export const BOOK_BUTTON_DE: Readonly<Record<VoucherPaymentMethod, string>> = {
  bank: "Buchen",
  card_pending: "Buchen – Bankumsatz folgt",
  cash: "Buchen – bar bezahlt",
  private: "Buchen – privat bezahlt",
};

export const PAYMENT_MESSAGES = {
  dateInvalid: "Das Zahlungsdatum darf nicht in der Zukunft oder in einem festgeschriebenen Zeitraum liegen.",
  privateIncome: "Einnahmen können nicht privat bezahlt werden. Bitte Bank oder Bar wählen.",
  amount: "Der Zahlbetrag muss größer als 0 sein und darf den offenen Betrag nicht übersteigen.",
  backdateReason: "Bitte begründen, warum die Barzahlung erst jetzt erfasst wird (mehr als 10 Tage zurück).",
  corporation: "Auslage durch Gesellschafter – wird auf dem Verrechnungskonto Gesellschafter gebucht.",
  dailyRecording: (date: string, days: number) =>
    `Barausgaben sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Zahlungsdatum ${formatGermanDate(date as CalendarDate)} liegt ${days} Tage zurück.`,
  cashNegative: (date: string, balanceCents: number) =>
    `Der Kassenbestand reicht nicht aus: am ${formatGermanDate(date as CalendarDate)} wären es ${formatEuro(balanceCents)}. Wurde der Beleg privat bezahlt? Dann bitte ‚Privat bezahlt‘ wählen.`,
} as const;

export interface PaymentWarning {
  code: "cash_backdated" | "shareholder_clearing";
  message: string;
  /** ⚑ must be acknowledged (API `acknowledge_warnings`). */
  acknowledge: boolean;
}

export type PaymentChoiceIssue = Issue<
  "payment_date_invalid" | "payment_private_income" | "payment_amount_invalid" | "backdate_reason_required"
>;

export interface PaymentChoiceInput {
  method: VoucherPaymentMethod;
  direction: VoucherDirection;
  date: string;
  amountCents: number;
  /** Open amount of the voucher in EUR (positive for payables, the sign of the voucher). */
  openCents: number;
  today: CalendarDate;
  closedPeriods: ReadonlySet<string>;
  backdateReason?: string;
  corporation: boolean;
}

/** Validation of the chosen method (no I/O; the cash balance is checked in the posting transaction). */
export function checkPaymentChoice(
  input: PaymentChoiceInput,
): Result<{ settles: boolean; warnings: PaymentWarning[] }, PaymentChoiceIssue> {
  if (input.method === "private" && input.direction === "income") {
    return err(issue("payment_private_income", PAYMENT_MESSAGES.privateIncome));
  }
  if (input.method === "bank" || input.method === "card_pending") return ok({ settles: false, warnings: [] });
  if (!isCalendarDate(input.date)) return err(issue("payment_date_invalid", PAYMENT_MESSAGES.dateInvalid));
  const daysBack = daysBetween(input.date as CalendarDate, input.today);
  if (daysBack < 0 || input.closedPeriods.has(input.date.slice(0, 7))) {
    return err(issue("payment_date_invalid", PAYMENT_MESSAGES.dateInvalid));
  }
  const open = Math.abs(input.openCents);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > open) {
    return err(issue("payment_amount_invalid", PAYMENT_MESSAGES.amount));
  }
  const warnings: PaymentWarning[] = [];
  if (input.method === "cash") {
    if (daysBack > CASH_REASON_DAYS && (input.backdateReason?.trim().length ?? 0) < CASH_REASON_MIN_LENGTH) {
      return err(issue("backdate_reason_required", PAYMENT_MESSAGES.backdateReason));
    }
    if (daysBack > 1) {
      warnings.push({
        code: "cash_backdated",
        message: PAYMENT_MESSAGES.dailyRecording(input.date, daysBack),
        acknowledge: true,
      });
    }
  }
  if (input.method === "private" && input.corporation) {
    warnings.push({ code: "shareholder_clearing", message: PAYMENT_MESSAGES.corporation, acknowledge: false });
  }
  return ok({ settles: true, warnings });
}

/** OCR `paymentHint` / supplier profile → preselected method (never applied without confirmation). */
export function preselectPaymentMethod(hint: string | undefined, direction: VoucherDirection): VoucherPaymentMethod {
  if (hint === "paid_cash") return "cash";
  if (hint === "paid_card" || hint === "direct_debit" || hint === "paid_paypal") {
    return direction === "income" ? "bank" : "card_pending";
  }
  return "bank";
}

/** Methods offered in the „Bezahlt mit“ control (VOU-136: income vouchers offer Bank and Bar only). */
export const methodsFor = (direction: VoucherDirection): VoucherPaymentMethod[] =>
  direction === "income" ? ["bank", "cash"] : ["bank", "card_pending", "cash", "private"];
