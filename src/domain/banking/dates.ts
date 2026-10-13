/**
 * Timestamps of bank files (F07 BNK-112, EC-155): Revolut statements and CSV columns are UTC by default; a CSV can
 * carry local-time columns instead („Date completed (Europe/Berlin)“, column naming UNSURE). Every source ends up
 * with the Europe/Berlin calendar date as booking date and, where a time is known, the UTC instant for statement
 * reconciliation.
 */
import { tzOffset } from "@date-fns/tz";
import { berlinCalendarDate } from "../time/berlin";
import { isCalendarDate } from "../time/calendar-date";

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

export interface BankInstant {
  /** Europe/Berlin calendar date. */
  date: string;
  /** UTC instant, ISO without milliseconds (`2026-10-31T23:30:00Z`). */
  instant: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/**
 * Parses `YYYY-MM-DD[ HH:mm[:ss]][Z|±hh:mm]` given in `timeZone` (default UTC; an explicit offset wins) and returns
 * the Berlin date and the UTC instant. Also accepts `DD.MM.YYYY[ HH:mm[:ss]]`.
 */
export function parseBankDateTime(value: string, timeZone = "UTC"): BankInstant | null {
  const v = value.trim().replace(/^(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1");
  const m = DATE_TIME.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isCalendarDate(date)) return null;
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, s);
  let ms: number;
  if (m[7]) {
    const off =
      m[7] === "Z"
        ? 0
        : Number(m[7].slice(0, 3)) * 60 + Math.sign(Number(m[7].slice(0, 3)) || 1) * Number(m[7].slice(-2));
    ms = wall - off * 60_000;
  } else if (timeZone === "UTC") {
    ms = wall;
  } else {
    // Local wall time → instant: two refinement steps settle the offset around DST switches.
    ms = wall - tzOffset(timeZone, new Date(wall)) * 60_000;
    ms = wall - tzOffset(timeZone, new Date(ms)) * 60_000;
  }
  return { date: berlinCalendarDate(ms), instant: iso(ms) };
}
