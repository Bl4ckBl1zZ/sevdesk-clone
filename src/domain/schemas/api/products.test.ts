import { describe, expect, test } from "vitest";
import { productFormFromRecord, productSchema } from "../products";
import { decimalToScaled, scaledToDecimal } from "./common";
import {
  type ProductWireRecord,
  productCreateToForm,
  productCreateWire,
  productFieldMapper,
  productOut,
  productPatchToForm,
  productPatchWire,
  serializeProduct,
} from "./products";

const RAW = "p57f3x2m9q8w1e4r6t";
const record: ProductWireRecord = {
  _id: RAW,
  _creationTime: Date.UTC(2026, 9, 1),
  number: "P-1",
  name: "Beratung",
  type: "service",
  unitCode: "HUR",
  priceMode: "net",
  unitPriceMicros: 950_000,
  vatRateKey: "standard",
  extraUnits: [{ unitCode: "DAY", factorMilli: 8000 }],
  tags: [],
  customFields: {},
  active: true,
  version: 2,
};

describe("products on the wire (05 §4.2, F03 §7.1)", () => {
  test("API-011 decimal strings convert exactly to integer micros/milli and back (no floats)", () => {
    expect(decimalToScaled("95.5", 4)).toBe(955_000);
    expect(decimalToScaled("0.0001", 4)).toBe(1);
    expect(decimalToScaled("1.23456", 4)).toBeNull();
    expect(decimalToScaled("1,5", 4)).toBeNull();
    expect(scaledToDecimal(955_000, 4)).toBe("95.5000");
    expect(scaledToDecimal(-5, 4)).toBe("-0.0005");
    expect(scaledToDecimal(8000, 3)).toBe("8.000");
  });

  test("API-018 a POST body maps onto the product form and parses to the same micros", () => {
    const body = productCreateWire.parse({
      name: "Workshop",
      unit_price: "1234.5",
      unit_code: "HUR",
      labor_cost_share_bp: 6000,
      extra_units: [{ unit_code: "DAY", factor: "7.5" }],
    });
    const form = productCreateToForm(body);
    expect(form).toMatchObject({ price: "1.234,50", laborCostShare: "60", extraUnits: [{ factor: "7,5" }] });
    const parsed = productSchema.parse(form);
    expect(parsed).toMatchObject({ unitPriceMicros: 12_345_000, laborCostShareBp: 6000 });
    expect(parsed.extraUnits[0]?.factorMilli).toBe(7500);
  });

  test("API-018 unit_price is required on create, and more than 4 decimals are refused", () => {
    expect(productCreateWire.safeParse({ name: "X" }).success).toBe(false);
    expect(productCreateWire.safeParse({ name: "X", unit_price: "1.23456" }).success).toBe(false);
    expect(productCreateWire.safeParse({ name: "X", unit_price: 12.5 }).success).toBe(false);
  });

  test("API-015 a PATCH changes only the given fields", () => {
    const patch = productPatchToForm(productPatchWire.parse({ unit_price: "99" }));
    expect(patch).toEqual({ price: "99,00" });
    const merged = productSchema.parse({ ...productFormFromRecord(record), ...patch });
    expect(merged.unitPriceMicros).toBe(990_000);
    expect(merged.name).toBe("Beratung");
  });

  test("API-009 form paths map to wire fields", () => {
    expect(productFieldMapper("price")).toBe("unit_price");
    expect(productFieldMapper("extraUnits.0.factor")).toBe("extra_units[0].factor");
    expect(productFieldMapper("laborCostShare")).toBe("labor_cost_share_bp");
  });

  test("API-011 a product serialises with the price block of today and decimal strings", () => {
    const out = serializeProduct(record, { netMicros: 950_000, grossMicros: 1_130_500, rateBp: 1900 });
    expect(productOut.parse(out)).toBeTruthy();
    expect(out).toMatchObject({
      id: `prd_${RAW}`,
      price: { mode: "net", unit_price: "95.0000", unit_price_micros: 950_000, gross_micros_today: 1_130_500 },
      extra_units: [{ unit_code: "DAY", factor: "8.000", factor_milli: 8000 }],
    });
  });
});
