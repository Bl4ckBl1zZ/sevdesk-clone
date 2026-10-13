import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { eigenbelegContent } from "../src/domain/banking/eigenbeleg";
import { decodeStatement } from "../src/domain/banking/statement";
import { statementAccountSchema } from "../src/domain/schemas/banking";
import { renderEigenbeleg } from "../src/pdf/eigenbeleg";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, actorMutation, mutation, query } from "./functions";
import { appError } from "./lib/errors";
import { addStatementAccount } from "./model/bankAccounts";
import {
  attachStatementPdf as attachPdf,
  commitStatementImport,
  type FileRefValue,
  fileRefFromStorage,
  type ImportPreview,
  planStatementImport,
} from "./model/bankImport";
import {
  linkReversal,
  markEigenbelegInput,
  markTransaction,
  requireTransaction,
  resolvePossibleDuplicate,
  reversalCandidates,
  rollbackImport,
  unmarkTransaction,
  unmatchedTransactions,
} from "./model/bankTransactions";
import { accountsOverview, liveReconciliation, revisionFindings, statementTodosFor } from "./model/bankViews";
import { getCompanyProfile } from "./model/companyProfile";
import { entriesBySource } from "./model/journal";
import { vFileRef } from "./validators";

/**
 * F07 P1 bank statement import (BNK-030…036), transactions, marking (BNK-060/061/063, CSH-025), reversal links
 * (BNK-121), the possible-duplicates review (BNK-034/110) and the matching extension point (`unmatched`).
 * File parsing happens in actions (file storage is only readable there); every write runs in a mutation with the
 * caller's actor (actorMutation) and is audited.
 */

const vMarkKind = v.union(
  v.literal("private"),
  v.literal("transfer"),
  v.literal("cash_withdrawal"),
  v.literal("ignored"),
);
const vIgnoreReason = v.union(
  v.literal("duplicate_of_file_import"),
  v.literal("neutralised_pair"),
  v.literal("test_or_zero"),
);
const vShareholder = v.object({ name: v.string(), note: v.string() });

// ── accounts ───────────────────────────────────────────────────────────────────────────────────────────

export const accounts = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => accountsOverview(ctx),
});

export const account = query({
  permission: "banking.read",
  args: { id: v.id("bankAccounts") },
  handler: async (ctx, { id }) => {
    const a = await ctx.db.get(id);
    if (!a) return null;
    return {
      id: a._id,
      name: a.name,
      currency: a.currency,
      iban: a.iban ?? null,
      archived: a.archivedAt !== undefined,
    };
  },
});

/** BNK-020 P1: a statement account per currency pocket (same IBAN allowed for another currency). */
export const createAccount = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const parsed = statementAccountSchema.safeParse(values);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw appError("invalid_input", i?.message ?? "Ungültige Eingabe.", { field: String(i?.path[0] ?? "") });
    }
    const profile = await getCompanyProfile(ctx);
    return addStatementAccount(ctx, parsed.data, profile?.chartOfAccounts.at(-1)?.chart ?? "SKR03");
  },
});

// ── transactions ───────────────────────────────────────────────────────────────────────────────────────

const listArgs = {
  accountId: v.id("bankAccounts"),
  status: v.optional(v.string()),
  direction: v.optional(v.union(v.literal("in"), v.literal("out"))),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  q: v.optional(v.string()),
};

const rowView = (t: Doc<"bankTransactions">) => ({
  _id: t._id,
  bookingDate: t.bookingDate,
  valueDate: t.valueDate ?? null,
  amountCents: t.amountCents,
  currency: t.currency,
  counterpartyName: t.counterpartyName ?? null,
  counterpartyIban: t.counterpartyIban ?? null,
  purpose: t.purpose,
  status: t.status,
  ignoredReason: t.ignoredReason ?? null,
  allocatedCents: t.allocatedCents,
  feeCents: t.source.feeCents ?? null,
  reversal: t.reversal === true,
  reversalOfId: t.reversalOfId ?? null,
  sourceKinds: [t.source.kind, ...t.sources.map((s) => s.kind)],
});

export const transactions = query({
  permission: "banking.read",
  args: { paginationOpts: paginationOptsValidator, ...listArgs },
  handler: async (ctx, { paginationOpts, accountId, status, direction, from, to, q }) => {
    const needle = q?.trim().toLowerCase();
    const base = ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (ix) => {
        const a = ix.eq("accountId", accountId);
        if (from && to) return a.gte("bookingDate", from).lte("bookingDate", to);
        if (from) return a.gte("bookingDate", from);
        if (to) return a.lte("bookingDate", to);
        return a;
      })
      .order("desc");
    const page = await filter(base, (t) => {
      if (status && status !== "all") {
        if (status === "matched" ? !["matched", "partially_matched", "booked"].includes(t.status) : t.status !== status)
          return false;
      }
      if (direction === "in" && t.amountCents < 0) return false;
      if (direction === "out" && t.amountCents >= 0) return false;
      if (needle) {
        const hay =
          `${t.counterpartyName ?? ""} ${t.purpose} ${t.reference ?? ""} ${t.counterpartyIban ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    }).paginate(paginationOpts);
    return { ...page, page: page.page.map(rowView) };
  },
});

/** Detail sheet: the row, its sources and revisions, postings, reversal candidates. */
export const transaction = query({
  permission: "banking.read",
  args: { id: v.id("bankTransactions") },
  handler: async (ctx, { id }) => {
    const t = await ctx.db.get(id);
    if (!t) return null;
    const revisions = await ctx.db
      .query("bankTransactionRevisions")
      .withIndex("by_transaction", (q) => q.eq("transactionId", id))
      .collect();
    const entries = await entriesBySource(ctx, { kind: "bankTransaction", id });
    const cash = await ctx.db
      .query("cashTransfers")
      .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", id))
      .collect();
    const cashEntries = (
      await Promise.all(cash.map((c) => entriesBySource(ctx, { kind: "cashTransfer", id: c._id })))
    ).flat();
    const peer = t.ignoredLinkId ? await ctx.db.get(t.ignoredLinkId) : null;
    const original = t.reversalOfId ? await ctx.db.get(t.reversalOfId) : null;
    const attachments = [...entries, ...cashEntries].flatMap((e) => e.attachments ?? []);
    return {
      ...rowView(t),
      reference: t.reference ?? null,
      endToEndId: t.endToEndId ?? null,
      mandateRef: t.mandateRef ?? null,
      creditorId: t.creditorId ?? null,
      counterpartyBic: t.counterpartyBic ?? null,
      bankTransactionCode: t.source.bankTransactionCode ?? null,
      proprietaryCode: t.source.proprietaryCode ?? null,
      merchantName: t.source.merchantName ?? null,
      bookedAtRaw: t.source.bookedAtRaw ?? null,
      exchangeRate: t.source.exchangeRate ?? null,
      instructedAmount: t.source.instructedAmount ?? null,
      sources: [
        {
          kind: t.source.kind,
          at: t.recordedAt,
          reference: t.source.entryReference ?? t.source.providerTransactionId ?? null,
        },
        ...t.sources.map((s) => ({
          kind: s.kind,
          at: s.at,
          reference: s.entryReference ?? s.providerTransactionId ?? null,
        })),
      ],
      revisions: revisions.map((r) => ({
        sourceKind: r.sourceKind,
        applied: r.applied,
        changedFields: r.changedFields ?? [],
        at: r.fetchedAt,
        line: r.line ?? null,
      })),
      postings: [...entries, ...cashEntries]
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({
          id: e._id,
          seq: e.seq,
          date: e.date,
          text: e.text,
          explanation: e.explanation,
          reversal: e.reversalOfId !== undefined,
          lines: e.lines.map((l) => ({ account: l.account, debitCents: l.debitCents, creditCents: l.creditCents })),
        })),
      eigenbelege: await Promise.all(
        attachments.map(async (f) => ({ name: f.name, sha256: f.sha256, url: await ctx.storage.getUrl(f.storageId) })),
      ),
      link: peer ? { id: peer._id, bookingDate: peer.bookingDate, amountCents: peer.amountCents } : null,
      original: original
        ? {
            id: original._id,
            bookingDate: original.bookingDate,
            amountCents: original.amountCents,
            purpose: original.purpose,
          }
        : null,
      reversalCandidates: t.amountCents !== 0 && !t.reversalOfId ? await reversalCandidates(ctx, id) : [],
    };
  },
});

/**
 * Extension point for the matching slice (BNK-040…049): booked, not fully allocated rows with their open amount
 * (`src/domain/banking/match-types.ts` `UnmatchedTransaction`).
 */
export const unmatched = query({
  permission: "banking.read",
  args: { accountId: v.optional(v.id("bankAccounts")), limit: v.optional(v.number()) },
  handler: async (ctx, args) => unmatchedTransactions(ctx, args),
});

// ── statement import (BNK-030…036) ─────────────────────────────────────────────────────────────────────

export const generateUploadUrl = mutation({
  permission: "banking.write",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

const sha256Hex = async (bytes: BufferSource) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

async function readStatementFile(ctx: ActionCtx, storageId: Id<"_storage">) {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw appError("not_found", "Die hochgeladene Datei wurde nicht gefunden.");
  if (blob.size > 10 * 1024 * 1024) throw appError("invalid_input", "Die Datei ist größer als 10 MB.");
  const bytes = await blob.arrayBuffer();
  const decoded = decodeStatement(new Uint8Array(bytes));
  if (!decoded.ok) throw appError("invalid_input", decoded.error.message, { reason: "STATEMENT_UNREADABLE" });
  return { content: decoded.value, sha256: await sha256Hex(bytes) };
}

async function assertPdf(ctx: ActionCtx, storageId: Id<"_storage">) {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw appError("not_found", "Die hochgeladene Datei wurde nicht gefunden.");
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== "%PDF-") {
    throw appError("invalid_input", "Der Kontoauszug muss eine PDF-Datei sein.", { reason: "PDF_REQUIRED" });
  }
}

/** Preview (dry run) on the decoded file content; the import action calls it, the UI never sends content itself. */
export const importPlan = query({
  permission: "banking.write",
  args: { accountId: v.id("bankAccounts"), content: v.string(), fileName: v.string(), fileSha256: v.string() },
  handler: async (ctx, args): Promise<ImportPreview> => (await planStatementImport(ctx, args)).preview,
});

export const previewImport = action({
  permission: "banking.write",
  args: { accountId: v.id("bankAccounts"), storageId: v.id("_storage"), fileName: v.string() },
  handler: async (ctx, { accountId, storageId, fileName }): Promise<ImportPreview> => {
    const file = await readStatementFile(ctx, storageId);
    return ctx.runQuery(api.banking.importPlan, {
      accountId,
      content: file.content,
      fileName,
      fileSha256: file.sha256,
    });
  },
});

export const commitImportInternal = actorMutation({
  permission: "banking.write",
  args: {
    accountId: v.id("bankAccounts"),
    content: v.string(),
    contentSha256: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    pdfStorageId: v.optional(v.id("_storage")),
    pdfName: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const file = await fileRefFromStorage(ctx, args.storageId, args.fileName);
    // The parsed content must be the stored file (GOBD-20: the archived file is what was imported).
    if (file.sha256 !== args.contentSha256)
      throw appError("conflict", "Die Datei wurde während des Imports verändert.");
    const pdf = args.pdfStorageId
      ? await fileRefFromStorage(ctx, args.pdfStorageId, args.pdfName ?? "Kontoauszug.pdf", "application/pdf")
      : undefined;
    return commitStatementImport(ctx, {
      accountId: args.accountId,
      content: args.content,
      file,
      ...(pdf ? { pdf } : {}),
      ...(args.force ? { force: true } : {}),
    });
  },
});

export const commitImport = action({
  permission: "banking.write",
  args: {
    accountId: v.id("bankAccounts"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    pdfStorageId: v.optional(v.id("_storage")),
    pdfName: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    importId: Id<"bankImports">;
    statementId: Id<"bankStatements"> | null;
    counts: ImportPreview["counts"];
    reconciled: boolean | null;
    message: string | null;
  }> => {
    const file = await readStatementFile(ctx, args.storageId);
    if (args.pdfStorageId) await assertPdf(ctx, args.pdfStorageId);
    const r = await ctx.runMutation(internal.banking.commitImportInternal, {
      actorContext: ctx.actorContext,
      ...args,
      content: file.content,
      contentSha256: file.sha256,
    });
    return {
      importId: r.importId,
      statementId: r.statementId,
      counts: r.counts,
      reconciled: r.reconciliation?.reconciled ?? null,
      message: r.reconciliation?.message ?? null,
    };
  },
});

export const imports = query({
  permission: "banking.read",
  args: { accountId: v.id("bankAccounts") },
  handler: async (ctx, { accountId }) =>
    (
      await ctx.db
        .query("bankImports")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .order("desc")
        .take(100)
    ).map((i) => ({
      id: i._id,
      at: i.at,
      fileName: i.fileName ?? null,
      source: i.source,
      periodFrom: i.periodFrom,
      periodTo: i.periodTo,
      counts: i.counts,
      rolledBackAt: i.rolledBackAt ?? null,
      continuityOk: i.continuityOk ?? null,
    })),
});

/** BNK-036 „Import zurücknehmen“. */
export const rollback = mutation({
  permission: "banking.write",
  args: { importId: v.id("bankImports"), reason: v.string() },
  handler: async (ctx, args) => rollbackImport(ctx, args),
});

// ── statement archive + reconciliation ─────────────────────────────────────────────────────────────────

export const statements = query({
  permission: "banking.read",
  args: { accountId: v.id("bankAccounts") },
  handler: async (ctx, { accountId }) => {
    const rows = await ctx.db
      .query("bankStatements")
      .withIndex("by_account_period", (q) => q.eq("accountId", accountId))
      .order("desc")
      .collect();
    return Promise.all(
      rows.map(async (s) => {
        const live = await liveReconciliation(ctx, s);
        const files = [s.camt, ...(s.other ?? []), s.pdf].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return {
          id: s._id,
          periodFrom: s.periodFrom,
          periodTo: s.periodTo,
          format: s.format,
          statementRef: s.statementRef ?? null,
          openingBalanceCents: s.openingBalanceCents ?? null,
          closingBalanceCents: s.closingBalanceCents ?? null,
          expectedClosingCents: live.expectedClosingCents ?? null,
          diffCents: live.diffCents ?? null,
          reconciled: live.reconciled,
          message: live.message ?? null,
          differences: live.differences,
          continuity: s.continuity ?? null,
          rolledBack: s.rolledBack === true,
          uploadedAt: s.uploadedAt,
          retentionUntil: s.retentionUntil,
          hasPdf: s.pdf !== undefined,
          files: await Promise.all(
            files.map(async (f) => ({
              name: f.name,
              sha256: f.sha256,
              bytes: f.bytes,
              kind: f === s.pdf ? ("pdf" as const) : ("data" as const),
              url: await ctx.storage.getUrl(f.storageId),
            })),
          ),
        };
      }),
    );
  },
});

export const attachStatementPdfInternal = actorMutation({
  permission: "banking.write",
  args: { statementId: v.id("bankStatements"), storageId: v.id("_storage"), name: v.string() },
  handler: async (ctx, { statementId, storageId, name }) => {
    return attachPdf(ctx, statementId, await fileRefFromStorage(ctx, storageId, name, "application/pdf"));
  },
});

/** BNK-030 / EC-BNK-52: the signed PDF for an imported statement (set once, sha256). */
export const attachStatementPdf = action({
  permission: "banking.write",
  args: { statementId: v.id("bankStatements"), storageId: v.id("_storage"), name: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await assertPdf(ctx, args.storageId);
    await ctx.runMutation(internal.banking.attachStatementPdfInternal, { actorContext: ctx.actorContext, ...args });
    return null;
  },
});

export const todos = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => statementTodosFor(ctx, ctx.now()),
});

/** BNK-113 / EC-BNK-15 integrity findings: differing re-deliveries kept as revisions, never applied. */
export const findings = query({
  permission: "banking.read",
  args: { accountId: v.optional(v.id("bankAccounts")) },
  handler: async (ctx, { accountId }) => revisionFindings(ctx, accountId),
});

// ── possible duplicates (BNK-034/110) ──────────────────────────────────────────────────────────────────

export const possibleDuplicates = query({
  permission: "banking.read",
  args: { accountId: v.optional(v.id("bankAccounts")) },
  handler: async (ctx, { accountId }) => {
    const rows = accountId
      ? await ctx.db
          .query("possibleDuplicates")
          .withIndex("by_account_status", (q) => q.eq("accountId", accountId).eq("status", "open"))
          .collect()
      : (await ctx.db.query("possibleDuplicates").collect()).filter((d) => d.status === "open");
    return Promise.all(
      rows.map(async (d) => {
        const c = d.candidate as {
          bookingDate: string;
          amountCents: number;
          currency: string;
          purpose: string;
          counterpartyName?: string;
          kind: string;
          line: number;
        };
        const existing = (await Promise.all(d.existingIds.map((id) => ctx.db.get(id)))).filter(
          (x): x is Doc<"bankTransactions"> => x !== null,
        );
        return {
          id: d._id,
          reason: d.reason,
          candidate: {
            bookingDate: c.bookingDate,
            amountCents: c.amountCents,
            currency: c.currency,
            purpose: c.purpose,
            counterpartyName: c.counterpartyName ?? null,
            source: c.kind,
            line: c.line,
          },
          existing: existing.map((e) => ({
            id: e._id,
            bookingDate: e.bookingDate,
            amountCents: e.amountCents,
            purpose: e.purpose,
            counterpartyName: e.counterpartyName ?? null,
            sourceKinds: [e.source.kind, ...e.sources.map((s) => s.kind)],
          })),
        };
      }),
    );
  },
});

export const resolveDuplicate = mutation({
  permission: "banking.write",
  args: { id: v.id("possibleDuplicates"), decision: v.union(v.literal("same"), v.literal("separate")) },
  handler: async (ctx, args) => resolvePossibleDuplicate(ctx, args),
});

// ── marking (BNK-060/061/063, CSH-025) and reversals (BNK-121) ─────────────────────────────────────────

const markArgs = {
  transactionId: v.id("bankTransactions"),
  as: vMarkKind,
  reason: v.optional(vIgnoreReason),
  linkId: v.optional(v.id("bankTransactions")),
  shareholder: v.optional(vShareholder),
};

/** Validates the mark and returns the Eigenbeleg data (null for „Ignorieren“). */
export const markContext = query({
  permission: "banking.mark",
  args: markArgs,
  handler: async (ctx, args) => markEigenbelegInput(ctx, args, ctx.actorContext.label ?? ctx.actor, ctx.now()),
});

export const applyMark = actorMutation({
  permission: "banking.mark",
  args: { ...markArgs, eigenbeleg: v.optional(vFileRef) },
  handler: async (ctx, args) => markTransaction(ctx, args),
});

/**
 * ⚠ „Privat“, „Geldtransit“, „Bargeld in die Kasse“, „Ignorieren“: validates, renders and archives the Eigenbeleg
 * (BNK-060, CSH-025, sha256), then posts the journal entry in one mutation. The MCP tool adds the confirm token.
 */
export const mark = action({
  permission: "banking.mark",
  args: markArgs,
  handler: async (ctx, args): Promise<{ status: string }> => {
    const input = await ctx.runQuery(api.banking.markContext, args);
    let eigenbeleg: FileRefValue | undefined;
    if (input) {
      const content = eigenbelegContent(input);
      const bytes = await renderEigenbeleg(content, input.company, ctx.now());
      const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      eigenbeleg = {
        storageId,
        sha256: await sha256Hex(bytes as BufferSource),
        bytes: bytes.byteLength,
        mime: "application/pdf",
        name: content.fileName,
      };
    }
    try {
      return await ctx.runMutation(internal.banking.applyMark, {
        actorContext: ctx.actorContext,
        ...args,
        ...(eigenbeleg ? { eigenbeleg } : {}),
      });
    } catch (e) {
      // Nothing references the Eigenbeleg when the mutation failed: remove the orphan.
      if (eigenbeleg) await ctx.storage.delete(eigenbeleg.storageId);
      throw e;
    }
  },
});

/** „Markierung aufheben“ — Generalumkehr of the posting (ACC-004), reason mandatory. */
export const unmark = mutation({
  permission: "banking.mark",
  args: { transactionId: v.id("bankTransactions"), reason: v.string() },
  handler: async (ctx, args) => unmarkTransaction(ctx, args),
});

export const linkReversalTo = mutation({
  permission: "banking.write",
  args: { counterId: v.id("bankTransactions"), originalId: v.id("bankTransactions") },
  handler: async (ctx, args) => {
    await requireTransaction(ctx, args.counterId);
    await linkReversal(ctx, args);
    return null;
  },
});
