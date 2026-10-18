import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { retentionUntil } from "../src/domain/documents/finalize";
import { isZipBytes } from "../src/domain/import/sevdesk/archive";
import { IMPORT_FILE_MAX_BYTES, inspectFile } from "../src/domain/import/sevdesk/files";
import { INVOICE_TYPES_WITH_OPEN_ITEMS } from "../src/domain/import/sevdesk/invoices";
import { isMappedCsvKind } from "../src/domain/import/sevdesk/mapping";
import {
  buildPlan,
  type FileMappingInput,
  type ImportFileInput,
  type ImportPlan,
  type ImportResolutions,
  lookupKeys,
  missingPdfKeys,
  type PreviewSummary,
  parseImportFiles,
  previewHashInput,
  summarizePlan,
} from "../src/domain/import/sevdesk/preview";
import type { ImportProtocolInput } from "../src/domain/import/sevdesk/protocol";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, actorMutation, mutation, query, systemQuery } from "./functions";
import { appError } from "./lib/errors";
import { describeImportFile, type NewImportFilePayload, vNewImportFile } from "./lib/importFiles";
import { getCompanyProfile } from "./model/companyProfile";
import {
  addImportFiles,
  attachImportProtocol,
  beginImportCommit,
  commitImportContacts,
  commitImportDocuments,
  commitImportOpeningItems,
  commitImportProducts,
  continueImportedRanges,
  createImport,
  discardImport,
  failImport,
  finishImport,
  IMPORT_MESSAGES,
  type ImportedDocumentPayload,
  importLocalState,
  removeImportFile,
  requireImport,
  saveImportPreview,
  setImportMapping,
  setImportResolutions,
  updateImportFile,
} from "./model/imports";
import type { ActorContext } from "./model/types";
import { vFileRef, vTaxCase, vVatCategory } from "./validators";

/**
 * F09 sevdesk export import (IMP-003…024, §4.3.4): upload → classification → mapping → preview → commit / discard.
 * Files are read in actions (storage is readable there); parsing and the preview plan are the pure domain functions;
 * every write runs in a mutation with the caller's actor (actorMutation) and is audited. The commit re-computes the
 * preview and refuses a stale one (E-IMP-27), writes in resumable batches on channel `import` (IMP-014) and never
 * contacts sevdesk.
 */

const vMappingValue = v.object({
  columns: v.record(v.string(), v.string()),
  numberFormat: v.optional(v.union(v.literal("de"), v.literal("en"))),
  dateFormat: v.optional(v.union(v.literal("dmy"), v.literal("mdy"))),
});
const vResolutions = v.object({
  excluded: v.optional(v.array(v.string())),
  pdfAssignments: v.optional(v.record(v.string(), v.string())),
  openAmounts: v.optional(v.record(v.string(), v.number())),
});
const vResetPolicy = v.union(v.literal("never"), v.literal("yearly"), v.literal("monthly"));
const vRangeDecision = v.object({
  rangeKey: v.string(),
  format: v.string(),
  resetPolicy: vResetPolicy,
  next: v.number(),
});
const vDocType = v.union(
  v.literal("invoice"),
  v.literal("advance_invoice"),
  v.literal("partial_invoice"),
  v.literal("final_invoice"),
  v.literal("correction"),
  v.literal("cancellation"),
);
const vDocPayload = v.object({
  key: v.string(),
  type: vDocType,
  number: v.string(),
  documentDate: v.string(),
  supplyDate: v.optional(v.string()),
  dueDate: v.optional(v.string()),
  sentOn: v.string(),
  sentOnAssumed: v.boolean(),
  customerName: v.string(),
  currency: v.string(),
  taxCase: vTaxCase,
  groups: v.array(
    v.object({
      category: vVatCategory,
      rateBp: v.number(),
      netCents: v.number(),
      vatCents: v.number(),
      grossCents: v.number(),
    }),
  ),
  totals: v.object({ netCents: v.number(), vatCents: v.number(), grossCents: v.number() }),
  finalStatus: v.union(v.literal("sent"), v.literal("cancelled")),
  paymentStatus: v.optional(v.union(v.literal("open"), v.literal("partially_paid"), v.literal("paid"))),
  openAmountCents: v.optional(v.number()),
  contact: v.union(
    v.object({ kind: v.union(v.literal("import"), v.literal("minimal")), key: v.string() }),
    v.object({ kind: v.literal("local"), id: v.string() }),
  ),
  correctsKey: v.optional(v.string()),
  correctsLocalId: v.optional(v.string()),
  pdfFileId: v.optional(v.string()),
  deviations: v.array(v.string()),
});

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────

/** Import projects (newest first) for `/einstellungen/import`. */
export const list = query({
  permission: "imports.read",
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("imports").order("desc").take(50)).map((i) => ({
      id: i._id,
      source: i.source,
      status: i.status,
      files: i.files.length,
      startedAt: i.startedAt,
      committedAt: i.committedAt ?? null,
      actor: i.actor,
      committedBy: i.committedBy ?? null,
      counts: (i.preview as PreviewSummary | undefined)?.counts ?? i.stats,
    })),
});

/** One import project: files (without storage ids), mapping, resolutions, stored preview, run log. */
export const get = query({
  permission: "imports.read",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => {
    const i = await ctx.db.get(importId);
    if (!i) return null;
    const presets = await ctx.db.query("importMappingPresets").collect();
    return {
      id: i._id,
      status: i.status,
      revision: i.revision,
      files: i.files.map(({ storageId: _s, ...f }) => f),
      mapping: i.mapping ?? {},
      resolutions: i.resolutions ?? {},
      previewHash: i.previewHash ?? null,
      preview: (i.preview as PreviewSummary | undefined) ?? null,
      stats: i.stats,
      log: i.log,
      error: i.error ?? null,
      startedAt: i.startedAt,
      committedAt: i.committedAt ?? null,
      committedBy: i.committedBy ?? null,
      retentionUntil: i.retentionUntil ?? null,
      importerVersion: i.importerVersion,
      // IMP-024: the archived import protocol (download link for the import page).
      protocol: i.protocolFile
        ? {
            name: i.protocolFile.name,
            sha256: i.protocolFile.sha256,
            bytes: i.protocolFile.bytes,
            url: await ctx.storage.getUrl(i.protocolFile.storageId),
          }
        : null,
      presets: presets.map((p) => ({ id: p._id, name: p.name, fileKind: p.fileKind, columns: p.columns })),
    };
  },
});

/** The raw workspace for the preview/commit actions (storage ids included). */
export const source = query({
  permission: "imports.run",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => {
    const i = await requireImport(ctx, importId);
    // EC-202: the Kleinunternehmer history stands in for the tax rule sevdesk's invoice list does not export.
    const profile = await getCompanyProfile(ctx);
    return {
      kleinunternehmer: (profile?.kleinunternehmer ?? []).map((k) => ({ validFrom: k.validFrom, isKU: k.isKU })),
      status: i.status,
      revision: i.revision,
      previewHash: i.previewHash ?? null,
      files: i.files,
      mapping: i.mapping ?? {},
      resolutions: i.resolutions ?? {},
    };
  },
});

const vKeys = v.object({
  imported: v.array(v.string()),
  registerNumbers: v.array(v.string()),
  contactNumbers: v.array(v.string()),
  contactNames: v.array(v.string()),
  productNumbers: v.array(v.string()),
  documentNumbers: v.array(v.string()),
});

/** IMP-009: the local data the preview depends on (read-only; business tables are never touched by a preview). */
export const localState = query({
  permission: "imports.run",
  args: { keys: vKeys, today: v.string() },
  handler: async (ctx, { keys, today }) => importLocalState(ctx, keys, today as CalendarDate),
});

// ── workspace writes ──────────────────────────────────────────────────────────────────────────────────

export const create = mutation({
  permission: "imports.run",
  args: {},
  handler: async (ctx) => createImport(ctx),
});

export const generateUploadUrl = mutation({
  permission: "imports.run",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const addFilesInternal = actorMutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), files: v.array(vNewImportFile) },
  handler: async (ctx, { importId, files }) => addImportFiles(ctx, importId, files),
});

/**
 * IMP-016: uploaded files are hashed, decoded and classified here (bytes never pass through a mutation). A ZIP is
 * unpacked in the Node action `importsNode.unpackZip`: each contained file becomes an import file of its own (own
 * storage, SHA-256, inner path as name, `container` = the ZIP) and the ZIP stays as archived source file (IMP-024).
 * A rejected ZIP (E-IMP-29/39/40) is deleted and reported; the other files of the upload are still added.
 */
export const addFiles = action({
  permission: "imports.run",
  args: { importId: v.id("imports"), files: v.array(v.object({ storageId: v.id("_storage"), name: v.string() })) },
  handler: async (
    ctx,
    { importId, files },
  ): Promise<{
    added: string[];
    duplicates: string[];
    /** E-IMP-29/39/40: ZIPs that were not unpacked (deleted again). */
    rejected?: { name: string; code: string; message: string }[];
    /** OS metadata skipped inside ZIPs (`<zip>/<path>`). */
    ignoredEntries?: string[];
  }> => {
    const out: NewImportFilePayload[] = [];
    const rejected: { name: string; code: string; message: string }[] = [];
    const ignoredEntries: string[] = [];
    const cleanup = async () => {
      for (const f of files) await ctx.storage.delete(f.storageId).catch(() => {});
      for (const f of out) await ctx.storage.delete(f.storageId).catch(() => {});
    };
    try {
      let usedBytes: number = await ctx.runQuery(internal.imports.usedBytes, { importId });
      for (const f of files) {
        const blob = await ctx.storage.get(f.storageId);
        if (!blob) throw appError("not_found", `Die Datei ${f.name} wurde nicht gefunden.`);
        if (blob.size > IMPORT_FILE_MAX_BYTES) throw appError("invalid_input", `${f.name} ist größer als 50 MB.`);
        if (isZipBytes(new Uint8Array(await blob.slice(0, 4).arrayBuffer()))) {
          const r = await ctx.runAction(internal.importsNode.unpackZip, {
            storageId: f.storageId,
            name: f.name,
            usedBytes: usedBytes + blob.size,
          });
          if (!r.ok) {
            await ctx.storage.delete(f.storageId);
            rejected.push({ name: f.name, code: r.code, message: r.message });
            continue;
          }
          // The archive itself is kept as source file (IMP-024) but not parsed; the Node action hashed it.
          out.push({
            storageId: f.storageId,
            sha256: r.sha256,
            bytes: blob.size,
            mime: blob.type || "application/zip",
            name: f.name.slice(0, 255),
            kind: "zip",
            unpacked: { files: r.files, ignored: r.ignored.slice(0, 200) },
          });
          for (const e of r.entries) out.push({ ...e, containerSha256: r.sha256 });
          ignoredEntries.push(...r.ignored.map((p) => `${f.name}/${p}`));
          usedBytes += blob.size + r.entries.reduce((sum, e) => sum + e.bytes, 0);
          continue;
        }
        out.push(await describeImportFile(f.name, new Uint8Array(await blob.arrayBuffer()), f.storageId, blob.type));
        usedBytes += blob.size;
      }
      const r = await ctx.runMutation(internal.imports.addFilesInternal, {
        actorContext: ctx.actorContext,
        importId,
        files: out,
      });
      return {
        ...r,
        ...(rejected.length > 0 ? { rejected } : {}),
        ...(ignoredEntries.length > 0 ? { ignoredEntries } : {}),
      };
    } catch (e) {
      // Nothing of this upload was registered: no orphaned blobs (uploads and unpacked entries).
      await cleanup();
      throw e;
    }
  },
});

/** Bytes already stored in the import (IMP-016 2 GB budget for unpacking). */
export const usedBytes = systemQuery({
  job: "imports.files",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => (await requireImport(ctx, importId)).files.reduce((sum, f) => sum + f.bytes, 0),
});

export const updateFile = mutation({
  permission: "imports.run",
  args: {
    importId: v.id("imports"),
    fileId: v.string(),
    kind: v.optional(v.string()),
    ignored: v.optional(v.boolean()),
  },
  handler: async (ctx, { importId, fileId, kind, ignored }) =>
    updateImportFile(ctx, importId, fileId, {
      ...(kind !== undefined ? { kind } : {}),
      ...(ignored !== undefined ? { ignored } : {}),
    }),
});

export const removeFile = mutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), fileId: v.string() },
  handler: async (ctx, { importId, fileId }) => removeImportFile(ctx, importId, fileId),
});

export const setMapping = mutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), fileId: v.string(), mapping: vMappingValue, savePresetAs: v.optional(v.string()) },
  handler: async (ctx, { importId, fileId, mapping, savePresetAs }) =>
    setImportMapping(ctx, importId, fileId, mapping, savePresetAs),
});

export const setResolutions = mutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), resolutions: vResolutions },
  handler: async (ctx, { importId, resolutions }) => setImportResolutions(ctx, importId, resolutions),
});

export const discard = mutation({
  permission: "imports.run",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => discardImport(ctx, importId),
});

// ── preview (IMP-009) ─────────────────────────────────────────────────────────────────────────────────

type Workspace = {
  kleinunternehmer: { validFrom: string; isKU: boolean }[];
  status: string;
  revision: number;
  previewHash: string | null;
  files: { id: string; storageId: Id<"_storage">; sha256: string; name: string; kind: string; ignored?: boolean }[];
  mapping: Record<string, FileMappingInput>;
  resolutions: ImportResolutions;
};

/** Reads the workspace, re-reads and verifies the stored files and computes the plan against the local data. */
async function computePlan(
  ctx: ActionCtx,
  importId: Id<"imports">,
): Promise<{ ws: Workspace; plan: ImportPlan; hash: string; today: CalendarDate }> {
  const ws: Workspace = await ctx.runQuery(api.imports.source, { importId });
  const today = berlinCalendarDate(Date.now());
  const files: ImportFileInput[] = [];
  for (const f of ws.files) {
    const base = {
      id: f.id,
      name: f.name,
      sha256: f.sha256,
      kind: f.kind as ImportFileInput["kind"],
      ...(f.ignored ? { ignored: true } : {}),
    };
    if (!isMappedCsvKind(f.kind) || f.ignored) {
      files.push(base);
      continue;
    }
    const blob = await ctx.storage.get(f.storageId);
    if (!blob) throw appError("not_found", `Die Datei ${f.name} fehlt im Speicher.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // GOBD-20: what is parsed is exactly the stored, hashed upload.
    if ((await sha256Hex(bytes)) !== f.sha256) throw appError("conflict", `Die Datei ${f.name} wurde verändert.`);
    const info = inspectFile(f.name, bytes);
    files.push({ ...base, ...(info.table ? { table: info.table } : {}) });
  }
  const parsed = parseImportFiles(files, ws.mapping, today, { kleinunternehmer: ws.kleinunternehmer });
  const local = await ctx.runQuery(api.imports.localState, { keys: lookupKeys(parsed), today });
  const plan = buildPlan(parsed, local, ws.resolutions);
  const hash = await sha256Hex(previewHashInput(files, ws.mapping, ws.resolutions, plan));
  return { ws, plan, hash, today };
}

export const savePreviewInternal = actorMutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), revision: v.number(), previewHash: v.string(), preview: v.any() },
  handler: async (ctx, args) => saveImportPreview(ctx, args.importId, args),
});

export const preview = action({
  permission: "imports.run",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }): Promise<{ previewHash: string; preview: PreviewSummary }> => {
    const { ws, plan, hash } = await computePlan(ctx, importId);
    if (ws.status !== "uploaded" && ws.status !== "previewed") {
      throw appError("conflict", IMPORT_MESSAGES.committed, { reason: "IMPORT_COMMITTED" });
    }
    const summary = summarizePlan(plan);
    await ctx.runMutation(internal.imports.savePreviewInternal, {
      actorContext: ctx.actorContext,
      importId,
      revision: ws.revision,
      previewHash: hash,
      preview: summary,
    });
    return { previewHash: hash, preview: summary };
  },
});

// ── commit (IMP-023) ──────────────────────────────────────────────────────────────────────────────────

export const beginCommitInternal = actorMutation({
  permission: "imports.commit",
  args: {
    importId: v.id("imports"),
    previewHash: v.string(),
    revision: v.number(),
    decisions: v.object({ numberRanges: v.array(vRangeDecision), missingPdfReason: v.optional(v.string()) }),
  },
  handler: async (ctx, { importId, ...input }) => beginImportCommit(ctx, importId, input),
});

export const commitContactsInternal = actorMutation({
  permission: "imports.commit",
  args: {
    importId: v.id("imports"),
    contacts: v.array(v.object({ key: v.string(), values: v.any() })),
    minimal: v.array(v.object({ key: v.string(), name: v.string(), customerNumber: v.optional(v.string()) })),
  },
  handler: async (ctx, { importId, contacts, minimal }) => commitImportContacts(ctx, importId, contacts, minimal),
});

export const commitProductsInternal = actorMutation({
  permission: "imports.commit",
  args: {
    importId: v.id("imports"),
    products: v.array(v.object({ key: v.string(), form: v.any(), categoryPath: v.string() })),
  },
  handler: async (ctx, { importId, products }) => commitImportProducts(ctx, importId, products),
});

export const commitDocumentsInternal = actorMutation({
  permission: "imports.commit",
  args: { importId: v.id("imports"), docs: v.array(vDocPayload) },
  handler: async (ctx, { importId, docs }) => commitImportDocuments(ctx, importId, docs),
});

export const commitOpeningInternal = actorMutation({
  permission: "imports.commit",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => commitImportOpeningItems(ctx, importId),
});

export const continueRangesInternal = actorMutation({
  permission: "imports.commit",
  args: { importId: v.id("imports"), decisions: v.array(vRangeDecision), today: v.string() },
  handler: async (ctx, { importId, decisions, today }) =>
    continueImportedRanges(ctx, importId, decisions, today as CalendarDate),
});

export const finishInternal = actorMutation({
  permission: "imports.commit",
  args: {
    importId: v.id("imports"),
    stats: v.record(v.string(), v.number()),
    log: v.array(v.string()),
    today: v.string(),
    maxRetentionUntil: v.optional(v.string()),
  },
  handler: async (ctx, { importId, today, ...rest }) =>
    finishImport(ctx, importId, { ...rest, today: today as CalendarDate }),
});

// ── import protocol (IMP-024) ───────────────────────────────────────────────────────────────────────

/** Input of the protocol PDF: the frozen row plus the commit's audit entries (start time, actor label and role). */
export const protocolInput = systemQuery({
  job: "imports.protocol",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }): Promise<ImportProtocolInput> => {
    const i = await requireImport(ctx, importId);
    if (i.status !== "done") {
      throw appError("conflict", IMPORT_PROTOCOL_NOT_DONE, { reason: "IMPORT_NOT_DONE" });
    }
    const audit = await ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) => q.eq("entity.table", "imports").eq("entity.id", importId))
      .collect();
    const commitStart = audit.find((a) => a.action === "import.commit");
    const committer = audit.findLast((a) => a.action === "import.finish") ?? commitStart;
    const preview = (i.preview ?? {}) as NonNullable<ImportProtocolInput["preview"]>;
    const decisions = (i.decisions ?? {}) as NonNullable<ImportProtocolInput["decisions"]>;
    return {
      importId,
      importerVersion: i.importerVersion,
      createdBy: i.actor,
      startedAt: i.startedAt,
      commit: {
        actor: i.committedBy ?? committer?.actor ?? i.actor,
        ...(committer?.actorLabel ? { label: committer.actorLabel } : {}),
        ...(committer?.actorRole ? { role: committer.actorRole } : {}),
        ...(commitStart ? { startedAt: commitStart.at } : {}),
        finishedAt: i.finishedAt ?? i.committedAt ?? i.startedAt,
      },
      ...(i.retentionUntil ? { retentionUntil: i.retentionUntil } : {}),
      files: i.files.map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        detectedKind: f.detectedKind,
        bytes: f.bytes,
        sha256: f.sha256,
        ...(f.ignored ? { ignored: true } : {}),
        ...(f.container ? { container: f.container } : {}),
        ...(f.rows !== undefined ? { rows: f.rows } : {}),
        ...(f.encoding ? { encoding: f.encoding } : {}),
        ...(f.delimiter ? { delimiter: f.delimiter } : {}),
        ...(f.unpacked ? { unpacked: f.unpacked } : {}),
      })),
      mapping: Object.fromEntries(Object.entries(i.mapping ?? {}).map(([id, m]) => [id, { columns: m.columns }])),
      resolutions: i.resolutions ?? {},
      decisions: {
        ...(decisions.numberRanges ? { numberRanges: decisions.numberRanges } : {}),
        ...(decisions.missingPdfReason ? { missingPdfReason: decisions.missingPdfReason } : {}),
      },
      preview: {
        ...(preview.findings
          ? {
              findings: preview.findings.map((f) => ({
                code: f.code,
                severity: f.severity,
                message: f.message,
                ...(f.fileName ? { fileName: f.fileName } : {}),
                ...(f.line !== undefined ? { line: f.line } : {}),
              })),
            }
          : {}),
        ...(preview.findingsTotal !== undefined ? { findingsTotal: preview.findingsTotal } : {}),
        ...(preview.openItems ? { openItems: preview.openItems } : {}),
        ...(preview.pdf ? { pdf: { orphans: preview.pdf.orphans ?? [], missing: preview.pdf.missing ?? [] } } : {}),
      },
      stats: i.stats,
      log: i.log,
    };
  },
});

const IMPORT_PROTOCOL_NOT_DONE = "Das Importprotokoll entsteht erst mit der Übernahme.";

export const attachProtocolInternal = actorMutation({
  permission: "imports.commit",
  args: { importId: v.id("imports"), file: vFileRef },
  handler: async (ctx, { importId, file }) => attachImportProtocol(ctx, importId, file),
});

async function archiveProtocol(ctx: ActionCtx, actorContext: ActorContext, importId: Id<"imports">) {
  const file = await ctx.runAction(internal.importsNode.renderProtocol, { importId });
  try {
    await ctx.runMutation(internal.imports.attachProtocolInternal, { actorContext, importId, file });
  } catch (e) {
    await ctx.storage.delete(file.storageId);
    throw e;
  }
}

/** IMP-024 „Protokoll erzeugen“: creates a missing protocol of a committed import; an existing one stays. */
export const generateProtocol = action({
  permission: "imports.commit",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }): Promise<{ created: boolean }> => {
    const i = await ctx.runQuery(api.imports.get, { importId });
    if (!i) throw appError("not_found", "Der Import existiert nicht.");
    if (i.status !== "done") throw appError("conflict", IMPORT_PROTOCOL_NOT_DONE, { reason: "IMPORT_NOT_DONE" });
    if (i.protocol) return { created: false };
    await archiveProtocol(ctx, ctx.actorContext, importId);
    return { created: true };
  },
});

export const failInternal = actorMutation({
  permission: "imports.commit",
  args: { importId: v.id("imports"), message: v.string() },
  handler: async (ctx, { importId, message }) => failImport(ctx, importId, message),
});

const CONTACT_BATCH = 50;
const PRODUCT_BATCH = 50;
const DOCUMENT_BATCH = 25;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** §4.3.4: a failed batch is retried 3× before the run is marked failed (resumable, already written rows skip). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const code = (e as { data?: { code?: string } }).data?.code;
      if (code && code !== "internal") break; // domain errors do not heal by retrying
    }
  }
  throw last;
}

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);

function docPayload(p: ImportPlan["documents"][number]): ImportedDocumentPayload {
  const d = p.doc;
  return {
    key: d.key,
    type: d.type,
    number: d.number,
    documentDate: d.documentDate,
    ...(d.supplyDate ? { supplyDate: d.supplyDate } : {}),
    ...(d.dueDate ? { dueDate: d.dueDate } : {}),
    sentOn: d.sentOn,
    sentOnAssumed: d.sentOnAssumed,
    customerName: d.customerName,
    currency: d.currency,
    taxCase: d.taxCase,
    groups: d.groups.map((g) => ({ ...g })),
    totals: { ...d.totals },
    finalStatus: p.finalStatus,
    ...(p.paymentStatus ? { paymentStatus: p.paymentStatus } : {}),
    ...(p.openAmountCents !== undefined ? { openAmountCents: p.openAmountCents } : {}),
    contact: p.contact as ImportedDocumentPayload["contact"],
    ...(p.correctsKey ? { correctsKey: p.correctsKey } : {}),
    ...(p.correctsLocalId ? { correctsLocalId: p.correctsLocalId } : {}),
    ...(p.pdfFileId ? { pdfFileId: p.pdfFileId } : {}),
    deviations: p.deviations,
  };
}

export const commit = action({
  permission: "imports.commit",
  args: {
    importId: v.id("imports"),
    previewHash: v.string(),
    numberRanges: v.array(vRangeDecision),
    /** E-IMP-07 „ohne Original-PDF übernehmen“ for all listed rows (reason mandatory, audited with the decisions). */
    missingPdfReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: "done"; counts: Record<string, number>; protocol: boolean }> => {
    const { ws, plan, hash, today } = await computePlan(ctx, args.importId);
    const resuming = ws.status === "failed";
    if (!resuming) {
      if (ws.status !== "previewed" || ws.previewHash !== args.previewHash || hash !== args.previewHash) {
        if (ws.status === "done" || ws.status === "discarded" || ws.status === "running") {
          throw appError(
            "conflict",
            ws.status === "discarded" ? IMPORT_MESSAGES.discarded : IMPORT_MESSAGES.committed,
            {
              reason: "IMPORT_COMMITTED",
            },
          );
        }
        throw appError("conflict", IMPORT_MESSAGES.stale, { reason: "PREVIEW_STALE" });
      }
      if (plan.blocking > 0) {
        throw appError(
          "invalid_input",
          `Die Vorschau enthält noch ${plan.blocking} Fehler. Bitte beheben oder Zeilen ausschließen.`,
          {
            reason: "IMPORT_BLOCKED",
          },
        );
      }
      const missing = missingPdfKeys(plan);
      if (missing.length > 0 && !args.missingPdfReason?.trim()) {
        throw appError(
          "invalid_input",
          `Für ${missing.length} Belege fehlt das Original-PDF. Bitte „ohne Original-PDF übernehmen“ mit Begründung bestätigen.`,
          { reason: "E_IMP_07" },
        );
      }
    }
    await ctx.runMutation(internal.imports.beginCommitInternal, {
      actorContext: ctx.actorContext,
      importId: args.importId,
      previewHash: args.previewHash,
      revision: ws.revision,
      decisions: {
        numberRanges: args.numberRanges,
        ...(args.missingPdfReason?.trim() ? { missingPdfReason: args.missingPdfReason.trim() } : {}),
      },
    });
    // IMP-014: the records carry channel `import`; the actor stays the committing user / API key.
    const actorContext = { ...ctx.actorContext, channel: "import" as const };
    const importId = args.importId;
    const counts = { contactsCreated: 0, productsCreated: 0, documentsCreated: 0, openingItemsCreated: 0, skipped: 0 };
    const log: string[] = [];
    try {
      // IMP-018 commit order: contacts → products → sales documents with artifacts → open items → number ranges.
      const contacts = plan.contacts.filter((c) => c.status === "new").map((c) => ({ key: c.key, values: c.values }));
      const minimal = plan.minimalContacts
        .filter((m) => !m.localId)
        .map((m) => ({ key: m.key, name: m.name, ...(m.customerNumber ? { customerNumber: m.customerNumber } : {}) }));
      for (const [i, batch] of chunks(contacts, CONTACT_BATCH).entries()) {
        const r = await withRetry(() =>
          ctx.runMutation(internal.imports.commitContactsInternal, {
            actorContext,
            importId,
            contacts: batch,
            minimal: i === 0 ? minimal : [],
          }),
        );
        counts.contactsCreated += r.created;
        counts.skipped += r.skipped;
      }
      if (contacts.length === 0 && minimal.length > 0) {
        const r = await withRetry(() =>
          ctx.runMutation(internal.imports.commitContactsInternal, { actorContext, importId, contacts: [], minimal }),
        );
        counts.contactsCreated += r.created;
        counts.skipped += r.skipped;
      }
      const products = plan.products
        .filter((p) => p.status === "new")
        .map((p) => ({ key: p.key, form: p.form, categoryPath: p.categoryPath }));
      for (const batch of chunks(products, PRODUCT_BATCH)) {
        const r = await withRetry(() =>
          ctx.runMutation(internal.imports.commitProductsInternal, { actorContext, importId, products: batch }),
        );
        counts.productsCreated += r.created;
        counts.skipped += r.skipped;
      }
      // Originals before their Storno/Korrektur so `correctsId` resolves across batches.
      const docs = plan.documents
        .filter((p) => p.status === "new")
        .sort(
          (a, b) =>
            Number(!INVOICE_TYPES_WITH_OPEN_ITEMS.includes(a.doc.type)) -
            Number(!INVOICE_TYPES_WITH_OPEN_ITEMS.includes(b.doc.type)),
        )
        .map(docPayload);
      for (const batch of chunks(docs, DOCUMENT_BATCH)) {
        const r = await withRetry(() =>
          ctx.runMutation(internal.imports.commitDocumentsInternal, { actorContext, importId, docs: batch }),
        );
        counts.documentsCreated += r.created;
        counts.skipped += r.skipped;
      }
      // IMP-007: open items → F08 opening receivables, linked to their archived documents (one transaction).
      const opening = await withRetry(() =>
        ctx.runMutation(internal.imports.commitOpeningInternal, { actorContext, importId }),
      );
      counts.openingItemsCreated = opening.created;
      if (opening.created > 0) log.push(`Eröffnungsbilanz: ${opening.created} offene Posten übernommen`);
      if (args.numberRanges.length > 0) {
        await ctx.runMutation(internal.imports.continueRangesInternal, {
          actorContext,
          importId,
          decisions: args.numberRanges,
          today,
        });
        for (const d of args.numberRanges) log.push(`Nummernkreis ${d.rangeKey}: ${d.format}, nächste ${d.next}`);
      }
      if (args.missingPdfReason?.trim()) {
        log.push(`Ohne Original-PDF übernommen (${missingPdfKeys(plan).length}): ${args.missingPdfReason.trim()}`);
      }
      const maxRetention = plan.documents
        .filter((p) => p.status === "new")
        .map((p) => retentionUntil(p.doc.type, p.doc.documentDate))
        .sort()
        .at(-1);
      const stats = { ...plan.counts, ...counts };
      await ctx.runMutation(internal.imports.finishInternal, {
        actorContext,
        importId,
        stats,
        log,
        today,
        ...(maxRetention ? { maxRetentionUntil: maxRetention } : {}),
      });
      // IMP-024: rendered from the frozen row; a failure leaves the import done („Protokoll erzeugen“ retries).
      const protocol = await archiveProtocol(ctx, actorContext, importId).then(
        () => true,
        () => false,
      );
      return { status: "done", counts: stats, protocol };
    } catch (e) {
      // E-IMP-14: finished batches stay; the run can be resumed.
      await ctx.runMutation(internal.imports.failInternal, { actorContext, importId, message: messageOf(e) });
      throw e;
    }
  },
});
