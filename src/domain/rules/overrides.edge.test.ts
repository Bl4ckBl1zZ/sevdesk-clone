import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { BASISZINSSATZ, lookupBasiszinssatz } from "./basiszinssatz";
import { checkOverride, groupOverrides, ruleOverview, type StoredOverride } from "./overrides";
import { ruleRowId } from "./rule-table";

/** 10-edge-cases EC-117: an owner override that conflicts with a shipped row (same row, different value). */

const shipped = BASISZINSSATZ.entries.find((e) => e.validFrom === "2026-01-01");

describe("EC-117 rule override conflicts with a shipped rule", () => {
  test("EC-117 the override wins only inside its validity range; both rows are shown; the shipped row stays authoritative outside", () => {
    expect(shipped?.value.rateBp).toBe(127);
    const conflicting: StoredOverride = {
      id: "o1",
      ruleSet: "basiszinssatz",
      tableId: "basiszinssatz",
      validFrom: "2026-01-01", // same start as the shipped row, different value
      validTo: "2026-03-31",
      value: { rateBp: 200 },
      source: "Eigene Recherche",
    };
    // Accepted: a conflict with a shipped row is not an overlap between overrides.
    expect(
      checkOverride(
        {
          ruleSet: "basiszinssatz",
          tableId: "basiszinssatz",
          validFrom: "2026-01-01",
          validTo: "2026-03-31",
          rateBp: 200,
          source: "Eigene Recherche",
        },
        [],
      ).error,
    ).toBeUndefined();

    const g = groupOverrides([conflicting]).basiszinssatz;
    const inside = lookupBasiszinssatz("2026-02-15" as CalendarDate, g);
    expect(inside.ok && inside.value).toMatchObject({
      origin: "override",
      rowId: "override:o1",
      value: { rateBp: 200 },
    });
    const after = lookupBasiszinssatz("2026-04-01" as CalendarDate, g);
    expect(after.ok && after.value).toMatchObject({
      origin: "code",
      rowId: ruleRowId("basiszinssatz", "2026-01-01"),
      value: { rateBp: 127 },
    });

    const view = ruleOverview([BASISZINSSATZ], [conflicting], "2026-02-15" as CalendarDate)[0];
    const sameStart = view?.rows.filter((r) => r.validFrom === "2026-01-01") ?? [];
    expect(sameStart.map((r) => [r.origin, r.value, r.current])).toEqual(
      expect.arrayContaining([
        ["code", "1,27 %", false],
        ["override", "2 %", true],
      ]),
    );
    // Outside the override range the shipped row is the effective one again.
    const later = ruleOverview([BASISZINSSATZ], [conflicting], "2026-04-01" as CalendarDate)[0];
    expect(later?.rows.find((r) => r.validFrom === "2026-01-01" && r.origin === "code")?.current).toBe(true);
  });
});
