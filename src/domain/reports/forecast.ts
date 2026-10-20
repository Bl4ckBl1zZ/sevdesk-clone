/**
 * Cash-flow forecast (F08 RPT-012, §4.8; E-RPT-09). Pure; `today` is passed in.
 *
 * 90 daily points from the opening balance (bank-reported balances + cash). Inflows: open receivables at the
 * expected payment date (due date + the customer's payment delay), recurring invoices, planned items. Outflows: open
 * payables by due date, recurring vouchers, tax payments. Two scenarios: „erwartet“ (median delay) and „vorsichtig“
 * (P80 delay, inflows −10 %, dunning level ≥ 2 counted at 50 %). A warning threshold marks the first day below it.
 *
 * §4.8 payment behaviour: per customer the delays (payment date − due date, days) of the last 10 fully paid
 * invoices within 24 months; expected = median, cautious = P80 (nearest rank); < 3 data points → company-wide
 * median (both scenarios); no history at all → 0 days with the E-RPT-09 info. Overdue invoices: expected date =
 * max(today + 7, due + delay).
 */
import { roundHalfAway } from "../money";
import { addDays, type CalendarDate, daysBetween } from "../time/calendar-date";

export const FORECAST_DAYS = 90;
export const NO_HISTORY_NOTICE = "Keine Zahlungshistorie – Fälligkeit angenommen.";
const MAX_HISTORY = 10;
const HISTORY_MONTHS = 24;
const MIN_POINTS = 3;
const OVERDUE_GRACE_DAYS = 7;
const CAUTIOUS_INFLOW_BP = 9_000;
const DUNNING_PROBABILITY_BP = 5_000;

export interface PaidInvoice {
  contactId: string;
  dueDate: string;
  /** Date the invoice became fully paid. */
  paidDate: string;
}

export interface Delay {
  expectedDays: number;
  cautiousDays: number;
  /** "customer" ≥ 3 own data points, "company" fallback median, "none" no history. */
  basis: "customer" | "company" | "none";
  points: number;
}

/** Median of integers (mean of the two middle values, half away from zero). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return Number(roundHalfAway(BigInt((s[mid - 1] as number) + (s[mid] as number)), 2n));
}

/** Nearest-rank percentile (p in basis points, 8 000 = P80). */
export function percentile(values: readonly number[], pBp: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((pBp * s.length) / 10_000);
  return s[Math.max(0, Math.min(s.length - 1, rank - 1))] as number;
}

const monthsBefore = (d: string, months: number) => {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - months;
  const yy = y + Math.floor((m - 1) / 12);
  const mm = ((((m - 1) % 12) + 12) % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}${d.slice(7)}`;
};

/** §4.8: payment delay statistics per customer. */
export function paymentDelays(history: readonly PaidInvoice[], today: string): (contactId: string) => Delay {
  const since = monthsBefore(today, HISTORY_MONTHS);
  const recent = history.filter((h) => h.paidDate >= since && h.paidDate <= today);
  const delayOf = (h: PaidInvoice) => daysBetween(h.dueDate as CalendarDate, h.paidDate as CalendarDate);
  const companyMedian = median(recent.map(delayOf));
  const byContact = new Map<string, PaidInvoice[]>();
  for (const h of recent) byContact.set(h.contactId, [...(byContact.get(h.contactId) ?? []), h]);
  return (contactId) => {
    const own = [...(byContact.get(contactId) ?? [])]
      .sort((a, b) => b.paidDate.localeCompare(a.paidDate))
      .slice(0, MAX_HISTORY)
      .map(delayOf);
    if (own.length >= MIN_POINTS) {
      return {
        expectedDays: median(own),
        cautiousDays: percentile(own, 8_000),
        basis: "customer",
        points: own.length,
      };
    }
    if (recent.length > 0) {
      return { expectedDays: companyMedian, cautiousDays: companyMedian, basis: "company", points: own.length };
    }
    return { expectedDays: 0, cautiousDays: 0, basis: "none", points: 0 };
  };
}

export type ForecastSource = "receivable" | "payable" | "recurring_invoice" | "recurring_voucher" | "tax" | "planned";

export interface ForecastItemInput {
  id: string;
  source: ForecastSource;
  label: string;
  /** Signed: + inflow, − outflow. */
  cents: number;
  /** Due date (receivables) or the planned date. */
  date: string;
  contactId?: string;
  dunningLevel?: number;
  href?: string | null;
}

export interface ForecastItem extends ForecastItemInput {
  expectedDate: string;
  cautiousDate: string;
  expectedCents: number;
  cautiousCents: number;
  delay?: Delay;
}

export interface ForecastDay {
  date: string;
  expectedCents: number;
  cautiousCents: number;
}

export interface Forecast {
  today: string;
  openingCents: number;
  days: ForecastDay[];
  weeks: { from: string; to: string; expectedCents: number; cautiousCents: number }[];
  items: ForecastItem[];
  thresholdCents: number | null;
  belowThreshold: { expected: string | null; cautious: string | null };
  notices: string[];
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

export function computeForecast(input: {
  today: string;
  openingCents: number;
  items: readonly ForecastItemInput[];
  history: readonly PaidInvoice[];
  thresholdCents?: number | null;
  notices?: readonly string[];
}): Forecast {
  const today = input.today as CalendarDate;
  const end = addDays(today, FORECAST_DAYS - 1);
  const delays = paymentDelays(input.history, today);
  const notices = [...(input.notices ?? [])];
  let noHistory = false;
  const items: ForecastItem[] = [];
  for (const it of input.items) {
    let expectedDate = it.date < today ? today : it.date;
    let cautiousDate = expectedDate;
    const expectedCents = it.cents;
    let cautiousCents = it.cents;
    let delay: Delay | undefined;
    if (it.source === "receivable" || (it.source === "recurring_invoice" && it.contactId)) {
      delay = delays(it.contactId ?? "");
      if (delay.basis === "none") noHistory = true;
      const grace = addDays(today, OVERDUE_GRACE_DAYS);
      const exp = addDays(it.date as CalendarDate, delay.expectedDays);
      const cau = addDays(it.date as CalendarDate, delay.cautiousDays);
      const overdue = it.date < today;
      expectedDate = overdue ? maxDate(grace, exp) : maxDate(today, exp);
      cautiousDate = overdue ? maxDate(grace, cau) : maxDate(today, cau);
      if ((it.dunningLevel ?? 0) >= 2) {
        cautiousCents = Number(roundHalfAway(BigInt(cautiousCents) * BigInt(DUNNING_PROBABILITY_BP), 10_000n));
      }
    }
    if (cautiousCents > 0) {
      cautiousCents = Number(roundHalfAway(BigInt(cautiousCents) * BigInt(CAUTIOUS_INFLOW_BP), 10_000n));
    }
    if (expectedDate > end && cautiousDate > end) continue;
    items.push({
      ...it,
      expectedDate,
      cautiousDate,
      expectedCents: expectedDate > end ? 0 : expectedCents,
      cautiousCents: cautiousDate > end ? 0 : cautiousCents,
      ...(delay ? { delay } : {}),
    });
  }
  if (noHistory) notices.push(NO_HISTORY_NOTICE);
  const exp = new Map<string, number>();
  const cau = new Map<string, number>();
  for (const i of items) {
    exp.set(i.expectedDate, (exp.get(i.expectedDate) ?? 0) + i.expectedCents);
    cau.set(i.cautiousDate, (cau.get(i.cautiousDate) ?? 0) + i.cautiousCents);
  }
  const days: ForecastDay[] = [];
  let e = input.openingCents;
  let c = input.openingCents;
  for (let d = 0; d < FORECAST_DAYS; d++) {
    const date = addDays(today, d);
    e += exp.get(date) ?? 0;
    c += cau.get(date) ?? 0;
    days.push({ date, expectedCents: e, cautiousCents: c });
  }
  const weeks: Forecast["weeks"] = [];
  for (let w = 0; w < days.length; w += 7) {
    const slice = days.slice(w, w + 7);
    const last = slice.at(-1) as ForecastDay;
    weeks.push({
      from: (slice[0] as ForecastDay).date,
      to: last.date,
      expectedCents: last.expectedCents,
      cautiousCents: last.cautiousCents,
    });
  }
  const threshold = input.thresholdCents ?? null;
  const firstBelow = (k: "expectedCents" | "cautiousCents") =>
    threshold === null ? null : (days.find((d) => d[k] < threshold)?.date ?? null);
  items.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.id.localeCompare(b.id));
  return {
    today,
    openingCents: input.openingCents,
    days,
    weeks,
    items,
    thresholdCents: threshold,
    belowThreshold: { expected: firstBelow("expectedCents"), cautious: firstBelow("cautiousCents") },
    notices,
  };
}

/** Days between today and a date (for the „in N Tagen“ column). */
export const daysFromToday = (today: string, date: string) => daysBetween(today as CalendarDate, date as CalendarDate);
