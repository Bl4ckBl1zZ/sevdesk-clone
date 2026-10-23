import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { rulesFreshness } from "./freshness";
import type { StoredOverride } from "./overrides";

const basis = (id: string, validFrom: string, rateBp: number, validTo?: string): StoredOverride => ({
  id,
  ruleSet: "basiszinssatz",
  tableId: "basiszinssatz",
  validFrom,
  ...(validTo ? { validTo } : {}),
  value: { rateBp },
  source: "https://www.bundesbank.de",
});

describe("SET-124 rules.freshness", () => {
  test("SET-124 an override equal to a shipped row is flagged with „Ihre Überschreibung entspricht der ausgelieferten Regel — entfernen?“", () => {
    const f = rulesFreshness([basis("o1", "2026-07-01", 152)], calendarDate("2026-10-12"));
    expect(f).toEqual([
      {
        code: "override_duplicates_shipped",
        tableId: "basiszinssatz",
        overrideId: "o1",
        message:
          "Ihre Überschreibung entspricht der ausgelieferten Regel — entfernen? (Basiszinssatz (§ 247 BGB) ab 01.07.2026)",
      },
    ]);
  });

  test("SET-124 a tax-rate override equal to the shipped standard rate is a duplicate as well (category is implied)", () => {
    const o: StoredOverride = {
      id: "o2",
      ruleSet: "taxRate",
      tableId: "standard",
      validFrom: "2007-01-01",
      validTo: "2020-06-30",
      value: { rateBp: 1900 },
      source: "UStG",
    };
    expect(rulesFreshness([o], calendarDate("2026-10-12")).map((x) => x.code)).toEqual(["override_duplicates_shipped"]);
    // open-ended, the same override would also replace the shipped 16 % of 2020-07-01 → a conflict, not a duplicate
    const { validTo: _, ...open } = o;
    expect(rulesFreshness([open], calendarDate("2026-10-12")).map((x) => x.code)).toEqual([
      "override_differs_from_shipped",
    ]);
  });

  test("SET-124 SET-E26 an override that differs from a later shipped row stays effective and is reported (no duplicate)", () => {
    const f = rulesFreshness([basis("o3", "2026-07-01", 140)], calendarDate("2026-10-12"));
    expect(f).toEqual([
      expect.objectContaining({
        code: "override_differs_from_shipped",
        overrideId: "o3",
        message: expect.stringContaining("Ihre Überschreibung bleibt wirksam"),
      }),
    ]);
  });

  test("SET-124 an override for a period the release does not cover is neither duplicate nor conflict", () => {
    expect(rulesFreshness([basis("o4", "2027-01-01", 130, "2027-06-30")], calendarDate("2027-01-10"))).toEqual([]);
  });

  test("SET-124 DUN-021 stale Basiszinssatz table: warns from 2 January / 2 July when no row for the current half-year exists", () => {
    // 2027-01-01: no warning on the day of the change itself
    expect(rulesFreshness([], calendarDate("2027-01-01"))).toEqual([]);
    const f = rulesFreshness([], calendarDate("2027-01-02"));
    expect(f).toEqual([
      {
        code: "table_stale",
        tableId: "basiszinssatz",
        message:
          "Der Basiszinssatz ab 01.01.2027 ist nicht hinterlegt. Bitte die Bundesbank-Bekanntgabe unter Einstellungen › Regeln ergänzen oder die App aktualisieren.",
      },
    ]);
    // an owner override for the half-year fixes it
    expect(rulesFreshness([basis("o5", "2027-01-01", 130, "2027-06-30")], calendarDate("2027-01-02"))).toEqual([]);
    // inside a shipped half-year nothing is stale
    expect(rulesFreshness([], calendarDate("2026-07-02"))).toEqual([]);
  });
});
