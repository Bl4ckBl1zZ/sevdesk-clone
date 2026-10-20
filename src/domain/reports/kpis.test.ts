import { describe, expect, test } from "vitest";
import { kpiRange } from "./kpis";

describe("dashboard KPI periods (RPT-002)", () => {
  test("RPT-002 month, quarter and year run to today; a custom range is validated", () => {
    expect(kpiRange("month", "2026-10-20")).toEqual({ from: "2026-10-01", to: "2026-10-20" });
    expect(kpiRange("quarter", "2026-11-05")).toEqual({ from: "2026-10-01", to: "2026-11-05" });
    expect(kpiRange("quarter", "2026-02-05")).toEqual({ from: "2026-01-01", to: "2026-02-05" });
    expect(kpiRange("year", "2026-10-20")).toEqual({ from: "2026-01-01", to: "2026-10-20" });
    expect(kpiRange("custom", "2026-10-20", "2026-03-01", "2026-03-31")).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(kpiRange("custom", "2026-10-20", "2026-04-01", "2026-03-31")).toBeNull();
    expect(kpiRange("custom", "2026-10-20")).toBeNull();
  });
});
