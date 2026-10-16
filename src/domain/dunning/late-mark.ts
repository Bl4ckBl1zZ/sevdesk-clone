/**
 * DUN-056 / EC-DUN-33: a reminder marked sent more than {@link LATE_MARK_DAYS} calendar days after its document date
 * may print a deadline that is too short. Pure; shared by the Convex mark (warning in the result) and the UI dialog
 * (asks before anything is recorded).
 */
import { type CalendarDate, isCalendarDate, toEpochDay } from "../time/calendar-date";

export const LATE_MARK_DAYS = 3;

export const LATE_MARK_WARNING_DE = "Die im Schreiben genannte Frist ist ggf. zu kurz – Mahnung neu erstellen?";

export function isLateMark(documentDate: string | null | undefined, sentOn: string): boolean {
  if (!documentDate || !isCalendarDate(documentDate) || !isCalendarDate(sentOn)) return false;
  return toEpochDay(sentOn as CalendarDate) - toEpochDay(documentDate as CalendarDate) > LATE_MARK_DAYS;
}

/** The warning text for a late mark of a reminder; null for other document types or timely marks. */
export function lateMarkWarning(type: string, documentDate: string | null | undefined, sentOn: string): string | null {
  return type === "reminder" && isLateMark(documentDate, sentOn) ? LATE_MARK_WARNING_DE : null;
}
