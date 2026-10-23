import { describe, expect, test } from "vitest";
import { ReceiptExtraction } from "../schemas/receipt-extraction";
import { parseOcrDecimal, postValidateExtraction, searchableText } from "./ocr";

const TODAY = "2026-10-19";

function extraction(over: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return ReceiptExtraction.parse({
    documentType: "invoice",
    supplier: { name: "Hosting AG", address: null, vatId: null, taxNumber: null, iban: null, email: null },
    buyerName: null,
    invoiceNumber: null,
    invoiceDate: "2026-10-01",
    supplyDate: null,
    supplyPeriod: null,
    dueDate: null,
    currency: "EUR",
    totals: { net: null, vat: null, gross: "119.00" },
    vatLines: [],
    lineItems: [],
    skonto: null,
    paymentHint: "unknown",
    hospitality: { isRestaurant: false, tip: null, tseDataPresent: false },
    categoryHint: null,
    fieldConfidence: { "supplier.name": 0.98, invoiceDate: 0.97, "totals.gross": 0.99 },
    ...over,
  });
}
const assess = (over: Partial<ReceiptExtraction> = {}) => postValidateExtraction(extraction(over), { today: TODAY });

describe("OCR post-validation — parsing (INB-025)", () => {
  test("INB-025 empty values, rates out of range and a lone dot as decimal point", () => {
    expect(parseOcrDecimal(null, 2)).toBeNull();
    expect(parseOcrDecimal("  € ", 2)).toBeNull();
    expect(parseOcrDecimal("1,234.56", 2)).toBe(123456n);
    const r = assess({ vatLines: [{ ratePercent: "120", net: "100.00", vat: "19.00" }] });
    expect(r.issues.map((i) => i.field)).toContain("vatLines.0");
  });
});

describe("OCR post-validation — supplier and header (INB-026)", () => {
  test("INB-026 a tax number is kept; a foreign VAT ID in an unknown format is kept as printed", () => {
    const r = assess({
      supplier: {
        name: "Cloud Inc.",
        address: null,
        vatId: "us 12-3456789",
        taxNumber: "12/345/67890",
        iban: null,
        email: null,
      },
    });
    expect(r.prefill).toMatchObject({ supplierTaxNumber: "12/345/67890", supplierVatId: "US123456789" });
    expect(r.highlighted).not.toContain("supplier.vatId");
  });

  test("INB-026 the invoice number is kept; an invalid invoice date is highlighted, a missing one only by confidence", () => {
    const r = assess({ invoiceNumber: "  INV-1  ", invoiceDate: "2026-13-01" });
    expect(r.prefill.documentNumber).toBe("INV-1");
    expect(r.prefill).not.toHaveProperty("documentDate");
    expect(r.highlighted).toContain("invoiceDate");
    expect(r.confidence).toBe(0);
  });

  test("INB-026 supply period vs. date: an inverted period falls back to the supply date and is highlighted", () => {
    const inverted = assess({ supplyPeriod: { from: "2026-09-30", to: "2026-09-01" }, supplyDate: "2026-09-15" });
    expect(inverted.prefill.supplyDate).toEqual({ kind: "date", date: "2026-09-15" });
    expect(inverted.highlighted).toContain("supplyPeriod");
    const badDate = assess({ supplyDate: "2027-05-01" });
    expect(badDate.prefill).not.toHaveProperty("supplyDate");
    expect(badDate.highlighted).toContain("supplyDate");
    const partial = assess({ supplyPeriod: { from: "2026-09-01", to: "" } });
    expect(partial.prefill).not.toHaveProperty("supplyDate");
    expect(partial.highlighted).toContain("supplyPeriod");
  });

  test("INB-026 due dates are not bounded (far future is fine) but must parse; the currency must be an ISO code", () => {
    expect(assess({ dueDate: "2030-01-31" }).prefill.dueDate).toBe("2030-01-31");
    const bad = assess({ dueDate: "31.01.2030", currency: "eur" });
    expect(bad.prefill).not.toHaveProperty("dueDate");
    expect(bad.prefill).not.toHaveProperty("currency");
    expect(bad.highlighted).toContain("dueDate");
  });
});

describe("OCR post-validation — amounts (INB-026, EC-INB-18)", () => {
  test("EC-INB-18 an unreadable gross amount is an issue and caps the confidence", () => {
    const r = assess({ totals: { net: null, vat: null, gross: "viel" } });
    expect(r.issues.map((i) => i.code)).toEqual(["ocr_amount_invalid", "ocr_arithmetic"]);
    expect(r.arithmeticOk).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.prefill).not.toHaveProperty("statedTotals");
    expect(r.prefill).not.toHaveProperty("lines");
  });

  test("EC-INB-18 stated net/VAT totals must match the VAT breakdown", () => {
    const r = assess({
      totals: { net: "90.00", vat: "20.00", gross: "119.00" },
      vatLines: [{ ratePercent: "19", net: "100.00", vat: "19.00" }],
    });
    expect(r.highlighted).toEqual(expect.arrayContaining(["totals.net", "totals.vat"]));
    expect(r.arithmeticOk).toBe(false);
  });

  test("EC-INB-18 without breakdown, net + VAT must give the gross (a tip may come on top)", () => {
    expect(assess({ totals: { net: "100.00", vat: "19.00", gross: "120.00" } }).arithmeticOk).toBe(false);
    const tip = assess({
      totals: { net: "100.00", vat: "19.00", gross: "124.00" },
      hospitality: { isRestaurant: true, tip: "5.00", tseDataPresent: true },
    });
    expect(tip.arithmeticOk).toBe(true);
    expect(tip.isRestaurant).toBe(true);
    expect(assess({ totals: { net: "100.00", vat: null, gross: "120.00" } }).arithmeticOk).toBe(true);
  });

  test("INB-026 without breakdown and with mixed or unreadable item rates no draft line is guessed", () => {
    const mixed = assess({
      lineItems: [
        { description: "A", quantity: "1", net: null, gross: "100.00", ratePercent: "19" },
        { description: "B", quantity: "1", net: null, gross: "19.00", ratePercent: "7" },
      ],
    });
    expect(mixed.prefill.priceMode).toBe("gross");
    expect(mixed.prefill).not.toHaveProperty("lines");
    const unreadable = assess({
      lineItems: [{ description: "A", quantity: "1", net: null, gross: "119.00", ratePercent: "neunzehn" }],
    });
    expect(unreadable.prefill).not.toHaveProperty("lines");
  });

  test("INB-026 line descriptions longer than 200 characters are cut; items without description are left out", () => {
    const long = "Sehr lange Positionsbeschreibung ".repeat(8);
    const r = assess({
      vatLines: [{ ratePercent: "19", net: "100.00", vat: "19.00" }],
      lineItems: [
        { description: long, quantity: "1", net: "100.00", gross: "119.00", ratePercent: "19" },
        { description: "  ", quantity: "1", net: null, gross: null, ratePercent: null },
      ],
    });
    const d = r.prefill.lines?.[0]?.description ?? "";
    expect(d).toHaveLength(200);
    expect(d.endsWith("…")).toBe(true);
    const none = assess({ vatLines: [{ ratePercent: "19", net: "100.00", vat: "19.00" }] });
    expect(none.prefill.lines?.[0]).not.toHaveProperty("description");
  });

  test("INB-026 Skonto terms need a readable percentage and non-negative days", () => {
    expect(assess({ skonto: { percent: "2", days: 10 } }).prefill.skontoTerms).toEqual({ percentBp: 200, days: 10 });
    expect(assess({ skonto: { percent: "zwei", days: 10 } }).prefill).not.toHaveProperty("skontoTerms");
  });

  test("INB-026 any field below 0.9 confidence is highlighted, also non-required ones", () => {
    const r = assess({
      fieldConfidence: { "supplier.name": 0.98, invoiceDate: 0.97, "totals.gross": 0.99, dueDate: 0.4 },
    });
    expect(r.highlighted).toEqual(["dueDate"]);
    expect(r.confidence).toBe(0.97);
  });
});

describe("OCR searchable text (INB-029)", () => {
  test("INB-029 without a gross amount the „Brutto“ line is left out", () => {
    const text = searchableText(extraction({ totals: { net: null, vat: null, gross: "" } }));
    expect(text).not.toContain("Brutto");
    expect(text).toContain("Lieferant: Hosting AG");
  });
});
