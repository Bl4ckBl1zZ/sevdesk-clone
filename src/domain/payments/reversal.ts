/**
 * Payment reversal and refund planning (F05 PAY-033, PAY-040…PAY-042, EC-PAY-27/29/33; F07 BNK-047, BNK-121).
 * Payments are never edited: a reversal is a new row with negated amounts. Pure; `today` is passed in.
 */
import { CASH_REASON_DAYS, CASH_REASON_MIN_LENGTH, CASH_WARNING_DAYS } from "../cash/dating";
import { err, type Issue, issue, ok, type Result } from "../result";
import { type CalendarDate, daysBetween, isCalendarDate } from "../time/calendar-date";
import { PAY_MESSAGES } from "./messages";
import type { PaymentWarning } from "./plan";

export const REASON_MIN_LENGTH = 5;

export type ReversalIssue = Issue<"already_reversed" | "reversal_of_reversal" | "reason_required">;

/**
 * PAY-041: the reversal is dated on the original payment date (or the preferred date, e.g. the bank counter-entry's
 * booking date, EC-PAY-24) if that period is open, otherwise today with the original kept as reference (EC-PAY-29).
 */
export function planReversal(input: {
  row: { date: string; reversedById?: string; reversalOfId?: string };
  reason: string;
  today: string;
  closedPeriods: ReadonlySet<string>;
  preferredDate?: string;
}): Result<{ date: string; warnings: PaymentWarning[] }, ReversalIssue> {
  if (input.row.reversalOfId) return err(issue("reversal_of_reversal", PAY_MESSAGES.reversalOfReversal));
  if (input.row.reversedById) return err(issue("already_reversed", PAY_MESSAGES.alreadyReversed));
  if (input.reason.trim().length < REASON_MIN_LENGTH) return err(issue("reason_required", PAY_MESSAGES.reasonRequired));
  const wanted = input.preferredDate ?? input.row.date;
  if (!input.closedPeriods.has(wanted.slice(0, 7))) return ok({ date: wanted, warnings: [] });
  return ok({
    date: input.today,
    warnings: [{ code: "reversal_period_locked", message: PAY_MESSAGES.reversalLocked(input.today), ack: false }],
  });
}

export type RefundIssue = Issue<
  | "amount_positive"
  | "refund_exceeds"
  | "future_date"
  | "period_locked"
  | "cash_reason_required"
  | "tx_direction"
  | "source_exceeded"
  | "date_invalid"
>;

/** PAY-033 refund of a credit balance (bank: an outgoing transaction; cash „Bar erstattet“, PAY-062; clearing). */
export function planRefund(input: {
  sourceKind: "bank" | "cash" | "clearing";
  amountCents: number;
  creditBalanceCents: number;
  date: string;
  today: string;
  closedPeriods: ReadonlySet<string>;
  backdateReason?: string;
  bank?: { bookingDate: string; amountCents: number; allocatedCents: number };
}): Result<{ date: string; warnings: PaymentWarning[] }, RefundIssue> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return err(issue("amount_positive", PAY_MESSAGES.amountPositive));
  }
  if (input.amountCents > input.creditBalanceCents) {
    return err(issue("refund_exceeds", PAY_MESSAGES.refundExceeds(input.creditBalanceCents)));
  }
  const warnings: PaymentWarning[] = [];
  if (input.sourceKind === "bank") {
    if (!input.bank || input.bank.amountCents >= 0) return err(issue("tx_direction", PAY_MESSAGES.txDirection));
    const available = -input.bank.amountCents - input.bank.allocatedCents;
    if (input.amountCents > available) {
      return err(issue("source_exceeded", PAY_MESSAGES.sourceExceeded(input.amountCents, available)));
    }
    return ok({ date: input.bank.bookingDate, warnings });
  }
  if (!isCalendarDate(input.date)) return err(issue("date_invalid", "Bitte ein gültiges Datum angeben."));
  const daysBack = daysBetween(input.date as CalendarDate, input.today as CalendarDate);
  if (daysBack < 0) return err(issue("future_date", PAY_MESSAGES.future));
  if (input.closedPeriods.has(input.date.slice(0, 7))) {
    return err(issue("period_locked", PAY_MESSAGES.periodLocked(input.date.slice(0, 7))));
  }
  if (input.sourceKind === "cash") {
    if (daysBack > CASH_REASON_DAYS && (input.backdateReason?.trim().length ?? 0) < CASH_REASON_MIN_LENGTH) {
      return err(issue("cash_reason_required", PAY_MESSAGES.cashReason));
    }
    if (daysBack > CASH_WARNING_DAYS) {
      warnings.push({ code: "cash_daily_recording", message: PAY_MESSAGES.cashDaily(daysBack), ack: true });
    }
  }
  return ok({ date: input.date, warnings });
}
