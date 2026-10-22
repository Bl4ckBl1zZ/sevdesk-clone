import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import {
  chartAt,
  fiscalYearEnd,
  fiscalYearOf,
  fiscalYearStart,
  futureDateNotice,
  icSupplyTaxPoint,
  isBeforeBookkeepingStart,
  periodOf,
  resolvePostingDate,
  supplyEnd,
  taxationMethodAt,
  taxPeriodOf,
} from "./period";

const d = calendarDate;

describe("periods and date-effective settings", () => {
  test("ACC-006 TST-ACC-04 EC-170 E-ACC-03 externally dated postings in a locked period move to the first open period", () => {
    const locked = new Set(["2026-09"]);
    expect(resolvePostingDate(d("2026-09-20"), "external", locked, d("2026-10-05"))).toEqual({
      ok: true,
      value: {
        date: "2026-10-05",
        period: "2026-10",
        originalDate: "2026-09-20",
        latePosting: {
          reason:
            "Der Zeitraum 09/2026 ist festgeschrieben. Die Buchung wurde in den 10/2026 übernommen (Belegdatum 20.09.2026 bleibt erhalten).",
        },
      },
    });
    // today in a later period → first day of the first open period
    expect(
      resolvePostingDate(d("2026-08-20"), "external", new Set(["2026-08", "2026-09"]), d("2026-11-03")),
    ).toMatchObject({ ok: true, value: { date: "2026-10-01", period: "2026-10" } });
    expect(resolvePostingDate(d("2026-12-31"), "external", new Set(["2026-12"]), d("2027-01-01"))).toMatchObject({
      ok: true,
      value: { date: "2027-01-01", period: "2027-01" },
    });
    expect(resolvePostingDate(d("2026-10-02"), "user", locked, d("2026-10-05"))).toEqual({
      ok: true,
      value: { date: "2026-10-02", period: "2026-10" },
    });
  });

  test("ACC-006 TST-ACC-05 E-ACC-04 user-chosen dates in a locked period are refused with period_locked", () => {
    expect(resolvePostingDate(d("2026-09-30"), "user", new Set(["2026-09"]), d("2026-10-05"))).toEqual({
      ok: false,
      error: {
        code: "period_locked",
        message:
          "Der Zeitraum 09/2026 ist festgeschrieben. Korrekturen sind nur als Gegenbuchung in einem offenen Zeitraum möglich.",
        params: { period: "2026-09" },
      },
    });
  });

  test("E-ACC-21 events in a future period post normally (open); more than 30 days ahead carries a notice", () => {
    expect(resolvePostingDate(d("2026-12-15"), "user", new Set(["2026-09"]), d("2026-10-05"))).toEqual({
      ok: true,
      value: { date: "2026-12-15", period: "2026-12" },
    });
    expect(futureDateNotice("2026-11-04", "2026-10-05")).toBeNull();
    expect(futureDateNotice("2026-11-05", "2026-10-05")).toEqual({
      code: "E-ACC-21",
      message: "Das Buchungsdatum liegt mehr als 30 Tage in der Zukunft.",
      params: { days: 31 },
    });
  });

  test("ACC-014 E-ACC-22 events before the Buchungsbeginn produce no postings", () => {
    expect(isBeforeBookkeepingStart("2026-12-31", "2027-01-01")).toBe(true);
    expect(isBeforeBookkeepingStart("2027-01-01", "2027-01-01")).toBe(false);
    expect(isBeforeBookkeepingStart("2020-01-01", undefined)).toBe(false);
  });

  test("ACC-007 EC-116 the chart is chosen per fiscal year (default SKR03); fiscal years follow the start month", () => {
    expect(fiscalYearOf("2026-03-01", 1)).toBe(2026);
    expect(fiscalYearOf("2026-03-01", 7)).toBe(2025);
    expect(fiscalYearOf("2026-07-01", 7)).toBe(2026);
    expect(fiscalYearStart(2026, 7)).toBe("2026-07-01");
    expect(fiscalYearEnd(2026, 7)).toBe("2027-06-30");
    expect(fiscalYearEnd(2026, 1)).toBe("2026-12-31");
    const charts = [
      { validFromFiscalYear: 2026, chart: "SKR04" as const },
      { validFromFiscalYear: 2028, chart: "SKR03" as const },
    ];
    expect(chartAt(charts, 1, "2026-05-01")).toBe("SKR04");
    expect(chartAt(charts, 1, "2027-12-31")).toBe("SKR04");
    expect(chartAt(charts, 1, "2028-01-01")).toBe("SKR03");
    expect(chartAt(charts, 1, "2025-12-31")).toBe("SKR03");
    expect(chartAt([], 1, "2026-01-01")).toBe("SKR03");
  });

  test("ACC-022 EC-115 Soll/Ist is applied by its validFrom (default Soll)", () => {
    const methods = [
      { validFrom: "2026-01-01", method: "soll" as const },
      { validFrom: "2027-01-01", method: "ist" as const },
    ];
    expect(taxationMethodAt(methods, "2026-12-31")).toBe("soll");
    expect(taxationMethodAt(methods, "2027-01-01")).toBe("ist");
    expect(taxationMethodAt([], "2027-01-01")).toBe("soll");
  });

  test("TAX-008 tax point helpers and filing periods (monthly, quarterly, annual, unknown year)", () => {
    expect(periodOf("2026-09-30")).toBe("2026-09");
    expect(supplyEnd({ kind: "date", date: "2026-02-03" })).toBe("2026-02-03");
    expect(supplyEnd({ kind: "period", from: "2026-01-15", to: "2026-02-14" })).toBe("2026-02-14");
    expect(supplyEnd({ kind: "month", month: "2028-02" })).toBe("2028-02-29");
    expect(icSupplyTaxPoint("2026-03-10", { kind: "month", month: "2026-03" })).toBe("2026-03-10");
    expect(icSupplyTaxPoint("2026-12-20", { kind: "date", date: "2026-11-02" })).toBe("2026-12-20");
    expect(icSupplyTaxPoint("2027-01-20", { kind: "date", date: "2026-11-30" })).toBe("2026-12-31");
    const rows = [
      { year: 2026, period: "monthly" as const },
      { year: 2027, period: "quarterly" as const },
      { year: 2028, period: "annual_only" as const },
    ];
    expect(taxPeriodOf("2026-09-30", rows)).toBe("2026-09");
    expect(taxPeriodOf("2027-11-02", rows)).toBe("2027-Q4");
    expect(taxPeriodOf("2028-05-05", rows)).toBe("2028");
    expect(taxPeriodOf("2029-05-05", rows)).toBeUndefined();
  });
});
