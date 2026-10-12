/**
 * Business dates as `YYYY-MM-DD` strings without a time zone (02 §5, GOBD-22).
 * Arithmetic uses integer epoch days (proleptic Gregorian calendar), so DST can never shift a date.
 * Lexicographic order of valid `CalendarDate`s equals chronological order (years 0000–9999).
 */
import { err, type Issue, issue, ok, type Result } from "../result";

declare const brand: unique symbol;
export type CalendarDate = string & { readonly [brand]: "CalendarDate" };

export class CalendarDateError extends RangeError {
  readonly code = "date_invalid";
  constructor(detail: string) {
    super(`date_invalid: ${detail}`);
    this.name = "CalendarDateError";
  }
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function isCalendarDate(value: string): value is CalendarDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parseCalendarDate(value: string): Result<CalendarDate, Issue<"date_invalid">> {
  return isCalendarDate(value)
    ? ok(value)
    : err(issue("date_invalid", "Bitte ein gültiges Datum im Format JJJJ-MM-TT angeben.", { value }));
}

/** Asserting constructor for literals and trusted data (throws `date_invalid`). */
export function calendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) throw new CalendarDateError(`"${value}" is not a YYYY-MM-DD date`);
  return value;
}

// Howard Hinnant's days_from_civil / civil_from_days (public domain), integer-only.
export function toEpochDay(date: CalendarDate): number {
  let y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

export function fromEpochDay(day: number): CalendarDate {
  if (!Number.isSafeInteger(day)) throw new CalendarDateError(`epoch day ${day} is not an integer`);
  const z = day + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return calendarDate(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

export const addDays = (date: CalendarDate, days: number): CalendarDate => fromEpochDay(toEpochDay(date) + days);

/** `b − a` in days. */
export const daysBetween = (a: CalendarDate, b: CalendarDate): number => toEpochDay(b) - toEpochDay(a);

export const compareDates = (a: CalendarDate, b: CalendarDate): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

/** "2026-01-10" → "10.01.2026" (German display). */
export const formatGermanDate = (date: CalendarDate): string =>
  `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
