import { describe, expect, test } from "vitest";
import { categorySchema, customerPriceSchema, emptyProductForm, productSchema, scheduledPriceSchema } from "./products";

const form = (over: Partial<ReturnType<typeof emptyProductForm>> = {}) => ({
  ...emptyProductForm(),
  name: "Beratung",
  price: "95,00",
  ...over,
});
const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => i.path.join("."));

describe("PRD-001 product schema (one implementation for UI, Convex and import)", () => {
  test("PRD-011 PRD-010 parses the entered side to micros; empty number = auto", () => {
    const r = productSchema.parse(form({ priceMode: "gross", price: "119,00", purchasePrice: "50" }));
    expect(r).toMatchObject({
      priceMode: "gross",
      unitPriceMicros: 1_190_000,
      purchasePriceMicros: 500_000,
      unitCode: "HUR",
    });
    expect(r.number).toBeUndefined();
  });

  test("PRD-010 > 4 decimals rejected on the price field", () => {
    expect(paths(productSchema.safeParse(form({ price: "1,23456" })))).toContain("price");
  });

  test("PRD-024 exempt without reason fails on exemptionReasonCode", () => {
    expect(paths(productSchema.safeParse(form({ vatRateKey: "exempt" })))).toContain("exemptionReasonCode");
  });

  test("PRD-035 extra-unit factor with 3 decimals; errors carry the row path", () => {
    const r = productSchema.parse(form({ extraUnits: [{ unitCode: "DAY", factor: "7,5" }] }));
    expect(r.extraUnits).toEqual([{ unitCode: "DAY", factorMilli: 7500 }]);
    expect(paths(productSchema.safeParse(form({ extraUnits: [{ unitCode: "DAY", factor: "0" }] })))).toContain(
      "extraUnits.0.factor",
    );
  });

  test("PRD-040 labour share in percent → basis points; > 100 % rejected", () => {
    expect(productSchema.parse(form({ laborCostShare: "62,5" })).laborCostShareBp).toBe(6250);
    expect(paths(productSchema.safeParse(form({ laborCostShare: "101" })))).toContain("laborCostShare");
  });

  test("PRD-009 place of supply dropped for goods in the output only when empty; set on goods → error", () => {
    expect(
      paths(productSchema.safeParse(form({ type: "good", unitCode: "C62", placeOfSupplyRule: "event_admission" }))),
    ).toEqual([]);
    expect(productSchema.parse(form({ placeOfSupplyRule: "event_admission" })).placeOfSupplyRule).toBe(
      "event_admission",
    );
  });

  test("PRD-036 negative purchase price rejected", () => {
    expect(paths(productSchema.safeParse(form({ purchasePrice: "-1" })))).toContain("purchasePrice");
  });
});

describe("PRD-030 PRD-031 PRD-060 price and category schemas", () => {
  test("PRD-030 customer price with optional validFrom", () => {
    expect(customerPriceSchema.parse({ contactId: "c1", priceMode: "net", price: "85", validFrom: "" })).toEqual({
      contactId: "c1",
      priceMode: "net",
      unitPriceMicros: 850_000,
    });
    expect(
      paths(customerPriceSchema.safeParse({ contactId: "", priceMode: "net", price: "x", validFrom: "2026-13-01" })),
    ).toEqual(expect.arrayContaining(["contactId", "price", "validFrom"]));
  });

  test("PRD-031 scheduled price needs a date", () => {
    expect(scheduledPriceSchema.parse({ validFrom: "2027-01-01", priceMode: "net", price: "99" })).toEqual({
      validFrom: "2027-01-01",
      priceMode: "net",
      unitPriceMicros: 990_000,
    });
    expect(scheduledPriceSchema.safeParse({ validFrom: "", priceMode: "net", price: "99" }).success).toBe(false);
  });

  test("PRD-060 category name 1–60", () => {
    expect(categorySchema.safeParse({ name: " ", parentId: "" }).success).toBe(false);
    expect(categorySchema.parse({ name: " Kabel ", parentId: "" }).name).toBe("Kabel");
  });
});
