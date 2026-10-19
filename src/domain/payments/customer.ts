/**
 * F05 PAY-004 per-customer receivables view: average days to pay (Zahlungsdauer) of the customer's settled invoices.
 * Pure; dates are Europe/Berlin calendar dates.
 */
import { type CalendarDate, daysBetween } from "../time/calendar-date";

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

export const PAYMENT_SOURCE_LABEL_DE: Readonly<Record<string, string>> = {
  bank: "Bank",
  clearing: "Verrechnungskonto",
  cash: "Kasse",
  credit: "Guthaben",
  adjustment: "Ausgleich",
  private: "Privat",
};
