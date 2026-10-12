import { describe, expect, test } from "vitest";
import {
  baseUnitChangeClearsExtraUnits,
  defaultUnitFor,
  genericNameWarning,
  isValidGtin,
  normalizeProductNumber,
  PRODUCT_NUMBER_RE,
  type ProductFields,
  sanitizeDescription,
  validateProductFields,
} from "./product";

const base: ProductFields = {
  name: "Beratung Netzwerk",
  type: "service",
  unitCode: "HUR",
  priceMode: "net",
  unitPriceMicros: 950_000,
  vatRateKey: "standard",
  extraUnits: [],
};
const errs = (p: Partial<ProductFields>, units?: ReadonlySet<string>) =>
  validateProductFields({ ...base, ...p }, units).errors.map((e) => e.code);
const warns = (p: Partial<ProductFields>) => validateProductFields({ ...base, ...p }).warnings.map((e) => e.code);

describe("PRD-001…009 product master data", () => {
  test("PRD-003 name is required (1–200), description ≤ 5,000", () => {
    expect(errs({ name: "  " })).toContain("REQUIRED");
    expect(errs({ name: "x".repeat(201) })).toContain("TOO_LONG");
    expect(errs({ description: "x".repeat(5001) })).toContain("TOO_LONG");
    expect(errs({})).toEqual([]);
  });

  test("PRD-003 description is sanitised rich text (bold, italic, lists), scripts removed", () => {
    const out = sanitizeDescription("<p><strong>fett</strong><script>alert(1)</script><ul><li>a</li></ul></p>");
    expect(out).toContain("<strong>fett</strong>");
    expect(out).toContain("<li>a</li>");
    expect(out).not.toContain("script");
  });

  test("T-PRD-026 PRD-004 generic name „Pauschale.“ warns (UST-07) but does not block", () => {
    expect(genericNameWarning("Pauschale.")?.code).toBe("GENERIC_NAME");
    expect(genericNameWarning("diverses")?.code).toBe("GENERIC_NAME");
    expect(genericNameWarning("Pauschale Wartung Server")).toBeNull();
    expect(warns({ name: "Leistung" })).toContain("GENERIC_NAME");
    expect(errs({ name: "Leistung" })).toEqual([]);
  });

  test("PRD-002 product number: 1–50 printable characters, compared case-insensitively", () => {
    const typical = "ART-00001";
    expect(PRODUCT_NUMBER_RE.test(typical)).toBe(true);
    expect(PRODUCT_NUMBER_RE.test("x".repeat(51))).toBe(false);
    expect(PRODUCT_NUMBER_RE.test(" A")).toBe(false);
    expect(errs({ number: "a\u0001b" })).toContain("PRODUCT_NUMBER_INVALID");
    expect(normalizeProductNumber(" art-1 ")).toBe("ART-1");
  });

  test("PRD-005 type drives the default unit", () => {
    expect(defaultUnitFor("good")).toBe("C62");
    expect(defaultUnitFor("service")).toBe("HUR");
  });

  test("PRD-006 unit must be an active unit", () => {
    expect(errs({ unitCode: "XYZ" }, new Set(["HUR", "C62"]))).toContain("UNIT_INVALID");
    expect(errs({ unitCode: "HUR" }, new Set(["HUR"]))).toEqual([]);
  });

  test("PRD-008 GTIN with GS1 check digit", () => {
    expect(isValidGtin("4006381333931")).toBe(true);
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("96385074")).toBe(true);
    expect(errs({ gtin: "123" })).toContain("GTIN_INVALID");
  });

  test("PRD-009 place-of-supply rule only for services", () => {
    expect(errs({ type: "good", unitCode: "C62", placeOfSupplyRule: "event_admission" })).toContain(
      "PLACE_OF_SUPPLY_SERVICES_ONLY",
    );
    expect(errs({ placeOfSupplyRule: "event_admission" })).toEqual([]);
  });

  test("PRD-009a §13b type from the rule table", () => {
    expect(errs({ reverseCharge13b: "construction" })).toEqual([]);
    expect(errs({ reverseCharge13b: "spaceflight" })).toContain("RC13B_TYPE_UNKNOWN");
  });

  test("PRD-014 range; zero and negative prices warn", () => {
    expect(errs({ unitPriceMicros: 1_000_000_000_000 })).toContain("PRICE_OUT_OF_RANGE");
    expect(warns({ unitPriceMicros: 0 })).toContain("PRICE_ZERO");
    expect(warns({ unitPriceMicros: -50_000 })).toContain("PRICE_NEGATIVE");
    expect(errs({ unitPriceMicros: -50_000 })).toEqual([]);
  });
});

describe("PRD-020…026 VAT keys", () => {
  test("T-PRD-036 PRD-024 exempt needs a VATEX reason; reason only on exempt", () => {
    expect(errs({ vatRateKey: "exempt" })).toContain("EXEMPTION_REASON_REQUIRED");
    expect(errs({ vatRateKey: "exempt", exemptionReasonCode: "VATEX-EU-132-1C" })).toEqual([]);
    expect(errs({ vatRateKey: "exempt", exemptionReasonCode: "VATEX-EU-XYZ" })).toContain("EXEMPTION_REASON_INVALID");
    expect(errs({ exemptionReasonCode: "VATEX-EU-132-1C" })).toContain("EXEMPTION_REASON_NOT_ALLOWED");
  });

  test("PRD-020 unknown key rejected", () => {
    expect(errs({ vatRateKey: "super_reduced" })).toContain("VAT_KEY_INVALID");
  });

  test("PRD-026 restaurant_food shows the drinks hint", () => {
    expect(warns({ vatRateKey: "restaurant_food" })).toContain("RESTAURANT_DRINKS_HINT");
  });
});

describe("PRD-035 PRD-040 extra units and labour share", () => {
  test("PRD-035 max 10 extra units, unique, ≠ base, factor > 0", () => {
    const units = Array.from({ length: 11 }, (_, i) => ({ unitCode: `U${i}`, factorMilli: 1000 }));
    expect(errs({ extraUnits: units })).toContain("EXTRA_UNIT_LIMIT");
    expect(errs({ extraUnits: [{ unitCode: "HUR", factorMilli: 1000 }] })).toContain("EXTRA_UNIT_DUPLICATE");
    expect(
      errs({
        extraUnits: [
          { unitCode: "DAY", factorMilli: 8000 },
          { unitCode: "DAY", factorMilli: 8000 },
        ],
      }),
    ).toContain("EXTRA_UNIT_DUPLICATE");
    expect(errs({ extraUnits: [{ unitCode: "DAY", factorMilli: 0 }] })).toContain("EXTRA_UNIT_FACTOR");
    expect(errs({ extraUnits: [{ unitCode: "DAY", factorMilli: 8000 }] })).toEqual([]);
  });

  test("T-PRD-013 PRD-E13 changing the base unit with extra units needs confirmation (they are cleared)", () => {
    expect(baseUnitChangeClearsExtraUnits("C62", "MTR", [{ unitCode: "XRO", factorMilli: 100_000 }])).toBe(true);
    expect(baseUnitChangeClearsExtraUnits("C62", "MTR", [])).toBe(false);
    expect(baseUnitChangeClearsExtraUnits("C62", "C62", [{ unitCode: "XRO", factorMilli: 100_000 }])).toBe(false);
  });

  test("PRD-040 labour share 0–10000 bp; on goods a warning", () => {
    expect(errs({ laborCostShareBp: 10_001 })).toContain("OUT_OF_RANGE");
    expect(errs({ laborCostShareBp: 6000 })).toEqual([]);
    expect(warns({ type: "good", unitCode: "C62", laborCostShareBp: 6000 })).toContain("LABOR_ON_GOOD");
  });
});
