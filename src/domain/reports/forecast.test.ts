import { describe, expect, test } from "vitest";
import { addDays, type CalendarDate } from "../time/calendar-date";
import { computeForecast, median, NO_HISTORY_NOTICE, paymentDelays, percentile } from "./forecast";

const TODAY = "2026-10-20" as CalendarDate;
const d = (n: number) => addDays(TODAY, n);

/** Paid invoices of customer c1 with the delays 2, 4, 10, 12, 30 days. */
const history = [2, 4, 10, 12, 30].map((delay, i) => ({
  contactId: "c1",
  dueDate: addDays("2026-03-01" as CalendarDate, i * 20),
  paidDate: addDays(addDays("2026-03-01" as CalendarDate, i * 20), delay),
}));

describe("payment behaviour (F08 §4.8, RPT-012)", () => {
  test("RPT-012 TST-RPT-07 delays 2, 4, 10, 12, 30: expected 10 days (median), cautious 12 days (P80); an invoice due in 5 days appears on day 15", () => {
    expect(paymentDelays(history, TODAY)("c1")).toEqual({
      expectedDays: 10,
      cautiousDays: 12,
      basis: "customer",
      points: 5,
    });
    const f = computeForecast({
      today: TODAY,
      openingCents: 100_000,
      history,
      items: [{ id: "inv1", source: "receivable", label: "RE-1", cents: 50_000, date: d(5), contactId: "c1" }],
    });
    expect(f.items[0]).toMatchObject({
      expectedDate: d(15),
      cautiousDate: d(17),
      expectedCents: 50_000,
      cautiousCents: 45_000,
    });
    expect(f.days).toHaveLength(90);
    expect(f.days[14]?.expectedCents).toBe(100_000);
    expect(f.days[15]?.expectedCents).toBe(150_000);
    expect(f.days[17]?.cautiousCents).toBe(145_000);
  });

  test("RPT-012 < 3 own data points use the company-wide median; only the last 10 within 24 months count", () => {
    const h = [...history, { contactId: "c2", dueDate: "2026-09-01", paidDate: "2026-09-03" }];
    // company-wide delays 2, 2, 4, 10, 12, 30 → median 7
    expect(paymentDelays(h, TODAY)("c2")).toEqual({ expectedDays: 7, cautiousDays: 7, basis: "company", points: 1 });
    const old = [{ contactId: "c3", dueDate: "2023-01-01", paidDate: "2023-03-01" }];
    expect(paymentDelays(old, TODAY)("c3").basis).toBe("none");
    expect(median([1, 2, 3, 4])).toBe(3); // 2,5 → half away from zero
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8_000)).toBe(8);
  });

  test("RPT-012 E-RPT-09 no history: due date assumed with the info", () => {
    const f = computeForecast({
      today: TODAY,
      openingCents: 0,
      history: [],
      items: [{ id: "inv1", source: "receivable", label: "RE-1", cents: 10_000, date: d(3), contactId: "c9" }],
    });
    expect(f.items[0]?.expectedDate).toBe(d(3));
    expect(f.notices).toEqual([NO_HISTORY_NOTICE]);
  });

  test("RPT-012 overdue invoices: max(today + 7, due + delay); dunning level ≥ 2 counts 50 % in the cautious scenario", () => {
    const f = computeForecast({
      today: TODAY,
      openingCents: 0,
      history,
      items: [
        { id: "a", source: "receivable", label: "A", cents: 10_000, date: d(-30), contactId: "c1" },
        { id: "b", source: "receivable", label: "B", cents: 10_000, date: d(-2), contactId: "c1", dunningLevel: 2 },
      ],
    });
    const a = f.items.find((i) => i.id === "a");
    const b = f.items.find((i) => i.id === "b");
    expect(a).toMatchObject({ expectedDate: d(7), cautiousDate: d(7) });
    expect(b).toMatchObject({ expectedDate: d(8), cautiousDate: d(10), expectedCents: 10_000, cautiousCents: 4_500 });
  });

  test("RPT-012 payables and taxes are outflows by date (overdue → today); the threshold marks the first day below it; items after 90 days are dropped", () => {
    const f = computeForecast({
      today: TODAY,
      openingCents: 50_000,
      history: [],
      thresholdCents: 20_000,
      items: [
        { id: "v1", source: "payable", label: "BE-1", cents: -20_000, date: d(-5) },
        { id: "t1", source: "tax", label: "UStVA 09/2026", cents: -15_000, date: d(20) },
        { id: "late", source: "payable", label: "BE-2", cents: -99_000, date: d(120) },
      ],
    });
    expect(f.items.map((i) => [i.id, i.expectedDate, i.cautiousCents])).toEqual([
      ["v1", TODAY, -20_000],
      ["t1", d(20), -15_000],
    ]);
    expect(f.belowThreshold).toEqual({ expected: d(20), cautious: d(20) });
    expect(f.weeks).toHaveLength(13);
    expect(f.weeks.at(-1)?.expectedCents).toBe(15_000);
  });
});
