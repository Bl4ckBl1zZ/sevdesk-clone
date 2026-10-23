/**
 * EC-BNK-76 (MISC-08, PAY-018 mirrored for purchase vouchers): a foreign card payment from the EUR account settles a
 * foreign-currency voucher in full when the instructed (original) amount equals the voucher's gross in its currency.
 * The EUR actually paid differs from the voucher's EUR value at the document-date rate; the difference is a realised
 * exchange difference (fx_loss / fx_gain, no VAT), never Skonto. Partly paid vouchers are not split (no FX lots per
 * voucher) — those stay a manual allocation.
 */
export interface VoucherFxInput {
  voucherCurrency: string;
  /** The voucher's gross in its own currency (minor units). */
  billGrossMinor: number;
  /** The voucher's open amount in EUR (booking currency). */
  openEurCents: number;
  /** Nothing paid yet (open = EUR gross). */
  unpaid: boolean;
  /** EUR leaving the account for the principal (fee excluded). */
  paidEurCents: number;
  instructed?: { amountMinor: number; currency: string };
}

export interface VoucherFxDifference {
  /** Difference in the voucher-payment sign convention: − = paid more than the claim, + = paid less. */
  amountCents: number;
  role: "expense.fx_loss" | "income.fx_gain";
}

export function voucherFxDifference(input: VoucherFxInput): VoucherFxDifference | null {
  const { instructed } = input;
  if (input.voucherCurrency === "EUR" || !input.unpaid || !instructed) return null;
  if (instructed.currency !== input.voucherCurrency || instructed.amountMinor !== input.billGrossMinor) return null;
  const amountCents = input.openEurCents - input.paidEurCents;
  if (amountCents === 0) return null;
  return { amountCents, role: amountCents < 0 ? "expense.fx_loss" : "income.fx_gain" };
}
