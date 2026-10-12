import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { grossToNetMicros, netToGrossMicros } from "../money/convert";
import type { RuleOverride } from "../rules/rule-table";
import { lookupVatRate, VAT_RATE_KEYS, type VatRateValue } from "../rules/vat-rates";
import { calendarDate } from "../time/calendar-date";
import {
  belowPurchaseWarning,
  computeMargin,
  convertPriceMode,
  extraUnitPriceMicros,
  type PricingProduct,
  parseUnitPrice,
  priceViews,
  productKeyApplies,
  type ResolvePriceOptions,
  resolvePrice,
  revenueAccountForLine,
  splitLaborMaterial,
} from "./pricing";

const d = calendarDate;
const product: PricingProduct = {
  id: "p1",
  active: true,
  unitCode: "HUR",
  priceMode: "net",
  unitPriceMicros: 950_000,
  vatRateKey: "standard",
  extraUnits: [{ unitCode: "DAY", factorMilli: 8000 }],
};
const opts: ResolvePriceOptions = {
  customerPrices: [],
  referenceDate: d("2026-10-12"),
  documentPriceMode: "net",
  documentCurrency: "EUR",
};
const resolved = (p: Partial<PricingProduct>, o: Partial<ResolvePriceOptions>) => {
  const r = resolvePrice({ ...product, ...p }, { ...opts, ...o });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("PRD-010 price input", () => {
  test("T-PRD-031 PRD-010 „1.234,56789“ → PRICE_PRECISION; „1.234,5678“ → 12345678; „1234.5“ → 12345000", () => {
    const p = parseUnitPrice("1.234,56789");
    expect(p.ok ? null : p.error.code).toBe("PRICE_PRECISION");
    expect(parseUnitPrice("1.234,5678")).toEqual({ ok: true, value: 12_345_678 });
    expect(parseUnitPrice("1234.5")).toEqual({ ok: true, value: 12_345_000 });
    expect(parseUnitPrice("1.234")).toEqual({ ok: true, value: 12_340_000 });
    expect(parseUnitPrice("95,00 €")).toEqual({ ok: true, value: 950_000 });
    expect(parseUnitPrice("-2,50")).toEqual({ ok: true, value: -25_000 });
    const bad = parseUnitPrice("abc");
    expect(bad.ok ? null : bad.error.code).toBe("PRICE_INVALID");
    const big = parseUnitPrice("100.000.000,00");
    expect(big.ok ? null : big.error.code).toBe("PRICE_OUT_OF_RANGE");
  });
});

describe("PRD-011…013 net and gross", () => {
  test("T-PRD-021 PRD-012 net 100.0000 € on a B2C document → gross 119.0000 €", () => {
    expect(priceViews("net", 1_000_000, 1900)).toEqual({ netMicros: 1_000_000, grossMicros: 1_190_000 });
    expect(resolved({ unitPriceMicros: 1_000_000 }, { documentPriceMode: "gross" }).unitPriceMicros).toBe(1_190_000);
  });

  test("T-PRD-005 PRD-E05 gross 11.9000 € keeps gross after a change to 7 % (net 11.1215 €); net 10 € → gross 10.70 €", () => {
    expect(priceViews("gross", 119_000, 700)).toEqual({ netMicros: 111_215, grossMicros: 119_000 });
    expect(priceViews("net", 100_000, 700)).toEqual({ netMicros: 100_000, grossMicros: 107_000 });
  });

  test("T-PRD-032 PRD-012 net→gross→net round trip error ≤ 1 micro for every rate in the table", () => {
    const rates = [...new Set(Object.values(VAT_RATE_KEYS).flatMap((t) => t.entries.map((e) => e.value.rateBp)))];
    fc.assert(
      fc.property(
        fc.integer({ min: -999_999_999_999, max: 999_999_999_999 }),
        fc.constantFrom(...rates),
        (net, rate) => {
          const back = grossToNetMicros(netToGrossMicros(net, rate), rate);
          return Math.abs(back - net) <= 1;
        },
      ),
    );
  });

  test("PRD-013 converting the entered side", () => {
    expect(convertPriceMode(1_000_000, "net", "gross", 1900)).toBe(1_190_000);
    expect(convertPriceMode(1_190_000, "gross", "net", 1900)).toBe(1_000_000);
    expect(convertPriceMode(5, "net", "net", 1900)).toBe(5);
  });
});

describe("PRD-020…023 rates by supply date", () => {
  test("T-PRD-004 PRD-020 restaurant_food 2025-12-31 → 19 %, 2026-01-01 → 7 %; standard 19 % on both; month 2025-12 → 19 %", () => {
    const rate = (key: string, date: string) => resolved({ vatRateKey: key }, { referenceDate: d(date) }).rateBp;
    expect(rate("restaurant_food", "2025-12-31")).toBe(1900);
    expect(rate("restaurant_food", "2026-01-01")).toBe(700);
    expect(rate("standard", "2025-12-31")).toBe(1900);
    expect(rate("standard", "2026-01-01")).toBe(1900);
    expect(
      resolved({ vatRateKey: "restaurant_food" }, { referenceDate: { from: d("2025-12-01"), to: d("2025-12-31") } })
        .rateBp,
    ).toBe(1900);
  });

  test("T-PRD-006 PRD-021 a period spanning a rate change cannot be resolved (line must be split)", () => {
    const r = resolvePrice(
      { ...product, vatRateKey: "restaurant_food" },
      { ...opts, referenceDate: { from: d("2025-12-15"), to: d("2026-01-15") } },
    );
    expect(r.ok ? null : r.error.code).toBe("rule_changes_in_period");
  });

  test("T-PRD-007 PRD-022 an F01 override applies from its date and its row ID is returned", () => {
    const overrides: RuleOverride<VatRateValue>[] = [
      { id: "ov1", validFrom: d("2027-07-01"), value: { category: "S", rateBp: 2000 }, source: "Test" },
    ];
    expect(resolved({}, { referenceDate: d("2027-06-30"), rateOverrides: overrides }).rateBp).toBe(1900);
    const after = resolved({}, { referenceDate: d("2027-07-01"), rateOverrides: overrides });
    expect(after.rateBp).toBe(2000);
    expect(after.ruleRowId).toBe("override:ov1");
  });

  test("T-PRD-008 T-PRD-009 PRD-023 product key only for domestic and §4 tax cases", () => {
    expect(productKeyApplies("domestic")).toEqual({ applies: true });
    expect(productKeyApplies("exempt_4")).toEqual({ applies: true });
    const ku = productKeyApplies("kleinunternehmer");
    expect(ku.applies).toBe(false);
    expect(productKeyApplies("export").applies).toBe(false);
  });

  test("T-PRD-010 PRD-025 zero (PV) resolves category Z at 0 % with the confirmation warning", () => {
    const r = resolved({ vatRateKey: "zero" }, {});
    expect(r.category).toBe("Z");
    expect(r.rateBp).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain("PV_CONFIRMATION_REQUIRED");
  });

  test("PRD-051 revenue override only on domestic lines (S, Z, E)", () => {
    expect(revenueAccountForLine("S", "8400")).toBe("8400");
    expect(revenueAccountForLine("AE", "8400")).toBeUndefined();
    expect(revenueAccountForLine("K", "8400")).toBeUndefined();
  });
});

describe("PRD-030…035 price resolution", () => {
  const cp = (contactId: string, unitPriceMicros: number, validFrom?: string) => ({
    contactId,
    unitPriceMicros,
    priceMode: "net" as const,
    ...(validFrom ? { validFrom } : {}),
  });

  test("T-PRD-033 PRD-032 PRD-033 own price → parent org price → base", () => {
    const prices = [cp("person", 800_000), cp("org", 850_000)];
    expect(resolved({}, { contactId: "person", parentContactId: "org", customerPrices: prices })).toMatchObject({
      unitPriceMicros: 800_000,
      source: "customer",
    });
    expect(resolved({}, { contactId: "other", parentContactId: "org", customerPrices: prices })).toMatchObject({
      unitPriceMicros: 850_000,
      source: "parent_customer",
    });
    expect(resolved({}, { contactId: "x", customerPrices: prices })).toMatchObject({
      unitPriceMicros: 950_000,
      source: "base",
    });
  });

  test("T-PRD-022 PRD-030 customer price from 2027-01-01 applies only from that supply date", () => {
    const prices = [cp("c", 850_000, "2027-01-01")];
    expect(
      resolved({}, { contactId: "c", customerPrices: prices, referenceDate: d("2026-12-31") }).unitPriceMicros,
    ).toBe(950_000);
    expect(
      resolved({}, { contactId: "c", customerPrices: prices, referenceDate: d("2027-01-02") }).unitPriceMicros,
    ).toBe(850_000);
  });

  test("PRD-030 history: the latest validFrom ≤ reference date wins", () => {
    const prices = [cp("c", 700_000), cp("c", 800_000, "2026-01-01"), cp("c", 900_000, "2026-06-01")];
    expect(
      resolved({}, { contactId: "c", customerPrices: prices, referenceDate: d("2026-03-01") }).unitPriceMicros,
    ).toBe(800_000);
    expect(
      resolved({}, { contactId: "c", customerPrices: prices, referenceDate: d("2025-03-01") }).unitPriceMicros,
    ).toBe(700_000);
  });

  test("T-PRD-034 PRD-034 discount on base price; on customer prices only with the company option", () => {
    expect(resolved({}, { contactDiscountBp: 1000 }).discountBp).toBe(1000);
    const prices = [cp("c", 800_000)];
    expect(
      resolved({}, { contactId: "c", customerPrices: prices, contactDiscountBp: 1000 }).discountBp,
    ).toBeUndefined();
    expect(
      resolved({}, { contactId: "c", customerPrices: prices, contactDiscountBp: 1000, discountOnCustomerPrices: true })
        .discountBp,
    ).toBe(1000);
  });

  test("T-PRD-035 PRD-035 extra unit XRO ×100.000 with base 1.2345 € → 123.4500 €; 0.3333 € × 3.000 → 0.9999 €", () => {
    expect(extraUnitPriceMicros(12_345, 100_000)).toBe(1_234_500);
    expect(extraUnitPriceMicros(3_333, 3_000)).toBe(9_999);
    expect(resolved({}, { unitCode: "DAY" })).toMatchObject({ unitPriceMicros: 7_600_000, unitCode: "DAY" });
    const r = resolvePrice(product, { ...opts, unitCode: "KGM" });
    expect(r.ok ? null : r.error.code).toBe("UNIT_INVALID");
  });

  test("T-PRD-039 PRD-031 a scheduled price applies to supply dates from its date", () => {
    const p = { scheduledPrice: { validFrom: "2027-01-01", priceMode: "net" as const, unitPriceMicros: 990_000 } };
    expect(resolved(p, { referenceDate: d("2026-12-31") }).unitPriceMicros).toBe(950_000);
    expect(resolved(p, { referenceDate: d("2027-01-01") }).unitPriceMicros).toBe(990_000);
  });

  test("T-PRD-024 PRD-015 USD document at 1 EUR = 1.0850 USD → 95.0000 € becomes 103.0750 USD", () => {
    expect(resolved({}, { documentCurrency: "USD", fxRate: "1.0850" }).unitPriceMicros).toBe(1_030_750);
    const r = resolvePrice(product, { ...opts, documentCurrency: "USD" });
    expect(r.ok ? null : r.error.code).toBe("FX_RATE_REQUIRED");
  });

  test("PRD-072 archived product warns when resolved", () => {
    expect(resolved({ active: false }, {}).warnings.map((w) => w.code)).toContain("PRODUCT_ARCHIVED");
  });
});

describe("PRD-036…041 margin and labour share", () => {
  test("T-PRD-028 PRD-036 KU company: purchase 10 € net, sale 15 € → cost 11.90 €, margin 20.67 %", () => {
    const m = computeMargin(150_000, 100_000, { kleinunternehmer: true, standardRateBp: 1900 });
    expect(m.costMicros).toBe(119_000);
    expect(m.marginBp).toBe(2067);
    const regular = computeMargin(150_000, 100_000, { kleinunternehmer: false, standardRateBp: 1900 });
    expect(regular.marginBp).toBe(3333);
    expect(regular.markupBp).toBe(5000);
    expect(computeMargin(0, 0, { kleinunternehmer: false, standardRateBp: 1900 })).toMatchObject({
      marginBp: null,
      markupBp: null,
    });
  });

  test("PRD-038 warning when the sales price is below the purchase price (compared net)", () => {
    expect(
      belowPurchaseWarning(
        { purchasePriceMicros: 100_000, vatRateKey: "standard" },
        { priceMode: "net", unitPriceMicros: 90_000 },
      )?.code,
    ).toBe("PRICE_BELOW_PURCHASE");
    // 115 € gross = 96.64 € net < 100 €
    expect(
      belowPurchaseWarning(
        { purchasePriceMicros: 1_000_000, vatRateKey: "standard" },
        { priceMode: "gross", unitPriceMicros: 1_150_000 },
        1900,
      ),
    ).not.toBeNull();
    expect(belowPurchaseWarning({ vatRateKey: "standard" }, { priceMode: "net", unitPriceMicros: 1 })).toBeNull();
  });

  test("T-PRD-020 PRD-041 60 % product at 1,000 € on B2C → 600 € labour + 400 € material; B2B one line", () => {
    expect(splitLaborMaterial("Badsanierung", 10_000_000, 6000, true)).toEqual([
      { name: "Badsanierung – Arbeitskosten", unitPriceMicros: 6_000_000, isLaborCost: true },
      { name: "Badsanierung – Material", unitPriceMicros: 4_000_000, isLaborCost: false },
    ]);
    expect(splitLaborMaterial("Badsanierung", 10_000_000, 6000, false)).toHaveLength(1);
    expect(splitLaborMaterial("Wartung", 1_000_000, 10_000, true)).toEqual([
      { name: "Wartung", unitPriceMicros: 1_000_000, isLaborCost: true },
    ]);
  });

  test("PRD-041 the split always sums to the original price (half-up on the labour line)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999_999_999 }), fc.integer({ min: 1, max: 9999 }), (price, share) => {
        const [a, b] = splitLaborMaterial("x", price, share, true);
        return (a?.unitPriceMicros ?? 0) + (b?.unitPriceMicros ?? 0) === price;
      }),
    );
  });

  test("PRD-020 sanity: the lookup used by the form shows today's rate", () => {
    const r = lookupVatRate("reduced", d("2026-10-12"));
    expect(r.ok && r.value.value.rateBp).toBe(700);
  });
});
