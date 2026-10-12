import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { formatBasisPoints, formatCents, formatEuro, formatMicros, formatMilli } from "./format";
import { parseBasisPoints, parseCents, parseDecimal, parseMicros, parseMilli } from "./parse";
import { MAX_AMOUNT_CENTS, MAX_QUANTITY_MILLI, MAX_UNIT_PRICE_MICROS } from "./units";

const okValue = <T>(r: { ok: true; value: T } | { ok: false }) => (r.ok ? r.value : undefined);
const errCode = (r: { ok: true } | { ok: false; error: { code: string } }) => (r.ok ? undefined : r.error.code);

describe("German money input (de-DE)", () => {
  test("GOBD-03 parses German amounts into integer cents", () => {
    expect(okValue(parseCents("1.234,56"))).toBe(123456);
    expect(okValue(parseCents("1234,56"))).toBe(123456);
    expect(okValue(parseCents("1234"))).toBe(123400);
    expect(okValue(parseCents("0,5"))).toBe(50);
    expect(okValue(parseCents("-12,30"))).toBe(-1230);
    expect(okValue(parseCents("−12,30"))).toBe(-1230); // U+2212 minus sign
    expect(okValue(parseCents("+7"))).toBe(700);
    expect(okValue(parseCents("  1.000.000,00 € "))).toBe(100_000_000);
    expect(okValue(parseCents("€ 6,29"))).toBe(629);
    expect(okValue(parseCents("6,29 €"))).toBe(629);
    expect(okValue(parseCents("99.999.999.999,99"))).toBe(MAX_AMOUNT_CENTS);
  });

  test("GOBD-03 rejects malformed input, excess precision and amounts above 99.999.999.999,99", () => {
    expect(errCode(parseCents(""))).toBe("amount_invalid");
    expect(errCode(parseCents("   "))).toBe("amount_invalid");
    expect(errCode(parseCents("abc"))).toBe("amount_invalid");
    expect(errCode(parseCents("1.23"))).toBe("amount_invalid"); // not a valid German grouping
    expect(errCode(parseCents("1.2345,00"))).toBe("amount_invalid");
    expect(errCode(parseCents("12,"))).toBe("amount_invalid");
    expect(errCode(parseCents(",5"))).toBe("amount_invalid");
    expect(errCode(parseCents("1,2,3"))).toBe("amount_invalid");
    expect(errCode(parseCents("--1"))).toBe("amount_invalid");
    expect(errCode(parseCents("1e5"))).toBe("amount_invalid");
    expect(errCode(parseCents("NaN"))).toBe("amount_invalid");
    expect(errCode(parseCents("Infinity"))).toBe("amount_invalid");
    expect(errCode(parseCents("1,234"))).toBe("amount_precision");
    expect(errCode(parseCents("100.000.000.000,00"))).toBe("amount_too_large");
    expect(errCode(parseCents("-100.000.000.000,00"))).toBe("amount_too_large");
    const r = parseCents("1,234");
    expect(r.ok ? "" : r.error.message).toMatch(/Nachkommastellen/);
  });

  test("PRD-014 unit prices parse with up to 4 decimals into micros; more decimals are rejected", () => {
    expect(okValue(parseMicros("10,005"))).toBe(100_050);
    expect(okValue(parseMicros("19,99"))).toBe(199_900);
    expect(okValue(parseMicros("-0,0001"))).toBe(-1);
    expect(okValue(parseMicros("99.999.999,9999"))).toBe(MAX_UNIT_PRICE_MICROS);
    expect(errCode(parseMicros("1,00001"))).toBe("amount_precision");
    expect(errCode(parseMicros("100.000.000,0000"))).toBe("amount_too_large");
  });

  test("DOC-09 quantities parse with up to 3 decimals into milli; percentages into basis points", () => {
    expect(okValue(parseMilli("2,5"))).toBe(2500);
    expect(okValue(parseMilli("999.999.999,999"))).toBe(MAX_QUANTITY_MILLI);
    expect(errCode(parseMilli("1,0005"))).toBe("amount_precision");
    expect(okValue(parseBasisPoints("19"))).toBe(1900);
    expect(okValue(parseBasisPoints("2,5"))).toBe(250);
    expect(okValue(parseBasisPoints("19,00 %"))).toBe(1900);
    expect(errCode(parseBasisPoints("2,555"))).toBe("amount_precision");
  });

  test("BNK-021 machine decimals (CAMT/feed strings) parse per ISO 4217 exponent without floats", () => {
    const camt = { decimalSeparator: "." as const, grouping: false, currencySymbol: false };
    expect(okValue(parseDecimal("1234.56", { ...camt, scale: 2 }))).toBe(123456n);
    expect(okValue(parseDecimal("-0.10", { ...camt, scale: 2 }))).toBe(-10n);
    expect(okValue(parseDecimal("1500", { ...camt, scale: 0 }))).toBe(1500n); // JPY
    expect(okValue(parseDecimal("12.345", { ...camt, scale: 3 }))).toBe(12345n); // KWD
    expect(errCode(parseDecimal("12.345", { ...camt, scale: 2 }))).toBe("amount_precision");
    expect(errCode(parseDecimal("1,234.56", { ...camt, scale: 2 }))).toBe("amount_invalid");
    expect(errCode(parseDecimal("1.234,56 €", { ...camt, scale: 2 }))).toBe("amount_invalid");
    // international grouping on request
    expect(okValue(parseDecimal("1,234.56", { decimalSeparator: ".", scale: 2 }))).toBe(123456n);
    // 0.1 + 0.2 style float traps cannot occur: exact digits are kept
    expect(okValue(parseDecimal("0.30", { ...camt, scale: 2 }))).toBe(30n);
    expect(okValue(parseDecimal("123456789012345678.99", { ...camt, scale: 2 }))).toBe(12345678901234567899n);
  });
});

describe("de-DE formatting", () => {
  test("GOBD-03 formats cents, euros, micros, milli and basis points in German notation", () => {
    expect(formatCents(123456)).toBe("1.234,56");
    expect(formatCents(-5)).toBe("-0,05");
    expect(formatCents(0)).toBe("0,00");
    expect(formatCents(MAX_AMOUNT_CENTS)).toBe("99.999.999.999,99");
    expect(formatEuro(629)).toBe("6,29 €");
    expect(formatEuro(-123456)).toBe("-1.234,56 €");
    expect(formatMicros(100_050)).toBe("10,005");
    expect(formatMicros(168_000)).toBe("16,80");
    expect(formatMicros(1)).toBe("0,0001");
    expect(formatMilli(2500)).toBe("2,5");
    expect(formatMilli(3000)).toBe("3");
    expect(formatMilli(1_234_567)).toBe("1.234,567");
    expect(formatBasisPoints(1900)).toBe("19");
    expect(formatBasisPoints(250)).toBe("2,5");
    expect(formatBasisPoints(-88)).toBe("-0,88");
  });

  test("GOBD-03 parse ∘ format is the identity for cents, euros, micros and milli", () => {
    fc.assert(
      fc.property(fc.integer({ min: -MAX_AMOUNT_CENTS, max: MAX_AMOUNT_CENTS }), (c) => {
        expect(okValue(parseCents(formatCents(c)))).toBe(c);
        expect(okValue(parseCents(formatEuro(c)))).toBe(c);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: -MAX_UNIT_PRICE_MICROS, max: MAX_UNIT_PRICE_MICROS }), (m) => {
        expect(okValue(parseMicros(formatMicros(m)))).toBe(m);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: -MAX_QUANTITY_MILLI, max: MAX_QUANTITY_MILLI }), (q) => {
        expect(okValue(parseMilli(formatMilli(q)))).toBe(q);
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (bp) => {
        expect(okValue(parseBasisPoints(formatBasisPoints(bp)))).toBe(bp);
      }),
    );
  });

  test("GOBD-03 formatting rejects non-integer input instead of rounding silently", () => {
    expect(() => formatCents(1.5)).toThrow(/amount_invalid/);
    expect(() => formatMicros(Number.NaN)).toThrow(/amount_invalid/);
  });
});
