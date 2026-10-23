/**
 * German texts of the F07 matching edge cases (§5.3): concurrent confirmations (EC-BNK-62), unmatch and bank
 * reversals with a locked period (EC-BNK-74, EC-BNK-78) and the returned-payment notice (F08 E-ACC-24, EC-BNK-14).
 */
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export const MATCH_MESSAGES = {
  concurrent: "Dieser Umsatz wurde soeben anderweitig zugeordnet.",
  unmatchLocked: "Zeitraum festgeschrieben – Rückbuchung erfolgt mit heutigem Datum.",
  reversalLocked: "Zeitraum der ursprünglichen Buchung festgeschrieben – Rückbuchung mit heutigem Datum.",
  bankReturned: (paymentDate: string, target: string) =>
    `Zahlung vom ${formatGermanDate(paymentDate as CalendarDate)} wurde von der Bank zurückgebucht – Zahlung storniert, ${target} wieder offen.`,
  /** Reversal reason of a payment whose card payment the merchant refunded (EC-BNK-27). */
  cardRefundReason: "Kartenerstattung durch den Händler",
  cardRefunded: (paymentDate: string, target: string) =>
    `Kartenerstattung zur Zahlung vom ${formatGermanDate(paymentDate as CalendarDate)} – Zahlung storniert, ${target} wieder offen.`,
} as const;
