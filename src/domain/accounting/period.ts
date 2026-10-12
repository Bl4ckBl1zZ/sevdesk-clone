/**
 * Periods, fiscal years and date-effective settings for postings (F08 ACC-006, ACC-007, ACC-014, ACC-022,
 * TAX-008). Pure: the caller passes the profile data, the locked periods and `today`.
 */

import { err, type Issue, issue, ok, type Result } from "../result";
import type { Chart } from "../rules/accounting";
import { addDays, type CalendarDate, calendarDate, daysInMonth } from "../time/calendar-date";
import type { SupplyDate, TaxationMethod } from "./events";

/** `YYYY-MM` of a business date (03 §8 `journalEntries.period`). */
export const periodOf = (date: string): string => date.slice(0, 7);

/**
 * Fiscal year label of a date: the calendar year in which the fiscal year **starts** (F01 SET-042; for the
 * standard January start this is the calendar year).
 */
export function fiscalYearOf(date: string, fiscalYearStartMonth: number): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= fiscalYearStartMonth ? year : year - 1;
}

export function fiscalYearStart(fiscalYear: number, fiscalYearStartMonth: number): CalendarDate {
  return calendarDate(`${fiscalYear}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`);
}

export function fiscalYearEnd(fiscalYear: number, fiscalYearStartMonth: number): CalendarDate {
  const next = fiscalYearStart(fiscalYear + 1, fiscalYearStartMonth);
  return addDays(next, -1);
}

const latestBy = <E>(list: readonly E[], key: (e: E) => string | number, upTo: string | number): E | undefined => {
  let best: E | undefined;
  for (const e of list) if (key(e) <= upTo && (best === undefined || key(e) >= key(best))) best = e;
  return best;
};

/** Chart of the fiscal year containing `date` (EC-116: switches only at a fiscal-year start). Default SKR03. */
export function chartAt(
  chartOfAccounts: readonly { validFromFiscalYear: number; chart: Chart }[],
  fiscalYearStartMonth: number,
  date: string,
): Chart {
  const fy = fiscalYearOf(date, fiscalYearStartMonth);
  return latestBy(chartOfAccounts, (c) => c.validFromFiscalYear, fy)?.chart ?? "SKR03";
}

/** Soll/Ist valid on `date` (ACC-022, UVA-06; stored date-effective in companyProfile). Default Soll. */
export function taxationMethodAt(
  taxationMethod: readonly { validFrom: string; method: TaxationMethod }[],
  date: string,
): TaxationMethod {
  return latestBy(taxationMethod, (m) => m.validFrom, date)?.method ?? "soll";
}

/** Last day of the supply (§13 Abs. 1 Nr. 1a UStG: tax arises at the end of the period of supply). */
export function supplyEnd(s: SupplyDate): CalendarDate {
  if (s.kind === "date") return calendarDate(s.date);
  if (s.kind === "period") return calendarDate(s.to);
  return endOfMonth(s.month);
}

export function endOfMonth(month: string): CalendarDate {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return calendarDate(`${month.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`);
}

const nextMonth = (month: string): string => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** igL tax point (§13 Abs. 1 Nr. 6 UStG, F08 §4.3 ⚠): invoice date, at the latest the end of the following month. */
export function icSupplyTaxPoint(invoiceDate: string, supply: SupplyDate): CalendarDate {
  const latest = endOfMonth(nextMonth(periodOf(supplyEnd(supply))));
  return invoiceDate < latest ? calendarDate(invoiceDate) : latest;
}

export type UstvaPeriodKind = "monthly" | "quarterly" | "annual_only";

/**
 * Filing period containing a tax point (TAX-008): `YYYY-MM` (monthly), `YYYY-Qn` (quarterly), `YYYY` (annual only);
 * undefined while no `ustvaPeriod` row exists for that year (assigned when the UStVA is computed, P2).
 */
export function taxPeriodOf(
  taxPointDate: string,
  ustvaPeriod: readonly { year: number; period: UstvaPeriodKind }[],
): string | undefined {
  const year = Number(taxPointDate.slice(0, 4));
  const row = ustvaPeriod.find((p) => p.year === year);
  if (!row) return undefined;
  if (row.period === "monthly") return periodOf(taxPointDate);
  if (row.period === "quarterly") return `${year}-Q${Math.ceil(Number(taxPointDate.slice(5, 7)) / 3)}`;
  return String(year);
}

// ── period lock (ACC-006) ───────────────────────────────────────────────────────────────────────────────

/** user = date chosen by the user (manual/cash payments, documents, cash transfers); external = given (bank, Storno). */
export type Dating = "user" | "external";

export interface PostingDate {
  date: CalendarDate;
  period: string;
  originalDate?: CalendarDate;
  latePosting?: { reason: string };
}

const formatPeriod = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;
const formatDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** E-ACC-04 */
export const periodLockedIssue = (period: string): Issue<"period_locked"> =>
  issue(
    "period_locked",
    `Der Zeitraum ${formatPeriod(period)} ist festgeschrieben. Korrekturen sind nur als Gegenbuchung in einem offenen Zeitraum möglich.`,
    { period },
  );

/**
 * ACC-006: (a) user-chosen dates in a locked (or locking, E-ACC-20) period are refused (409 `period_locked`);
 * (b) externally given dates move to the first open period — its first day, or `today` if today lies in it —
 * keeping `originalDate` and the late-posting reason (E-ACC-03).
 */
export function resolvePostingDate(
  date: CalendarDate,
  dating: Dating,
  closedPeriods: ReadonlySet<string>,
  today: CalendarDate,
): Result<PostingDate, Issue<"period_locked">> {
  const period = periodOf(date);
  if (!closedPeriods.has(period)) return ok({ date, period });
  if (dating === "user") return err(periodLockedIssue(period));
  let p = period;
  while (closedPeriods.has(p)) p = nextMonth(p);
  const first = calendarDate(`${p}-01`);
  const target = periodOf(today) === p && today > first ? today : first;
  return ok({
    date: target,
    period: p,
    originalDate: date,
    latePosting: {
      reason: `Der Zeitraum ${formatPeriod(period)} ist festgeschrieben. Die Buchung wurde in den ${formatPeriod(p)} übernommen (Belegdatum ${formatDate(date)} bleibt erhalten).`,
    },
  });
}

/** ACC-014: events dated before the Buchungsbeginn produce no journal entries (books were kept elsewhere). */
export const isBeforeBookkeepingStart = (date: string, bookkeepingStartDate: string | undefined): boolean =>
  bookkeepingStartDate !== undefined && date < bookkeepingStartDate;
