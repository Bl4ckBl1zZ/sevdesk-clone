import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { archiveReminderFor } from "./archive-reminder";

const d = (s: string) => s as CalendarDate;

describe("yearly archive export reminder (F09 EXP-025)", () => {
  test("EXP-025 from 31.01. a reminder suggests the full export and GDPdU for the closed year", () => {
    const r = archiveReminderFor(d("2027-01-31"), { hasBookingsInClosedYear: true });
    expect(r).toEqual({
      year: 2026,
      dedupeKey: "archive_export|2026",
      title: "Jahresarchiv 2026 sichern",
      body:
        "Bitte jetzt den vollständigen Datenexport und den GDPdU-Export für 2026 erstellen und außerhalb dieses Servers " +
        "(EU-Speicherort) aufbewahren – so bleiben die Daten auch ohne diese Software lesbar.",
      link: "/export",
    });
    // a cron run missed on 31.01. still reminds until the end of February
    expect(archiveReminderFor(d("2027-02-28"), { hasBookingsInClosedYear: true })?.year).toBe(2026);
  });

  test("EXP-025 no reminder before 31.01., after February or for a year without bookings", () => {
    expect(archiveReminderFor(d("2027-01-30"), { hasBookingsInClosedYear: true })).toBeNull();
    expect(archiveReminderFor(d("2027-03-01"), { hasBookingsInClosedYear: true })).toBeNull();
    expect(archiveReminderFor(d("2026-10-12"), { hasBookingsInClosedYear: true })).toBeNull();
    expect(archiveReminderFor(d("2027-01-31"), { hasBookingsInClosedYear: false })).toBeNull();
  });
});
