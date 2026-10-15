/**
 * Limitation (Verjährung) of a claim — F05 DUN-040/041, MAHN-05, §§ 195, 199 BGB: three years from the end of the
 * year in which the claim became due. Reminders do not suspend limitation; a Mahnbescheid or a lawsuit does (§ 204).
 */
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";

/** Regular limitation period in years (§ 195 BGB). */
export const LIMITATION_YEARS = 3;
/** Warnings start on this day of the limitation year (DUN-041). */
export const LIMITATION_WARNING_FROM = "10-01";

export const limitationDateOf = (dueDate: CalendarDate): CalendarDate =>
  `${Number(dueDate.slice(0, 4)) + LIMITATION_YEARS}-12-31` as CalendarDate;

export interface LimitationStatus {
  readonly date: CalendarDate;
  readonly state: "ok" | "soon" | "expired";
  readonly message?: string;
}

export function limitationStatus(dueDate: CalendarDate, today: CalendarDate): LimitationStatus {
  const date = limitationDateOf(dueDate);
  if (today > date) {
    return {
      date,
      state: "expired",
      message: `Die Forderung ist seit dem ${formatGermanDate(addDays(date, 1))} verjährt. Der Schuldner kann die Einrede der Verjährung erheben.`,
    };
  }
  if (today >= `${date.slice(0, 4)}-${LIMITATION_WARNING_FROM}`) {
    return {
      date,
      state: "soon",
      message: `Verjährt am ${formatGermanDate(date)} – Mahnbescheid oder Klage hemmen die Verjährung, Mahnungen nicht.`,
    };
  }
  return { date, state: "ok" };
}
