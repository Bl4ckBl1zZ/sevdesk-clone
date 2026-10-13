/**
 * Skonto eligibility (F05 PAY-021/PAY-022, EC-PAY-09/11, 10 EC-122) and the allocation order of a receipt between
 * principal, dunning fees and default interest (PAY-024, DUN-027; F05 Q-10 / README B12: principal first is the
 * default, § 367 BGB selectable). Pure.
 */
import { err, ok } from "../result";
import { PAY_MESSAGES } from "./messages";

/** From the frozen snapshot (`payment.skonto`): deadline = documentDate + skontoDays, agreed amount on the payable. */
export interface SkontoTerms {
  percentBp: number;
  deadline: string;
  agreedCents: number;
}

/** PAY-021 tolerance: the shortfall may exceed the agreed Skonto by at most 1 cent (rounding at the customer). */
export const SKONTO_TOLERANCE_CENTS = 1;

export type SkontoVerdict =
  | { eligible: true }
  | { eligible: false; reason: "no_terms" | "late" | "above"; message: string };

export function evaluateSkonto(input: {
  terms: SkontoTerms | null | undefined;
  paymentDate: string;
  shortfallCents: number;
}): SkontoVerdict {
  const t = input.terms;
  if (!t || t.percentBp <= 0) return { eligible: false, reason: "no_terms", message: PAY_MESSAGES.noSkontoTerms };
  const late = input.paymentDate > t.deadline;
  const above = input.shortfallCents > t.agreedCents + SKONTO_TOLERANCE_CENTS;
  if (!late && !above) return { eligible: true };
  return {
    eligible: false,
    reason: late ? "late" : "above",
    message: PAY_MESSAGES.skontoNotAllowed(input.paymentDate, t.deadline, input.shortfallCents, t.agreedCents),
  };
}

/** Result-style wrapper for validators. */
export const checkSkonto = (input: Parameters<typeof evaluateSkonto>[0]) => {
  const v = evaluateSkonto(input);
  return v.eligible ? ok(true) : err(v);
};

export type AllocationOrder = "principal_first" | "bgb_367";

export interface ReceiptSplit {
  principalCents: number;
  feesCents: number;
  interestCents: number;
  /** Cash beyond principal + claimed fees + claimed interest → PAY-030 (credit balance, further items, …). */
  excessCents: number;
}

/**
 * Splits a receipt. `principal_first`: principal, then claimed fees, then claimed interest (fees and interest are
 * only recognised when received, DUN-006). `bgb_367`: costs → interest → principal (§ 367 Abs. 1 BGB).
 */
export function splitReceipt(input: {
  cashCents: number;
  principalOpenCents: number;
  claimedFeesCents: number;
  claimedInterestCents: number;
  order: AllocationOrder;
}): ReceiptSplit {
  let rest = Math.max(0, input.cashCents);
  const take = (cap: number) => {
    const v = Math.min(rest, Math.max(0, cap));
    rest -= v;
    return v;
  };
  if (input.order === "bgb_367") {
    const feesCents = take(input.claimedFeesCents);
    const interestCents = take(input.claimedInterestCents);
    const principalCents = take(input.principalOpenCents);
    return { principalCents, feesCents, interestCents, excessCents: rest };
  }
  const principalCents = take(input.principalOpenCents);
  const feesCents = take(input.claimedFeesCents);
  const interestCents = take(input.claimedInterestCents);
  return { principalCents, feesCents, interestCents, excessCents: rest };
}
