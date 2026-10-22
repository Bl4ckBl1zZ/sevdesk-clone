import { describe, expect, test } from "vitest";
import { formatCsv } from "../csv/export";
import { calendarDate } from "../time/calendar-date";
import { isoWeek, isoWeekday, weekDays, weekLabel, weekStart } from "../time/week";
import { type ReportEntry, TIME_REPORT_CSV_COLUMNS, timeReport, weekGrid } from "./time-report";

const d = calendarDate;
const RATE = 900_000; // 90,00 €/h

const e = (date: string, minutes: number, over: Partial<ReportEntry> = {}): ReportEntry => ({
  date: d(date),
  durationMinutes: minutes,
  billable: true,
  status: "open",
  hourlyRateMicros: RATE,
  projectId: "p1",
  projectName: "Website",
  contactId: "c1",
  contactName: "Muster GmbH",
  ...over,
});

describe("ISO weeks", () => {
  test("PRJ-017 weekday, Monday of the week, the seven days and ISO week numbers at year boundaries", () => {
    expect(isoWeekday(d("2026-10-19"))).toBe(1); // Monday
    expect(isoWeekday(d("2026-10-25"))).toBe(7); // Sunday
    expect(isoWeekday(d("1970-01-01"))).toBe(4);
    expect(weekStart(d("2026-10-25"))).toBe("2026-10-19");
    expect(weekDays(d("2026-10-21"))).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(isoWeek(d("2026-10-23"))).toEqual({ year: 2026, week: 43 });
    expect(isoWeek(d("2027-01-01"))).toEqual({ year: 2026, week: 53 }); // Friday → week of 2026
    expect(isoWeek(d("2024-12-30"))).toEqual({ year: 2025, week: 1 });
    expect(weekLabel(d("2026-10-23"))).toBe("KW 43/2026");
  });
});

describe("PRJ-017 time reports", () => {
  const entries = [
    e("2026-10-19", 120),
    e("2026-10-20", 60, { billable: false }),
    e("2026-10-21", 90, { status: "invoiced" }),
    e("2026-10-22", 30, { projectId: "p2", projectName: "Shop", productId: "pr1", productName: "Support" }),
    e("2026-10-27", 240, { projectId: undefined, projectName: undefined, contactId: "c2", contactName: "Beispiel AG" }),
    e("2026-09-30", 600), // outside the period
  ];

  test("PRJ-017 hours per project in the period: billable vs non-billable, unbilled and billed value", () => {
    const r = timeReport(entries, { groupBy: "project", from: d("2026-10-01"), to: d("2026-10-31") });
    expect(r.rows.map((x) => [x.label, x.minutes, x.billableMinutes, x.nonBillableMinutes])).toEqual([
      ["Website", 270, 210, 60],
      ["ohne Projekt", 240, 240, 0],
      ["Shop", 30, 30, 0],
    ]);
    const website = r.rows[0];
    expect(website).toMatchObject({
      unbilledMinutes: 120,
      unbilledValueCents: 18_000,
      billedValueCents: 13_500,
      entries: 3,
    });
    expect(r.totals).toMatchObject({ minutes: 540, billableMinutes: 480, nonBillableMinutes: 60, entries: 5 });
    expect(r.totals.unbilledValueCents).toBe(18_000 + 36_000 + 4_500);
  });

  test("PRJ-017 grouping by customer, product, month and week", () => {
    const period = { from: d("2026-09-01"), to: d("2026-10-31") };
    expect(timeReport(entries, { ...period, groupBy: "customer" }).rows.map((x) => [x.label, x.minutes])).toEqual([
      ["Muster GmbH", 900],
      ["Beispiel AG", 240],
    ]);
    expect(timeReport(entries, { ...period, groupBy: "product" }).rows.map((x) => [x.label, x.minutes])).toEqual([
      ["ohne Leistung", 1110],
      ["Support", 30],
    ]);
    expect(timeReport(entries, { ...period, groupBy: "month" }).rows.map((x) => [x.label, x.minutes])).toEqual([
      ["09/2026", 600],
      ["10/2026", 540],
    ]);
    expect(timeReport(entries, { ...period, groupBy: "week" }).rows.map((x) => [x.key, x.label])).toEqual([
      ["2026-09-28", "KW 40/2026"],
      ["2026-10-19", "KW 43/2026"],
      ["2026-10-26", "KW 44/2026"],
    ]);
  });

  test("PRJ-017 utilisation per week is the billable share of the tracked time", () => {
    const r = timeReport(entries, { groupBy: "project", from: d("2026-10-01"), to: d("2026-10-31") });
    expect(r.weeks.map((w) => [w.label, w.minutes, w.billableMinutes, w.utilisationBp])).toEqual([
      ["KW 43/2026", 300, 240, 8000],
      ["KW 44/2026", 240, 240, 10_000],
    ]);
    expect(timeReport([], { groupBy: "project", from: d("2026-10-01"), to: d("2026-10-31") }).weeks).toEqual([]);
  });

  test("PRJ-017 EXP-021 the report exports as CSV (Excel: German headers, euros; technical: cents and IDs)", () => {
    const r = timeReport(entries.slice(0, 3), { groupBy: "project", from: d("2026-10-01"), to: d("2026-10-31") });
    const excel = formatCsv(TIME_REPORT_CSV_COLUMNS, r.rows, "excel");
    expect(excel.startsWith("﻿Gruppe;Minuten gesamt;")).toBe(true);
    expect(excel).toContain("Website;270;210;60;120;180,00;135,00;3");
    const tech = formatCsv(TIME_REPORT_CSV_COLUMNS, r.rows, "technical");
    expect(tech.split("\r\n")[0]).toBe(
      "group,group_id,minutes,billable_minutes,non_billable_minutes,unbilled_minutes,unbilled_value_cents,billed_value_cents,entries",
    );
    expect(tech).toContain("Website,p1,270,210,60,120,18000,13500,3");
  });
});

describe("week view", () => {
  test("PRJ-017 Monday–Sunday grid with one row per project (else customer) and totals per day and row", () => {
    const g = weekGrid(
      [
        e("2026-10-19", 120),
        e("2026-10-19", 30, { projectId: "p2", projectName: "Shop" }),
        e("2026-10-25", 45),
        e("2026-10-21", 60, { projectId: undefined, projectName: undefined }),
        e("2026-10-26", 600), // next week
      ],
      d("2026-10-22"),
    );
    expect(g.label).toBe("KW 43/2026 · 19.10.2026–25.10.2026");
    expect(g.days[0]).toBe("2026-10-19");
    expect(g.rows.map((r) => [r.label, r.minutesByDay, r.total])).toEqual([
      ["Muster GmbH", [0, 0, 60, 0, 0, 0, 0], 60],
      ["Shop", [30, 0, 0, 0, 0, 0, 0], 30],
      ["Website", [120, 0, 0, 0, 0, 0, 45], 165],
    ]);
    expect(g.dayTotals).toEqual([150, 0, 60, 0, 0, 0, 45]);
    expect(g.total).toBe(255);
  });
});
