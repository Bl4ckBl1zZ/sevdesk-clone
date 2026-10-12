/**
 * Dating rules for every cash movement (F07 CSH-021 — shared by „Bar bezahlt“ on invoices (F05 PAY-061), voucher
 * cash payments (CSH-022) and cash transfers (CSH-024/025); EC-200, EC-CSH-06/19/30/31):
 *  - amount > 0;
 *  - date ≤ today (Europe/Berlin) and ≥ the cash opening-balance date;
 *  - more than 1 day in the past → warning (daily-recording duty, § 146 Abs. 1 S. 2 AO);
 *  - more than 10 days in the past → a reason of at least 5 characters is mandatory (audited `backdateReason`).
 * Locked periods are refused by the posting (`period_locked`, EC-CSH-18). Pure; `today` is passed in.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { type CalendarDate, daysBetween, formatGermanDate, isCalendarDate } from "../time/calendar-date";

export const CASH_WARNING_DAYS = 1;
export const CASH_REASON_DAYS = 10;
export const CASH_REASON_MIN_LENGTH = 5;

export const CASH_MESSAGES = {
  amount: "Der Betrag muss größer als 0 sein.",
  dailyRecording:
    "Bareinnahmen und -ausgaben sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Bitte künftig am Tag der Zahlung erfassen.",
  reasonRequired:
    "Die Zahlung liegt mehr als 10 Tage zurück. Bitte eine Begründung für die verspätete Erfassung angeben.",
  range: (opening: string) =>
    `Das Datum muss zwischen dem Anfangsbestand der Kasse (${formatGermanDate(opening as CalendarDate)}) und heute liegen.`,
  future: "Das Datum darf nicht in der Zukunft liegen.",
} as const;

export type CashDatingIssue = Issue<"cash_amount" | "cash_date" | "backdate_reason_required">;

export function checkCashDating(input: {
  date: string;
  today: string;
  amountCents: number;
  /** Date of the cash opening balance (or the Buchungsbeginn). */
  openingDate?: string;
  backdateReason?: string;
}): Result<{ warning?: string; daysBack: number }, CashDatingIssue> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return err(issue("cash_amount", CASH_MESSAGES.amount));
  }
  if (!isCalendarDate(input.date)) return err(issue("cash_date", "Bitte ein gültiges Datum angeben."));
  const daysBack = daysBetween(input.date as CalendarDate, input.today as CalendarDate);
  if (daysBack < 0 || (input.openingDate !== undefined && input.date < input.openingDate)) {
    return err(issue("cash_date", input.openingDate ? CASH_MESSAGES.range(input.openingDate) : CASH_MESSAGES.future));
  }
  if (daysBack > CASH_REASON_DAYS && (input.backdateReason?.trim().length ?? 0) < CASH_REASON_MIN_LENGTH) {
    return err(issue("backdate_reason_required", CASH_MESSAGES.reasonRequired));
  }
  return ok({ daysBack, ...(daysBack > CASH_WARNING_DAYS ? { warning: CASH_MESSAGES.dailyRecording } : {}) });
}
