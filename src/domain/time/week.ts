/**
 * ISO weeks (Monday–Sunday) on calendar dates. Pure. Used by the week view of the time entries (F11 §6) and the
 * utilisation per week of the time reports (PRJ-017).
 */
import { addDays, type CalendarDate, toEpochDay } from "./calendar-date";

/** 1 = Monday … 7 = Sunday (1970-01-01 was a Thursday). */
export function isoWeekday(date: CalendarDate): number {
  return ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1;
}

/** The Monday of the ISO week containing `date`. */
export const weekStart = (date: CalendarDate): CalendarDate => addDays(date, 1 - isoWeekday(date));

/** The seven dates Monday … Sunday of the week starting at (or containing) `date`. */
export function weekDays(date: CalendarDate): CalendarDate[] {
  const monday = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** ISO 8601 week number and week-based year (the week belongs to the year of its Thursday). */
export function isoWeek(date: CalendarDate): { year: number; week: number } {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = Number(thursday.slice(0, 4));
  const jan1 = `${year}-01-01` as CalendarDate;
  return { year, week: Math.floor((toEpochDay(thursday) - toEpochDay(jan1)) / 7) + 1 };
}

/** „KW 43/2026“ */
export function weekLabel(date: CalendarDate): string {
  const { year, week } = isoWeek(date);
  return `KW ${week}/${year}`;
}
