/**
 * Balance continuity (F07 BNK-035, GOBD-02, RI-27, EC-BNK-17/44/47): a statement must add up (opening + Σ entries
 * = closing), per-row balances must chain, and consecutive statements must connect (opening = previous closing).
 * A CSV without balances is „Saldo nicht prüfbar“. Pure; messages are the German texts of F07 §5.2.
 */
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { formatMoneyDe } from "./amount";
import type { ParsedStatement, ParsedTransaction } from "./types";

export type ArithmeticResult =
  | { status: "ok" }
  | { status: "mismatch"; diffCents: number; message: string }
  | { status: "unverifiable"; message: string };

export function checkStatementArithmetic(
  st: Pick<ParsedStatement, "openingBalanceCents" | "closingBalanceCents" | "transactions" | "currency">,
): ArithmeticResult {
  if (st.openingBalanceCents === undefined || st.closingBalanceCents === undefined) {
    return { status: "unverifiable", message: "Saldo nicht prüfbar" };
  }
  const currency = st.currency ?? st.transactions[0]?.currency ?? "EUR";
  const expected = st.openingBalanceCents + st.transactions.reduce((a, t) => a + t.amountCents, 0);
  if (expected === st.closingBalanceCents) return { status: "ok" };
  const diff = st.closingBalanceCents - expected;
  return {
    status: "mismatch",
    diffCents: diff,
    message: `Anfangssaldo + Umsätze (${formatMoneyDe(expected, currency)}) ≠ Endsaldo (${formatMoneyDe(st.closingBalanceCents, currency)}): Differenz ${formatMoneyDe(diff, currency)}.`,
  };
}

/** EC-BNK-17: `balance_n = balance_{n−1} + amount_n` for rows that carry a balance (CSV `Balance`). */
export function checkRunningBalances(
  txs: readonly Pick<ParsedTransaction, "line" | "bookingDate" | "amountCents" | "balanceAfterCents">[],
  currency: string,
): { line: number; diffCents: number; message: string }[] {
  const out: { line: number; diffCents: number; message: string }[] = [];
  for (let i = 1; i < txs.length; i++) {
    const prev = txs[i - 1];
    const cur = txs[i];
    if (prev?.balanceAfterCents === undefined || cur?.balanceAfterCents === undefined) continue;
    const diff = cur.balanceAfterCents - (prev.balanceAfterCents + cur.amountCents);
    if (diff === 0) continue;
    out.push({
      line: cur.line,
      diffCents: diff,
      message: `Saldenlücke zwischen ${formatGermanDate(prev.bookingDate as CalendarDate)} und ${formatGermanDate(cur.bookingDate as CalendarDate)}: ${formatMoneyDe(diff, currency)}`,
    });
  }
  return out;
}

export interface StatementBalances {
  periodFrom?: string;
  periodTo?: string;
  openingBalanceCents?: number;
  closingBalanceCents?: number;
}

export type ContinuityResult =
  | { status: "first" }
  | { status: "ok" }
  | { status: "unverifiable"; message: string }
  | { status: "gap"; from: string; to: string; diffCents: number; message: string }
  | { status: "overlap"; from: string; to: string; message: string };

/** Consecutive statements of one account (BNK-035, EC-BNK-47). `prev` = the latest earlier statement. */
export function checkContinuity(
  prev: StatementBalances | undefined,
  next: StatementBalances,
  currency: string,
): ContinuityResult {
  if (!prev) return { status: "first" };
  if (!prev.periodTo || !next.periodFrom) return { status: "unverifiable", message: "Saldo nicht prüfbar" };
  if (next.periodFrom <= prev.periodTo) {
    return {
      status: "overlap",
      from: next.periodFrom,
      to: prev.periodTo,
      message: `Der Kontoauszug überschneidet sich mit dem vorherigen (${formatGermanDate(next.periodFrom as CalendarDate)}–${formatGermanDate(prev.periodTo as CalendarDate)}); bereits vorhandene Umsätze werden erkannt und nicht erneut gebucht.`,
    };
  }
  if (prev.closingBalanceCents === undefined || next.openingBalanceCents === undefined) {
    return { status: "unverifiable", message: "Saldo nicht prüfbar" };
  }
  const diff = next.openingBalanceCents - prev.closingBalanceCents;
  if (diff === 0) return { status: "ok" };
  return {
    status: "gap",
    from: prev.periodTo,
    to: next.periodFrom,
    diffCents: diff,
    message: `Anfangssaldo (${formatMoneyDe(next.openingBalanceCents, currency)}) passt nicht zum letzten Endsaldo (${formatMoneyDe(prev.closingBalanceCents, currency)}) – fehlen Umsätze zwischen ${formatGermanDate(prev.periodTo as CalendarDate)} und ${formatGermanDate(next.periodFrom as CalendarDate)}?`,
  };
}

/** Days not covered between two statements (info for the to-do list). */
export function uncoveredRange(prevTo: string, nextFrom: string): { from: string; to: string } | null {
  const from = addDays(prevTo as CalendarDate, 1);
  const to = addDays(nextFrom as CalendarDate, -1);
  return from <= to ? { from, to } : null;
}
