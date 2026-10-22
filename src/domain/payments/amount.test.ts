import { describe, expect, test } from "vitest";
import { parsePaymentAmount } from "./amount";

const cents = (s: string) => {
  const r = parsePaymentAmount(s);
  return r.ok ? r.value.cents : r.error.code;
};

describe("payment amount input (04 §8)", () => {
  test("EC-PAY-38 GOBD-03 amounts parse per 04 §8; „1.234“ is 1.234,00 € shown back; more than 2 decimals are rejected", () => {
    expect(cents("1.234,56")).toBe(123_456);
    expect(cents("1234,56")).toBe(123_456);
    expect(cents("1234.56")).toBe(123_456); // one dot, ≤ 2 decimals = decimal point
    expect(cents("12.5")).toBe(1_250);
    expect(cents("1.190,00 €")).toBe(119_000);
    const ambiguous = parsePaymentAmount("1.234");
    expect(ambiguous.ok && ambiguous.value).toEqual({ cents: 123_400, interpretation: "1.234,00 €" });
    expect(parsePaymentAmount("1234,5").ok && parsePaymentAmount("1234,5")).toMatchObject({
      value: { cents: 123_450 },
    });
    for (const s of ["1,234", "1.234,567", "12.3456", "1234.567", "0,001"]) {
      const r = parsePaymentAmount(s);
      expect(r.ok ? null : r.error, s).toEqual({
        code: "amount_precision",
        message: "Bitte höchstens zwei Nachkommastellen angeben.",
      });
    }
    expect(cents("abc")).toBe("amount_invalid");
    expect(cents("1.2.3")).toBe("amount_invalid");
  });
});
