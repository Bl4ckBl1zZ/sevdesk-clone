import { describe, expect, test } from "vitest";
import { computeInterest } from "../dunning/interest";
import type { CalendarDate } from "../time/calendar-date";
import { lookupBasiszinssatz } from "./basiszinssatz";
import {
  basiszinsRuleVersions,
  checkOverride,
  effectiveOverrides,
  groupOverrides,
  type OverrideInput,
  overrideLockIssue,
  overrideRowId,
  overrideTableIds,
  ruleOverview,
  type StoredOverride,
} from "./overrides";
import { ALL_RULE_TABLES } from "./registry";
import { lookupVatRate } from "./vat-rates";

const basis = (o: Partial<OverrideInput> = {}): OverrideInput => ({
  ruleSet: "basiszinssatz",
  tableId: "basiszinssatz",
  validFrom: "2027-01-01",
  validTo: "2027-06-30",
  rateBp: 150,
  source: "Bundesbank-Pressenotiz vom 28.12.2026",
  ...o,
});

describe("rule overrides (F01 SET-121…123)", () => {
  test("SET-121 validates source, range, keys and dates with the F01 §5.11 codes", () => {
    expect(checkOverride(basis(), []).value).toEqual({ rateBp: 150 });
    expect(checkOverride(basis({ source: " " }), []).error?.code).toBe("SOURCE_REQUIRED");
    expect(checkOverride(basis({ rateBp: 2100 }), []).error?.code).toBe("OUT_OF_RANGE");
    expect(checkOverride(basis({ validTo: "2026-12-31" }), []).error).toMatchObject({
      code: "DATE_RANGE_INVALID",
      message: "Das Enddatum liegt vor dem Startdatum.",
    });
    expect(checkOverride(basis({ validFrom: "2027-02-01" }), []).warnings.map((w) => w.message)).toEqual([
      "Der Basiszinssatz ändert sich üblicherweise zum 1. Januar und 1. Juli (§ 247 BGB).",
    ]);
    expect(checkOverride(basis({ ruleSet: "taxRate", tableId: "luxury" }), []).error).toMatchObject({
      code: "RULE_KEY_UNKNOWN",
      message: "Unbekannter Steuersatz-Schlüssel luxury.",
    });
    const rate20 = checkOverride(basis({ ruleSet: "taxRate", tableId: "standard", rateBp: 2000 }), []);
    expect(rate20.value).toEqual({ rateBp: 2000 });
    expect(rate20.warnings.map((w) => w.code)).toEqual(["RATE_WITHOUT_ACCOUNT_ROLE"]);
    // zero-rated / exempt keys have no rate to override
    expect(overrideTableIds("taxRate")).toContain("standard");
    expect(overrideTableIds("taxRate")).not.toContain("zero_pv");
  });

  test("SET-121 note text overrides keep the placeholders and warn without a § reference", () => {
    const note = (de: string, en = "Reverse charge.") =>
      checkOverride(
        { ruleSet: "noteText", tableId: "rc_eu", validFrom: "2027-01-01", de, en, source: "Eigene Formulierung" },
        [],
      );
    expect(note("Steuerschuldnerschaft des Leistungsempfängers").error?.code).toBe("PLACEHOLDER_MISSING");
    const ok = note("Steuerschuldnerschaft des Leistungsempfängers, USt-IdNr. {sellerVatId} / {buyerVatId}");
    expect(ok.error).toBeUndefined();
    const ku = checkOverride(
      {
        ruleSet: "noteText",
        tableId: "ku_note_19",
        validFrom: "2027-01-01",
        de: "Kein USt-Ausweis.",
        en: "No VAT.",
        source: "x",
      },
      [],
    );
    expect(ku.warnings.map((w) => w.code)).toEqual(["NOTE_LEGAL_BASIS"]);
  });

  test("SET-122 an override wins over the shipped row in its range and the row id names the override", () => {
    const rows: StoredOverride[] = [
      {
        id: "o1",
        ruleSet: "basiszinssatz",
        tableId: "basiszinssatz",
        validFrom: "2027-01-01",
        validTo: "2027-06-30",
        value: { rateBp: 150 },
        source: "BBk",
      },
      {
        id: "o2",
        ruleSet: "taxRate",
        tableId: "standard",
        validFrom: "2027-01-01",
        value: { rateBp: 2000 },
        source: "BGBl.",
      },
    ];
    const g = groupOverrides(rows);
    const b = lookupBasiszinssatz("2027-03-01" as CalendarDate, g.basiszinssatz);
    expect(b.ok && b.value).toMatchObject({ rowId: overrideRowId("o1"), origin: "override", value: { rateBp: 150 } });
    const v = lookupVatRate("standard", "2027-03-01" as CalendarDate, g.vatRateOverrides.standard);
    expect(v.ok && v.value).toMatchObject({ rowId: "override:o2", value: { category: "S", rateBp: 2000 } });
    const before = lookupVatRate("standard", "2026-12-31" as CalendarDate, g.vatRateOverrides.standard);
    expect(before.ok && before.value.origin).toBe("code");
    const interest = computeInterest({
      principalCents: 100_000,
      changes: [],
      from: "2027-01-01" as CalendarDate,
      to: "2027-01-31" as CalendarDate,
      margin: "b2c",
      overrides: g.basiszinssatz,
    });
    if (!interest.ok) throw new Error(interest.error.message);
    expect(basiszinsRuleVersions(interest.value.segments)).toEqual({ "basiszins:2027-01-01": "override:o1" });
  });

  test("SET-123 overlapping overrides of one table are refused; a referenced override is locked", () => {
    const existing: StoredOverride[] = [
      {
        id: "o1",
        ruleSet: "basiszinssatz",
        tableId: "basiszinssatz",
        validFrom: "2027-01-01",
        validTo: "2027-06-30",
        value: { rateBp: 150 },
        source: "BBk",
      },
    ];
    expect(checkOverride(basis({ validFrom: "2027-03-01", validTo: undefined }), existing).error?.code).toBe(
      "RULE_OVERLAP",
    );
    expect(checkOverride(basis({ validFrom: "2027-07-01", validTo: undefined }), existing).error).toBeUndefined();
    expect(overrideLockIssue("o1", [{ "note:ku_note_19": "ku_note_19@2025-01-01" }])).toBeNull();
    expect(overrideLockIssue("o1", [{ "basiszins:2027-01-01": "override:o1" }])).toMatchObject({
      code: "RULE_ROW_LOCKED",
      message:
        "Diese Regel wurde bereits in fertiggestellten Dokumenten verwendet. Bitte eine neue Zeile mit neuem Gültigkeitsdatum anlegen.",
    });
  });

  test("SET-123 a new row supersedes an open-ended override from its start date (the stored row stays unchanged)", () => {
    const jan: StoredOverride = {
      id: "o1",
      ruleSet: "basiszinssatz",
      tableId: "basiszinssatz",
      validFrom: "2027-01-01",
      value: { rateBp: 150 },
      source: "BBk Januar",
    };
    expect(
      checkOverride(basis({ validFrom: "2027-07-01", validTo: undefined, rateBp: 200 }), [jan]).error,
    ).toBeUndefined();
    expect(checkOverride(basis({ validFrom: "2027-01-01", validTo: undefined }), [jan]).error?.code).toBe(
      "RULE_OVERLAP",
    );
    const jul: StoredOverride = {
      ...jan,
      id: "o2",
      validFrom: "2027-07-01",
      value: { rateBp: 200 },
      source: "BBk Juli",
    };
    expect(effectiveOverrides([jul, jan]).find((o) => o.id === "o1")?.validTo).toBe("2027-06-30");
    expect(jan.validTo).toBeUndefined();
    const g = groupOverrides([jan, jul]);
    const june = lookupBasiszinssatz("2027-06-30" as CalendarDate, g.basiszinssatz);
    const july = lookupBasiszinssatz("2027-07-01" as CalendarDate, g.basiszinssatz);
    expect([june.ok && june.value.rowId, july.ok && july.value.rowId]).toEqual(["override:o1", "override:o2"]);
    const row = ruleOverview(ALL_RULE_TABLES, [jan, jul], "2027-03-01" as CalendarDate)
      .find((x) => x.id === "basiszinssatz")
      ?.rows.find((r) => r.overrideId === "o1");
    expect(row).toMatchObject({ validTo: "2027-06-30", current: true });
  });

  test("SET-120 the overview lists every shipped table with source, validity and the row effective today", () => {
    const rows: StoredOverride[] = [
      {
        id: "o1",
        ruleSet: "basiszinssatz",
        tableId: "basiszinssatz",
        validFrom: "2027-01-01",
        value: { rateBp: 150 },
        source: "BBk",
      },
    ];
    const view = ruleOverview(ALL_RULE_TABLES, rows, "2027-02-01" as CalendarDate);
    expect(view).toHaveLength(ALL_RULE_TABLES.length);
    const standard = view.find((t) => t.id === "standard");
    expect(standard).toMatchObject({ group: "taxRate", overridable: "taxRate" });
    expect(standard?.rows.find((r) => r.current)).toMatchObject({
      value: "19 % (S)",
      origin: "code",
      source: "§ 12 Abs. 1 UStG",
    });
    const b = view.find((t) => t.id === "basiszinssatz");
    expect(b?.rows.filter((r) => r.current)).toEqual([
      {
        rowId: "override:o1",
        validFrom: "2027-01-01",
        value: "1,5 %",
        source: "BBk",
        origin: "override",
        current: true,
        overrideId: "o1",
      },
    ]);
    expect(view.find((t) => t.id === "kleinunternehmer_limits")).toMatchObject({ group: "other", overridable: null });
    expect(view.find((t) => t.id === "ku_note_19")?.rows.at(-1)?.value).toContain("§ 19 Abs. 1 UStG");
  });
});
