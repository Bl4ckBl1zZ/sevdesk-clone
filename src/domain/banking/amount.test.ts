import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { currencyExponent, formatMinor, parseBankAmount } from "./amount";

describe("bank amounts (BNK-021)", () => {
  test("T07-021 EC-BNK-23 decimal strings become integer minor units without floating point", () => {
    expect(parseBankAmount("-47.8", "EUR")).toEqual({ ok: true, value: -4780 });
    expect(parseBankAmount("0.30", "EUR")).toEqual({ ok: true, value: 30 });
    expect(parseBankAmount("1234.56", "EUR")).toEqual({ ok: true, value: 123456 });
    expect(parseBankAmount("+12", "USD")).toEqual({ ok: true, value: 1200 });
  });

  test("T07-021 EC-BNK-24 JPY has exponent 0 and KWD exponent 3 (ISO 4217)", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("EUR")).toBe(2);
    expect(parseBankAmount("1500", "JPY")).toEqual({ ok: true, value: 1500 });
    expect(parseBankAmount("1.250", "KWD")).toEqual({ ok: true, value: 1250 });
  });

  test("T07-021 MT940 amounts use the decimal comma", () => {
    expect(parseBankAmount("1234,56", "EUR", { decimalSeparator: "," })).toEqual({ ok: true, value: 123456 });
    expect(parseBankAmount("12,", "EUR", { decimalSeparator: "," })).toEqual({ ok: true, value: 1200 });
  });

  test("T07-021 EC-BNK-23 more decimals than the currency exponent are rejected with the German message", () => {
    const r = parseBankAmount("10.005", "EUR");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe("Ungültiger Betrag in Bankdaten (10.005).");
    expect(parseBankAmount("1.5", "JPY").ok).toBe(false);
    expect(parseBankAmount("abc", "EUR").ok).toBe(false);
    expect(parseBankAmount("1e3", "EUR").ok).toBe(false);
    expect(parseBankAmount("", "EUR").ok).toBe(false);
  });

  test("BNK-021 property: formatting and parsing minor units round-trips for every exponent", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), fc.constantFrom("EUR", "JPY", "KWD"), (minor, ccy) => {
        expect(parseBankAmount(formatMinor(minor, ccy), ccy)).toEqual({ ok: true, value: minor });
      }),
    );
  });
});
