import { encodeId } from "../../src/domain/api/ids";
import {
  type ContinuityResult,
  checkContinuity,
  checkRunningBalances,
  checkStatementArithmetic,
} from "../../src/domain/banking/continuity";
import {
  bankTxId,
  type Candidate,
  dedupeKeys,
  type ExistingBankRow,
  type ImportPlan,
  type PlanItem,
  planImport,
  toCandidates,
} from "../../src/domain/banking/dedupe";
import { type LockedPeriodNotice, lockedPeriodNotices } from "../../src/domain/banking/locked-periods";
import { normaliseIban } from "../../src/domain/banking/normalise";
import { type ReconcileResult, reconcileStatement } from "../../src/domain/banking/reconcile";
import { parseStatement, statementRetentionUntil } from "../../src/domain/banking/statement";
import type { ParsedStatement, StatementFormat } from "../../src/domain/banking/types";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";
import { emitBankTransactionEvent, emitEvent } from "./webhooks";

/**
 * Statement import pipeline (F07 BNK-030…036, §4.6): parse → normalise → dedupe (BNK-109/110/034) → insert →
 * archive the official statement (+ signed PDF) → reconcile. `planStatementImport` is the side-effect-free preview;
 * `commitStatementImport` re-plans inside the serialisable mutation (concurrent imports cannot double-insert) and
 * writes every row with its audit entry and raw revision (BNK-113).
 */

export interface FileRefValue {
  storageId: Id<"_storage">;
  sha256: string;
  bytes: number;
  mime: string;
  name: string;
}

export interface PreviewRow {
  line: number;
  bookingDate: string;
  amountCents: number;
  currency: string;
  counterpartyName?: string;
  purpose: string;
  outcome: PlanItem["kind"];
  detail?: string;
}

export interface ImportPreview {
  format: StatementFormat;
  fileName: string;
  statementRef?: string;
  iban?: string;
  currency: string;
  periodFrom?: string;
  periodTo?: string;
  openingBalanceCents?: number;
  closingBalanceCents?: number;
  balanceSource: ParsedStatement["balanceSource"];
  counts: ImportPlan["counts"] & { rejected: number; skipped: number };
  issues: ParsedStatement["issues"];
  skipped: ParsedStatement["skipped"];
  arithmetic: ReturnType<typeof checkStatementArithmetic>;
  continuity: ContinuityResult;
  runningBalanceBreaks: { line: number; diffCents: number; message: string }[];
  alreadyImported?: { at: number; message: string };
  feeSemantics?: ParsedStatement["feeSemantics"];
  /** EC-BNK-51: new rows in a locked period are imported; their bookings go to the first open period. */
  lockedPeriods: LockedPeriodNotice[];
  rows: PreviewRow[];
}

interface Planned {
  account: Doc<"bankAccounts">;
  statement: ParsedStatement;
  candidates: Candidate[];
  plan: ImportPlan;
  keys: string[];
  preview: ImportPreview;
}

export function existingRow(t: Doc<"bankTransactions">): ExistingBankRow {
  const ids = new Set<string>();
  for (const s of [t.source, ...t.sources]) {
    if (s.entryReference) ids.add(s.entryReference);
    if (s.providerTransactionId) ids.add(s.providerTransactionId);
  }
  return {
    id: t._id,
    dedupeKey: t.dedupeKey,
    contentHash: t.contentHash,
    bookingDate: t.bookingDate,
    amountCents: t.amountCents,
    currency: t.currency,
    ...(t.counterpartyName ? { counterpartyName: t.counterpartyName } : {}),
    ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
    ...(t.counterpartyBic ? { counterpartyBic: t.counterpartyBic } : {}),
    bankTxIds: [...ids],
    sourceKinds: [t.source.kind, ...t.sources.map((s) => s.kind)],
    rawSha256s: [t.source.rawSha256, ...t.sources.map((s) => s.rawSha256)],
  };
}

export async function existingFor(
  ctx: ReadCtx,
  accountId: Id<"bankAccounts">,
  candidates: Candidate[],
  keys: string[],
) {
  const rows = new Map<string, Doc<"bankTransactions">>();
  const dates = candidates.map((c) => c.bookingDate).sort();
  if (dates.length > 0) {
    const from = addDays(dates[0] as CalendarDate, -3);
    const to = addDays(dates[dates.length - 1] as CalendarDate, 3);
    const window = await ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (q) =>
        q.eq("accountId", accountId).gte("bookingDate", from).lte("bookingDate", to),
      )
      .collect();
    for (const r of window) rows.set(r._id, r);
  }
  // ID matches are not limited to the date window (EC-155): look every bank-ID key up directly.
  for (const k of new Set(keys.filter((k) => k.includes(":er:")))) {
    const hit = await ctx.db
      .query("bankTransactions")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", k))
      .first();
    if (hit) rows.set(hit._id, hit);
  }
  return [...rows.values()];
}

const accountLabel = (a: Doc<"bankAccounts">) => `${a.name} (${a.currency})`;

/** Latest earlier statement of the account for the continuity check (BNK-035). */
async function previousStatement(ctx: ReadCtx, accountId: Id<"bankAccounts">, periodFrom: string | undefined) {
  if (!periodFrom) return null;
  const all = await ctx.db
    .query("bankStatements")
    .withIndex("by_account_period", (q) => q.eq("accountId", accountId).lt("periodFrom", periodFrom))
    .order("desc")
    .collect();
  return all.find((s) => !s.rolledBack) ?? null;
}

export async function planStatementImport(
  ctx: ReadCtx,
  args: { accountId: Id<"bankAccounts">; content: string; fileName: string; fileSha256?: string },
): Promise<Planned> {
  const account = await ctx.db.get(args.accountId);
  if (!account || account.archivedAt !== undefined) throw appError("not_found", "Das Bankkonto existiert nicht.");
  const parsed = parseStatement(args.content, { fileName: args.fileName, currency: account.currency });
  if (!parsed.ok) throw appError("invalid_input", parsed.error.message, { reason: "STATEMENT_UNREADABLE" });
  const st = parsed.value;
  // EC-BNK-53: the file belongs to another account.
  const fileIban = st.iban ? normaliseIban(st.iban) : undefined;
  const fileCurrency = st.currency ?? st.transactions[0]?.currency;
  const wrongIban = fileIban && account.iban && normaliseIban(account.iban) !== fileIban;
  const wrongCurrency = fileCurrency && fileCurrency !== account.currency;
  const foreignRows = st.transactions.some((t) => t.currency !== account.currency);
  if (wrongIban || wrongCurrency || foreignRows) {
    throw appError(
      "invalid_input",
      `Die Datei gehört zu Konto ${fileIban ?? account.iban ?? "?"} (${fileCurrency ?? "?"}), nicht zu ${accountLabel(account)}.`,
      { reason: "STATEMENT_WRONG_ACCOUNT" },
    );
  }
  const candidates = await toCandidates(account._id, st.transactions);
  const keys = dedupeKeys(account._id, candidates);
  const existing = (await existingFor(ctx, account._id, candidates, keys)).map(existingRow);
  const plan = planImport({ accountId: account._id, kind: st.format, candidates, existing });

  let alreadyImported: ImportPreview["alreadyImported"];
  if (args.fileSha256) {
    const earlier = (
      await ctx.db
        .query("bankImports")
        .withIndex("by_fileSha256", (q) => q.eq("fileSha256", args.fileSha256))
        .collect()
    ).find((i) => i.accountId === account._id && i.rolledBackAt === undefined);
    if (earlier) {
      alreadyImported = {
        at: earlier.at,
        message: `Diese Datei wurde bereits importiert (${formatGermanDate(berlinCalendarDate(earlier.at))}).`,
      };
    }
  }
  const closed = new Set(
    (await ctx.db.query("periods").collect()).filter((p) => p.status !== "open").map((p) => p.period),
  );
  const lockedPeriods = lockedPeriodNotices(
    plan.items.filter((it) => it.kind === "new").map((it) => it.tx.bookingDate),
    closed,
    berlinCalendarDate(Date.now()),
  );
  const prev = await previousStatement(ctx, account._id, st.periodFrom);
  const continuity = checkContinuity(prev ?? undefined, st, account.currency);
  const detail = (it: PlanItem) =>
    it.kind === "conflict"
      ? `Abweichung: ${it.fields.join(", ")}`
      : it.kind === "possible_duplicate"
        ? "Mögliche Dublette – bitte prüfen"
        : it.kind === "merge"
          ? "bereits vorhanden (andere Quelle)"
          : it.kind === "duplicate"
            ? "bereits vorhanden"
            : undefined;
  const preview: ImportPreview = {
    format: st.format,
    fileName: args.fileName,
    ...(st.statementId ? { statementRef: st.statementId } : {}),
    ...(fileIban ? { iban: fileIban } : {}),
    currency: account.currency,
    ...(st.periodFrom ? { periodFrom: st.periodFrom } : {}),
    ...(st.periodTo ? { periodTo: st.periodTo } : {}),
    ...(st.openingBalanceCents !== undefined ? { openingBalanceCents: st.openingBalanceCents } : {}),
    ...(st.closingBalanceCents !== undefined ? { closingBalanceCents: st.closingBalanceCents } : {}),
    balanceSource: st.balanceSource,
    counts: { ...plan.counts, rejected: st.issues.length, skipped: st.skipped.length },
    issues: st.issues,
    skipped: st.skipped,
    arithmetic: checkStatementArithmetic(st),
    continuity,
    runningBalanceBreaks: checkRunningBalances(st.transactions, account.currency),
    ...(alreadyImported ? { alreadyImported } : {}),
    ...(st.feeSemantics ? { feeSemantics: st.feeSemantics } : {}),
    lockedPeriods,
    rows: plan.items.map((it) => {
      const d = detail(it);
      return {
        line: it.tx.line,
        bookingDate: it.tx.bookingDate,
        amountCents: it.tx.amountCents,
        currency: it.tx.currency,
        ...(it.tx.counterpartyName ? { counterpartyName: it.tx.counterpartyName } : {}),
        purpose: it.tx.purpose,
        outcome: it.kind,
        ...(d ? { detail: d } : {}),
      };
    }),
  };
  return { account, statement: st, candidates, plan, keys, preview };
}

/** The row a candidate becomes (03 §7 `bankTransactions`). */
function transactionValue(
  ctx: ModelCtx,
  account: Doc<"bankAccounts">,
  c: Candidate,
  dedupeKey: string,
  importId: Id<"bankImports"> | undefined,
  kind: Doc<"bankTransactions">["source"]["kind"],
): Omit<Doc<"bankTransactions">, "_id" | "_creationTime"> {
  const opt = <K extends string, V>(k: K, v: V | undefined) =>
    v === undefined || v === "" ? {} : ({ [k]: v } as Record<K, V>);
  return {
    accountId: account._id,
    bookingDate: c.bookingDate,
    ...opt("valueDate", c.valueDate),
    amountCents: c.amountCents,
    currency: c.currency,
    ...(c.currency === "EUR" ? { amountEurCents: c.amountCents } : {}),
    ...opt("counterpartyName", c.counterpartyName),
    ...opt("counterpartyIban", c.counterpartyIban),
    ...opt("counterpartyBic", c.counterpartyBic),
    ...opt("counterpartySource", c.counterpartySource),
    purpose: c.purpose,
    ...opt("reference", c.reference),
    ...opt("endToEndId", c.endToEndId),
    ...opt("mandateRef", c.mandateRef),
    ...opt("creditorId", c.creditorId),
    ...opt("bankRef", c.bankRef),
    source: {
      kind,
      ...opt("entryReference", c.entryReference),
      ...opt("providerTransactionId", c.providerTransactionId),
      ...opt("bankTransactionCode", c.bankTransactionCode),
      ...opt("proprietaryCode", c.proprietaryCode),
      ...opt("merchantName", c.merchantName),
      ...opt("mcc", c.mcc),
      ...opt("feeCents", c.feeCents),
      ...opt("exchangeRate", c.exchangeRate),
      ...opt("instructedAmount", c.instructedAmount),
      ...opt("balanceAfterCents", c.balanceAfterCents),
      ...opt("bookedAtRaw", c.bookedAtRaw),
      ...opt("importId", importId),
      line: c.line,
      rawSha256: c.rawSha256,
    },
    sources: [],
    dedupeKey,
    contentHash: c.contentHash,
    ...opt("importId", importId),
    status: "open",
    ...(c.reversal ? { reversal: true } : {}),
    allocatedCents: 0,
    recordedAt: ctx.now(),
  };
}

/** Inserts one booked row with its raw revision (BNK-113). */
export async function insertCandidate(
  ctx: ModelCtx,
  account: Doc<"bankAccounts">,
  c: Candidate,
  dedupeKey: string,
  importId: Id<"bankImports"> | undefined,
  kind: Doc<"bankTransactions">["source"]["kind"],
): Promise<Id<"bankTransactions">> {
  const id = await auditedInsert(
    ctx,
    "bankTransactions",
    transactionValue(ctx, account, c, dedupeKey, importId, kind),
    {
      action: "bank.import",
      label: `${c.bookingDate} ${c.amountCents} ${c.currency}`,
    },
  );
  await addRevision(ctx, id, c, kind, importId, true);
  await emitBankTransactionEvent(ctx, "bank_transaction.imported", id); // BNK-080
  return id;
}

async function addRevision(
  ctx: ModelCtx,
  transactionId: Id<"bankTransactions">,
  c: Candidate,
  kind: string,
  importId: Id<"bankImports"> | undefined,
  applied: boolean,
  changedFields?: string[],
) {
  const exists = await ctx.db
    .query("bankTransactionRevisions")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId).eq("rawSha256", c.rawSha256))
    .first();
  if (exists) return;
  await auditedInsert(
    ctx,
    "bankTransactionRevisions",
    {
      transactionId,
      sourceKind: kind,
      rawSha256: c.rawSha256,
      rawJson: c.raw,
      fetchedAt: ctx.now(),
      applied,
      ...(importId ? { importId } : {}),
      line: c.line,
      ...(changedFields?.length ? { changedFields } : {}),
    },
    { action: "bank.revision", ...(applied ? {} : { reason: "Bank hat eine gebuchte Umsatzzeile geändert" }) },
  );
}

/** A statement period as UTC instants (statements are UTC by default, EC-155). */
function periodInstants(st: ParsedStatement): { start: number; end: number } {
  const from = st.periodFrom ?? st.transactions[0]?.bookingDate ?? "1970-01-01";
  const to = st.periodTo ?? from;
  return {
    start: Date.parse(st.periodStartUtc ?? `${from}T00:00:00Z`),
    end: Date.parse(st.periodEndUtc ?? `${to}T23:59:59Z`),
  };
}

export async function reconcileFor(
  ctx: ReadCtx,
  statement: Pick<
    Doc<"bankStatements">,
    | "accountId"
    | "periodFrom"
    | "periodTo"
    | "periodStartUtc"
    | "periodEndUtc"
    | "openingBalanceCents"
    | "closingBalanceCents"
  >,
  currency: string,
  fileRowIds: readonly string[],
  missing: readonly { line: number; amountCents: number; detail: string }[],
): Promise<ReconcileResult> {
  const rows = await ctx.db
    .query("bankTransactions")
    .withIndex("by_account_bookingDate", (q) =>
      q
        .eq("accountId", statement.accountId)
        .gte("bookingDate", addDays(statement.periodFrom as CalendarDate, -1))
        .lte("bookingDate", addDays(statement.periodTo as CalendarDate, 1)),
    )
    .collect();
  return reconcileStatement({
    statement: {
      periodFrom: statement.periodFrom,
      periodTo: statement.periodTo,
      periodStartUtc: new Date(statement.periodStartUtc).toISOString(),
      periodEndUtc: new Date(statement.periodEndUtc).toISOString(),
      ...(statement.openingBalanceCents !== undefined ? { openingBalanceCents: statement.openingBalanceCents } : {}),
      ...(statement.closingBalanceCents !== undefined ? { closingBalanceCents: statement.closingBalanceCents } : {}),
      currency,
    },
    fileRowIds,
    missing,
    rows: rows
      .filter((r) => r.ignoredReason !== "import_rolled_back")
      .map((r) => ({
        id: r._id,
        amountCents: r.amountCents,
        bookingDate: r.bookingDate,
        ...(r.source.bookedAtRaw ? { bookedAtRaw: r.source.bookedAtRaw } : {}),
      })),
  });
}

export interface CommitResult {
  importId: Id<"bankImports">;
  statementId: Id<"bankStatements"> | null;
  counts: ImportPreview["counts"];
  reconciliation: ReconcileResult | null;
  continuity: ContinuityResult;
  lockedPeriods: LockedPeriodNotice[];
}

export async function commitStatementImport(
  ctx: ModelCtx,
  args: {
    accountId: Id<"bankAccounts">;
    content: string;
    file: FileRefValue;
    pdf?: FileRefValue;
    force?: boolean;
  },
): Promise<CommitResult> {
  const p = await planStatementImport(ctx, {
    accountId: args.accountId,
    content: args.content,
    fileName: args.file.name,
    fileSha256: args.file.sha256,
  });
  if (p.preview.alreadyImported && !args.force) {
    // EC-BNK-42 / EC-BNK-45: the same file again → 0 inserted unless forced.
    throw appError(
      "conflict",
      `Dieser Kontoauszug wurde bereits hochgeladen (${formatGermanDate(berlinCalendarDate(p.preview.alreadyImported.at))}).`,
      { reason: "STATEMENT_DUPLICATE_FILE" },
    );
  }
  const st = p.statement;
  const kind = st.format;
  const now = ctx.now();
  const dates = st.transactions.map((t) => t.bookingDate).sort();
  const periodFrom = st.periodFrom ?? dates[0] ?? berlinCalendarDate(now);
  const periodTo = st.periodTo ?? dates[dates.length - 1] ?? periodFrom;
  const importId = await auditedInsert(
    ctx,
    "bankImports",
    {
      accountId: p.account._id,
      source: kind,
      fileStorageId: args.file.storageId,
      fileSha256: args.file.sha256,
      fileName: args.file.name,
      periodFrom,
      periodTo,
      ...(st.openingBalanceCents !== undefined ? { openingBalanceCents: st.openingBalanceCents } : {}),
      ...(st.closingBalanceCents !== undefined ? { closingBalanceCents: st.closingBalanceCents } : {}),
      continuityOk: p.preview.continuity.status === "ok" || p.preview.continuity.status === "first",
      counts: {
        total: p.plan.counts.total,
        inserted: p.plan.counts.new,
        duplicates: p.plan.counts.duplicates,
        mergedCrossSource: p.plan.counts.merged,
        possibleDuplicates: p.plan.counts.possibleDuplicates,
        conflicts: p.plan.counts.conflicts,
        rejected: st.issues.length,
      },
      at: now,
      actor: ctx.actor,
    },
    { action: "bank.import", label: args.file.name },
  );

  const missing: { line: number; amountCents: number; detail: string }[] = st.issues.map((i) => ({
    line: i.line,
    amountCents: 0,
    detail: i.message,
  }));
  const applied = await applyPlan(ctx, { account: p.account, plan: p.plan, keys: p.keys, kind, importId, now });
  const fileRowIds: string[] = applied.rowIds;
  missing.push(...applied.missing);

  // The official statement (BNK-030): archived even if every row was a duplicate. A forced re-import of the same
  // file (BNK-034) adds no second archive entry — the first one already holds this file.
  if (p.preview.alreadyImported) {
    await auditedPatch(
      ctx,
      "bankImports",
      importId,
      { rowIds: fileRowIds as Id<"bankTransactions">[] },
      { action: "bank.import", label: args.file.name },
    );
    return {
      importId,
      statementId: null,
      counts: p.preview.counts,
      reconciliation: null,
      continuity: p.preview.continuity,
      lockedPeriods: p.preview.lockedPeriods,
    };
  }
  const { start, end } = periodInstants(st);
  const base = {
    accountId: p.account._id,
    periodFrom,
    periodTo,
    periodStartUtc: start,
    periodEndUtc: end,
    ...(st.openingBalanceCents !== undefined ? { openingBalanceCents: st.openingBalanceCents } : {}),
    ...(st.closingBalanceCents !== undefined ? { closingBalanceCents: st.closingBalanceCents } : {}),
  };
  const reconciliation = await reconcileFor(ctx, base, p.account.currency, fileRowIds, missing);
  const statementId = await auditedInsert(
    ctx,
    "bankStatements",
    {
      ...base,
      format: kind,
      ...(st.statementId ? { statementRef: st.statementId } : {}),
      ...(args.pdf ? { pdf: args.pdf } : {}),
      ...(kind === "camt053" ? { camt: args.file } : { other: [args.file] }),
      importId,
      reconciled: reconciliation.reconciled,
      ...(reconciliation.differences.length
        ? {
            differences: reconciliation.differences.map((d) => ({
              kind: d.kind,
              detail: d.detail,
              ...(d.transactionId ? { transactionId: d.transactionId as Id<"bankTransactions"> } : {}),
              ...(d.amountCents !== undefined ? { amountCents: d.amountCents } : {}),
            })),
          }
        : {}),
      continuity: {
        status: p.preview.continuity.status,
        ...("message" in p.preview.continuity ? { message: p.preview.continuity.message } : {}),
        ...("diffCents" in p.preview.continuity ? { diffCents: p.preview.continuity.diffCents } : {}),
      },
      uploadedAt: now,
      retentionUntil: statementRetentionUntil(periodTo),
    },
    { action: "bank.import", label: `Kontoauszug ${periodFrom}–${periodTo}` },
  );
  if (reconciliation.reconciled) {
    // BNK-080: the statement's balances reconcile with the booked rows
    await emitEvent(ctx, "bank_statement.reconciled", {
      id: encodeId("bankStatements", statementId),
      object: "bank_statement",
      bank_account_id: encodeId("bankAccounts", p.account._id),
      period_from: periodFrom,
      period_to: periodTo,
      opening_balance_cents: st.openingBalanceCents ?? null,
      closing_balance_cents: st.closingBalanceCents ?? null,
      reconciled: true,
      updated_at: new Date(now).toISOString(),
    });
  }
  await auditedPatch(
    ctx,
    "bankImports",
    importId,
    { statementId, rowIds: fileRowIds as Id<"bankTransactions">[] },
    { action: "bank.import", label: args.file.name },
  );
  return {
    importId,
    statementId,
    counts: p.preview.counts,
    reconciliation,
    continuity: p.preview.continuity,
    lockedPeriods: p.preview.lockedPeriods,
  };
}

/**
 * Applies a dedupe plan (BNK-109/110/113): inserts new rows with their raw revision, appends further sources, stores
 * differing re-deliveries as `applied: false` revisions and puts ambiguous rows into „Mögliche Dubletten“. Shared by
 * the statement import and the Enable Banking feed (one implementation, CLAUDE.md rule 5).
 */
export async function applyPlan(
  ctx: ModelCtx,
  args: {
    account: Doc<"bankAccounts">;
    plan: ImportPlan;
    keys: string[];
    kind: Doc<"bankTransactions">["source"]["kind"];
    importId: Id<"bankImports"> | undefined;
    now: number;
  },
): Promise<{
  rowIds: string[];
  insertedIds: Id<"bankTransactions">[];
  possibleDuplicates: number;
  missing: { line: number; amountCents: number; detail: string }[];
}> {
  const { kind, importId, now } = args;
  const p = { account: args.account, plan: args.plan, keys: args.keys };
  const fileRowIds: string[] = [];
  const insertedIds: Id<"bankTransactions">[] = [];
  const missing: { line: number; amountCents: number; detail: string }[] = [];
  let possible = 0;
  for (const [i, it] of p.plan.items.entries()) {
    const c = it.tx;
    switch (it.kind) {
      case "new": {
        const id = await insertCandidate(ctx, p.account, c, it.dedupeKey, importId, kind);
        insertedIds.push(id);
        fileRowIds.push(id);
        break;
      }
      case "duplicate":
        fileRowIds.push(it.existingId);
        break;
      case "merge": {
        const tx = (await ctx.db.get(it.existingId as Id<"bankTransactions">)) as Doc<"bankTransactions">;
        const ref = {
          kind,
          importId,
          ...(c.entryReference ? { entryReference: c.entryReference } : {}),
          ...(c.providerTransactionId ? { providerTransactionId: c.providerTransactionId } : {}),
          rawSha256: c.rawSha256,
          at: now,
        };
        await auditedPatch(
          ctx,
          "bankTransactions",
          tx._id,
          {
            sources: [...tx.sources, ref],
            ...it.enrich,
            ...((it.enrich.counterpartyName || it.enrich.counterpartyIban) && !tx.counterpartySource
              ? { counterpartySource: "statement" as const }
              : {}),
          },
          { action: "bank.import", label: `${tx.bookingDate} ${tx.amountCents}` },
        );
        await addRevision(ctx, tx._id, c, kind, importId, true);
        fileRowIds.push(tx._id);
        break;
      }
      case "conflict":
        await addRevision(ctx, it.existingId as Id<"bankTransactions">, c, kind, importId, false, it.fields);
        fileRowIds.push(it.existingId);
        break;
      case "possible_duplicate": {
        await auditedInsert(
          ctx,
          "possibleDuplicates",
          {
            accountId: p.account._id,
            candidate: { ...c, dedupeKey: p.keys[i], kind },
            existingIds: it.existingIds as Id<"bankTransactions">[],
            importId,
            reason: it.reason,
            status: "open",
            createdAt: now,
          },
          { action: "bank.import", label: `Mögliche Dublette ${c.bookingDate}` },
        );
        possible++;
        missing.push({
          line: c.line,
          amountCents: c.amountCents,
          detail: `${formatGermanDate(c.bookingDate as CalendarDate)} ${c.counterpartyName ?? c.purpose} (mögliche Dublette)`,
        });
        break;
      }
    }
  }
  return { rowIds: fileRowIds, insertedIds, possibleDuplicates: possible, missing };
}

export { bankTxId };

/** base64 SHA-256 of Convex file storage → lowercase hex (our FileRef convention). */
export const base64ToHex = (b64: string): string =>
  Array.from(atob(b64), (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** FileRef from the stored file's system metadata (size and server-computed sha256, GOBD-20). */
export async function fileRefFromStorage(
  ctx: ReadCtx,
  storageId: Id<"_storage">,
  name: string,
  expectMime?: string,
): Promise<FileRefValue> {
  const meta = await ctx.db.system.get(storageId);
  if (!meta) throw appError("not_found", "Die hochgeladene Datei wurde nicht gefunden.");
  const mime = meta.contentType ?? expectMime ?? "application/octet-stream";
  return { storageId, sha256: base64ToHex(meta.sha256), bytes: meta.size, mime, name: name.slice(0, 200) };
}

/** BNK-030 / EC-BNK-52: attach the signed PDF statement once (sha256, retention as the statement). */
export async function attachStatementPdf(
  ctx: ModelCtx,
  statementId: Id<"bankStatements">,
  pdf: FileRefValue,
): Promise<null> {
  const st = await ctx.db.get(statementId);
  if (!st) throw appError("not_found");
  if (st.pdf) {
    throw appError("immutable_record", "Für diesen Kontoauszug ist bereits ein PDF archiviert.", {
      reason: "PDF_ALREADY_ATTACHED",
    });
  }
  await auditedPatch(
    ctx,
    "bankStatements",
    statementId,
    { pdf },
    {
      action: "bank.statement_pdf",
      label: `Kontoauszug ${st.periodFrom}–${st.periodTo}`,
    },
  );
  return null;
}
