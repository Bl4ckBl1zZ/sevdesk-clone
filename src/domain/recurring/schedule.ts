/**
 * Recurring invoices — the schedule (F04 §3.4 REC-02…06, REC-10, REC-12, REC-13, §4.11; 10 EC-DOC-92/93/96).
 *
 * Pure: `today` is always passed in. Occurrence `i` is computed from `firstDate` and the index, never by chaining
 * `next()` on an already clamped date — so the anchor day survives short months (31.01. → 28.02. → 31.03.) and leap
 * years (29.02.2028 → 28.02.2029 → … → 29.02.2032 for yearly anchors).
 */
import { addDays, type CalendarDate, daysBetween, daysInMonth, formatGermanDate } from "../time/calendar-date";

export const RECURRING_INTERVALS = [
  "P7D",
  "P14D",
  "P1M",
  "P2M",
  "P3M",
  "P6M",
  "P1Y",
  "P2Y",
  "P3Y",
  "P4Y",
  "P5Y",
] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

export const RECURRING_INTERVAL_LABELS_DE: Readonly<Record<RecurringInterval, string>> = {
  P7D: "Alle 7 Tage",
  P14D: "Alle 14 Tage",
  P1M: "Monatlich",
  P2M: "Alle 2 Monate",
  P3M: "Vierteljährlich",
  P6M: "Halbjährlich",
  P1Y: "Jährlich",
  P2Y: "Alle 2 Jahre",
  P3Y: "Alle 3 Jahre",
  P4Y: "Alle 4 Jahre",
  P5Y: "Alle 5 Jahre",
};

export const BILLING_MODES = ["in_advance", "in_arrears"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const BILLING_LABELS_DE: Readonly<Record<BillingMode, string>> = {
  in_advance: "Im Voraus",
  in_arrears: "Nachträglich",
};

const STEP: Readonly<Record<RecurringInterval, { days: number } | { months: number }>> = {
  P7D: { days: 7 },
  P14D: { days: 14 },
  P1M: { months: 1 },
  P2M: { months: 2 },
  P3M: { months: 3 },
  P6M: { months: 6 },
  P1Y: { months: 12 },
  P2Y: { months: 24 },
  P3Y: { months: 36 },
  P4Y: { months: 48 },
  P5Y: { months: 60 },
};

export const isRecurringInterval = (v: string): v is RecurringInterval =>
  (RECURRING_INTERVALS as readonly string[]).includes(v);

/** `date` + `months`, keeping the anchor day `anchorDay` clamped to the target month's length (REC-02). */
function addMonthsAnchored(date: CalendarDate, months: number, anchorDay: number): CalendarDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12 + 1;
  const d = Math.min(anchorDay, daysInMonth(ty, tm));
  return `${String(ty).padStart(4, "0")}-${String(tm).padStart(2, "0")}-${String(d).padStart(2, "0")}` as CalendarDate;
}

/** Occurrence number `index` (0 = `firstDate`; negative = before the first, used for the first in-arrears period). */
export function occurrenceAt(firstDate: CalendarDate, interval: RecurringInterval, index: number): CalendarDate {
  const step = STEP[interval];
  if ("days" in step) return addDays(firstDate, step.days * index);
  return addMonthsAnchored(firstDate, step.months * index, Number(firstDate.slice(8, 10)));
}

/** Smallest index ≥ 0 whose occurrence is on or after `date`. */
export function indexOnOrAfter(firstDate: CalendarDate, interval: RecurringInterval, date: CalendarDate): number {
  if (date <= firstDate) return 0;
  const step = STEP[interval];
  let i: number;
  if ("days" in step) i = Math.ceil(daysBetween(firstDate, date) / step.days);
  else {
    const months =
      (Number(date.slice(0, 4)) - Number(firstDate.slice(0, 4))) * 12 +
      (Number(date.slice(5, 7)) - Number(firstDate.slice(5, 7)));
    i = Math.max(0, Math.floor(months / step.months));
  }
  while (occurrenceAt(firstDate, interval, i) < date) i++;
  while (i > 0 && occurrenceAt(firstDate, interval, i - 1) >= date) i--;
  return i;
}

/** Index of an occurrence date of the schedule (`nextDate` is always one); throws for a foreign date. */
export function indexOf(firstDate: CalendarDate, interval: RecurringInterval, date: CalendarDate): number {
  const i = indexOnOrAfter(firstDate, interval, date);
  if (occurrenceAt(firstDate, interval, i) !== date) throw new RangeError(`${date} is not an occurrence`);
  return i;
}

export interface Period {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
}

/**
 * REC-04: `in_advance` bills [occurrence, next occurrence − 1 day]; `in_arrears` bills [previous occurrence,
 * occurrence − 1 day] — the previous occurrence of the first one is `firstDate − interval` (anchor-aware).
 * Consecutive periods are contiguous: no gap, no overlap (EC-DOC-96).
 */
export function periodFor(
  firstDate: CalendarDate,
  interval: RecurringInterval,
  index: number,
  billing: BillingMode,
): Period {
  const start = billing === "in_advance" ? index : index - 1;
  return {
    from: occurrenceAt(firstDate, interval, start),
    to: addDays(occurrenceAt(firstDate, interval, start + 1), -1),
  };
}

export interface ScheduleState {
  readonly interval: RecurringInterval;
  readonly firstDate: CalendarDate;
  /** The next occurrence not yet generated or skipped. */
  readonly nextDate: CalendarDate;
  readonly endDate?: CalendarDate | undefined;
  readonly maxCount?: number | undefined;
  readonly billing: BillingMode;
}

export interface Occurrence {
  readonly index: number;
  readonly date: CalendarDate;
  readonly period: Period;
}

const occurrence = (s: ScheduleState, index: number): Occurrence => ({
  index,
  date: occurrenceAt(s.firstDate, s.interval, index),
  period: periodFor(s.firstDate, s.interval, index, s.billing),
});

/** REC-03: no further occurrence (`endDate` passed or `maxCount` invoices generated) — the template is „Beendet“. */
export function isEnded(s: ScheduleState, generatedCount: number): boolean {
  if (s.maxCount !== undefined && generatedCount >= s.maxCount) return true;
  return s.endDate !== undefined && s.nextDate > s.endDate;
}

/**
 * The upcoming occurrences from `nextDate` on, honouring `endDate` (last occurrence ≤ endDate) and `maxCount`
 * (invoices still to generate). `until` limits by date (inclusive), `limit` by number.
 */
export function upcoming(
  s: ScheduleState,
  generatedCount: number,
  opts: { until?: CalendarDate; limit?: number },
): Occurrence[] {
  const out: Occurrence[] = [];
  const remaining = s.maxCount === undefined ? Number.POSITIVE_INFINITY : s.maxCount - generatedCount;
  const limit = Math.min(opts.limit ?? Number.POSITIVE_INFINITY, remaining);
  let i = indexOf(s.firstDate, s.interval, s.nextDate);
  while (out.length < limit) {
    const o = occurrence(s, i);
    if (s.endDate !== undefined && o.date > s.endDate) break;
    if (opts.until !== undefined && o.date > opts.until) break;
    out.push(o);
    i++;
    if (out.length > 10_000) break; // a schedule never needs more; guards a corrupt state
  }
  return out;
}

/** REC-05/06: the occurrences due on `today` (all of `[nextDate, today]`), oldest first. */
export const dueOccurrences = (s: ScheduleState, generatedCount: number, today: CalendarDate): Occurrence[] =>
  upcoming(s, generatedCount, { until: today });

/** REC-13: the next `count` occurrences (default 12) with their periods. */
export const previewOccurrences = (s: ScheduleState, generatedCount: number, count = 12): Occurrence[] =>
  upcoming(s, generatedCount, { limit: count });

/** The `nextDate` after the occurrence `index` was generated or skipped. */
export const nextDateAfter = (s: Pick<ScheduleState, "firstDate" | "interval">, index: number): CalendarDate =>
  occurrenceAt(s.firstDate, s.interval, index + 1);

export interface RunPlan {
  /** Occurrences to generate now, oldest first (REC-06). */
  readonly occurrences: readonly Occurrence[];
  /**
   * REC-06: more than `catchUpAutoMax` missed occurrences → all become drafts without automation (+ notification).
   * `automated` is false then, and always false when the template has no (confirmed) finalise automation.
   */
  readonly automated: boolean;
  readonly catchUpOverflow: boolean;
  /** `nextDate` after the run (unchanged when nothing is due). */
  readonly nextDate: CalendarDate;
  readonly generatedCount: number;
  readonly ended: boolean;
}

/** REC-05/06 daily run (and REC-10 „nachberechnen“) for one active template. */
export function planRun(input: {
  readonly schedule: ScheduleState;
  readonly generatedCount: number;
  readonly today: CalendarDate;
  readonly catchUpAutoMax: number;
  readonly finalize: boolean;
}): RunPlan {
  const { schedule: s, generatedCount, today } = input;
  const due = dueOccurrences(s, generatedCount, today);
  return finishPlan(s, generatedCount, due, {
    overflow: due.length > input.catchUpAutoMax,
    finalize: input.finalize,
  });
}

/**
 * REC-12 „Jetzt erzeugen“: the next occurrence immediately (same rules — period, automation), advancing the
 * schedule. Empty when the template is ended.
 */
export function planRunNow(input: {
  readonly schedule: ScheduleState;
  readonly generatedCount: number;
  readonly finalize: boolean;
}): RunPlan {
  const next = upcoming(input.schedule, input.generatedCount, { limit: 1 });
  return finishPlan(input.schedule, input.generatedCount, next, { overflow: false, finalize: input.finalize });
}

function finishPlan(
  s: ScheduleState,
  generatedCount: number,
  occurrences: readonly Occurrence[],
  o: { overflow: boolean; finalize: boolean },
): RunPlan {
  const last = occurrences.at(-1);
  const nextDate = last ? nextDateAfter(s, last.index) : s.nextDate;
  const count = generatedCount + occurrences.length;
  return {
    occurrences,
    automated: o.finalize && !o.overflow,
    catchUpOverflow: o.overflow,
    nextDate,
    generatedCount: count,
    ended: isEnded({ ...s, nextDate }, count),
  };
}

/**
 * REC-10 „überspringen“ on resume: every occurrence before `today` is skipped (audited by the caller); `nextDate`
 * moves to the first occurrence on or after today. An occurrence falling on `today` is not past and stays due.
 */
export function skipPast(s: ScheduleState, generatedCount: number, today: CalendarDate) {
  const skipped = upcoming(s, generatedCount, { until: addDays(today, -1) });
  const last = skipped.at(-1);
  return { skipped, nextDate: last ? nextDateAfter(s, last.index) : s.nextDate };
}

/** `{{recurring.periodText}}` (F01 §5.6) / the period line of the head text (REC-04). */
export function periodText(p: Period, language: "de" | "en"): string {
  const from = formatGermanDate(p.from);
  const to = formatGermanDate(p.to);
  return language === "en"
    ? `Billing period from ${from} to ${to}`
    : `Berechnung für den Zeitraum vom ${from} bis ${to}`;
}
