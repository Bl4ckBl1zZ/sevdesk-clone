/**
 * Missing receipts and unbooked items (F06 VOU-110, VOU-111; GOBD-02/04/07; EC-INB-22).
 *
 * `/belege/fehlend` lists (a) booked bank transactions (in/out) that are not allocated, not marked private/transfer/
 * ignored, have no voucher and no „Beleg nicht erforderlich“ waiver — with inbox/draft suggestions by amount, date
 * and name; (b) vouchers open past their due date without payment; (c) recurring templates whose expected voucher
 * has no matching bank debit. „Unbearbeitet > 10 Tage“ counts drafts and inbox items from their `receivedAt`
 * (server capture time, EC-INB-20). Pure; `today`/`now` passed in.
 */
import { addDays, type CalendarDate, daysBetween } from "../time/calendar-date";
import { jaroWinkler, normaliseSupplierName } from "./supplier-key";

export const UNBOOKED_DAYS = 10;
const DAY_MS = 86_400_000;

export interface MissingTransaction {
  id: string;
  bookingDate: string;
  amountCents: number;
  counterpartyName?: string;
  purpose?: string;
  status: string;
  allocatedCents: number;
  /** A voucher is linked to the transaction (payment or receipt link). */
  hasVoucher: boolean;
  /** „Beleg nicht erforderlich“ recorded. */
  waived: boolean;
}

export interface ReceiptCandidate {
  id: string;
  kind: "draft" | "inbox";
  grossCents: number;
  date?: string;
  name?: string;
}

export interface OpenVoucherRef {
  id: string;
  status: string;
  dueDate?: string;
  documentDate: string;
  openAmountCents: number;
  recurringVoucherId?: string;
}

/** (a) booked transactions without receipt. Outgoing and incoming alike; marked/ignored/allocated ones are excluded. */
export function transactionsWithoutReceipt(txs: readonly MissingTransaction[]): MissingTransaction[] {
  return txs.filter(
    (t) => t.status === "open" && t.allocatedCents === 0 && !t.hasVoucher && !t.waived && t.amountCents !== 0,
  );
}

/** Inbox/draft suggestions for one transaction: same absolute amount, date within ± 10 days, name similarity. */
export function receiptSuggestions(
  tx: MissingTransaction,
  candidates: readonly ReceiptCandidate[],
): ReceiptCandidate[] {
  const amount = Math.abs(tx.amountCents);
  const name = tx.counterpartyName ? normaliseSupplierName(tx.counterpartyName) : "";
  return candidates
    .filter((c) => Math.abs(c.grossCents) === amount)
    .map((c) => {
      const days = c.date ? Math.abs(daysBetween(c.date as CalendarDate, tx.bookingDate as CalendarDate)) : 99;
      const sim = name && c.name ? jaroWinkler(name, normaliseSupplierName(c.name)) : 0;
      return { c, score: (days <= 10 ? 1 - days / 20 : 0) + sim };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

/** (b) vouchers open past due without any payment. */
export function overdueVouchers(vouchers: readonly OpenVoucherRef[], today: CalendarDate): OpenVoucherRef[] {
  return vouchers.filter(
    (v) => (v.status === "open" || v.status === "scheduled") && v.dueDate !== undefined && v.dueDate < today,
  );
}

/**
 * (c) vouchers generated from a recurring template that are still unpaid 10 days after their date (the expected
 * debit did not arrive or was not matched).
 */
export function recurringWithoutDebit(vouchers: readonly OpenVoucherRef[], today: CalendarDate): OpenVoucherRef[] {
  return vouchers.filter(
    (v) =>
      v.recurringVoucherId !== undefined &&
      (v.status === "open" || v.status === "scheduled") &&
      addDays(v.documentDate as CalendarDate, UNBOOKED_DAYS) < today,
  );
}

/** VOU-111 / EC-INB-22: drafts and inbox items received more than 10 days ago and not yet booked. */
export function unbookedOlderThan<T extends { receivedAt: number }>(
  items: readonly T[],
  now: number,
  days = UNBOOKED_DAYS,
): T[] {
  return items.filter((i) => now - i.receivedAt > days * DAY_MS);
}

export const unbookedMessage = (n: number) => `${n} Belege sind seit mehr als 10 Tagen unbearbeitet.`;

export const WAIVER_REASON_MIN = 5;
export const WAIVER_MESSAGE =
  "Bitte einen Grund angeben, warum kein Beleg erforderlich ist (z. B. Bankgebühr – Kontoauszug genügt).";
