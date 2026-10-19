/**
 * Europe/Berlin calendar date of an instant (GOBD-22, 10 EC-020 / EC-155, F04 EC-DOC-11, F07 BNK-112).
 * Instants are passed in as epoch milliseconds (UTC); the domain never reads the clock.
 * The offset comes from the IANA database via @date-fns/tz, so DST switch days are exact.
 */
import { tzOffset } from "@date-fns/tz";
import { type CalendarDate, fromEpochDay, toEpochDay } from "./calendar-date";

export const BUSINESS_TIME_ZONE = "Europe/Berlin";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export class InstantError extends RangeError {
  readonly code = "instant_invalid";
  constructor(detail: string) {
    super(`instant_invalid: ${detail}`);
    this.name = "InstantError";
  }
}

export function berlinCalendarDate(epochMs: number): CalendarDate {
  if (!Number.isSafeInteger(epochMs)) throw new InstantError(`${epochMs} is not an integer epoch millisecond`);
  const offsetMinutes = tzOffset(BUSINESS_TIME_ZONE, new Date(epochMs));
  return fromEpochDay(Math.floor((epochMs + offsetMinutes * MS_PER_MINUTE) / MS_PER_DAY));
}

/**
 * Last millisecond of `date` in Europe/Berlin (expiry dates such as „Gültig bis 31.10.“ end at local midnight).
 * DST switches happen at 02:00/03:00, so the offset at local midnight is unambiguous; one refinement step settles it.
 */
export function berlinEndOfDay(date: CalendarDate): number {
  const nextMidnightUtc = (toEpochDay(date) + 1) * MS_PER_DAY;
  let instant = nextMidnightUtc - tzOffset(BUSINESS_TIME_ZONE, new Date(nextMidnightUtc)) * MS_PER_MINUTE;
  instant = nextMidnightUtc - tzOffset(BUSINESS_TIME_ZONE, new Date(instant)) * MS_PER_MINUTE;
  return instant - 1;
}

/** First millisecond of `date` in Europe/Berlin (presets such as „heute 00:00“, F12 AUD-006). */
export function berlinStartOfDay(date: CalendarDate): number {
  return berlinEndOfDay(fromEpochDay(toEpochDay(date) - 1)) + 1;
}
