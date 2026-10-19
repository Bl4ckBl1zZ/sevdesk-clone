/**
 * Recurring vouchers (F06 VOU-064; EC-VOU-33/34; delta D-08/D-10): rent, subscriptions, insurance as a template
 * (supplier, lines, tax rule, cost centre, expected mandate reference/IBAN for matching) with an interval
 * (P1W, P2W, P1M, P2M, P3M, P6M, P1Y … P5Y), first date, optional end date and an active toggle. The daily job
 * creates one voucher per due occurrence — missed periods are caught up in order (EC-VOU-33) — with status `open`
 * (setting: `draft`). Template edits affect only future vouchers (EC-VOU-34): generated vouchers are copies.
 * The schedule arithmetic is shared with recurring invoices (end-of-month anchors: 31.01. → 28.02. → 31.03.). Pure.
 */
import { dueOccurrences, nextDateAfter, previewOccurrences, type RecurringInterval } from "../recurring/schedule";
import { type Issue, issue } from "../result";
import { type CalendarDate, isCalendarDate } from "../time/calendar-date";

export const VOUCHER_INTERVALS = ["P1W", "P2W", "P1M", "P2M", "P3M", "P6M", "P1Y", "P2Y", "P3Y", "P4Y", "P5Y"] as const;
export type VoucherInterval = (typeof VOUCHER_INTERVALS)[number];

export const VOUCHER_INTERVAL_DE: Readonly<Record<VoucherInterval, string>> = {
  P1W: "Wöchentlich",
  P2W: "Alle 2 Wochen",
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

const SCHEDULE_INTERVAL: Record<VoucherInterval, RecurringInterval> = {
  P1W: "P7D",
  P2W: "P14D",
  P1M: "P1M",
  P2M: "P2M",
  P3M: "P3M",
  P6M: "P6M",
  P1Y: "P1Y",
  P2Y: "P2Y",
  P3Y: "P3Y",
  P4Y: "P4Y",
  P5Y: "P5Y",
};

export const isVoucherInterval = (v: string): v is VoucherInterval =>
  (VOUCHER_INTERVALS as readonly string[]).includes(v);

export interface RecurringVoucherSchedule {
  interval: VoucherInterval;
  firstDate: string;
  nextDate: string;
  endDate?: string;
  active: boolean;
}

const state = (s: RecurringVoucherSchedule) => ({
  interval: SCHEDULE_INTERVAL[s.interval],
  firstDate: s.firstDate as CalendarDate,
  nextDate: s.nextDate as CalendarDate,
  ...(s.endDate ? { endDate: s.endDate as CalendarDate } : {}),
  billing: "in_advance" as const,
});

/** Occurrences due on `today` (all of [nextDate, today]), oldest first — the catch-up of EC-VOU-33. */
export function dueVoucherDates(
  s: RecurringVoucherSchedule,
  today: CalendarDate,
): { index: number; date: CalendarDate }[] {
  if (!s.active) return [];
  return dueOccurrences(state(s), 0, today).map((o) => ({ index: o.index, date: o.date }));
}

/** `nextDate` after generating the occurrence `index`. */
export const nextVoucherDate = (s: Pick<RecurringVoucherSchedule, "firstDate" | "interval">, index: number) =>
  nextDateAfter({ firstDate: s.firstDate as CalendarDate, interval: SCHEDULE_INTERVAL[s.interval] }, index);

/** The next `count` dates (detail preview). */
export const upcomingVoucherDates = (s: RecurringVoucherSchedule, count = 3): CalendarDate[] =>
  previewOccurrences(state(s), 0, count).map((o) => o.date);

export type RecurringVoucherIssue = Issue<"recurring_interval" | "recurring_dates">;

export function checkRecurringSchedule(s: {
  interval: string;
  firstDate: string;
  endDate?: string;
}): RecurringVoucherIssue | null {
  if (!isVoucherInterval(s.interval)) return issue("recurring_interval", "Bitte ein gültiges Intervall wählen.");
  if (
    !isCalendarDate(s.firstDate) ||
    (s.endDate !== undefined && (!isCalendarDate(s.endDate) || s.endDate < s.firstDate))
  ) {
    return issue("recurring_dates", "Bitte ein gültiges erstes Datum und ein Enddatum danach angeben.");
  }
  return null;
}

/** The last 3 generated voucher ids (detail shows them, D-10). */
export const lastThree = <T>(ids: readonly T[], added: T): T[] => [...ids, added].slice(-3);
