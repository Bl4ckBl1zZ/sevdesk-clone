/**
 * F09 EXP-025 (GOBD-23, 08-deployment §7 „long-term readability"): on 31.01. the owner is reminded to create the full
 * export and the GDPdU export for the closed year and to store them off-host. Pure; `today` is passed in.
 *
 * The window runs from 31.01. to the end of February so that a missed cron run still reminds; the caller creates the
 * notification only once per year (dedupe key), so a resolved reminder is not re-opened.
 */
import type { CalendarDate } from "../time/calendar-date";

export interface ArchiveReminder {
  year: number;
  dedupeKey: string;
  title: string;
  body: string;
  link: string;
}

export const archiveReminderKey = (year: number): string => `archive_export|${year}`;

export function archiveReminderFor(
  today: CalendarDate,
  { hasBookingsInClosedYear }: { hasBookingsInClosedYear: boolean },
): ArchiveReminder | null {
  const monthDay = today.slice(5);
  if (monthDay < "01-31" || monthDay > "02-29") return null;
  if (!hasBookingsInClosedYear) return null;
  const year = Number(today.slice(0, 4)) - 1;
  return {
    year,
    dedupeKey: archiveReminderKey(year),
    title: `Jahresarchiv ${year} sichern`,
    body:
      `Bitte jetzt den vollständigen Datenexport und den GDPdU-Export für ${year} erstellen und außerhalb dieses ` +
      "Servers (EU-Speicherort) aufbewahren – so bleiben die Daten auch ohne diese Software lesbar.",
    link: "/export",
  };
}
