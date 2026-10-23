import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { thresholdMonitor } from "./threshold-monitor";

const base = {
  today: calendarDate("2026-10-12"),
  priorYearCents: 0,
  currentYearCents: 0,
  taxationMethod: "soll" as const,
  bookkeepingDuty: false,
};

describe("SET-040 threshold monitor (800,000 € turnover / 80,000 € profit)", () => {
  test("SET-040 shows turnover (prior and current year) against 800,000 € and the prior-year profit against 80,000 €", () => {
    const m = thresholdMonitor({
      ...base,
      priorYearCents: 40_000_000,
      currentYearCents: 66_000_000,
      priorYearProfitCents: 2_000_000,
    });
    expect(m.bars).toEqual([
      {
        key: "turnover_prior_year",
        year: 2025,
        amountCents: 40_000_000,
        limitCents: 80_000_000,
        bp: 5000,
        level: "ok",
      },
      {
        key: "turnover_current_year",
        year: 2026,
        amountCents: 66_000_000,
        limitCents: 80_000_000,
        bp: 8250,
        level: "warn_80",
      },
      { key: "profit_prior_year", year: 2025, amountCents: 2_000_000, limitCents: 8_000_000, bp: 2500, level: "ok" },
    ]);
    expect(m.notices).toEqual([]);
    expect(m.blocking).toBe(false);
  });

  test("SET-040 the profit bar is 'unknown' until an EÜR figure exists (P3)", () => {
    const m = thresholdMonitor(base);
    expect(m.bars.find((b) => b.key === "profit_prior_year")).toEqual({
      key: "profit_prior_year",
      year: 2025,
      amountCents: null,
      limitCents: 8_000_000,
      bp: 0,
      level: "unknown",
    });
  });

  test("SET-040 crossing a limit is a warning with the § 141 AO notice — never blocking", () => {
    const m = thresholdMonitor({ ...base, priorYearCents: 80_000_001, priorYearProfitCents: 8_000_001 });
    expect(m.bars.map((b) => b.level)).toEqual(["exceeded", "ok", "exceeded"]);
    expect(m.notices.map((n) => n.code)).toContain("bookkeeping_duty_info");
    expect(m.blocking).toBe(false);
  });

  test("SET-040 a company that already keeps books (Bilanz) gets bars but no § 141 AO notice", () => {
    const m = thresholdMonitor({ ...base, priorYearCents: 90_000_000, bookkeepingDuty: true });
    expect(m.bars[0]?.level).toBe("exceeded");
    expect(m.notices.map((n) => n.code)).not.toContain("bookkeeping_duty_info");
  });
});
