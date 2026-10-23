import { describe, expect, test } from "vitest";
import { productSchema } from "../products";
import {
  type ProductWireRecord,
  productCreateToForm,
  productCreateWire,
  productFieldMapper,
  productPatchToForm,
  productPatchWire,
  serializeProduct,
} from "./products";

/** 05 §4.2 / F03 §7.1 PATCH /products/{id}: every writable wire field maps to its form field; null clears. */

const RAW = "p57f3x2m9q8w1e4r6t";
const CAT = "c1c1c1c1c1c1c1c1c1";

describe("PATCH /products wire → form (05 §4.2)", () => {
  test("API-015 PRD-001 PRD-010 every writable field maps onto the product form with German decimal input strings", () => {
    const form = productPatchToForm(
      productPatchWire.parse({
        number: "ART-00042",
        name: "Dachdeckerarbeiten",
        description: "Arbeitsstunde Geselle",
        internal_note: "nur Bestandskunden",
        type: "service",
        unit_code: "HUR",
        gtin: "4006381333931",
        price_mode: "gross",
        unit_price: "59.5",
        purchase_price: "30.1234",
        vat_rate_key: "standard",
        exemption_reason_code: "",
        place_of_supply_rule: "property",
        reverse_charge_13b: "construction",
        labor_cost_share_bp: 6_500,
        category_id: `pcat_${CAT}`,
        extra_units: [{ unit_code: "DAY", factor: "8" }],
        tags: [`tag_${RAW}`],
        custom_fields: { gewerk: "Dach" },
      }),
    );
    expect(form).toMatchObject({
      number: "ART-00042",
      name: "Dachdeckerarbeiten",
      description: "Arbeitsstunde Geselle",
      internalNote: "nur Bestandskunden",
      type: "service",
      unitCode: "HUR",
      gtin: "4006381333931",
      priceMode: "gross",
      price: "59,50",
      purchasePrice: "30,1234",
      vatRateKey: "standard",
      exemptionReasonCode: "",
      placeOfSupplyRule: "property",
      reverseCharge13b: "construction",
      laborCostShare: "65",
      extraUnits: [{ unitCode: "DAY", factor: "8" }],
      tags: [RAW],
      customFields: { gewerk: "Dach" },
    });
    expect(form.categoryId).toBe(CAT);
  });

  test("API-015 null clears the purchase price, the labour share and the category", () => {
    expect(
      productPatchToForm(
        productPatchWire.parse({ purchase_price: null, labor_cost_share_bp: null, category_id: null }),
      ),
    ).toEqual({ purchasePrice: "", laborCostShare: "", categoryId: "" });
    expect(productPatchToForm(productPatchWire.parse({}))).toEqual({});
  });

  test("PRD-001 a created good keeps its type; the vat key default applies only when the wire has none", () => {
    const form = productCreateToForm(productCreateWire.parse({ name: "Kabel", unit_price: "2.5", type: "good" }), {
      vatRateKey: "reduced",
    });
    expect(form).toMatchObject({ name: "Kabel", type: "good", price: "2,50", vatRateKey: "reduced" });
    expect(productSchema.safeParse(form).success).toBe(true);
  });

  test("API-009 an empty or values-only issue path has no wire field", () => {
    expect(productFieldMapper(undefined)).toBeUndefined();
    expect(productFieldMapper("values")).toBeUndefined();
    expect(productFieldMapper("values.extraUnits.0.factor")).toBe("extra_units[0].factor");
  });
});

describe("product serialisation (05 §4.2)", () => {
  const record: ProductWireRecord = {
    _id: RAW,
    _creationTime: Date.UTC(2026, 9, 1),
    number: "P-1",
    name: "Beratung",
    description: "Stundensatz",
    type: "service",
    unitCode: "HUR",
    priceMode: "net",
    unitPriceMicros: 950_000,
    purchasePriceMicros: 400_000,
    vatRateKey: "standard",
    laborCostShareBp: 10_000,
    categoryId: CAT,
    extraUnits: [],
    scheduledPrice: { validFrom: "2027-01-01", priceMode: "net", unitPriceMicros: 1_000_000 },
    tags: [],
    customFields: {},
    active: true,
    version: 2,
    updatedAt: Date.UTC(2026, 9, 5),
  };

  test("PRD-031 a scheduled price change, the purchase price and the category appear on the wire", () => {
    const out = serializeProduct(record, { netMicros: 950_000, grossMicros: 1_130_500, rateBp: 1_900 });
    expect(out).toMatchObject({
      description: "Stundensatz",
      purchase_price: "40.0000",
      labor_cost_share_bp: 10_000,
      category_id: `pcat_${CAT}`,
      scheduled_price: { valid_from: "2027-01-01", mode: "net", unit_price: "100.0000", unit_price_micros: 1_000_000 },
      updated_at: "2026-10-05T00:00:00.000Z",
    });
    const { scheduledPrice: _s, purchasePriceMicros: _p, updatedAt: _u, ...plain } = record;
    const bare = serializeProduct(plain as ProductWireRecord, { netMicros: 1, grossMicros: 1, rateBp: 0 });
    expect(bare).toMatchObject({ scheduled_price: null, purchase_price: null, updated_at: "2026-10-01T00:00:00.000Z" });
  });
});
