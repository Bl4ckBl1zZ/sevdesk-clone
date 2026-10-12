import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  basisPoints,
  cents,
  MAX_AMOUNT_CENTS,
  MAX_QUANTITY_MILLI,
  MAX_UNIT_PRICE_MICROS,
  MoneyError,
  micros,
  milli,
  toCents,
} from "./units";

describe("branded integer units (02 §5)", () => {
  test("GOBD-03 cents accepts safe integers up to 99.999.999.999,99 and rejects floats, NaN and overflow", () => {
    expect(cents(0)).toBe(0);
    expect(cents(-123)).toBe(-123);
    expect(cents(MAX_AMOUNT_CENTS)).toBe(9_999_999_999_999);
    expect(cents(-MAX_AMOUNT_CENTS)).toBe(-9_999_999_999_999);
    expect(() => cents(MAX_AMOUNT_CENTS + 1)).toThrow(MoneyError);
    expect(() => cents(1.5)).toThrow(/amount_invalid/);
    expect(() => cents(Number.NaN)).toThrow(/amount_invalid/);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(/amount_invalid/);
    try {
      cents(MAX_AMOUNT_CENTS + 1);
    } catch (e) {
      expect(e).toBeInstanceOf(MoneyError);
      expect((e as MoneyError).code).toBe("amount_too_large");
    }
  });

  test("PRD-014 unit prices are 1/10,000 units within ±99.999.999,9999", () => {
    expect(micros(MAX_UNIT_PRICE_MICROS)).toBe(999_999_999_999);
    expect(micros(-MAX_UNIT_PRICE_MICROS)).toBe(-999_999_999_999);
    expect(() => micros(MAX_UNIT_PRICE_MICROS + 1)).toThrow(/amount_too_large/);
    expect(() => micros(0.1)).toThrow(/amount_invalid/);
  });

  test("DOC-09 quantities are thousandths within ±999.999.999,999 and basis points are integers", () => {
    expect(milli(MAX_QUANTITY_MILLI)).toBe(999_999_999_999);
    expect(() => milli(MAX_QUANTITY_MILLI + 1)).toThrow(/amount_too_large/);
    expect(() => milli(2.5)).toThrow(/amount_invalid/);
    expect(basisPoints(1900)).toBe(1900);
    expect(basisPoints(-88)).toBe(-88);
    expect(() => basisPoints(19.5)).toThrow(/amount_invalid/);
  });

  test("GOBD-03 toCents converts exact BigInt results and refuses values beyond the amount limit", () => {
    expect(toCents(123n)).toBe(123);
    expect(toCents(-9_999_999_999_999n)).toBe(-9_999_999_999_999);
    expect(() => toCents(10_000_000_000_000n)).toThrow(/amount_too_large/);
    fc.assert(
      fc.property(fc.bigInt({ min: -9_999_999_999_999n, max: 9_999_999_999_999n }), (v) => {
        expect(BigInt(toCents(v))).toBe(v);
      }),
    );
  });
});
