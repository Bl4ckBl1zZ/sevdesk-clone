import { describe, expect, test } from "vitest";
import { addDays, type CalendarDate, calendarDate, daysInMonth } from "../time/calendar-date";
import {
  dueOccurrences,
  indexOf,
  isEnded,
  occurrenceAt,
  periodFor,
  periodText,
  planRun,
  planRunNow,
  previewOccurrences,
  RECURRING_INTERVALS,
  type ScheduleState,
  skipPast,
} from "./schedule";

const d = (s: string) => calendarDate(s);

const monthly = (over: Partial<ScheduleState> = {}): ScheduleState => ({
  interval: "P1M",
  firstDate: d("2026-11-01"),
  nextDate: d("2026-11-01"),
  billing: "in_advance",
  ...over,
});

describe("REC-02 intervals and the anchor rule", () => {
  test("REC-02 EC-096 T-REC-002 monthly from 31.01. keeps the anchor day: 28.02. → 31.03. → 30.04. …", () => {
    const first = d("2026-01-31");
    const dates = Array.from({ length: 24 }, (_, i) => occurrenceAt(first, "P1M", i));
    expect(dates.slice(0, 6)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
    expect(dates[13]).toBe("2027-02-28");
    // leap year 2028 is outside the 24 steps; check it explicitly
    expect(occurrenceAt(first, "P1M", 25)).toBe("2028-02-29");
  });

  test("REC-02 EC-096 T-REC-002 every interval code: 24 steps from 31.01.2026 keep the anchor and stay contiguous", () => {
    const first = d("2026-01-31");
    for (const interval of RECURRING_INTERVALS) {
      for (let i = 0; i < 24; i++) {
        const occ = occurrenceAt(first, interval, i);
        const next = occurrenceAt(first, interval, i + 1);
        expect(next > occ).toBe(true);
        if (interval === "P7D" || interval === "P14D") {
          expect(next).toBe(addDays(occ, interval === "P7D" ? 7 : 14));
        } else {
          // anchor day 31 clamped to the month length
          const day = Number(occ.slice(8, 10));
          expect(day).toBe(Math.min(31, daysInMonth(Number(occ.slice(0, 4)), Number(occ.slice(5, 7)))));
        }
        // in-advance periods are contiguous: no gap, no overlap
        const p = periodFor(first, interval, i, "in_advance");
        const q = periodFor(first, interval, i + 1, "in_advance");
        expect(q.from).toBe(addDays(p.to, 1));
        expect(indexOf(first, interval, occ)).toBe(i);
      }
    }
  });

  test("REC-02 EC-096 yearly from 29.02.2028 → 28.02.2029 … → 29.02.2032 (leap-year anchor)", () => {
    const first = d("2028-02-29");
    expect([0, 1, 2, 3, 4].map((i) => occurrenceAt(first, "P1Y", i))).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  test("REC-02 EC-096 quarterly from 31.01. → 30.04. → 31.07. → 31.10.", () => {
    expect([0, 1, 2, 3].map((i) => occurrenceAt(d("2026-01-31"), "P3M", i))).toEqual([
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
    ]);
  });
});

describe("REC-04 billing periods", () => {
  test("REC-04 T-REC-001 monthly in advance from 01.11.2026 bills 01.11.–30.11.2026", () => {
    expect(periodFor(d("2026-11-01"), "P1M", 0, "in_advance")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  test("REC-04 T-REC-004 in arrears monthly on 01.12.2026 bills 01.11.–30.11.2026", () => {
    expect(periodFor(d("2026-12-01"), "P1M", 0, "in_arrears")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(periodFor(d("2026-12-01"), "P1M", 1, "in_arrears")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  test("REC-04 EC-096 periods of a 31st anchor are contiguous: 31.01.–27.02., 28.02.–30.03., 31.03.–29.04.", () => {
    const first = d("2026-01-31");
    expect([0, 1, 2].map((i) => periodFor(first, "P1M", i, "in_advance"))).toEqual([
      { from: "2026-01-31", to: "2026-02-27" },
      { from: "2026-02-28", to: "2026-03-30" },
      { from: "2026-03-31", to: "2026-04-29" },
    ]);
  });

  test("REC-04 period text placeholder in German and English", () => {
    const p = { from: d("2026-11-01"), to: d("2026-11-30") };
    expect(periodText(p, "de")).toBe("Berechnung für den Zeitraum vom 01.11.2026 bis 30.11.2026");
    expect(periodText(p, "en")).toBe("Billing period from 01.11.2026 to 30.11.2026");
  });
});

describe("REC-03 end conditions", () => {
  test("REC-03 T-REC-003 maxCount = 3: ended after the 3rd invoice", () => {
    const s = monthly({ maxCount: 3 });
    expect(isEnded(s, 2)).toBe(false);
    expect(isEnded(s, 3)).toBe(true);
    const plan = planRun({
      schedule: s,
      generatedCount: 2,
      today: d("2027-06-01"),
      catchUpAutoMax: 10,
      finalize: false,
    });
    expect(plan.occurrences).toHaveLength(1);
    expect(plan.ended).toBe(true);
  });

  test("REC-03 T-REC-003 endDate: the last occurrence is ≤ endDate", () => {
    const s = monthly({ endDate: d("2027-01-15") });
    expect(previewOccurrences(s, 0).map((o) => o.date)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(isEnded({ ...s, nextDate: d("2027-02-01") }, 3)).toBe(true);
  });
});

describe("REC-05/06 due occurrences and catch-up", () => {
  test("REC-05 nothing is due before the first date; on the day exactly one", () => {
    expect(dueOccurrences(monthly(), 0, d("2026-10-31"))).toEqual([]);
    expect(dueOccurrences(monthly(), 0, d("2026-11-01")).map((o) => o.date)).toEqual(["2026-11-01"]);
  });

  test("REC-06 EC-092 T-EC-092 weekly + 20-day outage: 3 occurrences, oldest first, automated", () => {
    const s: ScheduleState = { ...monthly(), interval: "P7D", firstDate: d("2026-11-02"), nextDate: d("2026-11-02") };
    const plan = planRun({ schedule: s, generatedCount: 0, today: d("2026-11-16"), catchUpAutoMax: 3, finalize: true });
    expect(plan.occurrences.map((o) => o.date)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(plan.occurrences.map((o) => o.period.from)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(plan.automated).toBe(true);
    expect(plan.catchUpOverflow).toBe(false);
    expect(plan.nextDate).toBe("2026-11-23");
    expect(plan.generatedCount).toBe(3);
  });

  test("REC-06 EC-092 T-EC-092 a 30-day outage: 4 occurrences > catchUpAutoMax 3 → drafts without automation", () => {
    const s: ScheduleState = { ...monthly(), interval: "P7D", firstDate: d("2026-11-02"), nextDate: d("2026-11-02") };
    const plan = planRun({ schedule: s, generatedCount: 0, today: d("2026-11-25"), catchUpAutoMax: 3, finalize: true });
    expect(plan.occurrences).toHaveLength(4);
    expect(plan.automated).toBe(false);
    expect(plan.catchUpOverflow).toBe(true);
  });

  test("REC-07 without finalise automation nothing is automated", () => {
    const plan = planRun({
      schedule: monthly(),
      generatedCount: 0,
      today: d("2026-11-01"),
      catchUpAutoMax: 3,
      finalize: false,
    });
    expect(plan.automated).toBe(false);
  });
});

describe("REC-10 skip on resume, REC-12 run now, REC-13 preview", () => {
  test("REC-10 T-REC-007 two past occurrences are skipped; nextDate = first occurrence on or after today", () => {
    const r = skipPast(monthly(), 0, d("2026-12-15"));
    expect(r.skipped.map((o) => o.date)).toEqual(["2026-11-01", "2026-12-01"]);
    expect(r.nextDate).toBe("2027-01-01");
    // an occurrence on today is not past
    expect(skipPast(monthly(), 0, d("2026-12-01")).nextDate).toBe("2026-12-01");
  });

  test("REC-12 T-REC-009 run now generates the next occurrence and advances nextDate", () => {
    const plan = planRunNow({ schedule: monthly(), generatedCount: 0, finalize: false });
    expect(plan.occurrences.map((o) => o.date)).toEqual(["2026-11-01"]);
    expect(plan.nextDate).toBe("2026-12-01");
    expect(planRunNow({ schedule: monthly({ maxCount: 1 }), generatedCount: 1, finalize: false }).occurrences).toEqual(
      [],
    );
  });

  test("REC-13 T-REC-010 the next 12 occurrences with contiguous periods", () => {
    const list = previewOccurrences(monthly(), 0);
    expect(list).toHaveLength(12);
    expect(list[0]).toMatchObject({ date: "2026-11-01", period: { from: "2026-11-01", to: "2026-11-30" } });
    expect(list[11]).toMatchObject({ date: "2027-10-01", period: { from: "2027-10-01", to: "2027-10-31" } });
    for (let i = 1; i < list.length; i++) {
      expect(list[i]?.period.from).toBe(addDays(list[i - 1]?.period.to as CalendarDate, 1));
    }
  });
});
