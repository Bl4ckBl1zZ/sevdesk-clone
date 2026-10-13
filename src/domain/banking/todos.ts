/**
 * Monthly statement to-do (F07 BNK-030, EC-156, EC-BNK-40/52). Derived, not stored: for every active `bank`
 * account and every past month since its start, from the 3rd of the following month a missing official statement
 * is an info to-do, after the 10th a warning; an imported statement without the signed PDF is a warning. Pure —
 * the Convex query passes accounts, statements and `today` (Europe/Berlin).
 */
import { addDays, type CalendarDate, daysInMonth } from "../time/calendar-date";
import { monthLabel } from "./reconcile";

export interface TodoAccount {
  id: string;
  name: string;
  kind: "bank" | "clearing" | "paypal";
  /** First day the account needs statements (opening balance date / first statement); default: last month. */
  startDate?: string;
  archived?: boolean;
}

export interface TodoStatement {
  accountId: string;
  periodFrom: string;
  periodTo: string;
  hasPdf: boolean;
  rolledBack?: boolean;
}

export interface StatementTodo {
  accountId: string;
  month: string;
  kind: "statement_missing" | "pdf_missing";
  severity: "info" | "warning";
  title: string;
}

/** Lookback limit so a long-unused account does not flood the list. */
const MAX_MONTHS = 12;

const monthStart = (m: string) => `${m}-01`;
const monthEnd = (m: string) =>
  `${m}-${String(daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7)))).padStart(2, "0")}`;
const prevMonth = (m: string) => {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
};

function covers(statements: readonly TodoStatement[], from: string, to: string): boolean {
  const ranges = statements.map((s) => [s.periodFrom, s.periodTo] as const).sort((a, b) => a[0].localeCompare(b[0]));
  let cursor = from;
  for (const [f, t] of ranges) {
    if (f > cursor) break;
    if (t >= cursor) cursor = addDays(t as CalendarDate, 1);
    if (cursor > to) return true;
  }
  return cursor > to;
}

export function statementTodos(
  accounts: readonly TodoAccount[],
  statements: readonly TodoStatement[],
  today: string,
): StatementTodo[] {
  const out: StatementTodo[] = [];
  const currentMonth = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  for (const a of accounts) {
    if (a.kind !== "bank" || a.archived) continue;
    const own = statements.filter((s) => s.accountId === a.id && !s.rolledBack);
    let m = prevMonth(currentMonth);
    const start = (a.startDate ?? monthStart(m)).slice(0, 7);
    for (let n = 0; n < MAX_MONTHS && m >= start; n++, m = prevMonth(m)) {
      const latest = n === 0;
      if (latest && day < 3) continue;
      const from = monthStart(m);
      const to = monthEnd(m);
      const covering = own.filter((s) => s.periodFrom <= to && s.periodTo >= from);
      if (!covers(covering, from, to)) {
        const warning = !latest || day > 10;
        out.push({
          accountId: a.id,
          month: m,
          kind: "statement_missing",
          severity: warning ? "warning" : "info",
          title: warning
            ? `Kontoauszug ${monthLabel(m)} für ${a.name} fehlt.`
            : `Kontoauszug ${monthLabel(m)} importieren (CAMT.053 + PDF signiert)`,
        });
      } else if (!covering.some((s) => s.hasPdf)) {
        out.push({
          accountId: a.id,
          month: m,
          kind: "pdf_missing",
          severity: "warning",
          title: `Für ${monthLabel(m)} fehlt der signierte PDF-Kontoauszug.`,
        });
      }
    }
  }
  return out.sort((x, y) => x.month.localeCompare(y.month) || x.accountId.localeCompare(y.accountId));
}
