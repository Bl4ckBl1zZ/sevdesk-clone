import { describe, expect, test } from "vitest";
import { formatBasisPoints, formatCents, formatInteger, formatIsoDate, formatTimestamp } from "./format";

// Intl uses a no-break space (U+00A0) between amount and currency in de-DE.
const nbsp = (s: string) => s.replace(/ /g, " ");

describe("de-DE display formatting (04-ui-ux §8)", () => {
  test("SMOKE formats integer cents as 1.234,56 € without float arithmetic", () => {
    expect(formatCents(123456)).toBe(nbsp("1.234,56 €"));
    expect(formatCents(5)).toBe(nbsp("0,05 €"));
    expect(formatCents(0)).toBe(nbsp("0,00 €"));
    expect(formatCents(-119000)).toBe(nbsp("-1.190,00 €"));
    expect(formatCents(123456789012)).toBe(nbsp("1.234.567.890,12 €"));
  });

  test("SMOKE formats other currencies with the German layout", () => {
    expect(formatCents(100050, "USD")).toBe(nbsp("1.000,50 $"));
  });

  test("SMOKE rejects non-integer cents", () => {
    expect(() => formatCents(1.5)).toThrow(/integer/);
  });

  test("SMOKE business dates (YYYY-MM-DD) render as 12.10.2026 without a time-zone shift", () => {
    expect(formatIsoDate("2026-10-12")).toBe("12.10.2026");
    expect(formatIsoDate("2027-01-01")).toBe("01.01.2027");
    expect(() => formatIsoDate("12.10.2026")).toThrow();
  });

  test("SMOKE timestamps render in Europe/Berlin", () => {
    // 2026-12-31T23:30Z is already 1 January in Berlin (GOBD-22).
    expect(formatTimestamp(Date.UTC(2026, 11, 31, 23, 30))).toBe("01.01.2027");
    expect(formatTimestamp(Date.UTC(2026, 11, 31, 23, 30), { withTime: true })).toBe("01.01.2027, 00:30");
  });

  test("SMOKE integers and percentages", () => {
    expect(formatInteger(1234567)).toBe("1.234.567");
    expect(formatBasisPoints(1900)).toBe(nbsp("19 %"));
    expect(formatBasisPoints(250)).toBe(nbsp("2,5 %"));
    expect(formatBasisPoints(1234)).toBe(nbsp("12,34 %"));
    expect(formatBasisPoints(-27)).toBe(nbsp("-0,27 %"));
  });
});
