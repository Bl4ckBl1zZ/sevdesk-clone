import { describe, expect, test } from "vitest";
import type { RuleOverride } from "../rules/rule-table";
import type { VatRateValue } from "../rules/vat-rates";
import { calendarDate } from "../time/calendar-date";
import {
  type CategoryNode,
  categoryPath,
  depthOf,
  planCategoryDelete,
  resolveCategoryPath,
  validateCategory,
} from "./categories";
import { autoMapProductHeaders, mapUnit, mapVat, PRODUCT_EXPORT_HEADERS, productExportRow, productRow } from "./csv-io";
import { rateChangeBanner, upcomingRateChanges } from "./rate-change";

const tree: CategoryNode[] = [
  { id: "w", name: "Waren" },
  { id: "k", name: "Kabel", parentId: "w" },
  { id: "c7", name: "Cat7", parentId: "k" },
  { id: "d", name: "Dienstleistungen" },
];

describe("PRD-060 PRD-061 categories", () => {
  test("PRD-060 depth ≤ 3, sibling names unique, no cycles", () => {
    expect(depthOf("c7", tree)).toBe(3);
    expect(categoryPath("c7", tree)).toBe("Waren > Kabel > Cat7");
    expect(validateCategory({ name: "Extra", parentId: "c7" }, tree)?.code).toBe("CATEGORY_DEPTH");
    expect(validateCategory({ name: "kabel", parentId: "w" }, tree)?.code).toBe("CATEGORY_DUPLICATE");
    expect(validateCategory({ name: "Stecker", parentId: "w" }, tree)).toBeNull();
    expect(validateCategory({ id: "w", name: "Waren", parentId: "c7" }, tree)?.code).toBe("CATEGORY_CYCLE");
    // moving "Kabel" (height 2) under "Dienstleistungen" → depth 3: ok; under Cat7 would be a cycle
    expect(validateCategory({ id: "k", name: "Kabel", parentId: "d" }, tree)).toBeNull();
    expect(validateCategory({ name: "" }, tree)?.code).toBe("CATEGORY_NAME_INVALID");
    expect(validateCategory({ name: "x".repeat(61) }, tree)?.code).toBe("CATEGORY_NAME_INVALID");
  });

  test("T-PRD-043 PRD-061 deleting a category with products needs a target; nothing is orphaned", () => {
    const missing = planCategoryDelete("k", tree, 4, undefined);
    expect("error" in missing && missing.error.code).toBe("CATEGORY_NOT_EMPTY");
    expect(planCategoryDelete("k", tree, 4, "parent")).toEqual({ moveTo: "w", children: ["c7"] });
    expect(planCategoryDelete("k", tree, 4, "none")).toEqual({ moveTo: undefined, children: ["c7"] });
    expect(planCategoryDelete("d", tree, 0, undefined)).toEqual({ moveTo: undefined, children: [] });
  });

  test("T-PRD-041 PRD-084 „Waren > Kabel > Cat7 > Extra“ → depth error; „Waren > Stecker“ creates the missing level", () => {
    const deep = resolveCategoryPath("Waren > Kabel > Cat7 > Extra", tree);
    expect("error" in deep && deep.error.code).toBe("CATEGORY_DEPTH");
    expect(resolveCategoryPath("Waren > Stecker", tree)).toEqual({ existingId: "w", toCreate: ["Stecker"] });
    expect(resolveCategoryPath("waren > kabel", tree)).toEqual({ existingId: "k", toCreate: [] });
    expect(resolveCategoryPath("Neu > Unter", tree)).toEqual({ existingId: undefined, toCreate: ["Neu", "Unter"] });
  });
});

describe("PRD-027 rate-change banner", () => {
  test("T-PRD-038 PRD-027 banner lists gross- and net-mode products within 60 days of a rule change", () => {
    const overrides: Record<string, RuleOverride<VatRateValue>[]> = {
      standard: [
        { id: "ov", validFrom: calendarDate("2026-12-01"), value: { category: "S", rateBp: 2000 }, source: "Test" },
      ],
    };
    const changes = upcomingRateChanges(calendarDate("2026-10-12"), 60, overrides);
    expect(changes).toEqual([{ key: "standard", date: "2026-12-01", fromBp: 1900, toBp: 2000 }]);
    expect(upcomingRateChanges(calendarDate("2026-09-01"), 60, overrides)).toEqual([]);
    const banner = rateChangeBanner(changes[0] as (typeof changes)[number], [
      { vatRateKey: "standard", priceMode: "gross", active: true },
      { vatRateKey: "standard", priceMode: "net", active: true },
      { vatRateKey: "standard", priceMode: "net", active: true },
      { vatRateKey: "reduced", priceMode: "net", active: true },
      { vatRateKey: "standard", priceMode: "net", active: false },
    ]);
    expect(banner).toBe(
      "Ab 01.12.2026 ändert sich der Steuersatz für standard. 1 Produkte mit Bruttopreis behalten den Bruttopreis (Nettopreis sinkt); 2 Produkte mit Nettopreis behalten den Nettopreis.",
    );
  });

  test("PRD-E04 the shipped restaurant_food change is reported in December 2025", () => {
    expect(upcomingRateChanges(calendarDate("2025-12-01"))).toContainEqual({
      key: "restaurant_food",
      date: "2026-01-01",
      fromBp: 1900,
      toBp: 700,
    });
  });
});

describe("PRD-080…085 CSV import mapping", () => {
  test("PRD-080 header aliases incl. German labels", () => {
    expect(autoMapProductHeaders(["Artikelnummer", "Bezeichnung", "Einheit", "VK netto", "MwSt", "Unbekannt"])).toEqual(
      ["number", "name", "unit", "netPrice", "vat", null],
    );
  });

  test("T-PRD-040 PRD-081 Stk → C62, qm → MTK, Rec 20 codes pass, unknown → null", () => {
    expect(mapUnit("Stk")).toBe("C62");
    expect(mapUnit("Stück")).toBe("C62");
    expect(mapUnit("qm")).toBe("MTK");
    expect(mapUnit("Std.")).toBe("HUR");
    expect(mapUnit("hur")).toBe("HUR");
    expect(mapUnit("Fass")).toBeNull();
  });

  test("T-PRD-040 PRD-082 19 → standard, 7 → reduced, 0 → row error unless exempt with reason", () => {
    expect(mapVat("19", "", 2)).toEqual({ key: "standard" });
    expect(mapVat("7 %", "", 2)).toEqual({ key: "reduced" });
    expect(mapVat("zero", "", 2)).toEqual({ key: "zero" });
    expect("error" in mapVat("0", "", 4) && mapVat("0", "", 4)).toMatchObject({
      error: expect.stringContaining("Zeile 4"),
    });
    expect(mapVat("0", "VATEX-EU-132-1C", 4)).toEqual({ key: "exempt" });
    expect("error" in mapVat("16", "", 2)).toBe(true);
  });

  test("T-PRD-040 PRD-083 one price column per row, > 4 decimals is a row error", () => {
    const mapping = autoMapProductHeaders(["Name", "Einheit", "VK netto", "VK brutto", "MwSt"]);
    const rate = () => 1900;
    const ok = productRow(["Kabel", "m", "1,2345", "", "19"], mapping, 2, rate);
    expect(ok.values).toMatchObject({
      name: "Kabel",
      unitCode: "MTR",
      unitPriceMicros: 12_345,
      priceMode: "net",
      vatRateKey: "standard",
    });
    const gross = productRow(["Kabel", "m", "", "11,90", "19"], mapping, 3, rate);
    expect(gross.values).toMatchObject({ unitPriceMicros: 119_000, priceMode: "gross" });
    const precise = productRow(["Kabel", "m", "1,23456", "", "19"], mapping, 4, rate);
    expect(precise.errors.map((e) => e.code)).toEqual(["PRICE_PRECISION"]);
    expect(precise.errors[0]?.message).toMatch(/^Zeile 4:/);
    const inconsistent = productRow(["Kabel", "m", "10,00", "12,00", "19"], mapping, 5, rate);
    expect(inconsistent.errors.map((e) => e.code)).toEqual(["PRICE_INCONSISTENT"]);
    const unit = productRow(["Kabel", "Fass", "1", "", "19"], mapping, 6, rate);
    expect(unit.errors.map((e) => e.code)).toEqual(["UNIT_INVALID"]);
  });
});

describe("PRD-085 CSV export", () => {
  test("T-PRD-042 PRD-085 net and gross at today's rate, key and current rate, margin in German notation", () => {
    const row = productExportRow({
      number: "ART-00001",
      name: "Kabel Cat7",
      type: "good",
      unitCode: "MTR",
      priceMode: "net",
      netMicros: 12_345,
      grossMicros: 14_691,
      vatRateKey: "standard",
      rateBp: 1900,
      purchasePriceMicros: 8_000,
      marginBp: 3520,
      categoryPath: "Waren > Kabel",
      active: true,
      tagNames: [],
      customFields: {},
      extraUnits: [{ unitCode: "XRO", factorMilli: 100_000 }],
    });
    expect(row).toHaveLength(PRODUCT_EXPORT_HEADERS.length);
    const at = (h: (typeof PRODUCT_EXPORT_HEADERS)[number]) => row[PRODUCT_EXPORT_HEADERS.indexOf(h)];
    expect(at("VK netto")).toBe("1,2345");
    expect(at("VK brutto")).toBe("1,4691");
    expect(at("Steuersatz heute (%)")).toBe("19");
    expect(at("Marge (%)")).toBe("35,2");
    expect(at("Kategorie")).toBe("Waren > Kabel");
    expect(at("Zusatzeinheiten")).toBe("XRO=100");
  });
});
