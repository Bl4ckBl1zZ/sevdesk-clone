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

export const REFUND_EXCEEDED_MESSAGE = "Die Erstattung übersteigt den offenen Erstattungsbetrag.";

/**
 * PAY-033 (b), §4.3 „mirrored logic“: a credit correction (negative payable) has open ≤ 0 = refund still owed
 * („Erstattung offen“); outgoing refunds (negative rows) move it towards 0 („erstattet“). Settled by the offset alone
 * (fully absorbed by the corrected invoice) → `credited`. Open > 0 = refunded more than owed → corrupt (EC-PAY-33).
 */
function refundStatus(
  rows: readonly StatusRow[],
  active: readonly StatusRow[],
  base: Omit<DerivedPaymentStatus, "paymentStatus">,
): DerivedPaymentStatus {
  if (base.openAmountCents > 0) throw new RangeError(REFUND_EXCEEDED_MESSAGE);
  if (base.openAmountCents === 0) {
    const moneyCents = active.filter((r) => r.cash).reduce((s, r) => s + r.amountCents, 0);
    return { ...base, paymentStatus: moneyCents === 0 && rows.length === 0 ? "credited" : "paid" };
  }
  return { ...base, paymentStatus: base.settledCents < 0 ? "partially_paid" : "open" };
}

export function derivePaymentStatus(input: {
  payableCents: number;
  /**
   * Part of the payable settled by credit corrections (F04 §4.2.5); counts like a settlement without money. For a
   * credit correction itself: −`creditAppliedCents` (the part the corrected invoice absorbed, PAY-033 b).
   */
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
  if (input.payableCents < 0) return refundStatus(input.rows, active, base);
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
