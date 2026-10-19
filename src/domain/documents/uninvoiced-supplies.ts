/**
 * UST-01 / F04 QUO-14: supplies (delivery notes) that are not yet invoiced. § 14 Abs. 2 S. 1 Nr. 1 und 2 UStG
 * requires an invoice within six months after the supply to another business or a legal person, and for
 * property-related supplies to anyone. `deadlines.notify` warns at day 150 and escalates at day 180 after the end of
 * the supply; the levels are date-effective rule data (`INVOICING_DEADLINE`). Pure; `today` is passed in.
 */

import type { RuleOverride } from "../rules/rule-table";
import { type InvoicingDeadline, lookupInvoicingDeadline } from "../rules/thresholds";
import { addDays, type CalendarDate, daysBetween, isCalendarDate } from "../time/calendar-date";
import type { SalesDocStatus } from "./lifecycle";
import { type SupplyDate, supplyEnd } from "./snapshot";

export type InvoicingDeadlineLevel = "warning" | "escalation";

export interface DeadlineCustomer {
  readonly isConsumer: boolean;
  readonly kind: "organization" | "person";
}

export interface UninvoicedSupplyRow {
  readonly id: string;
  readonly status: SalesDocStatus;
  readonly supplyDate?: SupplyDate | undefined;
  /** The customer contact; null when the note has none (treated as obligated — conservative). */
  readonly customer: DeadlineCustomer | null;
  readonly propertyRelated?: boolean | undefined;
}

export interface InvoicingDeadlineState {
  readonly level: InvoicingDeadlineLevel;
  /** End of the supply (delivery date, period end or last day of the month). */
  readonly deliveredOn: CalendarDate;
  readonly daysSince: number;
  /** The day the to-do escalates (end of the supply + `escalateAfterDays`). */
  readonly escalatesOn: CalendarDate;
}

/** Finalised delivery notes that no invoice has billed yet (§4.2.3: finalized/sent/received). */
const UNINVOICED: readonly SalesDocStatus[] = ["finalized", "sent", "accepted"];

/**
 * UST-01: is the six-month invoicing duty of § 14 Abs. 2 UStG triggered? Businesses (not a consumer), legal persons
 * (organisations, even when flagged as consumer) and property-related supplies to anyone. An unknown customer counts
 * as obligated (a missed deadline costs more than a superfluous to-do).
 */
export function mustInvoiceWithinSixMonths(customer: DeadlineCustomer | null, propertyRelated: boolean): boolean {
  if (propertyRelated || !customer) return true;
  return !customer.isConsumer || customer.kind === "organization";
}

export function invoicingDeadlineLevel(
  row: UninvoicedSupplyRow,
  today: CalendarDate,
  overrides: readonly RuleOverride<InvoicingDeadline>[] = [],
): InvoicingDeadlineState | null {
  if (!UNINVOICED.includes(row.status) || !row.supplyDate) return null;
  if (!mustInvoiceWithinSixMonths(row.customer, row.propertyRelated === true)) return null;
  const end = supplyEnd(row.supplyDate);
  if (!isCalendarDate(end) || end > today) return null;
  const rule = lookupInvoicingDeadline(end, overrides);
  if (!rule.ok) return null;
  const { warnAfterDays, escalateAfterDays } = rule.value.value;
  const daysSince = daysBetween(end, today);
  const escalatesOn = addDays(end, escalateAfterDays);
  if (daysSince >= escalateAfterDays) return { level: "escalation", deliveredOn: end, daysSince, escalatesOn };
  if (daysSince >= warnAfterDays) return { level: "warning", deliveredOn: end, daysSince, escalatesOn };
  return null;
}

export function uninvoicedSupplyDeadlines(
  rows: readonly UninvoicedSupplyRow[],
  today: CalendarDate,
  overrides: readonly RuleOverride<InvoicingDeadline>[] = [],
): {
  warn: (InvoicingDeadlineState & { id: string })[];
  escalate: (InvoicingDeadlineState & { id: string })[];
} {
  const warn: (InvoicingDeadlineState & { id: string })[] = [];
  const escalate: (InvoicingDeadlineState & { id: string })[] = [];
  for (const row of rows) {
    const s = invoicingDeadlineLevel(row, today, overrides);
    if (!s) continue;
    (s.level === "escalation" ? escalate : warn).push({ id: row.id, ...s });
  }
  return { warn, escalate };
}
