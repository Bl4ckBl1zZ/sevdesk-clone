/**
 * F05 PAY-004 per-customer receivables view: average days to pay (Zahlungsdauer) of the customer's settled invoices.
 * Pure; dates are Europe/Berlin calendar dates.
 */
import { addDays, type CalendarDate, daysBetween, daysInMonth } from "../time/calendar-date";

export interface PaidInvoice {
  readonly documentDate: string;
  /** Date of the last active payment that settled the invoice. */
  readonly paidOn: string;
}

/** Mean of (paidOn − documentDate) in days, rounded half-up; null without settled invoices. */
export function averageDaysToPay(invoices: readonly PaidInvoice[]): number | null {
  if (invoices.length === 0) return null;
  const total = invoices.reduce(
    (s, i) => s + Math.max(0, daysBetween(i.documentDate as CalendarDate, i.paidOn as CalendarDate)),
    0,
  );
  return Math.floor((total * 2 + invoices.length) / (2 * invoices.length));
}

export interface SettledInvoice {
  readonly documentDate: string;
  readonly dueDate?: string | undefined;
  /** Date of the last active payment that settled the invoice. */
  readonly paidOn: string;
  /** Settled amount in EUR cents (the weight). */
  readonly amountCents: number;
}

export interface PaymentBehaviour {
  /** Σ(amount × (paidOn − documentDate)) / Σ amount, rounded half-up; prepayments count as 0 days. */
  readonly averageDaysToPay: number;
  /** Share of invoices paid after their due date, in basis points (10000 = all late). */
  readonly lateShareBp: number;
  readonly invoices: number;
  /** First day of the 12-month window (by payment date). */
  readonly from: string;
}

/** The same day one year earlier, + 1 day (29.02. → 28.02. of a non-leap year): the 12-month window start. */
function windowStart(today: CalendarDate): CalendarDate {
  const y = Number(today.slice(0, 4)) - 1;
  const m = Number(today.slice(5, 7));
  const d = Math.min(Number(today.slice(8, 10)), daysInMonth(y, m));
  return addDays(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as CalendarDate, 1);
}

const halfUpDiv = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

/**
 * F05 PAY-008 payment behaviour of a customer: settled invoices with a payment date in the last 12 months (`today`
 * included). Average days to pay weighted by amount, share of late payments (paid after the due date). Integer
 * arithmetic only; null without settled invoices in the window. Used by the customer view and the F08 forecast.
 */
export function paymentBehaviour(invoices: readonly SettledInvoice[], today: string): PaymentBehaviour | null {
  const from = windowStart(today as CalendarDate);
  const inWindow = invoices.filter((i) => i.paidOn >= from && i.paidOn <= today && i.amountCents > 0);
  if (inWindow.length === 0) return null;
  let weight = 0;
  let weighted = 0;
  let late = 0;
  for (const i of inWindow) {
    const days = Math.max(0, daysBetween(i.documentDate as CalendarDate, i.paidOn as CalendarDate));
    weight += i.amountCents;
    weighted += i.amountCents * days;
    if (i.dueDate && i.paidOn > i.dueDate) late++;
  }
  return {
    averageDaysToPay: halfUpDiv(weighted, weight),
    lateShareBp: halfUpDiv(late * 10_000, inWindow.length),
    invoices: inWindow.length,
    from,
  };
}

export const PAYMENT_SOURCE_LABEL_DE: Readonly<Record<string, string>> = {
  bank: "Bank",
  clearing: "Verrechnungskonto",
  cash: "Kasse",
  credit: "Guthaben",
  adjustment: "Ausgleich",
  private: "Privat",
};
