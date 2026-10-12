/**
 * Europe/Berlin calendar date of an instant (GOBD-22, 10 EC-020 / EC-155, F04 EC-DOC-11, F07 BNK-112).
 * Instants are passed in as epoch milliseconds (UTC); the domain never reads the clock.
 * The offset comes from the IANA database via @date-fns/tz, so DST switch days are exact.
 */
import { tzOffset } from "@date-fns/tz";
import { type CalendarDate, fromEpochDay } from "./calendar-date";

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
