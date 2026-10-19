/**
 * Polling rules of the Enable Banking feed (F07 BNK-103, BNK-106, BNK-107, §4.3; EC-BNK-06/86/88, EC-191/193).
 * Pure: the caller passes the Berlin wall clock and the stored per-account counters.
 *
 * PSD2 RTS Art. 36(5)(b): at most 4 unattended requests per account, endpoint and consent per 24 h (research 13 §2).
 * The counter is kept per Europe/Berlin calendar day (03 §1 `feed.unattendedFetches`); one logical fetch counts once
 * however many `continuation_key` pages it has. Owner-present fetches (PSU headers) do not count (BNK-107).
 */
import { TZDate } from "@date-fns/tz";
import { addDays, type CalendarDate, daysBetween } from "../../time/calendar-date";

export const UNATTENDED_LIMIT = 4;
/** Balances are read unattended at most once per day (BNK-106). */
export const BALANCES_PER_DAY = 1;
/** `429 ASPSP_RATE_LIMIT_EXCEEDED` → no unattended call for 6 hours (Enable Banking FAQ). */
export const RATE_LIMIT_BACKOFF_MS = 6 * 3_600_000;
/** Poll window overlap (BNK-106, BNK-105 renewal gap fetch). */
export const OVERLAP_DAYS = 10;
/** Revolut serves 90 days without the consent window (research 13 §1/§2). */
export const HISTORY_DAYS_AFTER_CONSENT = 90;
/** At most this many retries of a 5xx within one poll run (each retry is a request, EC-BNK-06). */
export const MAX_TRANSIENT_RETRIES = 1;
/** `bank.sync` slots, Europe/Berlin wall clock (BNK-106). */
export const POLL_SLOTS_BERLIN = ["05:30", "11:30", "17:30", "23:30"] as const;
const POLL_HOURS = new Set([5, 11, 17, 23]);

export type FeedEndpoint = "transactions" | "balances";

export interface UnattendedCounter {
  day: string;
  transactions: number;
  balances: number;
}

export interface FeedAccountState {
  backoffUntil?: number;
  unattendedFetches?: UnattendedCounter;
}

/** Whether a cron firing at this Berlin wall clock is one of the four poll slots (CET and CEST registrations). */
export const isPollSlot = (berlin: { hour: number; minute: number }): boolean =>
  POLL_HOURS.has(berlin.hour) && berlin.minute >= 25 && berlin.minute <= 40;

export function usedToday(state: FeedAccountState, berlinDay: string): UnattendedCounter {
  const c = state.unattendedFetches;
  return c && c.day === berlinDay ? c : { day: berlinDay, transactions: 0, balances: 0 };
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: "backoff"; until: number }
  | { ok: false; reason: "budget" };

/** BNK-106 / EC-BNK-86: may an unattended fetch of `endpoint` run now? */
export function unattendedAllowed(
  state: FeedAccountState,
  endpoint: FeedEndpoint,
  now: number,
  berlinDay: string,
): BudgetDecision {
  if (state.backoffUntil !== undefined && now < state.backoffUntil)
    return { ok: false, reason: "backoff", until: state.backoffUntil };
  const used = usedToday(state, berlinDay);
  const limit = endpoint === "balances" ? BALANCES_PER_DAY : UNATTENDED_LIMIT;
  return used[endpoint] < limit ? { ok: true } : { ok: false, reason: "budget" };
}

/** The counter after one unattended logical fetch (pages count once). */
export function countFetch(state: FeedAccountState, endpoint: FeedEndpoint, berlinDay: string): UnattendedCounter {
  const used = usedToday(state, berlinDay);
  return { ...used, [endpoint]: used[endpoint] + 1 };
}

export const remainingUnattended = (state: FeedAccountState, berlinDay: string): number =>
  Math.max(0, UNATTENDED_LIMIT - usedToday(state, berlinDay).transactions);

/** BNK-106: `date_from` = last booked date − 10 days (or the backfill start when nothing is booked yet). */
export function pollDateFrom(lastBookedDate: string | undefined, fallbackStart: string): string {
  if (!lastBookedDate) return fallbackStart;
  const from = addDays(lastBookedDate as CalendarDate, -OVERLAP_DAYS);
  return from < fallbackStart ? fallbackStart : from;
}

/**
 * BNK-103: backfill start = the day after the last booked transaction of the account, else the opening-balance date
 * (never earlier), else the fallback (Buchungsbeginn / 1 January of the current year).
 */
export function backfillStart(input: {
  lastBookedDate?: string;
  openingBalanceDate?: string;
  fallback: string;
}): string {
  if (input.lastBookedDate) {
    const next = addDays(input.lastBookedDate as CalendarDate, 1);
    return input.openingBalanceDate && next < input.openingBalanceDate ? input.openingBalanceDate : next;
  }
  return input.openingBalanceDate ?? input.fallback;
}

/**
 * EC-BNK-88 / EC-193 / EC-BNK-06: the part of `[start, today]` the feed can no longer deliver, i.e. older than 90
 * days and not covered by the delivered rows → statement-import to-do. `earliestDelivered` = the oldest booked date
 * the bank returned; `complete` = every page was fetched (else the history may be cut off).
 */
export function olderGap(input: {
  start: string;
  today: string;
  earliestDelivered?: string;
  complete: boolean;
}): { from: string; to: string } | null {
  const limit = addDays(input.today as CalendarDate, -(HISTORY_DAYS_AFTER_CONSENT + 1));
  if (input.start > limit) return null;
  let to: string = limit;
  if (input.complete && input.earliestDelivered) {
    if (input.earliestDelivered <= input.start) return null;
    const before = addDays(input.earliestDelivered as CalendarDate, -1);
    if (before < to) to = before;
  }
  return daysBetween(input.start as CalendarDate, to as CalendarDate) >= 0 ? { from: input.start, to } : null;
}

/** SET-049a „nächster Abruf“: the next `bank.sync` slot after `now` (Europe/Berlin wall clock, DST-exact). */
export function nextPollAt(now: number): number {
  const base = new TZDate(now, "Europe/Berlin");
  for (let day = 0; day < 3; day++) {
    for (const slot of POLL_SLOTS_BERLIN) {
      const [h, m] = slot.split(":").map(Number) as [number, number];
      const t = new TZDate(base.getFullYear(), base.getMonth(), base.getDate() + day, h, m, 0, "Europe/Berlin");
      if (t.getTime() > now) return t.getTime();
    }
  }
  return now + 6 * 3_600_000;
}
