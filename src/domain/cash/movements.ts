/**
 * The Kasse page and the cash report (F07 CSH-020, CSH-030, §6.7): the movement list of the `cash` ledger account
 * in (date, journal seq) order with running balance, derived from journal lines — there is no cash book. Also the
 * live never-negative projection for the „Bargeld eingezahlt / entnommen“ dialog (CSH-026, §4.7).
 */
import { writeCsv } from "../csv/csv";
import { formatCents } from "../money";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export interface CashJournalLine {
  date: string;
  seq: number;
  debitCents: number;
  creditCents: number;
  text: string;
  /** Beleg reference shown in the list (invoice number, „Eigenbeleg …“, „Buchung 12“). */
  voucher: string;
  /** Counter accounts of the entry (Gegenkonto). */
  counterAccounts: string[];
  entryId: string;
}

export interface CashMovementRow extends CashJournalLine {
  inCents: number;
  outCents: number;
  balanceCents: number;
}

const order = (a: { date: string; seq: number }, b: { date: string; seq: number }) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq;

export function cashMovements(lines: readonly CashJournalLine[]): { rows: CashMovementRow[]; balanceCents: number } {
  let balance = 0;
  const rows = [...lines].sort(order).map((l) => {
    balance += l.debitCents - l.creditCents;
    return { ...l, inCents: l.debitCents, outCents: l.creditCents, balanceCents: balance };
  });
  return { rows, balanceCents: balance };
}

/** Rows of a period with the opening balance carried in (CSH-030). */
export function cashPeriod(rows: readonly CashMovementRow[], from: string, to: string) {
  const before = rows.filter((r) => r.date < from);
  const openingCents = before.length > 0 ? (before[before.length - 1] as CashMovementRow).balanceCents : 0;
  const inPeriod = rows.filter((r) => r.date >= from && r.date <= to);
  const closingCents =
    inPeriod.length > 0 ? (inPeriod[inPeriod.length - 1] as CashMovementRow).balanceCents : openingCents;
  return { openingCents, closingCents, rows: inPeriod };
}

/** CSH-030 CSV: Datum; Beleg; Text; Einnahme; Ausgabe; Bestand; Gegenkonto (UTF-8 BOM, `;`, CRLF). */
export function cashReportCsv(rows: readonly CashMovementRow[], from: string, to: string): string {
  const p = cashPeriod(rows, from, to);
  const body: (string | number)[][] = [
    [formatGermanDate(from as CalendarDate), "", "Anfangsbestand", "", "", formatCents(p.openingCents), ""],
    ...p.rows.map((r) => [
      formatGermanDate(r.date as CalendarDate),
      r.voucher,
      r.text,
      r.inCents ? formatCents(r.inCents) : "",
      r.outCents ? formatCents(r.outCents) : "",
      formatCents(r.balanceCents),
      r.counterAccounts.join(", "),
    ]),
    [formatGermanDate(to as CalendarDate), "", "Endbestand", "", "", formatCents(p.closingCents), ""],
  ];
  return writeCsv(["Datum", "Beleg", "Text", "Einnahme", "Ausgabe", "Bestand", "Gegenkonto"], body);
}

/**
 * Live projection for a planned movement (§6.7): the balance after inserting `amountCents` on `date` after all
 * movements of that date, and the minimum balance from that date on (the dialog highlights it).
 */
export function projectCash(
  rows: readonly { date: string; seq: number; debitCents: number; creditCents: number }[],
  planned: { date: string; amountCents: number },
): { minBalanceCents: number; minDate: string; ok: boolean } {
  const all = [...rows.map((r) => ({ date: r.date, seq: r.seq, delta: r.debitCents - r.creditCents }))];
  all.push({ date: planned.date, seq: Number.MAX_SAFE_INTEGER, delta: planned.amountCents });
  all.sort(order);
  let balance = 0;
  let min = Number.POSITIVE_INFINITY;
  let minDate = planned.date;
  for (const m of all) {
    balance += m.delta;
    if (m.date >= planned.date && balance < min) {
      min = balance;
      minDate = m.date;
    }
  }
  return { minBalanceCents: min, minDate, ok: min >= 0 };
}
