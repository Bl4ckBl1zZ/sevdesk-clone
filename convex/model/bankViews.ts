import type { ReconcileResult } from "../../src/domain/banking/reconcile";
import { type StatementTodo, statementTodos } from "../../src/domain/banking/todos";
import { type TransitWarning, transitWarnings } from "../../src/domain/banking/transit";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { reconcileFor } from "./bankImport";
import { transitBankRows, transitDeposits } from "./bankTransactions";
import type { ReadCtx } from "./types";

/** Read models of the Bank pages (04 §4.6): account cards, statement archive, reconciliation, to-dos, findings. */

export async function accountsOverview(ctx: ReadCtx) {
  const accounts = (await ctx.db.query("bankAccounts").collect()).filter((a) => a.archivedAt === undefined);
  return Promise.all(
    accounts.map(async (a) => {
      const statements = (
        await ctx.db
          .query("bankStatements")
          .withIndex("by_account_period", (q) => q.eq("accountId", a._id))
          .order("desc")
          .collect()
      ).filter((s) => !s.rolledBack);
      const last = statements[0];
      const open = await ctx.db
        .query("bankTransactions")
        .withIndex("by_account_status", (q) => q.eq("accountId", a._id).eq("status", "open"))
        .collect();
      const latest = await ctx.db
        .query("bankTransactions")
        .withIndex("by_account_bookingDate", (q) => q.eq("accountId", a._id))
        .order("desc")
        .first();
      const pendingDuplicates = await ctx.db
        .query("possibleDuplicates")
        .withIndex("by_account_status", (q) => q.eq("accountId", a._id).eq("status", "open"))
        .collect();
      return {
        id: a._id,
        name: a.name,
        kind: a.kind,
        currency: a.currency,
        iban: a.iban ?? null,
        ledgerAccount: a.ledgerAccount,
        openCount: open.length,
        lastBookingDate: latest?.bookingDate ?? null,
        possibleDuplicates: pendingDuplicates.length,
        lastStatement: last
          ? {
              id: last._id,
              periodFrom: last.periodFrom,
              periodTo: last.periodTo,
              closingBalanceCents: last.closingBalanceCents ?? null,
              reconciled: last.reconciled,
              hasPdf: last.pdf !== undefined,
            }
          : null,
      };
    }),
  );
}

/** Reconciliation against the current rows (after the duplicate review, BNK-030/034): the rows the file delivered. */
export async function liveReconciliation(ctx: ReadCtx, statement: Doc<"bankStatements">): Promise<ReconcileResult> {
  const account = await ctx.db.get(statement.accountId);
  const imp = statement.importId ? await ctx.db.get(statement.importId) : null;
  const fileRowIds = new Set<string>(imp?.rowIds ?? []);
  const missing: { line: number; amountCents: number; detail: string }[] = [];
  if (imp) {
    const dups = await ctx.db
      .query("possibleDuplicates")
      .withIndex("by_account_status", (q) => q.eq("accountId", statement.accountId))
      .collect();
    for (const d of dups) {
      if (d.importId !== imp._id) continue;
      if (d.status === "open") {
        const c = d.candidate as { line: number; amountCents: number; bookingDate: string; purpose: string };
        missing.push({
          line: c.line,
          amountCents: c.amountCents,
          detail: `${c.bookingDate} ${c.purpose} (mögliche Dublette)`,
        });
      } else if (d.resolvedTransactionId) fileRowIds.add(d.resolvedTransactionId);
    }
  }
  return reconcileFor(ctx, statement, account?.currency ?? "EUR", [...fileRowIds], missing);
}

/** One line of the bank to-do list: a statement to-do or an open Geldtransit (with the row/transfer id). */
export type BankTodo =
  | (StatementTodo & { accountName: string; id?: undefined })
  | (Omit<TransitWarning, "kind"> & { kind: TransitWarning["kind"]; month: string; accountName: string });

export async function statementTodosFor(ctx: ReadCtx, now: number): Promise<BankTodo[]> {
  const accounts = await ctx.db.query("bankAccounts").collect();
  const statements = await ctx.db.query("bankStatements").collect();
  const firstStatement = new Map<string, string>();
  for (const s of statements) {
    if (s.rolledBack) continue;
    const prev = firstStatement.get(s.accountId);
    if (!prev || s.periodFrom < prev) firstStatement.set(s.accountId, s.periodFrom);
  }
  const todos = statementTodos(
    accounts.map((a) => {
      const start = a.openingBalance?.date ?? firstStatement.get(a._id);
      return {
        id: a._id,
        name: a.name,
        kind: a.kind,
        ...(start ? { startDate: start } : {}),
        ...(a.archivedAt !== undefined ? { archived: true } : {}),
      };
    }),
    statements.map((s) => ({
      accountId: s.accountId,
      periodFrom: s.periodFrom,
      periodTo: s.periodTo,
      hasPdf: s.pdf !== undefined,
      ...(s.rolledBack ? { rolledBack: true } : {}),
    })),
    berlinCalendarDate(now),
  );
  const names = new Map(accounts.map((a) => [a._id as string, a.name]));
  // BNK-061 / CSH-024: open Geldtransit (E-ACC-23, EC-BNK-68, EC-BNK-20, EC-CSH-15), derived the same way.
  const transit = transitWarnings(
    await transitBankRows(ctx),
    await transitDeposits(ctx),
    accounts.filter((a) => a.archivedAt === undefined).map((a) => ({ id: a._id, name: a.name, currency: a.currency })),
    berlinCalendarDate(now),
  );
  return [
    ...todos.map((t) => ({ ...t, accountName: names.get(t.accountId) ?? "" })),
    ...transit.map((w) => ({ ...w, month: w.date.slice(0, 7), accountName: names.get(w.accountId) ?? "" })),
  ];
}

/** BNK-113 / EC-BNK-15: a booked row re-delivered with different content — never applied, shown as a finding. */
export async function revisionFindings(ctx: ReadCtx, accountId?: Id<"bankAccounts">) {
  const out: {
    transactionId: Id<"bankTransactions">;
    bookingDate: string;
    changedFields: string[];
    at: number;
    sourceKind: string;
  }[] = [];
  const all = await ctx.db.query("bankTransactionRevisions").order("desc").take(2000);
  for (const r of all) {
    if (r.applied) continue;
    const tx = await ctx.db.get(r.transactionId);
    if (!tx || (accountId && tx.accountId !== accountId)) continue;
    out.push({
      transactionId: r.transactionId,
      bookingDate: tx.bookingDate,
      changedFields: r.changedFields ?? [],
      at: r.fetchedAt,
      sourceKind: r.sourceKind,
    });
  }
  return out;
}
