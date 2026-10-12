import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { berlinCalendarDate } from "./berlin";
import {
  addDays,
  calendarDate,
  compareDates,
  daysBetween,
  fromEpochDay,
  isCalendarDate,
  parseCalendarDate,
  toEpochDay,
} from "./calendar-date";

describe("business dates (YYYY-MM-DD, GOBD-22)", () => {
  test("GOBD-22 business dates are validated YYYY-MM-DD strings without time zone", () => {
    expect(isCalendarDate("2026-10-12")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2000-02-29")).toBe(true);
    expect(isCalendarDate("2100-02-29")).toBe(false);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-00-10")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false);
    expect(isCalendarDate("2026-10-12T00:00:00Z")).toBe(false);
    const r = parseCalendarDate("2026-02-30");
    expect(r.ok ? null : r.error.code).toBe("date_invalid");
    expect(() => calendarDate("31.12.2026")).toThrow(/date_invalid/);
  });

  test("GOBD-22 date arithmetic is pure integer math (epoch days), DST-free", () => {
    expect(toEpochDay(calendarDate("1970-01-01"))).toBe(0);
    expect(toEpochDay(calendarDate("2026-10-12"))).toBe(20_738);
    expect(fromEpochDay(20_738)).toBe("2026-10-12");
    expect(addDays(calendarDate("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(calendarDate("2028-03-01"), -1)).toBe("2028-02-29");
    expect(addDays(calendarDate("2026-03-28"), 1)).toBe("2026-03-29");
    expect(daysBetween(calendarDate("2026-06-01"), calendarDate("2026-07-31"))).toBe(60);
    expect(compareDates(calendarDate("2026-01-01"), calendarDate("2025-12-31"))).toBe(1);
    expect(compareDates(calendarDate("2025-12-31"), calendarDate("2026-01-01"))).toBe(-1);
    expect(compareDates(calendarDate("2026-01-01"), calendarDate("2026-01-01"))).toBe(0);
    expect(() => fromEpochDay(0.5)).toThrow(/date_invalid/);
  });

  test("GOBD-22 epoch-day conversion agrees with the proleptic Gregorian calendar (oracle: Date.UTC)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -200_000, max: 200_000 }), (day) => {
        const d = fromEpochDay(day);
        expect(toEpochDay(d)).toBe(day);
        expect(d).toBe(new Date(day * 86_400_000).toISOString().slice(0, 10));
        expect(daysBetween(d, addDays(d, 17))).toBe(17);
      }),
    );
  });
});

const utc = (iso: string) => Date.parse(iso);

describe("Europe/Berlin calendar date of an instant (EC-020, EC-DOC-11)", () => {
  test("EC-020 commit at 23:59:59.900 Berlin keeps the Berlin date although UTC is earlier or later", () => {
    // winter (CET, UTC+1)
    expect(berlinCalendarDate(utc("2026-01-15T22:59:59.900Z"))).toBe("2026-01-15");
    expect(berlinCalendarDate(utc("2026-01-15T23:00:00.000Z"))).toBe("2026-01-16");
    // summer (CEST, UTC+2)
    expect(berlinCalendarDate(utc("2026-07-15T21:59:59.900Z"))).toBe("2026-07-15");
    expect(berlinCalendarDate(utc("2026-07-15T22:00:00.000Z"))).toBe("2026-07-16");
  });

  test("EC-DOC-11 DST start 2026-03-29: 23:59:59.900 on the eve (CET) and on the day (CEST)", () => {
    expect(berlinCalendarDate(utc("2026-03-28T22:59:59.900Z"))).toBe("2026-03-28");
    expect(berlinCalendarDate(utc("2026-03-28T23:00:00.000Z"))).toBe("2026-03-29");
    // 01:59:59.999 CET → 03:00:00.000 CEST at 01:00Z
    expect(berlinCalendarDate(utc("2026-03-29T00:59:59.999Z"))).toBe("2026-03-29");
    expect(berlinCalendarDate(utc("2026-03-29T01:00:00.000Z"))).toBe("2026-03-29");
    expect(berlinCalendarDate(utc("2026-03-29T21:59:59.900Z"))).toBe("2026-03-29");
    expect(berlinCalendarDate(utc("2026-03-29T22:00:00.000Z"))).toBe("2026-03-30");
  });

  test("EC-DOC-11 DST end 2026-10-25: 23:59:59.900 on the eve (CEST) and on the day (CET)", () => {
    expect(berlinCalendarDate(utc("2026-10-24T21:59:59.900Z"))).toBe("2026-10-24");
    expect(berlinCalendarDate(utc("2026-10-24T22:00:00.000Z"))).toBe("2026-10-25");
    // the repeated hour 02:00–03:00 (00:00Z–02:00Z) stays on the 25th
    expect(berlinCalendarDate(utc("2026-10-25T00:30:00.000Z"))).toBe("2026-10-25");
    expect(berlinCalendarDate(utc("2026-10-25T01:30:00.000Z"))).toBe("2026-10-25");
    expect(berlinCalendarDate(utc("2026-10-25T22:59:59.900Z"))).toBe("2026-10-25");
    expect(berlinCalendarDate(utc("2026-10-25T23:00:00.000Z"))).toBe("2026-10-26");
  });

  test("EC-155 month, quarter and year ends around midnight UTC land on the Berlin date", () => {
    expect(berlinCalendarDate(utc("2026-06-30T21:59:59.999Z"))).toBe("2026-06-30");
    expect(berlinCalendarDate(utc("2026-06-30T22:00:00.000Z"))).toBe("2026-07-01");
    expect(berlinCalendarDate(utc("2026-12-31T22:59:59.999Z"))).toBe("2026-12-31");
    expect(berlinCalendarDate(utc("2026-12-31T23:30:00.000Z"))).toBe("2027-01-01");
    expect(berlinCalendarDate(utc("2026-10-31T23:30:00.000Z"))).toBe("2026-11-01");
  });

  test("GOBD-22 berlinCalendarDate matches the IANA zone for random instants and rejects invalid instants", () => {
    const oracle = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    fc.assert(
      fc.property(fc.integer({ min: utc("1990-01-01T00:00:00Z"), max: utc("2040-12-31T23:59:59Z") }), (ms) => {
        expect(berlinCalendarDate(ms)).toBe(oracle.format(ms));
      }),
    );
    expect(() => berlinCalendarDate(Number.NaN)).toThrow(/instant_invalid/);
    expect(() => berlinCalendarDate(1.5)).toThrow(/instant_invalid/);
  });
});
