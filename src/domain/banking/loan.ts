/**
 * Darlehen (F07 BNK-062, EC-BNK-75): a loan disbursement (incoming) is posted against the loan account; a repayment
 * (outgoing) is split into principal (loan account) and interest (interest expense) — the owner enters one part,
 * the other is the rest of the payment (a fee in the row stays a bank fee, R5). Pure.
 *
 * Default accounts per chart are rule data (`src/domain/rules/accounting/loan-accounts.ts`); the owner may choose
 * another existing account of the chart (the posting resolves and validates it).
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export const LOAN_MESSAGES = {
  principalExceeds: "Der Tilgungsanteil übersteigt den Zahlbetrag.",
  interestExceeds: "Der Zinsanteil übersteigt den Zahlbetrag.",
  splitMismatch: "Tilgung und Zinsen ergeben nicht den Zahlbetrag.",
  splitRequired: "Bitte den Tilgungs- oder den Zinsanteil angeben.",
  negative: "Tilgung und Zinsen dürfen nicht negativ sein.",
  disbursementSplit: "Eine Darlehensauszahlung hat keinen Zinsanteil.",
} as const;

export interface LoanSplitInput {
  /** Signed account movement (cents). */
  amountCents: number;
  /** Bank fee contained in the movement (BNK-023). */
  feeCents?: number;
  principalCents?: number;
  interestCents?: number;
}

export interface LoanSplit {
  direction: "disbursement" | "repayment";
  principalCents: number;
  interestCents: number;
}

const isInt = Number.isSafeInteger;

export function splitLoanPayment(input: LoanSplitInput): Result<LoanSplit, Issue<"loan_split">> {
  const fail = (m: string) => err(issue("loan_split", m));
  const fee = input.feeCents ?? 0;
  const { principalCents: p, interestCents: i } = input;
  if ((p !== undefined && (!isInt(p) || p < 0)) || (i !== undefined && (!isInt(i) || i < 0))) {
    return fail(LOAN_MESSAGES.negative);
  }
  if (input.amountCents > 0) {
    // Kreditaufnahme: the whole credit (plus a fee the bank kept) is the loan.
    if (i) return fail(LOAN_MESSAGES.disbursementSplit);
    return ok({ direction: "disbursement", principalCents: input.amountCents + fee, interestCents: 0 });
  }
  const paid = -input.amountCents - fee;
  if (p === undefined && i === undefined) return fail(LOAN_MESSAGES.splitRequired);
  if (p !== undefined && p > paid) return fail(LOAN_MESSAGES.principalExceeds);
  if (i !== undefined && i > paid) return fail(LOAN_MESSAGES.interestExceeds);
  const principal = p ?? paid - (i as number);
  const interest = i ?? paid - principal;
  if (principal + interest !== paid) return fail(LOAN_MESSAGES.splitMismatch);
  return ok({ direction: "repayment", principalCents: principal, interestCents: interest });
}
