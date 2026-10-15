/**
 * Payment status derivation (F05 PAY-043, §4.3; 03 §4; RI-09). Pure; called in every payment mutation.
 *
 *   settled = Σ over all payment rows of the document (amountCents + Σ differences.amountCents) — reversal rows are
 *             already negated, so reversed payments cancel out
 *   open    = payable − credited − settled   (credited = Σ `creditAppliedCents` of the finalised, non-cancelled
 *             Rechnungskorrekturen of the document, F04 §4.2.5 / INV-12; no payment rows)
 *
 * Stored values `open | partially_paid | paid | credited | written_off` with the precedence
 * `written_off > credited > paid > partially_paid > open`. **Overdue is never stored**: `displayStatus()` derives it
 * at read time (F04 §4.2.9, 02 §6).
 */
import type { PaymentStatus } from "./display-status";

export interface StatusRow {
  amountCents: number;
  differences: readonly { reason: string; amountCents: number }[];
  /** Money moved (bank, cash, clearing, applied credit) — false for adjustments (write-off without cash). */
  cash: boolean;
  /** Original row that was reversed later (its reversal row is in the list as well). */
  reversed?: boolean;
  /** The reversal row itself (negated amounts). */
  reversal?: boolean;
}

export interface DerivedPaymentStatus {
  paymentStatus?: PaymentStatus;
  openAmountCents: number;
  settledCents: number;
  writeOffCents: number;
}

/** Net settlement value of one row: cash allocated plus accepted differences (RI-09). */
export const settledOf = (r: Pick<StatusRow, "amountCents" | "differences">): number =>
  r.amountCents + r.differences.reduce((s, d) => s + d.amountCents, 0);

const writeOffOf = (r: StatusRow): number =>
  r.differences.filter((d) => d.reason === "write_off").reduce((s, d) => s + d.amountCents, 0);

export const NEGATIVE_OPEN_MESSAGE = "Interner Fehler: negativer offener Betrag. Vorgang abgebrochen.";

export function derivePaymentStatus(input: {
  payableCents: number;
  /** Part of the payable settled by credit corrections (F04 §4.2.5); counts like a settlement without money. */
  creditedCents?: number;
  /** Rows in recording order (originals and reversal rows). */
  rows: readonly StatusRow[];
  cancelled?: boolean;
}): DerivedPaymentStatus {
  const settledCents = input.rows.reduce((s, r) => s + settledOf(r), 0);
  const openAmountCents = input.payableCents - (input.creditedCents ?? 0) - settledCents;
  const active = input.rows.filter((r) => !r.reversed && !r.reversal);
  const writeOffCents = active.reduce((s, r) => s + writeOffOf(r), 0);
  const base = { openAmountCents, settledCents, writeOffCents };
  if (input.cancelled) return base;
  // EC-PAY-45: overpayments are routed to a credit balance (PAY-030); a negative open amount is corrupt state.
  if (input.payableCents > 0 && openAmountCents < 0) throw new RangeError(NEGATIVE_OPEN_MESSAGE);
  if (input.payableCents <= 0) return { ...base, paymentStatus: "paid" };
  if (openAmountCents === 0) {
    const last = active.at(-1);
    if (writeOffCents > 0 && last && writeOffOf(last) > 0) return { ...base, paymentStatus: "written_off" };
    const moneyCents = active.filter((r) => r.cash).reduce((s, r) => s + r.amountCents, 0);
    if (moneyCents === 0 && writeOffCents === 0) return { ...base, paymentStatus: "credited" };
    return { ...base, paymentStatus: "paid" };
  }
  return { ...base, paymentStatus: settledCents > 0 ? "partially_paid" : "open" };
}
