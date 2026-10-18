/**
 * Dashboard „Übersicht“ aggregations (04-ui-ux §4.7, DASH-001…011). Pure: every function takes plain rows and
 * `today` (Europe/Berlin calendar date); `convex/dashboard.ts` loads the rows and returns the view model.
 *
 * Definitions (documented in 04 §4.7):
 *  - Gewinn vor Steuern / Einnahmen / Ausgaben (DASH-003): journal lines by entry date over the month window,
 *    revenue = Σ(credit − debit) on accounts of type `revenue`, expenses = Σ(debit − credit) on type `expense`
 *    (account types from the chart seed rule data, `src/domain/rules/accounting`). A preliminary result from the
 *    journal, not the EÜR cash-basis computation (that needs payment allocations, F08 §4.4 / TAX-015).
 *  - Ausstehende Rechnungen (DASH-004): open items with a positive open EUR amount; disjoint buckets.
 *  - Kleinunternehmergrenze (DASH-005): same turnover sum as the finalise-time KU check (`kuYearTurnoverCents`):
 *    finalised, not cancelled invoices of the year, gross (for a KU gross = net, no VAT is shown).
 *  - Zuordnungsquote (DASH-007): assigned bank rows / all rows except `ignored`, floored.
 *  - Top 5 Kunden (DASH-008): invoiced payable amount of finalised invoices in (today − 3 months, today].
 */

import type { AccountType } from "../rules/accounting/types";
import { lookupRule } from "../rules/rule-table";
import { KLEINUNTERNEHMER_LIMITS } from "../rules/thresholds";
import type { KuEntry } from "../tax/ku-history";
import { type CalendarDate, calendarDate, daysInMonth } from "../time/calendar-date";

// ── DASH-001 greeting ─────────────────────────────────────────────────────────────────────────────────

/** First word of the member name; else the e-mail local part; else null („Herzlich Willkommen“ alone). */
export function greetingName(m: { name?: string | null; email?: string | null }): string | null {
  const email = m.email?.trim() ?? "";
  const name = m.name?.trim() ?? "";
  if (name && name.toLowerCase() !== email.toLowerCase() && !name.includes("@")) {
    return name.split(/\s+/)[0] ?? null;
  }
  const local = email.split("@")[0]?.trim() ?? "";
  return local || null;
}

// ── months ────────────────────────────────────────────────────────────────────────────────────────────

/** German month abbreviations (fixed data, no ICU: `Intl` short months differ between runtimes, e.g. „Nov.“). */
export const MONTH_ABBREVIATIONS_DE = [
  "Jan",
  "Feb",
  "Mär",
  "Apr",
  "Mai",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Okt",
  "Nov",
  "Dez",
] as const;

/** Months shown in „Gewinn vor Steuern“ (DASH-003; a UI parameter, see the open question in 04 §4.7). */
export const DASHBOARD_MONTHS = 12;

export interface MonthSlot {
  /** `YYYY-MM` */
  period: string;
  /** „Okt 26“ */
  label: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `count` months ending with the month of `today`, oldest first. */
export function monthWindow(today: CalendarDate, count = DASHBOARD_MONTHS): MonthSlot[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const out: MonthSlot[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const index = y * 12 + (m - 1) - i;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    out.push({
      period: `${year}-${pad2(month)}`,
      label: `${MONTH_ABBREVIATIONS_DE[month - 1]} ${String(year).slice(-2)}`,
    });
  }
  return out;
}

/** The same day `months` months earlier, clamped to the end of a shorter month. */
export function subtractMonths(date: CalendarDate, months: number): CalendarDate {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return calendarDate(`${year}-${pad2(month)}-${pad2(Math.min(day, daysInMonth(year, month)))}`);
}

// ── DASH-003 Gewinn vor Steuern ───────────────────────────────────────────────────────────────────────

export interface LedgerLine {
  date: string;
  account: string;
  debitCents: number;
  creditCents: number;
}

export interface MonthResult extends MonthSlot {
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
}

export interface ResultSummary {
  from: string;
  to: string;
  months: MonthResult[];
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
}

export function monthlyResult(
  lines: readonly LedgerLine[],
  accountTypes: ReadonlyMap<string, AccountType>,
  today: CalendarDate,
  count = DASHBOARD_MONTHS,
): ResultSummary {
  const window = monthWindow(today, count);
  const months = new Map<string, MonthResult>(
    window.map((w) => [w.period, { ...w, incomeCents: 0, expenseCents: 0, profitCents: 0 }]),
  );
  const from = `${window[0]?.period ?? today.slice(0, 7)}-01`;
  for (const l of lines) {
    if (l.date < from || l.date > today) continue;
    const month = months.get(l.date.slice(0, 7));
    const type = accountTypes.get(l.account);
    if (!month || !type) continue;
    if (type === "revenue") month.incomeCents += l.creditCents - l.debitCents;
    else if (type === "expense") month.expenseCents += l.debitCents - l.creditCents;
  }
  const list = [...months.values()].map((m) => ({ ...m, profitCents: m.incomeCents - m.expenseCents }));
  const incomeCents = list.reduce((s, m) => s + m.incomeCents, 0);
  const expenseCents = list.reduce((s, m) => s + m.expenseCents, 0);
  return { from, to: today, months: list, incomeCents, expenseCents, profitCents: incomeCents - expenseCents };
}

// ── DASH-004 Ausstehende Rechnungen ───────────────────────────────────────────────────────────────────

export interface ReceivableItem {
  openCents: number;
  paidCents: number;
  overdue: boolean;
  currency: string;
}

export interface Bucket {
  count: number;
  cents: number;
}

export interface ReceivablesSummary {
  totalCents: number;
  /** „Fällig“: past the due date (also when partially paid, like the display status). */
  overdue: Bucket;
  /** „Offen“: not yet due, nothing paid. */
  open: Bucket;
  /** „Teilbezahlt“: not yet due, partially paid. */
  partiallyPaid: Bucket;
}

export function receivablesSummary(items: readonly ReceivableItem[]): ReceivablesSummary {
  const s: ReceivablesSummary = {
    totalCents: 0,
    overdue: { count: 0, cents: 0 },
    open: { count: 0, cents: 0 },
    partiallyPaid: { count: 0, cents: 0 },
  };
  for (const i of items) {
    if (i.openCents <= 0 || i.currency !== "EUR") continue;
    const b = i.overdue ? s.overdue : i.paidCents > 0 ? s.partiallyPaid : s.open;
    b.count++;
    b.cents += i.openCents;
    s.totalCents += i.openCents;
  }
  return s;
}

// ── DASH-005 Kleinunternehmergrenze ───────────────────────────────────────────────────────────────────

export interface KuInvoice {
  documentDate: string;
  grossCents: number;
  status: string;
  type: string;
}

export type KuLevel = "ok" | "warn" | "critical" | "exceeded";

export interface KuProgress {
  year: number;
  turnoverCents: number;
  /** Limit for this year from `kleinunternehmer_limits` (founding year or current year); null = rule missing. */
  limitCents: number | null;
  priorYearLimitCents: number | null;
  currentYearLimitCents: number | null;
  foundingYearLimitCents: number | null;
  foundingYear: boolean;
  /** Share of the limit in basis points, floored and capped at 10.000. */
  shareBp: number;
  level: KuLevel;
}

const isKuOn = (history: readonly KuEntry[], date: string): boolean => {
  let found: KuEntry | undefined;
  for (const e of [...history].sort((a, b) => a.validFrom.localeCompare(b.validFrom))) {
    if (e.validFrom <= date) found = e;
  }
  return found?.isKU ?? false;
};

/** null when the company is not Kleinunternehmer on `today` (the card is not shown). */
export function kuProgress(input: {
  today: CalendarDate;
  kleinunternehmer: readonly KuEntry[];
  foundedOn?: string | undefined;
  invoices: readonly KuInvoice[];
}): KuProgress | null {
  if (!isKuOn(input.kleinunternehmer, input.today)) return null;
  const year = input.today.slice(0, 4);
  let turnoverCents = 0;
  for (const d of input.invoices) {
    if (d.type !== "invoice" || d.status === "draft" || d.status === "cancelled") continue;
    if (!d.documentDate.startsWith(year)) continue;
    turnoverCents += d.grossCents;
  }
  const foundingYear = input.foundedOn?.slice(0, 4) === year;
  const rule = lookupRule(KLEINUNTERNEHMER_LIMITS, input.today);
  if (!rule.ok) {
    return {
      year: Number(year),
      turnoverCents,
      limitCents: null,
      priorYearLimitCents: null,
      currentYearLimitCents: null,
      foundingYearLimitCents: null,
      foundingYear,
      shareBp: 0,
      level: "ok",
    };
  }
  const L = rule.value.value;
  const limitCents = foundingYear ? L.foundingYearLimitCents : L.currentYearLimitCents;
  const rawBp = limitCents > 0 ? Math.floor((turnoverCents * 10_000) / limitCents) : 0;
  const [warnBp = 10_000, criticalBp = 10_000] = L.warnAtBp;
  const level: KuLevel =
    turnoverCents > limitCents ? "exceeded" : rawBp >= criticalBp ? "critical" : rawBp >= warnBp ? "warn" : "ok";
  return {
    year: Number(year),
    turnoverCents,
    limitCents,
    priorYearLimitCents: L.priorYearLimitCents,
    currentYearLimitCents: L.currentYearLimitCents,
    foundingYearLimitCents: L.foundingYearLimitCents,
    foundingYear,
    shareBp: Math.min(rawBp, 10_000),
    level,
  };
}

// ── DASH-006 Bank ─────────────────────────────────────────────────────────────────────────────────────

export interface BankAccountRow {
  kind: string;
  currency: string;
  /** Closing balance of the latest statement (what `/bank` shows); null = no statement balance yet. */
  closingBalanceCents: number | null;
}

export interface BankTxRow {
  id: string;
  bookingDate: string;
  amountCents: number;
  status: string;
  counterpartyName: string | null;
  purpose: string;
}

export interface BankSummary {
  accountCount: number;
  totalCents: number;
  accountsWithoutBalance: number;
  latest: { id: string; bookingDate: string; amountCents: number; label: string }[];
}

export const DASHBOARD_LATEST_TRANSACTIONS = 4;

export function bankSummary(
  accounts: readonly BankAccountRow[],
  transactions: readonly BankTxRow[],
  limit = DASHBOARD_LATEST_TRANSACTIONS,
): BankSummary {
  const eur = accounts.filter((a) => a.kind === "bank" && a.currency === "EUR");
  const latest = transactions
    .filter((t) => t.status !== "ignored")
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.bookingDate.localeCompare(a.t.bookingDate) || a.i - b.i)
    .slice(0, limit)
    .map(({ t }) => ({
      id: t.id,
      bookingDate: t.bookingDate,
      amountCents: t.amountCents,
      label: t.counterpartyName?.trim() || t.purpose.trim(),
    }));
  return {
    accountCount: eur.length,
    totalCents: eur.reduce((s, a) => s + (a.closingBalanceCents ?? 0), 0),
    accountsWithoutBalance: eur.filter((a) => a.closingBalanceCents === null).length,
    latest,
  };
}

// ── DASH-007 Zuordnungsquote ──────────────────────────────────────────────────────────────────────────

/** UI scale of the share (not legal data): red below 85 %, amber 85–99 %, green at 100 %. */
export const MATCHED_SHARE_LEVELS = { mediumFrom: 85, completeAt: 100 } as const;

const ASSIGNED = ["matched", "booked", "private", "transfer"] as const;
const UNASSIGNED = ["open", "partially_matched"] as const;

export interface MatchedShare {
  total: number;
  assigned: number;
  unassigned: number;
  percent: number | null;
  level: "low" | "medium" | "complete" | null;
}

export function matchedShare(counts: Readonly<Partial<Record<string, number>>>): MatchedShare {
  const assigned = ASSIGNED.reduce((s, k) => s + (counts[k] ?? 0), 0);
  const unassigned = UNASSIGNED.reduce((s, k) => s + (counts[k] ?? 0), 0);
  const total = assigned + unassigned;
  if (total === 0) return { total, assigned, unassigned, percent: null, level: null };
  const percent = Math.floor((assigned * 100) / total);
  const level =
    percent >= MATCHED_SHARE_LEVELS.completeAt
      ? "complete"
      : percent >= MATCHED_SHARE_LEVELS.mediumFrom
        ? "medium"
        : "low";
  return { total, assigned, unassigned, percent, level };
}

// ── DASH-008 Top 5 Kunden ─────────────────────────────────────────────────────────────────────────────

/** Invoice types that carry a receivable (advance/partial/final: the payable amount avoids double counting). */
const PAYABLE_TYPES: ReadonlySet<string> = new Set(["invoice", "advance_invoice", "partial_invoice", "final_invoice"]);
const FINAL_STATUSES: ReadonlySet<string> = new Set(["finalized", "sent"]);

export const TOP_CUSTOMERS_MONTHS = 3;
export const TOP_CUSTOMERS_LIMIT = 5;

export interface CustomerDoc {
  contactId?: string | undefined;
  contactName: string;
  documentDate: string;
  payableCents: number;
  type: string;
  status: string;
  currency: string;
}

export interface TopCustomer {
  contactId: string | null;
  name: string;
  amountCents: number;
}

export function topCustomers(
  docs: readonly CustomerDoc[],
  today: CalendarDate,
  limit = TOP_CUSTOMERS_LIMIT,
  months = TOP_CUSTOMERS_MONTHS,
): TopCustomer[] {
  const after = subtractMonths(today, months);
  const sums = new Map<string, TopCustomer>();
  for (const d of docs) {
    if (!PAYABLE_TYPES.has(d.type) || !FINAL_STATUSES.has(d.status) || d.currency !== "EUR") continue;
    if (d.documentDate <= after || d.documentDate > today) continue;
    const key = d.contactId ?? `name:${d.contactName}`;
    const row = sums.get(key) ?? { contactId: d.contactId ?? null, name: d.contactName, amountCents: 0 };
    row.amountCents += d.payableCents;
    sums.set(key, row);
  }
  return [...sums.values()]
    .filter((c) => c.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name, "de"))
    .slice(0, limit);
}
