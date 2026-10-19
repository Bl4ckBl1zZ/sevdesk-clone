import { canDo, canKeyDo, type Permission } from "../../src/domain/access/permissions";
import { sha256Hex } from "../../src/domain/audit/chain";
import { CSV_DIRECT_MAX_ROWS, type CsvVariant, csvFileName, formatCsv } from "../../src/domain/csv/export";
import {
  BANK_TRANSACTION_COLUMNS,
  type BankTransactionCsvRow,
  CSV_LIST_FILE,
  DOCUMENT_COLUMNS,
  type DocumentCsvRow,
  JOURNAL_COLUMNS,
  type JournalCsvRow,
  OPEN_ITEM_COLUMNS,
  PAYMENT_COLUMNS,
  type PaymentCsvRow,
} from "../../src/domain/csv/lists";
import { DOC_TYPE_LABEL_DE } from "../../src/domain/documents/doc-types";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit } from "./audit";
import { createJob } from "./jobs";
import { openItemsAsOf } from "./payments";
import { displayStatusOf } from "./salesDocuments";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Server-side list CSV exports (F09 EXP-021/022/026) for the lists whose rows live in Convex: documents, open items,
 * payments, bank transactions, journal. Up to 5,000 rows the file is returned directly; larger exports run as a
 * `csv_export` job. Every export is audited with its SHA-256 (`export.csv`). Contacts and products keep their CON-143 /
 * PRD-085 row queries and are formatted in the browser.
 */

export const SERVER_CSV_LISTS = ["documents", "open_items", "payments", "bank_transactions", "journal"] as const;
export type ServerCsvList = (typeof SERVER_CSV_LISTS)[number];

export const LIST_PERMISSION: Readonly<Record<ServerCsvList, Permission>> = {
  documents: "documents.read",
  open_items: "payments.read",
  payments: "payments.read",
  bank_transactions: "banking.read",
  journal: "accounting.read",
};

export interface CsvParams {
  list: ServerCsvList;
  variant: CsvVariant;
  /** documents: list type (invoice family by default) */
  type?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** The export entry point needs the list's own read permission on top of `documents.export`. */
export function assertListPermission(ctx: ModelCtx, list: ServerCsvList): void {
  const perm = LIST_PERMISSION[list];
  if (ctx.role) {
    if (!canDo(ctx.role, perm)) throw appError("forbidden_role");
    return;
  }
  const scopes = ctx.actorContext.scopes;
  if (scopes && !canKeyDo(scopes, perm)) throw appError("forbidden_scope");
}

const INVOICE_FAMILY: readonly string[] = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
];
const isInvoiceLike = (d: { type: string }) => INVOICE_FAMILY.includes(d.type);

const inRange = (d: string | undefined | null, p: CsvParams) =>
  !d ? !p.dateFrom && !p.dateTo : (!p.dateFrom || d >= p.dateFrom) && (!p.dateTo || d <= p.dateTo);

async function documentRows(ctx: ReadCtx, p: CsvParams, today: string): Promise<DocumentCsvRow[]> {
  const type = p.type ?? "invoice";
  const docs = await ctx.db.query("salesDocuments").order("desc").collect();
  return docs
    .filter((d) => (type === "invoice" ? isInvoiceLike(d) : d.type === type))
    .filter((d) => (!p.dateFrom && !p.dateTo) || inRange(d.documentDate, p))
    .map((d) => ({
      id: d._id,
      type: d.type,
      typeLabel: DOC_TYPE_LABEL_DE[d.type] ?? d.type,
      number: d.number ?? null,
      contactName: d.contactName ?? null,
      documentDate: d.documentDate ?? null,
      dueDate: d.dueDate ?? null,
      netCents: d.totals.netCents,
      vatCents: d.totals.vatCents,
      grossCents: d.totals.grossCents,
      openCents: d.openAmountCents ?? null,
      currency: d.currency,
      status: displayStatusOf(d, today).label,
    }));
}

async function paymentRows(ctx: ReadCtx, p: CsvParams): Promise<PaymentCsvRow[]> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_date", (q) => q.gte("date", p.dateFrom ?? "0000-00-00").lte("date", p.dateTo ?? "9999-12-31"))
    .order("desc")
    .collect();
  const out: PaymentCsvRow[] = [];
  for (const r of rows) {
    const doc = r.target.kind === "salesDocument" ? await ctx.db.get(r.target.id as Id<"salesDocuments">) : null;
    const contact = r.contactId ? await ctx.db.get(r.contactId) : null;
    out.push({
      id: r._id,
      date: r.date,
      number: r.number ?? null,
      targetLabel: doc?.number ?? r.target.kind,
      contactName: contact?.displayName ?? null,
      sourceKind: r.source.kind,
      amountCents: r.amountCents,
      reversed: Boolean(r.reversedById || r.reversalOfId),
      note: r.note ?? null,
    });
  }
  return out;
}

async function bankRows(ctx: ReadCtx, p: CsvParams): Promise<BankTransactionCsvRow[]> {
  const accountId = p.accountId ? ctx.db.normalizeId("bankAccounts", p.accountId) : null;
  const txs = accountId
    ? await ctx.db
        .query("bankTransactions")
        .withIndex("by_account_bookingDate", (q) => q.eq("accountId", accountId))
        .order("desc")
        .collect()
    : await ctx.db.query("bankTransactions").order("desc").collect();
  const names = new Map<string, string>();
  const out: BankTransactionCsvRow[] = [];
  for (const t of txs) {
    if (!inRange(t.bookingDate, p) && (p.dateFrom || p.dateTo)) continue;
    if (!names.has(t.accountId)) names.set(t.accountId, (await ctx.db.get(t.accountId))?.name ?? "");
    out.push({
      id: t._id,
      accountName: names.get(t.accountId) ?? "",
      bookingDate: t.bookingDate,
      valueDate: t.valueDate ?? null,
      amountCents: t.amountCents,
      currency: t.currency,
      counterpartyName: t.counterpartyName ?? null,
      counterpartyIban: t.counterpartyIban ?? null,
      purpose: t.purpose,
      status: t.status,
    });
  }
  return out;
}

async function journalRows(ctx: ReadCtx, p: CsvParams): Promise<JournalCsvRow[]> {
  const out: JournalCsvRow[] = [];
  for (const e of await ctx.db.query("journalEntries").withIndex("by_seq").collect()) {
    if ((p.dateFrom || p.dateTo) && !inRange(e.date, p)) continue;
    e.lines.forEach((l, i) => {
      out.push({
        entryId: e._id,
        seq: e.seq,
        date: e.date,
        text: e.text,
        lineIndex: i,
        account: l.account,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        sourceKind: e.source.kind,
        reversal: e.reversalOfId !== undefined,
      });
    });
  }
  return out;
}

/** Builds the CSV text and the row count of one list (read-only). */
export async function buildCsv(ctx: ReadCtx & { now: () => number }, p: CsvParams) {
  const today = berlinCalendarDate(ctx.now());
  let content: string;
  let rows: number;
  switch (p.list) {
    case "documents": {
      const r = await documentRows(ctx, p, today);
      rows = r.length;
      content = formatCsv(DOCUMENT_COLUMNS, r, p.variant);
      break;
    }
    case "open_items": {
      const r = (await openItemsAsOf(ctx, { asOf: p.dateTo ?? today })).items;
      rows = r.length;
      content = formatCsv(OPEN_ITEM_COLUMNS, r, p.variant);
      break;
    }
    case "payments": {
      const r = await paymentRows(ctx, p);
      rows = r.length;
      content = formatCsv(PAYMENT_COLUMNS, r, p.variant);
      break;
    }
    case "bank_transactions": {
      const r = await bankRows(ctx, p);
      rows = r.length;
      content = formatCsv(BANK_TRANSACTION_COLUMNS, r, p.variant);
      break;
    }
    case "journal": {
      const r = await journalRows(ctx, p);
      rows = r.length;
      content = formatCsv(JOURNAL_COLUMNS, r, p.variant);
      break;
    }
  }
  return { content, rows, name: csvFileName(CSV_LIST_FILE[p.list], p.variant, today) };
}

/**
 * EXP-021: ≤ 5,000 rows → the file is returned and the export is audited here; more → a `csv_export` job whose worker
 * stores the file for 30 days (EXP-026).
 */
export async function startCsvExport(ctx: ModelCtx, p: CsvParams) {
  assertListPermission(ctx, p.list);
  const built = await buildCsv(ctx, p);
  if (built.rows <= CSV_DIRECT_MAX_ROWS) {
    const sha256 = await sha256Hex(built.content);
    await appendAudit(ctx, {
      action: "export.csv",
      entity: { table: "exports", id: p.list, label: built.name },
      diff: { after: { sha256, rows: built.rows, params: p } },
    });
    return { kind: "file" as const, name: built.name, content: built.content, sha256, rows: built.rows };
  }
  const jobId = await createJob(ctx, {
    kind: "csv_export",
    label: `CSV-Export ${built.name}`,
    params: p,
    total: built.rows,
  });
  await ctx.scheduler.runAfter(0, internal.exports.runCsvJob, { jobId });
  return { kind: "job" as const, jobId, rows: built.rows };
}
