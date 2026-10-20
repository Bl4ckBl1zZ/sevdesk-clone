/**
 * UST-01 monitor for unbilled time (F11 PRJ-015, E-PRJ-26, EC-026). Pure; `today` is passed in.
 *
 * Billable `open` entries **older than** the warning threshold (150 days) get a warning on the dashboard and in
 * `deadlines.notify`; older than the escalation threshold (180 days) → „Rechnungsfrist überschritten“ for customers
 * with the six-month invoicing duty of § 14 Abs. 2 UStG (businesses, legal persons). The thresholds are the
 * date-effective `INVOICING_DEADLINE` rule rows shared with the delivery-note monitor (F04 QUO-14). Unlike QUO-14
 * („from day 150“), F11 says „older than 150 days“ (TST-PRJ-15: 150 → nothing, 151 → warning), so the comparison
 * here is strict.
 */
import { type DeadlineCustomer, mustInvoiceWithinSixMonths } from "../documents/uninvoiced-supplies";
import type { RuleOverride } from "../rules/rule-table";
import { type InvoicingDeadline, lookupInvoicingDeadline } from "../rules/thresholds";
import { type CalendarDate, daysBetween } from "../time/calendar-date";
import type { TimeEntryStatus } from "./time-entries";

export interface UnbilledEntryRow {
  readonly date: CalendarDate;
  readonly billable: boolean;
  readonly status: TimeEntryStatus;
}

export type UnbilledLevel = "warning" | "escalation";

export function unbilledEntryLevel(
  e: UnbilledEntryRow,
  customer: DeadlineCustomer | null,
  today: CalendarDate,
  overrides: readonly RuleOverride<InvoicingDeadline>[] = [],
): { level: UnbilledLevel; daysSince: number } | null {
  if (!e.billable || e.status !== "open" || e.date > today) return null;
  const rule = lookupInvoicingDeadline(e.date, overrides);
  if (!rule.ok) return null;
  const { warnAfterDays, escalateAfterDays } = rule.value.value;
  const daysSince = daysBetween(e.date, today);
  if (daysSince > escalateAfterDays && mustInvoiceWithinSixMonths(customer, false)) {
    return { level: "escalation", daysSince };
  }
  if (daysSince > warnAfterDays) return { level: "warning", daysSince };
  return null;
}

export interface UnbilledSummary {
  readonly warning: number;
  readonly escalation: number;
  readonly oldestDate?: CalendarDate;
}

export function summarizeUnbilled(
  rows: readonly (UnbilledEntryRow & { customer: DeadlineCustomer | null })[],
  today: CalendarDate,
  overrides: readonly RuleOverride<InvoicingDeadline>[] = [],
): UnbilledSummary {
  let warning = 0;
  let escalation = 0;
  let oldest: CalendarDate | undefined;
  for (const r of rows) {
    const l = unbilledEntryLevel(r, r.customer, today, overrides);
    if (!l) continue;
    if (l.level === "escalation") escalation += 1;
    else warning += 1;
    if (!oldest || r.date < oldest) oldest = r.date;
  }
  return { warning, escalation, ...(oldest ? { oldestDate: oldest } : {}) };
}

/** E-PRJ-26 text. */
export const unbilledWarningText = (n: number): string =>
  `${n} abrechenbare Zeiteinträge sind älter als 150 Tage. Rechnungen müssen spätestens 6 Monate nach der Leistung gestellt werden (§ 14 Abs. 2 UStG).`;

export const unbilledEscalationText = (n: number): string =>
  `Rechnungsfrist überschritten: ${n} abrechenbare Zeiteinträge sind älter als 180 Tage und noch nicht abgerechnet (§ 14 Abs. 2 UStG).`;
