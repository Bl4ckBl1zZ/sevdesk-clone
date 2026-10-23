import { describe, expect, test } from "vitest";
import type { DraftValues } from "../documents";
import { type DraftDefaults, documentFieldMapper, lineToDraft, type WireIssue, wireToDraft } from "./documents";

/**
 * 05 §4.3 / F04 §7.1: wire lines and bodies of sales documents → the shared draft body (create, and PATCH merged onto
 * the current values). Decimal strings become integer milli/micros/basis points; "" clears a text field on PATCH.
 */

const RAW = "k57f3x2m9q8w1e4r6t";
const defaults: DraftDefaults = {
  currency: "EUR",
  language: "de",
  priceMode: "net",
  paymentTerms: { dueDays: 14 },
};

describe("document lines on the wire (05 §4.3)", () => {
  test("DOC-07 a free item gets C62/standard/service defaults; discount, labour cost and optional are mapped", () => {
    const issues: WireIssue[] = [];
    const line = lineToDraft(
      {
        kind: "item",
        name: "Dachrinne erneuern",
        description: "inkl. Material",
        quantity: "2.5",
        unit_price: "120.1234",
        discount_percent: "7.5",
        line_period: { from: "2026-10-01", to: "2026-10-31" },
        optional: true,
        is_labor_cost: true,
      } as never,
      0,
      issues,
    );
    expect(issues).toEqual([]);
    expect(line).toEqual({
      kind: "item",
      name: "Dachrinne erneuern",
      description: "inkl. Material",
      quantityMilli: 2_500,
      unitCode: "C62",
      unitPriceMicros: 1_201_234,
      discount: { kind: "percent", valueBp: 750 },
      vatRateKey: "standard",
      productType: "service",
      linePeriod: { from: "2026-10-01", to: "2026-10-31" },
      optional: true,
      isLaborCost: true,
    });
  });

  test("DOC-05 a product line leaves unit, tax key and type to the product; a 0 % discount is no discount", () => {
    const issues: WireIssue[] = [];
    const line = lineToDraft(
      { kind: "item", product_id: `prd_${RAW}`, quantity: "3", discount_percent: "0", name: "" } as never,
      2,
      issues,
    );
    expect(line).toEqual({ kind: "item", productId: RAW, quantityMilli: 3_000 });
    const bad = lineToDraft({ kind: "item", product_id: `con_${RAW}` } as never, 4, issues);
    expect(issues).toEqual([{ field: "lines[4].product_id", message: "Unbekannte Produkt-ID." }]);
    expect(bad).toEqual({ kind: "item" });
    expect(lineToDraft({ kind: "text", description: "Vielen Dank" } as never, 0, [])).toEqual({
      kind: "text",
      description: "Vielen Dank",
    });
  });
});

describe("document bodies on the wire (05 §4.3)", () => {
  const lines = [{ kind: "item", name: "Beratung" }] as unknown as DraftValues["lines"];

  test("DOC-03 DOC-12 a create maps supply „same as document date“, Skonto terms, texts and the tax-case override", () => {
    const { values, issues } = wireToDraft(
      {
        contact_id: `con_${RAW}`,
        supply_date: "same_as_document_date",
        payment_terms: { due_days: 30, skonto_percent: "2.5", skonto_days: 10 },
        document_date: "2026-10-12",
        subject: "Angebot Dach",
        head_text: "Sehr geehrte Damen und Herren,",
        foot_text: "Mit freundlichen Grüßen",
        buyer_reference: "04011000-12345-67",
        order_reference: "PO-9",
        contract_reference: "V-1",
        delivery_terms: "frei Baustelle",
        internal_note: "Dringend",
        currency: "CHF",
        price_mode: "gross",
        language: "en",
        tax_case_override: { tax_case: "reverse_charge_13b", reason: "Bauleistung an Bauleistenden" },
        lines,
      } as never,
      "quote",
      defaults,
    );
    expect(issues).toEqual([]);
    expect(values).toMatchObject({
      type: "quote",
      contactId: RAW,
      supplyDateMode: "document_date",
      paymentTerms: { dueDays: 30, skontoPercentBp: 250, skontoDays: 10 },
      documentDate: "2026-10-12",
      subject: "Angebot Dach",
      headText: "Sehr geehrte Damen und Herren,",
      footText: "Mit freundlichen Grüßen",
      buyerReference: "04011000-12345-67",
      orderReference: "PO-9",
      contractReference: "V-1",
      deliveryTerms: "frei Baustelle",
      internalNote: "Dringend",
      currency: "CHF",
      priceMode: "gross",
      language: "en",
      showEpcQr: true,
      taxCaseOverride: { taxCase: "reverse_charge_13b", reason: "Bauleistung an Bauleistenden" },
    });
    expect(values.supplyDate).toBeUndefined();
  });

  test('API-015 a PATCH keeps the stored values, "" clears a text and a foreign contact ID is an issue', () => {
    const base = {
      type: "invoice",
      contactId: RAW,
      supplyDateMode: "explicit",
      supplyDate: { kind: "date", date: "2026-10-09" },
      currency: "EUR",
      priceMode: "net",
      language: "de",
      paymentTerms: { dueDays: 21, skontoPercentBp: 200, skontoDays: 7 },
      showEpcQr: false,
      subject: "Alt",
      internalNote: "bleibt",
      lines,
    } as unknown as DraftValues;
    const { values, issues } = wireToDraft(
      { subject: "", contact_id: `prd_${RAW}`, lines } as never,
      "invoice",
      defaults,
      base,
    );
    expect(issues).toEqual([{ field: "contact_id", message: "Unbekannte Kontakt-ID." }]);
    expect(values).toMatchObject({
      contactId: RAW,
      supplyDateMode: "explicit",
      supplyDate: { kind: "date", date: "2026-10-09" },
      paymentTerms: { dueDays: 21, skontoPercentBp: 200, skontoDays: 7 },
      showEpcQr: false,
      internalNote: "bleibt",
    });
    expect(values).not.toHaveProperty("subject"); // "" clears the stored subject
    const noBase = wireToDraft({ payment_terms: { due_days: 5 }, lines } as never, "invoice", defaults);
    expect(noBase.values).toMatchObject({ supplyDateMode: "explicit", paymentTerms: { dueDays: 5 } });
    expect(noBase.values.paymentTerms).toEqual({ dueDays: 5 });
  });

  test("API-009 finalisation finding paths map to wire fields; an empty path has none", () => {
    expect(documentFieldMapper(undefined)).toBeUndefined();
    expect(documentFieldMapper("values")).toBeUndefined();
    expect(documentFieldMapper("values.lines.0.discount.valueBp")).toBe("lines[0].discount_percent");
    expect(documentFieldMapper("paymentTerms.skontoPercentBp")).toBe("payment_terms.skonto_percent");
  });
});
