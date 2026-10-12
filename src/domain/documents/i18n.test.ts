import { describe, expect, test } from "vitest";
import { formatAmount, formatDate, formatNumber, formatQuantity, formatRate, formatUnitPrice } from "./i18n";
import { billableItems, isInvoiceType, monthBounds, supplyEnd } from "./snapshot";

describe("document formatting (DOC-16)", () => {
  test("DOC-16 German and English number, amount and date formats", () => {
    expect(formatAmount(119_000, "EUR", "de")).toBe("1.190,00 €");
    expect(formatAmount(-12_000, "EUR", "de")).toBe("-120,00 €");
    expect(formatAmount(100_000, "USD", "de")).toBe("1.000,00 USD");
    expect(formatAmount(119_000, "EUR", "en")).toBe("EUR 1,190.00");
    expect(formatAmount(-12_000, "EUR", "en")).toBe("-EUR 120.00");
    expect(formatDate("2026-11-11", "de")).toBe("11.11.2026");
    expect(formatDate("2026-11-01", "en")).toBe("1 Nov 2026");
    expect(formatNumber(1_234_567, 2, "en")).toBe("12,345.67");
    expect(formatRate(1900, "de")).toBe("19");
    expect(formatRate(250, "de")).toBe("2,5");
    expect(formatRate(250, "en")).toBe("2.5");
    expect(formatQuantity(12_500, "de")).toBe("12,5");
    expect(formatQuantity(10_000, "en")).toBe("10");
    expect(formatUnitPrice(100_050, "de")).toBe("10,005");
    expect(formatUnitPrice(1_000_000, "en")).toBe("100.00");
  });
});

describe("snapshot helpers", () => {
  test("DOC-21 supply end and month bounds (incl. leap years)", () => {
    expect(supplyEnd({ kind: "date", date: "2026-10-09" })).toBe("2026-10-09");
    expect(supplyEnd({ kind: "period", from: "2026-11-01", to: "2026-11-30" })).toBe("2026-11-30");
    expect(supplyEnd({ kind: "month", month: "2028-02" })).toBe("2028-02-29");
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  test("DOC-04 billable items exclude optional positions and text lines; invoice types", () => {
    const lines = [{ kind: "heading", text: "A" }, { kind: "item", optional: true }, { kind: "item" }] as never;
    expect(billableItems({ lines })).toHaveLength(1);
    expect(isInvoiceType("final_invoice")).toBe(true);
    expect(isInvoiceType("cancellation")).toBe(true);
    expect(isInvoiceType("proforma")).toBe(false);
    expect(isInvoiceType("reminder")).toBe(false);
  });
});
