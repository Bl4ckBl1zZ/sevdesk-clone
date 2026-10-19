/**
 * Voucher status machine (F06 §4.2, VOU-130; PAY-043 mirrored for payables).
 *
 *   draft ──finalise──▶ open ──(manual / mandate)──▶ scheduled
 *   open/scheduled ──payment──▶ partially_paid ──payment──▶ paid; reversals move back
 *   correct (unlocked): any non-draft, non-cancelled state keeps its status (journal Generalumkehr + re-post)
 *   cancel (all payments reversed): open/scheduled ──▶ cancelled
 *
 * The open amount is always derived: `open = payable − settled` (settled = Σ payment rows incl. differences; reversal
 * rows are negated). Credit notes (negative payable, VOU-012) settle towards 0 with incoming refunds (VOU-134).
 * The model layer rejects every transition not in `VOUCHER_TRANSITIONS`. Pure.
 */
import type { VoucherStatus } from "./types";

export const VOUCHER_TRANSITIONS: Readonly<Record<VoucherStatus, readonly VoucherStatus[]>> = {
  draft: ["open"],
  open: ["scheduled", "partially_paid", "paid", "cancelled"],
  scheduled: ["open", "partially_paid", "paid", "cancelled"],
  partially_paid: ["paid", "open", "scheduled"],
  paid: ["partially_paid", "open", "scheduled"],
  cancelled: [],
};

export const canTransition = (from: VoucherStatus, to: VoucherStatus): boolean =>
  from === to || VOUCHER_TRANSITIONS[from].includes(to);

export const isBooked = (s: VoucherStatus): boolean => s !== "draft";

export const VOUCHER_STATUS_DE: Readonly<Record<VoucherStatus, string>> = {
  draft: "Entwurf",
  open: "Offen",
  scheduled: "Vorgemerkt",
  partially_paid: "Teilbezahlt",
  paid: "Bezahlt",
  cancelled: "Storniert",
};

export interface SettlementRow {
  amountCents: number;
  differences: readonly { amountCents: number }[];
}

export const settledOfRow = (r: SettlementRow): number =>
  r.amountCents + r.differences.reduce((s, d) => s + d.amountCents, 0);

export class VoucherOverpaidError extends RangeError {
  constructor() {
    super("Die Zahlungen übersteigen den Belegbetrag.");
    this.name = "VoucherOverpaidError";
  }
}

/**
 * Status and open amount after any payment change. `scheduled` („Vorgemerkt“, VOU-133) is kept only while nothing
 * is settled. Throws `VoucherOverpaidError` if the settlement exceeds the payable (sign-aware).
 */
export function deriveVoucherStatus(input: {
  status: VoucherStatus;
  payableCents: number;
  rows: readonly SettlementRow[];
  scheduled?: boolean;
}): { status: VoucherStatus; openAmountCents: number } {
  const settled = input.rows.reduce((s, r) => s + settledOfRow(r), 0);
  const open = input.payableCents - settled;
  if (input.status === "draft" || input.status === "cancelled") return { status: input.status, openAmountCents: open };
  const sign = Math.sign(input.payableCents) || 1;
  if (sign * open < 0) throw new VoucherOverpaidError();
  if (open === 0 && input.payableCents !== 0) return { status: "paid", openAmountCents: 0 };
  if (settled !== 0) return { status: "partially_paid", openAmountCents: open };
  return { status: input.scheduled ? "scheduled" : "open", openAmountCents: open };
}
