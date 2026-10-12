/**
 * Customer statistics (F02 CON-150/151/153, §5.9; T-CON-029, T-CON-056). Pure over finalised documents of the contact
 * and its merged aliases; the caller resolves aliases and passes `today` (overdue is derived, never stored, 02 §6).
 */
import { fcToEurCents, parseFxRate } from "../money/convert";
import { addDays, type CalendarDate, toEpochDay } from "../time/calendar-date";

export type StatsDocType =
  | "invoice"
  | "partial_invoice"
  | "advance_invoice"
  | "final_invoice"
  | "cancellation"
  | "correction"
  | "quote"
  | "order_confirmation"
  | "delivery_note"
  | "reminder"
  | "proforma"
  | "self_billing";

export interface StatsDocument {
  readonly docType: StatsDocType;
  readonly documentDate: CalendarDate;
  readonly dueDate?: CalendarDate | undefined;
  /** Net and gross in document currency minor units (negative for cancellations/corrections). */
  readonly netCents: number;
  readonly grossCents: number;
  /** final_invoice: net of the deducted advances (document currency). */
  readonly deductedAdvanceNetCents?: number | undefined;
  readonly openAmountCents?: number | undefined;
  readonly paymentStatus?: "open" | "partially_paid" | "paid" | "credited" | "written_off" | undefined;
  readonly currency: string;
  /** "1 EUR = x FC" (03 §0.2 FxRate.rate) for non-EUR documents. */
  readonly fxRateToEur?: string | undefined;
  /** Date of the payment that settled the invoice in full. */
  readonly settledOn?: CalendarDate | undefined;
  /** Settled by a Storno (excluded from days-to-pay). */
  readonly settledByStorno?: boolean | undefined;
  /** Quotes: accepted (or converted). */
  readonly accepted?: boolean | undefined;
}

export interface ContactStats {
  readonly revenueThisYearCents: number;
  readonly revenueLastYearCents: number;
  readonly revenueAllTimeCents: number;
  readonly openCents: number;
  readonly overdueCents: number;
  /** Ø Zahlungsdauer; null = "zu wenig Daten" (< 3 invoices). */
  readonly avgDaysToPay: { days: number; invoices: number } | null;
  readonly avgDelay: { days: number; invoices: number } | null;
  readonly invoiceCount: number;
  readonly lastInvoiceDate: CalendarDate | null;
  /** Accepted quotes / quotes, in basis points; null without quotes. */
  readonly quoteConversionBp: number | null;
  readonly reminderCount: number;
  /** Last 12 months incl. the current one, oldest first ("YYYY-MM", net revenue in EUR cents). */
  readonly revenueByMonth: readonly { month: string; cents: number }[];
}

const INVOICE_TYPES: ReadonlySet<StatsDocType> = new Set([
  "invoice",
  "partial_invoice",
  "advance_invoice",
  "final_invoice",
  "cancellation",
  "correction",
]);

const PAYABLE: ReadonlySet<StatsDocType> = new Set(["invoice", "partial_invoice", "advance_invoice", "final_invoice"]);

/** Document currency → EUR cents with the document's rate (MISC-08, T-CON-029). */
export function toEurCents(cents: number, d: Pick<StatsDocument, "currency" | "fxRateToEur">): number {
  if (d.currency === "EUR" || !d.fxRateToEur) return cents;
  const rate = parseFxRate(d.fxRateToEur);
  return rate.ok ? fcToEurCents(cents, rate.value) : cents;
}

/** §5.9 revenue contribution of one document (net, EUR). */
export function revenueOf(d: StatsDocument): number {
  if (!INVOICE_TYPES.has(d.docType)) return 0;
  const net = d.docType === "final_invoice" ? d.netCents - (d.deductedAdvanceNetCents ?? 0) : d.netCents;
  return toEurCents(net, d);
}

function weightedDays(
  docs: readonly StatsDocument[],
  from: (d: StatsDocument) => CalendarDate | undefined,
  clampNegative: boolean,
): { days: number; invoices: number } | null {
  let weight = 0;
  let sum = 0;
  let n = 0;
  for (const d of docs) {
    const start = from(d);
    if (!start || !d.settledOn) continue;
    let days = toEpochDay(d.settledOn) - toEpochDay(start);
    if (clampNegative && days < 0) days = 0;
    const gross = Math.abs(toEurCents(d.grossCents, d));
    weight += gross;
    sum += gross * days;
    n++;
  }
  if (n < 3 || weight === 0) return null;
  return { days: Math.round(sum / weight), invoices: n };
}

export function computeContactStats(docs: readonly StatsDocument[], today: CalendarDate): ContactStats {
  const year = Number(today.slice(0, 4));
  let thisYear = 0;
  let lastYear = 0;
  let allTime = 0;
  let open = 0;
  let overdue = 0;
  let invoiceCount = 0;
  let lastInvoiceDate: CalendarDate | null = null;
  let quotes = 0;
  let accepted = 0;
  let reminders = 0;
  const months: string[] = [];
  const [ty, tm] = [year, Number(today.slice(5, 7))];
  for (let i = 11; i >= 0; i--) {
    const m = (tm - 1 - i + 120) % 12;
    const y = ty + Math.floor((tm - 1 - i) / 12);
    months.push(`${y}-${String(m + 1).padStart(2, "0")}`);
  }
  const byMonth = new Map(months.map((m) => [m, 0]));

  for (const d of docs) {
    if (d.docType === "quote") {
      quotes++;
      if (d.accepted) accepted++;
      continue;
    }
    if (d.docType === "reminder") {
      reminders++;
      continue;
    }
    const rev = revenueOf(d);
    if (INVOICE_TYPES.has(d.docType)) {
      const y = Number(d.documentDate.slice(0, 4));
      allTime += rev;
      if (y === year) thisYear += rev;
      if (y === year - 1) lastYear += rev;
      const month = d.documentDate.slice(0, 7);
      if (byMonth.has(month)) byMonth.set(month, (byMonth.get(month) ?? 0) + rev);
    }
    if (PAYABLE.has(d.docType)) {
      invoiceCount++;
      if (!lastInvoiceDate || d.documentDate > lastInvoiceDate) lastInvoiceDate = d.documentDate;
      if (d.paymentStatus === "open" || d.paymentStatus === "partially_paid") {
        const amount = toEurCents(d.openAmountCents ?? d.grossCents, d);
        open += amount;
        if (d.dueDate && d.dueDate < today) overdue += amount;
      }
    }
  }
  const since = addDays(today, -730);
  const paid = docs.filter(
    (d) =>
      PAYABLE.has(d.docType) &&
      d.paymentStatus === "paid" &&
      !d.settledByStorno &&
      !!d.settledOn &&
      d.settledOn >= since,
  );
  return {
    revenueThisYearCents: thisYear,
    revenueLastYearCents: lastYear,
    revenueAllTimeCents: allTime,
    openCents: open,
    overdueCents: overdue,
    avgDaysToPay: weightedDays(paid, (d) => d.documentDate, false),
    avgDelay: weightedDays(paid, (d) => d.dueDate, true),
    invoiceCount,
    lastInvoiceDate,
    quoteConversionBp: quotes === 0 ? null : Math.round((accepted * 10000) / quotes),
    reminderCount: reminders,
    revenueByMonth: months.map((month) => ({ month, cents: byMonth.get(month) ?? 0 })),
  };
}

export const EMPTY_STATS = (today: CalendarDate): ContactStats => computeContactStats([], today);
