/**
 * Statement rows in a locked period (F07 EC-BNK-51, EC-170, GOBD-06): the bank data is imported unchanged (booked
 * rows are facts), but their bookings move to the first open period by the ACC-006 late-posting rule — the same rule
 * `postJournalEntry` applies to externally dated events (`resolvePostingDate(…, "external")`). Pure.
 */
import { periodOf, resolvePostingDate } from "../accounting/period";
import { type CalendarDate, calendarDate } from "../time/calendar-date";

export interface LockedPeriodNotice {
  /** The locked month of the rows (`YYYY-MM`). */
  period: string;
  /** The first open month their bookings go to. */
  openPeriod: string;
  rows: number;
  message: string;
}

const mmYyyy = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;

/** One notice per locked month that new rows fall into. */
export function lockedPeriodNotices(
  bookingDates: readonly string[],
  closedPeriods: ReadonlySet<string>,
  today: string,
): LockedPeriodNotice[] {
  const byPeriod = new Map<string, number>();
  for (const d of bookingDates) {
    const p = periodOf(d);
    if (closedPeriods.has(p)) byPeriod.set(p, (byPeriod.get(p) ?? 0) + 1);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, rows]) => {
      const r = resolvePostingDate(
        calendarDate(`${period}-01`),
        "external",
        closedPeriods,
        calendarDate(today) as CalendarDate,
      );
      const openPeriod = r.ok ? r.value.period : period;
      return {
        period,
        openPeriod,
        rows,
        message: `Umsätze aus festgeschriebenem Zeitraum ${mmYyyy(period)} werden im Zeitraum ${mmYyyy(openPeriod)} gebucht.`,
      };
    });
}
