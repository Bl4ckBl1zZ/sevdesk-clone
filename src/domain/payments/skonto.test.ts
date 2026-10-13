import { describe, expect, test } from "vitest";
import { evaluateSkonto, splitReceipt } from "./skonto";

const terms = { percentBp: 200, deadline: "2026-10-23", agreedCents: 2380 };

describe("Skonto eligibility by date and amount (PAY-021, PAY-022, EC-122)", () => {
  test("PAY-021 within the period and up to the agreed amount + 1 cent → Skonto", () => {
    expect(evaluateSkonto({ terms, paymentDate: "2026-10-23", shortfallCents: 2380 })).toEqual({ eligible: true });
    expect(evaluateSkonto({ terms, paymentDate: "2026-10-10", shortfallCents: 2381 })).toEqual({ eligible: true });
    expect(evaluateSkonto({ terms, paymentDate: "2026-10-10", shortfallCents: 1000 })).toEqual({ eligible: true });
  });

  test("T05-034 EC-PAY-09 EC-122 after the deadline or above the agreed rate → never Skonto, exact message", () => {
    const late = evaluateSkonto({ terms, paymentDate: "2026-10-24", shortfallCents: 2380 });
    expect(late).toMatchObject({ eligible: false, reason: "late" });
    if (!late.eligible)
      expect(late.message).toBe(
        "Skonto-Frist überschritten (Zahlung am 24.10.2026, Frist bis 23.10.2026) bzw. Abzug höher als vereinbart (23,80 € statt 23,80 €). Der Restbetrag bleibt offen – oder als Kulanz-Preisminderung mit Begründung buchen.",
      );
    expect(evaluateSkonto({ terms, paymentDate: "2026-10-10", shortfallCents: 2382 })).toMatchObject({
      eligible: false,
      reason: "above",
    });
  });

  test("T05-035 EC-PAY-11 no Skonto terms → rejected", () => {
    expect(evaluateSkonto({ terms: null, paymentDate: "2026-10-10", shortfallCents: 100 })).toEqual({
      eligible: false,
      reason: "no_terms",
      message: "Für diese Rechnung wurde kein Skonto vereinbart. Bitte ‚Sonstige Preisminderung‘ wählen.",
    });
  });
});

describe("allocation order of a receipt (PAY-024, DUN-027, EC-PAY-20/21)", () => {
  test("T05-039a EC-PAY-21 principal first (default): 517,00 on 1.000,00 open with 5 + 12 claimed → all principal", () => {
    expect(
      splitReceipt({
        cashCents: 51700,
        principalOpenCents: 100000,
        claimedFeesCents: 500,
        claimedInterestCents: 1200,
        order: "principal_first",
      }),
    ).toEqual({ principalCents: 51700, feesCents: 0, interestCents: 0, excessCents: 0 });
  });

  test("T05-039 EC-PAY-20 the reminder total paid: excess offered as fees then interest, the rest is excess", () => {
    expect(
      splitReceipt({
        cashCents: 102000,
        principalOpenCents: 100000,
        claimedFeesCents: 500,
        claimedInterestCents: 1200,
        order: "principal_first",
      }),
    ).toEqual({ principalCents: 100000, feesCents: 500, interestCents: 1200, excessCents: 300 });
  });

  test("DUN-027 § 367 BGB option: costs → interest → principal", () => {
    expect(
      splitReceipt({
        cashCents: 51700,
        principalOpenCents: 100000,
        claimedFeesCents: 500,
        claimedInterestCents: 1200,
        order: "bgb_367",
      }),
    ).toEqual({ principalCents: 50000, feesCents: 500, interestCents: 1200, excessCents: 0 });
  });
});
