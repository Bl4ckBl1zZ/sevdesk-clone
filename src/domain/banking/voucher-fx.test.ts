import { describe, expect, test } from "vitest";
import { voucherFxDifference } from "./voucher-fx";

const base = {
  voucherCurrency: "USD",
  billGrossMinor: 11_900,
  openEurCents: 10_000,
  unpaid: true,
  paidEurCents: 10_250,
  instructed: { amountMinor: 11_900, currency: "USD" },
};

describe("voucherFxDifference (EC-BNK-76, PAY-018 mirrored)", () => {
  test("EC-BNK-76 paid more EUR than the voucher's EUR value → realised FX loss for the difference", () => {
    expect(voucherFxDifference(base)).toEqual({ amountCents: -250, role: "expense.fx_loss" });
  });

  test("EC-BNK-76 paid less EUR → realised FX gain", () => {
    expect(voucherFxDifference({ ...base, paidEurCents: 9_900 })).toEqual({ amountCents: 100, role: "income.fx_gain" });
  });

  test("EC-BNK-76 no difference, EUR voucher, other bill amount or a partly paid voucher → none", () => {
    expect(voucherFxDifference({ ...base, paidEurCents: 10_000 })).toBeNull();
    expect(voucherFxDifference({ ...base, voucherCurrency: "EUR" })).toBeNull();
    expect(voucherFxDifference({ ...base, instructed: { amountMinor: 11_800, currency: "USD" } })).toBeNull();
    expect(voucherFxDifference({ ...base, instructed: { amountMinor: 11_900, currency: "GBP" } })).toBeNull();
    expect(voucherFxDifference({ ...base, unpaid: false })).toBeNull();
    const { instructed: _, ...noInstructed } = base;
    expect(voucherFxDifference(noInstructed)).toBeNull();
  });
});
