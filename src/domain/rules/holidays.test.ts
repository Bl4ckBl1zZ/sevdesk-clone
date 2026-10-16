import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { easterSunday, isBusinessDay, publicHolidaysOf, shiftToBusinessDay } from "./holidays";

const d = (s: string) => s as CalendarDate;

describe("PAY-051 MAHN-01 § 193 BGB business days (public holidays as data)", () => {
  test("MAHN-01 Easter Sunday (Gregorian computus)", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2024)).toBe("2024-03-31");
  });

  test("MAHN-01 national holidays 2026 include Karfreitag, Ostermontag, Himmelfahrt, Pfingstmontag, 3. Oktober", () => {
    const h = publicHolidaysOf(2026, undefined).map((x) => x.date);
    expect(h).toEqual(
      expect.arrayContaining(["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-25"]),
    );
    expect(h).toEqual(expect.arrayContaining(["2026-10-03", "2026-12-25", "2026-12-26"]));
    expect(h).not.toContain("2026-10-31");
  });

  test("MAHN-01 Bundesland holidays: Reformationstag (SN), Allerheiligen (BY), Frauentag (BE), Buß- und Bettag (SN)", () => {
    expect(publicHolidaysOf(2026, "SN").map((x) => x.date)).toEqual(
      expect.arrayContaining(["2026-10-31", "2026-11-18"]),
    );
    expect(publicHolidaysOf(2026, "BY").map((x) => x.date)).toContain("2026-11-01");
    expect(publicHolidaysOf(2026, "BE").map((x) => x.date)).toContain("2026-03-08");
    expect(publicHolidaysOf(2018, "BE").map((x) => x.date)).not.toContain("2018-03-08");
  });

  test("MAHN-01 EC-DUE-01 T05-080: Saturday 2026-10-17 shifts to Monday 2026-10-19", () => {
    expect(shiftToBusinessDay(d("2026-10-17"), undefined)).toBe("2026-10-19");
    expect(isBusinessDay(d("2026-10-19"), undefined)).toBe(true);
  });

  test("MAHN-01 a deadline on Karfreitag moves past Easter Monday to Tuesday", () => {
    expect(shiftToBusinessDay(d("2026-04-03"), undefined)).toBe("2026-04-07");
  });

  test("MAHN-01 Reformationstag 2026 is a Saturday; Allerheiligen Sunday then Monday is a business day in BY", () => {
    expect(shiftToBusinessDay(d("2026-10-31"), "BY")).toBe("2026-11-02");
  });

  test("MAHN-01 a business day stays unchanged", () => {
    expect(shiftToBusinessDay(d("2026-10-15"), "BE")).toBe("2026-10-15");
  });
});
