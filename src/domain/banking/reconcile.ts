/**
 * Statement reconciliation (F07 BNK-030 §4.6, EC-156, EC-BNK-41): the official statement's closing balance is
 * compared with opening + Σ booked rows of the account in the statement period. Statements are UTC by default
 * (EC-155): rows with a UTC instant (`bookedAtRaw`) are placed by that instant, date-only rows by their date.
 */
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { formatMoneyDe } from "./amount";

export interface ReconcileRow {
  id: string;
  amountCents: number;
  bookingDate: string;
  bookedAtRaw?: string;
}

export interface ReconcileStatement {
  periodFrom?: string;
  periodTo?: string;
  periodStartUtc?: string;
  periodEndUtc?: string;
  openingBalanceCents?: number;
  closingBalanceCents?: number;
  currency: string;
}

export interface Difference {
  kind: "missing" | "extra" | "amount";
  detail: string;
  transactionId?: string;
  amountCents?: number;
}

export interface ReconcileResult {
  reconciled: boolean;
  expectedClosingCents?: number;
  diffCents?: number;
  differences: Difference[];
  message?: string;
}

export function inStatementPeriod(row: ReconcileRow, st: ReconcileStatement): boolean {
  if (!st.periodFrom || !st.periodTo) return false;
  if (row.bookedAtRaw) {
    const t = Date.parse(row.bookedAtRaw);
    const start = Date.parse(st.periodStartUtc ?? `${st.periodFrom}T00:00:00Z`);
    const end = Date.parse(`${addDays(st.periodTo as CalendarDate, 1)}T00:00:00Z`);
    return t >= start && t < end;
  }
  return row.bookingDate >= st.periodFrom && row.bookingDate <= st.periodTo;
}

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

export const monthLabel = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** „Oktober 2026“ for a full calendar month, else „01.10.2026–15.10.2026“. */
export function periodLabel(from: string, to: string): string {
  const fullMonth =
    from.slice(8) === "01" && from.slice(0, 7) === to.slice(0, 7) && addDays(to as CalendarDate, 1).slice(8) === "01";
  return fullMonth
    ? monthLabel(from.slice(0, 7))
    : `${formatGermanDate(from as CalendarDate)}–${formatGermanDate(to as CalendarDate)}`;
}

export function reconcileStatement(input: {
  statement: ReconcileStatement;
  /** DB ids of the rows this statement delivered (new, merged or already present). */
  fileRowIds: readonly string[];
  /** File rows without a DB row (possible duplicates awaiting review, conflicts, rejected rows). */
  missing: readonly { line: number; amountCents: number; detail: string }[];
  /** Booked rows of the account around the period (ignored/rolled-back rows excluded by the caller). */
  rows: readonly ReconcileRow[];
}): ReconcileResult {
  const { statement: st } = input;
  const differences: Difference[] = input.missing.map((m) => ({
    kind: "missing" as const,
    detail: `Zeile ${m.line}: ${m.detail}`,
    amountCents: m.amountCents,
  }));
  const fromFile = new Set(input.fileRowIds);
  const inPeriod = input.rows.filter((r) => inStatementPeriod(r, st));
  for (const r of inPeriod) {
    if (!fromFile.has(r.id)) {
      differences.push({
        kind: "extra",
        detail: `${formatGermanDate(r.bookingDate as CalendarDate)} nicht im Kontoauszug enthalten`,
        transactionId: r.id,
        amountCents: r.amountCents,
      });
    }
  }
  if (st.openingBalanceCents === undefined || st.closingBalanceCents === undefined) {
    return { reconciled: false, differences, message: "Saldo nicht prüfbar" };
  }
  const expected = st.openingBalanceCents + inPeriod.reduce((a, r) => a + r.amountCents, 0);
  const diff = st.closingBalanceCents - expected;
  const reconciled = diff === 0 && differences.length === 0;
  const label = st.periodFrom && st.periodTo ? periodLabel(st.periodFrom, st.periodTo) : "";
  return {
    reconciled,
    expectedClosingCents: expected,
    diffCents: diff,
    differences,
    ...(reconciled
      ? {}
      : {
          message: `Kontoauszug ${label} stimmt nicht mit den Umsätzen überein: Differenz ${formatMoneyDe(diff, st.currency)} (${differences.length} Abweichungen).`,
        }),
  };
}
