import { describe, expect, test } from "vitest";
import { berlinCalendarDate, berlinWallClockInstant } from "../time/berlin";
import { calendarDate } from "../time/calendar-date";
import {
  buildManualEntry,
  checkDurationRange,
  entryLock,
  formatMinutes,
  isGenericDescription,
  isIncomplete,
  minutesBetween,
  overlapCount,
  overlapWarning,
  parseClockTime,
  parseDuration,
  periodLabel,
  spansFromInstants,
  TIME_MESSAGES,
  timerAlert,
  timerRunningConfirm,
} from "./time-entries";

const d = calendarDate;
const minutes = (s: string) => {
  const r = parseDuration(s);
  return r.ok ? r.value : r.error.code;
};

describe("PRJ-007 duration input", () => {
  test("PRJ-007 TST-PRJ-04 parses 1:30, 1,5, 1.5h, 90m and 2h 15m; abc → E-PRJ-08", () => {
    expect(["1:30", "1,5", "1.5h", "90m", "2h 15m"].map(minutes)).toEqual([90, 90, 90, 90, 135]);
    expect(minutes("abc")).toBe("duration_unparsed");
    const r = parseDuration("abc");
    expect(r.ok ? "" : r.error.message).toBe("Dauer nicht erkannt. Beispiele: 1:30, 1,5, 90m, 2h 15m.");
  });

  test("PRJ-007 more notations: plain hours, minutes words, decimal minutes rounding half-up", () => {
    expect(minutes("2")).toBe(120);
    expect(minutes(" 0,25 ")).toBe(15);
    expect(minutes("1,333")).toBe(80); // 79.98 → 80
    expect(minutes("2 Std.")).toBe(120);
    expect(minutes("45 min")).toBe(45);
    expect(minutes("2h15m")).toBe(135);
    expect(minutes("1,5h 30m")).toBe(120);
    expect(minutes("3h")).toBe(180);
    expect(minutes("10:05")).toBe(605);
    expect(minutes("")).toBe("duration_unparsed");
    expect(minutes("h")).toBe("duration_unparsed");
    expect(minutes("1:75")).toBe("duration_unparsed");
  });

  test("PRJ-007 E-PRJ-05 durations must lie between 1 minute and 24 hours", () => {
    expect(checkDurationRange(1)).toBeNull();
    expect(checkDurationRange(1440)).toBeNull();
    expect(checkDurationRange(0)?.message).toBe(TIME_MESSAGES.durationRange);
    expect(checkDurationRange(1441)?.code).toBe("duration_range");
    expect(checkDurationRange(1.5)?.code).toBe("duration_range");
  });

  test("PRJ-007 formats minutes and parses clock times", () => {
    expect(formatMinutes(135)).toBe("2:15 h");
    expect(formatMinutes(-5)).toBe("−0:05 h");
    expect(parseClockTime("9:30")).toBe(570);
    expect(parseClockTime("23.59")).toBe(1439);
    expect(parseClockTime("24:00")).toBeNull();
  });

  test("PRJ-007 E-PRJ-04/06/08/09 manual entry validation with German messages", () => {
    const today = d("2026-10-20");
    const ok = buildManualEntry(
      { date: d("2026-10-19"), duration: "1:30", description: "Workshop-Vorbereitung" },
      today,
    );
    expect(ok).toMatchObject({ ok: true, value: { durationMinutes: 90, warnings: [] } });
    const times = buildManualEntry(
      { date: d("2026-10-19"), startTime: "09:00", endTime: "10:30", description: "Workshop Kunde" },
      today,
    );
    expect(times.ok && times.value.durationMinutes).toBe(90);
    expect(times.ok && berlinCalendarDate(times.value.startedAt ?? 0)).toBe("2026-10-19");
    const bad = buildManualEntry(
      { date: d("2026-10-21"), startTime: "10:00", endTime: "09:00", description: "ab" },
      today,
    );
    expect(bad.ok ? [] : bad.error.map((i) => [i.field, i.message])).toEqual([
      ["date", "Zeiten können nicht für die Zukunft erfasst werden."],
      ["description", TIME_MESSAGES.description],
      ["endTime", "Das Ende liegt vor dem Beginn."],
    ]);
    const unparsed = buildManualEntry({ date: today, duration: "viel", description: "Konzept" }, today);
    expect(unparsed.ok ? null : unparsed.error[0]?.field).toBe("duration");
    const badTime = buildManualEntry({ date: today, startTime: "x", endTime: "25:00", description: "Konzept" }, today);
    expect(badTime.ok ? [] : badTime.error.map((i) => i.field)).toEqual(["startTime", "endTime"]);
    const long = buildManualEntry({ date: today, duration: "25h", description: "Konzept" }, today);
    expect(long.ok ? null : long.error[0]?.code).toBe("duration_range");
    const generic = buildManualEntry({ date: today, duration: "1h", description: "Arbeit" }, today);
    expect(generic.ok && generic.value.warnings[0]?.message).toBe(
      "Die Beschreibung ist sehr allgemein und erscheint so auf der Rechnung.",
    );
    expect(isGenericDescription("Diverses.")).toBe(true);
    expect(isGenericDescription("Konzeption Startseite")).toBe(false);
  });

  test("PRJ-007 E-PRJ-07 overlapping entries are counted (warning only)", () => {
    const a = { startedAt: 0, endedAt: 3_600_000 };
    expect(
      overlapCount(a, [{ startedAt: 1_800_000, endedAt: 5_000_000 }, { startedAt: 3_600_000, endedAt: 4e6 }, {}]),
    ).toBe(1);
    expect(overlapCount({}, [a])).toBe(0);
    expect(overlapWarning(2)).toBe("Diese Zeit überschneidet sich mit 2 anderen Einträgen.");
  });
});

describe("PRJ-006 durations from instants", () => {
  test("PRJ-006 EC-020 TST-PRJ-03 E-PRJ-27 a timer 01:30–03:30 wall clock on the DST end day is 180 minutes", () => {
    // 25 Oct 2026: clocks go back 03:00 CEST → 02:00 CET. 01:30 CEST = 23:30Z, 03:30 CET = 02:30Z.
    const start = Date.UTC(2026, 9, 24, 23, 30);
    const end = Date.UTC(2026, 9, 25, 2, 30);
    expect(spansFromInstants(start, end)).toEqual([
      { date: "2026-10-25", startedAt: start, endedAt: end, durationMinutes: 180 },
    ]);
    // the same wall times entered manually resolve through the Berlin offsets
    const manual = buildManualEntry(
      { date: d("2026-10-25"), startTime: "01:30", endTime: "03:30", description: "Nachtwartung Server" },
      d("2026-10-25"),
    );
    expect(manual.ok && manual.value.durationMinutes).toBe(180);
    // spring forward: 01:30–03:30 on 29 Mar 2026 is one hour
    const spring = buildManualEntry(
      { date: d("2026-03-29"), startTime: "01:30", endTime: "03:30", description: "Nachtwartung Server" },
      d("2026-03-29"),
    );
    expect(spring.ok && spring.value.durationMinutes).toBe(60);
  });

  test("PRJ-006 E-PRJ-28 23:50–00:20 stays one entry dated the start day; the split option cuts at Berlin midnight", () => {
    const start = Date.UTC(2026, 9, 12, 21, 50); // 23:50 CEST
    const end = Date.UTC(2026, 9, 12, 22, 20); // 00:20 CEST next day
    expect(spansFromInstants(start, end)).toEqual([
      { date: "2026-10-12", startedAt: start, endedAt: end, durationMinutes: 30 },
    ]);
    const split = spansFromInstants(start, end, { splitAtMidnight: true });
    expect(split.map((s) => [s.date, s.durationMinutes])).toEqual([
      ["2026-10-12", 10],
      ["2026-10-13", 20],
    ]);
    expect(spansFromInstants(end, start)).toEqual([]);
    expect(minutesBetween(0, 29_999)).toBe(0);
    expect(minutesBetween(0, 30_000)).toBe(1);
  });

  test("PRJ-006 wall-clock instants: the repeated autumn hour takes summer time, the skipped spring hour moves on", () => {
    expect(berlinWallClockInstant(d("2026-10-25"), 150)).toBe(Date.UTC(2026, 9, 25, 0, 30)); // 02:30 CEST
    expect(berlinWallClockInstant(d("2026-03-29"), 150)).toBe(Date.UTC(2026, 2, 29, 1, 30)); // → 03:30 CEST
    expect(berlinWallClockInstant(d("2026-07-01"), 0)).toBe(Date.UTC(2026, 5, 30, 22, 0));
    expect(() => berlinWallClockInstant(d("2026-07-01"), 1440)).toThrow(/instant_invalid/);
  });
});

describe("PRJ-005 timer", () => {
  test("PRJ-005 E-PRJ-01/02/03 confirmation text, incomplete flag and the 10 h / 24 h alerts", () => {
    expect(timerRunningConfirm("Website", 75)).toBe(
      "Es läuft bereits ein Timer (Website, 1:15 h). Stoppen und neuen Timer starten?",
    );
    expect(timerRunningConfirm(undefined, 5)).toContain("ohne Projekt");
    expect(isIncomplete({ description: "Workshop", projectId: "p1" })).toBe(false);
    expect(isIncomplete({ description: "Workshop" })).toBe(true);
    expect(isIncomplete({ contactId: "c1" })).toBe(true);
    const h = 3_600_000;
    expect(timerAlert({ startedAt: 0 }, 10 * h - 1)).toBe("none");
    expect(timerAlert({ startedAt: 0 }, 10 * h)).toBe("warn_10h");
    expect(timerAlert({ startedAt: 0 }, 24 * h)).toBe("auto_stop_24h");
  });
});

describe("PRJ-012 entry locking", () => {
  test("PRJ-012 E-PRJ-10/11 only open entries are editable", () => {
    expect(entryLock({ status: "open" })).toBeNull();
    expect(entryLock({ status: "in_draft" })?.message).toBe(
      "Dieser Eintrag ist in Rechnungsentwurf Entwurf enthalten. Entfernen Sie ihn dort zuerst.",
    );
    expect(entryLock({ status: "invoiced", documentLabel: "RE-2026-0007" })?.message).toBe(
      "Dieser Eintrag wurde mit Rechnung RE-2026-0007 abgerechnet und kann nicht mehr geändert werden.",
    );
    expect(entryLock({ status: "invoiced" })?.code).toBe("time_entry_locked");
  });

  test("PRJ-013 period labels", () => {
    expect(periodLabel(d("2026-09-03"), d("2026-09-28"))).toBe("03.09.–28.09.2026");
    expect(periodLabel(d("2026-12-28"), d("2027-01-04"))).toBe("28.12.2026–04.01.2027");
    expect(periodLabel(d("2026-09-03"), d("2026-09-03"))).toBe("03.09.2026");
  });
});
