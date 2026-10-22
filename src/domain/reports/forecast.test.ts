import { describe, expect, test } from "vitest";
import { addDays, type CalendarDate } from "../time/calendar-date";
import {
  computeForecast,
  median,
  NO_HISTORY_NOTICE,
  paymentDelays,
  percentile,
  plannedItemInputs,
  validatePlannedItem,
} from "./forecast";

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

describe("forecast items and planned items (RPT-013)", () => {
  test("RPT-013 a monthly planned item expands to its occurrences inside the 90 days (end date honoured, day clamped)", () => {
    const items = plannedItemInputs(
      [
        { id: "rent", label: "Miete", cents: -120_000, date: "2026-08-31", recurrence: "P1M", confidence: "high" },
        {
          id: "grant",
          label: "Förderung",
          cents: 500_000,
          date: "2026-11-15",
          recurrence: "once",
          confidence: "low",
        },
        {
          id: "ended",
          label: "Altvertrag",
          cents: -1_000,
          date: "2026-01-01",
          recurrence: "P1M",
          endDate: "2026-11-30",
          confidence: "medium",
        },
      ],
      TODAY,
    );
    expect(items.map((i) => [i.id, i.date, i.cents, i.confidence])).toEqual([
      ["rent:2026-10-31", "2026-10-31", -120_000, "high"],
      ["rent:2026-11-30", "2026-11-30", -120_000, "high"],
      ["rent:2026-12-31", "2026-12-31", -120_000, "high"],
      ["grant", "2026-11-15", 500_000, "low"],
      ["ended:2026-11-01", "2026-11-01", -1_000, "medium"],
    ]);
    expect(items.every((i) => i.source === "planned")).toBe(true);
  });

  test("RPT-013 every item carries source, expected date, amount and a confidence; planned items move the balance", () => {
    const f = computeForecast({
      today: TODAY,
      openingCents: 0,
      history,
      items: [
        { id: "inv1", source: "receivable", label: "RE-1", cents: 50_000, date: d(5), contactId: "c1" },
        { id: "inv2", source: "receivable", label: "RE-2", cents: 10_000, date: d(5), contactId: "new" },
        { id: "v1", source: "payable", label: "ER-1", cents: -5_000, date: d(3) },
        { id: "t1", source: "tax", label: "UStVA", cents: -2_000, date: d(20) },
        ...plannedItemInputs(
          [{ id: "p", label: "Darlehen", cents: 30_000, date: d(1), recurrence: "once", confidence: "medium" }],
          TODAY,
        ),
      ],
    });
    expect(f.items.map((i) => [i.id, i.source, i.confidence])).toEqual([
      ["p", "planned", "medium"],
      ["v1", "payable", "high"],
      ["inv1", "receivable", "high"],
      ["inv2", "receivable", "medium"],
      ["t1", "tax", "medium"],
    ]);
    expect(f.days[1]?.expectedCents).toBe(30_000);
  });

  test("RPT-013 E-RPT-09 receivables without any history and dunning level ≥ 2 are low confidence", () => {
    const f = computeForecast({
      today: TODAY,
      openingCents: 0,
      history: [],
      items: [
        { id: "a", source: "receivable", label: "RE-A", cents: 1_000, date: d(2), contactId: "x" },
        { id: "b", source: "receivable", label: "RE-B", cents: 1_000, date: d(2), contactId: "x", dunningLevel: 2 },
      ],
    });
    expect(f.items.map((i) => i.confidence)).toEqual(["low", "low"]);
  });

  test("RPT-013 planned item validation: label, non-zero integer amount, valid dates, end ≥ start, known recurrence", () => {
    expect(
      validatePlannedItem({
        label: "Miete",
        cents: -120_000,
        date: "2026-11-01",
        recurrence: "P1M",
        confidence: "high",
      }),
    ).toEqual([]);
    expect(
      validatePlannedItem({
        label: " ",
        cents: 0,
        date: "2026-13-01",
        recurrence: "weekly" as never,
        endDate: "2026-01-01",
        confidence: "sure" as never,
      }).map((i) => i.field),
    ).toEqual(["label", "cents", "date", "recurrence", "confidence"]);
    expect(
      validatePlannedItem({
        label: "x",
        cents: 1.5,
        date: "2026-11-01",
        recurrence: "once",
        endDate: "2026-10-01",
        confidence: "low",
      }).map((i) => [i.field, i.message]),
    ).toEqual([
      ["cents", "Bitte einen Betrag ungleich 0 € eingeben."],
      ["endDate", "Das Enddatum darf nicht vor dem ersten Termin liegen."],
    ]);
  });
});
