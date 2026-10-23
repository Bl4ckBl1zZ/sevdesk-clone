import { describe, expect, test } from "vitest";
import { LOAN_ACCOUNT_DEFAULTS } from "../rules/accounting/loan-accounts";
import { LOAN_MESSAGES, splitLoanPayment } from "./loan";

describe("BNK-062 Darlehen: disbursement and repayment split", () => {
  test("BNK-062 T07-092 a repayment is split into principal and interest from either part; a disbursement is all loan", () => {
    expect(splitLoanPayment({ amountCents: -55_000, principalCents: 50_000 })).toEqual({
      ok: true,
      value: { direction: "repayment", principalCents: 50_000, interestCents: 5_000 },
    });
    expect(splitLoanPayment({ amountCents: -55_000, interestCents: 5_000 })).toMatchObject({
      ok: true,
      value: { principalCents: 50_000, interestCents: 5_000 },
    });
    // A fee in the row is a bank fee, not part of the loan.
    expect(splitLoanPayment({ amountCents: -55_100, feeCents: 100, principalCents: 50_000 })).toMatchObject({
      ok: true,
      value: { principalCents: 50_000, interestCents: 5_000 },
    });
    expect(splitLoanPayment({ amountCents: 1_000_000 })).toEqual({
      ok: true,
      value: { direction: "disbursement", principalCents: 1_000_000, interestCents: 0 },
    });
    expect(LOAN_ACCOUNT_DEFAULTS.SKR03).toEqual({ loan: "0630", interest: "2100" });
    expect(LOAN_ACCOUNT_DEFAULTS.SKR04).toEqual({ loan: "3150", interest: "7300" });
  });

  test("EC-BNK-75 T07-092 a principal above the payment is blocked; inconsistent or missing parts too", () => {
    const msg = (r: ReturnType<typeof splitLoanPayment>) => (r.ok ? null : r.error.message);
    expect(msg(splitLoanPayment({ amountCents: -55_000, principalCents: 55_001 }))).toBe(
      "Der Tilgungsanteil übersteigt den Zahlbetrag.",
    );
    expect(msg(splitLoanPayment({ amountCents: -55_100, feeCents: 100, principalCents: 55_050 }))).toBe(
      LOAN_MESSAGES.principalExceeds,
    );
    expect(msg(splitLoanPayment({ amountCents: -55_000, principalCents: 50_000, interestCents: 4_000 }))).toBe(
      LOAN_MESSAGES.splitMismatch,
    );
    expect(msg(splitLoanPayment({ amountCents: -55_000 }))).toBe(LOAN_MESSAGES.splitRequired);
    expect(msg(splitLoanPayment({ amountCents: -55_000, principalCents: -1 }))).toBe(LOAN_MESSAGES.negative);
    expect(msg(splitLoanPayment({ amountCents: 10_000, interestCents: 100 }))).toBe(LOAN_MESSAGES.disbursementSplit);
  });
});
