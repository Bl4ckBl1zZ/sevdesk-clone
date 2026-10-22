import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import {
  CHOOSABLE_ENCODINGS,
  type CsvEncoding,
  IMPORT_MAX_BYTES,
  looksLikeMojibake,
  readCsvRecords,
} from "../src/domain/csv/csv";
import {
  buildGenericPlan,
  checkGenericMapping,
  type GenericPlan,
  type GenericPreviewSummary,
  type GenericTarget,
  genericKeys,
  genericPreviewHashInput,
  type OnExisting,
  parseGenericRows,
  presetLabel,
  summarizeGenericPlan,
  withIdempotencyKeys,
} from "../src/domain/import/generic/csv-import";
import { shippedPresetsFor } from "../src/domain/import/generic/presets";
import { lookupVatRate } from "../src/domain/rules/vat-rates";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, actorMutation, mutation, query } from "./functions";
import { appError } from "./lib/errors";
import {
  commitGenericRows,
  createGenericImport,
  genericLocalState,
  genericTargetOf,
  requireGenericImport,
  setGenericFile,
  setGenericMapping,
  setGenericTarget,
} from "./model/csvImports";
import { IMPORT_MESSAGES } from "./model/imports";

/**
 * F09 IMP-012 generic CSV import (contacts and products, `imports.source = "generic_csv"`): upload → encoding and
 * delimiter detection → column mapping with saved presets → row validation with the API schemas → preview with error
 * CSV → commit or discard. Reuses the `imports` lifecycle of the sevdesk import (IMP-023: `imports.savePreviewInternal`,
 * `beginCommitInternal`, `finishInternal`, `failInternal`, `imports.discard`); parsing and planning are pure
 * (src/domain/import/generic). The commit runs its batches synchronously in the caller's action on channel `import`
 * (IMP-014; the spec's job name `import_csv` names this run).
 */

const vTarget = v.union(v.literal("contacts"), v.literal("products"));

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────

export const list = query({
  permission: "imports.read",
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("imports").order("desc").take(200))
      .filter((i) => i.source === "generic_csv")
      .slice(0, 50)
      .map((i) => ({
        id: i._id,
        status: i.status,
        target: genericTargetOf(i),
        fileName: i.files[0]?.name ?? null,
        startedAt: i.startedAt,
        committedAt: i.committedAt ?? null,
        stats: i.stats,
      })),
});

export const get = query({
  permission: "imports.read",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => {
    const i = await ctx.db.get(importId);
    if (i?.source !== "generic_csv") return null;
    const file = i.files[0];
    const target = genericTargetOf(i);
    const mapping = file ? i.mapping?.[file.id] : undefined;
    const presets = target
      ? await ctx.db
          .query("importMappingPresets")
          .withIndex("by_kind", (q) => q.eq("source", "generic_csv").eq("fileKind", target))
          .collect()
      : [];
    return {
      id: i._id,
      status: i.status,
      revision: i.revision,
      target,
      file: file
        ? {
            name: file.name,
            sha256: file.sha256,
            bytes: file.bytes,
            encoding: file.encoding ?? null,
            delimiter: file.delimiter ?? null,
            headers: file.headers ?? [],
            samples: file.samples ?? [],
            rows: file.rows ?? 0,
          }
        : null,
      columns: mapping?.columns ?? {},
      preset: mapping?.preset ?? null,
      onExisting: (mapping?.onExisting ?? "skip") as OnExisting,
      // the owner's presets first, then the shipped ones (IMP-013 lexoffice, flagged „ungeprüft“)
      presets: [
        ...presets
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((p) => ({ id: p._id as string, name: p.name, columns: p.columns, unsure: p.unsure })),
        ...(target ? shippedPresetsFor(target) : []).map((p) => ({
          id: p.id,
          name: p.name,
          columns: { ...p.columns },
          unsure: p.unsure,
        })),
      ],
      previewHash: i.previewHash ?? null,
      preview: (i.preview as GenericPreviewSummary | undefined) ?? null,
      stats: i.stats,
      log: i.log,
      error: i.error ?? null,
      startedAt: i.startedAt,
      committedAt: i.committedAt ?? null,
    };
  },
});

/** The raw workspace for the preview/commit actions (storage id included). */
export const source = query({
  permission: "imports.run",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }) => {
    const i = await requireGenericImport(ctx, importId);
    const file = i.files[0];
    return {
      status: i.status,
      revision: i.revision,
      previewHash: i.previewHash ?? null,
      target: genericTargetOf(i),
      file: file
        ? {
            id: file.id,
            storageId: file.storageId,
            sha256: file.sha256,
            name: file.name,
            encoding: file.encoding ?? null,
          }
        : null,
      columns: (file ? i.mapping?.[file.id]?.columns : undefined) ?? {},
      preset: (file ? i.mapping?.[file.id]?.preset : undefined) ?? null,
      onExisting: ((file ? i.mapping?.[file.id]?.onExisting : undefined) ?? "skip") as OnExisting,
    };
  },
});

const vKeys = v.object({
  idempotencyKeys: v.array(v.string()),
  numbers: v.array(v.string()),
  emails: v.array(v.string()),
  vatIds: v.array(v.string()),
});

export const localState = query({
  permission: "imports.run",
  args: { target: vTarget, keys: vKeys },
  handler: async (ctx, { target, keys }) => genericLocalState(ctx, target, keys),
});

// ── workspace writes ──────────────────────────────────────────────────────────────────────────────────

export const create = mutation({
  permission: "imports.run",
  args: {},
  handler: async (ctx) => createGenericImport(ctx),
});

const vFileInput = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  bytes: v.number(),
  mime: v.string(),
  name: v.string(),
  target: vTarget,
  encoding: v.string(),
  delimiter: v.string(),
  headers: v.array(v.string()),
  samples: v.array(v.array(v.string())),
  rows: v.number(),
});

export const setFileInternal = actorMutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), file: vFileInput },
  handler: async (ctx, { importId, file }) => setGenericFile(ctx, importId, file),
});

const vEncoding = v.union(...CHOOSABLE_ENCODINGS.map((e) => v.literal(e)));

type SetFileResult =
  | { rows: number; encoding: string }
  | {
      /** E-IMP-15: „Zeichenkodierung unklar – bitte Windows-1252 oder UTF-8 wählen.“ — upload again with `encoding`. */
      needsEncoding: true;
      message: string;
      samples: Record<(typeof CHOOSABLE_ENCODINGS)[number], string[][]>;
    };

export const ENCODING_UNCLEAR_MESSAGE = "Zeichenkodierung unklar – bitte Windows-1252 oder UTF-8 wählen.";

/**
 * Upload of the CSV (uploaded via `imports.generateUploadUrl`): ≤ 10 MB / 20.000 rows, encoding UTF-8 (with/without
 * BOM) or Windows-1252 and the delimiter are detected; an unreadable file is deleted again and reported. E-IMP-15: when
 * the decoded text looks like mojibake the owner is asked (sample rows in both encodings) and uploads again with the
 * chosen `encoding`, which is stored and used by the preview and the commit.
 */
export const setFile = action({
  permission: "imports.run",
  args: {
    importId: v.id("imports"),
    storageId: v.id("_storage"),
    name: v.string(),
    target: vTarget,
    encoding: v.optional(vEncoding),
  },
  handler: async (ctx, { importId, storageId, name, target, encoding: chosen }): Promise<SetFileResult> => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw appError("not_found", `Die Datei ${name} wurde nicht gefunden.`);
    try {
      if (blob.size > IMPORT_MAX_BYTES) {
        throw appError("invalid_input", "Die Datei ist zu groß (max. 10 MB bzw. 20.000 Zeilen).");
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const csv = readCsvRecords(bytes, chosen);
      if (!csv.ok) throw appError("invalid_input", csv.error.message, { reason: csv.error.code });
      const { headers, records, encoding, separator } = csv.value;
      const text = [headers, ...records.map((r) => r.cells)].map((c) => c.join(";")).join("\n");
      if (!chosen && looksLikeMojibake(text)) {
        const sample = (e: CsvEncoding) => {
          const r = readCsvRecords(bytes, e);
          return r.ok ? r.value.records.slice(0, 3).map((x) => [...x.cells]) : [];
        };
        await ctx.storage.delete(storageId).catch(() => {});
        return {
          needsEncoding: true,
          message: ENCODING_UNCLEAR_MESSAGE,
          samples: { "windows-1252": sample("windows-1252"), "utf-8": sample("utf-8") },
        };
      }
      await ctx.runMutation(internal.csvImports.setFileInternal, {
        actorContext: ctx.actorContext,
        importId,
        file: {
          storageId,
          sha256: await sha256Hex(bytes),
          bytes: bytes.byteLength,
          mime: "text/csv",
          name: name.trim() || "import.csv",
          target,
          encoding,
          delimiter: separator,
          headers,
          samples: records.slice(0, 5).map((r) => [...r.cells]),
          rows: records.length,
        },
      });
      return { rows: records.length, encoding };
    } catch (e) {
      await ctx.storage.delete(storageId).catch(() => {});
      throw e;
    }
  },
});

export const setTarget = mutation({
  permission: "imports.run",
  args: { importId: v.id("imports"), target: vTarget },
  handler: async (ctx, { importId, target }) => setGenericTarget(ctx, importId, target),
});

export const setMapping = mutation({
  permission: "imports.run",
  args: {
    importId: v.id("imports"),
    columns: v.record(v.string(), v.string()),
    preset: v.optional(v.string()),
    savePreset: v.optional(v.boolean()),
    onExisting: v.optional(v.union(v.literal("skip"), v.literal("update"))),
  },
  handler: async (ctx, { importId, ...input }) => setGenericMapping(ctx, importId, input),
});

// ── preview ──────────────────────────────────────────────────────────────────────────────────────────

type Workspace = {
  status: string;
  revision: number;
  previewHash: string | null;
  target: GenericTarget | null;
  file: { id: string; storageId: Id<"_storage">; sha256: string; name: string; encoding: string | null } | null;
  columns: Record<string, string>;
  preset: string | null;
  onExisting: OnExisting;
};

async function computePlan(
  ctx: ActionCtx,
  importId: Id<"imports">,
): Promise<{ ws: Workspace; plan: GenericPlan; hash: string; preset: string; target: GenericTarget }> {
  const ws: Workspace = await ctx.runQuery(api.csvImports.source, { importId });
  if (!ws.file || !ws.target) throw appError("invalid_input", "Bitte zuerst eine CSV-Datei hochladen.");
  const target = ws.target;
  const blob = await ctx.storage.get(ws.file.storageId);
  if (!blob) throw appError("not_found", `Die Datei ${ws.file.name} fehlt im Speicher.`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // GOBD-03: what is parsed is exactly the stored, hashed upload.
  if ((await sha256Hex(bytes)) !== ws.file.sha256)
    throw appError("conflict", `Die Datei ${ws.file.name} wurde verändert.`);
  // E-IMP-15: decode with the stored (detected or owner-chosen) encoding, never re-detect.
  const stored = ws.file.encoding as CsvEncoding | null;
  const csv = readCsvRecords(bytes, stored ?? undefined);
  if (!csv.ok) throw appError("invalid_input", csv.error.message);
  const check = checkGenericMapping(target, csv.value.headers, ws.columns);
  if (check.missing.length > 0) {
    throw appError(
      "invalid_input",
      `Pflichtspalte nicht zugeordnet: ${check.missing.join(", ")}. Bitte Spaltenzuordnung ergänzen.`,
      { reason: "E_IMP_21" },
    );
  }
  const today = berlinCalendarDate(Date.now());
  const rateBpToday = (key: string) => {
    const r = lookupVatRate(key, today);
    return r.ok ? r.value.value.rateBp : undefined;
  };
  const preset = presetLabel(target, ws.preset ?? undefined);
  const rows = await withIdempotencyKeys(parseGenericRows(target, csv.value, ws.columns, rateBpToday), preset);
  const local = await ctx.runQuery(api.csvImports.localState, { target, keys: genericKeys(rows) });
  const plan = buildGenericPlan(target, rows, local, { onExisting: ws.onExisting });
  const hash = await sha256Hex(
    genericPreviewHashInput({
      fileSha256: ws.file.sha256,
      target,
      columns: ws.columns,
      preset,
      plan,
      onExisting: ws.onExisting,
    }),
  );
  return { ws, plan, hash, preset, target };
}

export const preview = action({
  permission: "imports.run",
  args: { importId: v.id("imports") },
  handler: async (ctx, { importId }): Promise<{ previewHash: string; preview: GenericPreviewSummary }> => {
    const { ws, plan, hash } = await computePlan(ctx, importId);
    if (ws.status !== "uploaded" && ws.status !== "previewed") {
      throw appError("conflict", IMPORT_MESSAGES.committed, { reason: "IMPORT_COMMITTED" });
    }
    const summary = summarizeGenericPlan(plan);
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

// ── commit ───────────────────────────────────────────────────────────────────────────────────────────

const vCommitRow = v.object({
  line: v.number(),
  idempotencyKey: v.string(),
  keyValue: v.string(),
  number: v.optional(v.string()),
  email: v.optional(v.string()),
  vatId: v.optional(v.string()),
  values: v.any(),
  categoryPath: v.optional(v.string()),
  updateId: v.optional(v.string()),
});

export const commitRowsInternal = actorMutation({
  permission: "imports.commit",
  args: {
    importId: v.id("imports"),
    target: vTarget,
    preset: v.string(),
    rows: v.array(vCommitRow),
    mappedFields: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { importId, ...input }) => commitGenericRows(ctx, importId, input),
});

const BATCH = 50;

/**
 * IMP-023 commit: only from `previewed` with the current preview hash (stale → E-IMP-27); invalid, duplicate and
 * existing rows are not imported (they were listed in the preview); a failed run is marked `failed` and resumes
 * (rows already written skip through their idempotency key).
 */
export const commit = action({
  permission: "imports.commit",
  args: { importId: v.id("imports"), previewHash: v.string() },
  handler: async (ctx, args): Promise<{ status: "done"; created: number; skipped: number; updated: number }> => {
    const { ws, plan, hash, preset, target } = await computePlan(ctx, args.importId);
    if (ws.status !== "failed") {
      if (ws.status === "done" || ws.status === "discarded" || ws.status === "running") {
        throw appError("conflict", ws.status === "discarded" ? IMPORT_MESSAGES.discarded : IMPORT_MESSAGES.committed, {
          reason: "IMPORT_COMMITTED",
        });
      }
      if (ws.status !== "previewed" || ws.previewHash !== args.previewHash || hash !== args.previewHash) {
        throw appError("conflict", IMPORT_MESSAGES.stale, { reason: "PREVIEW_STALE" });
      }
    }
    await ctx.runMutation(internal.imports.beginCommitInternal, {
      actorContext: ctx.actorContext,
      importId: args.importId,
      previewHash: args.previewHash,
      revision: ws.revision,
      decisions: { numberRanges: [] },
    });
    // IMP-014: the records carry channel `import`; the actor stays the committing user / API key.
    const actorContext = { ...ctx.actorContext, channel: "import" as const };
    const rows = plan.rows
      .filter((r) => (r.status === "new" || r.status === "update") && r.idempotencyKey)
      .map((r) => ({
        ...(r.status === "update" && r.localId ? { updateId: r.localId } : {}),
        line: r.line,
        idempotencyKey: r.idempotencyKey as string,
        keyValue: r.keyValue,
        ...(r.keys.number ? { number: r.keys.number } : {}),
        ...(r.keys.email ? { email: r.keys.email } : {}),
        ...(r.keys.vatId ? { vatId: r.keys.vatId } : {}),
        values: r.values,
        ...(r.categoryPath ? { categoryPath: r.categoryPath } : {}),
      }));
    let created = 0;
    let skipped = 0;
    let updated = 0;
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const r = await ctx.runMutation(internal.csvImports.commitRowsInternal, {
          actorContext,
          importId: args.importId,
          target,
          preset,
          rows: rows.slice(i, i + BATCH),
          mappedFields: Object.keys(ws.columns),
        });
        created += r.created;
        skipped += r.skipped;
        updated += r.updated;
      }
      const stats = {
        rows: plan.counts.rows,
        created,
        updated,
        skipped: skipped + plan.counts.skipped,
        existing: plan.counts.existing,
        duplicates: plan.counts.duplicates,
        errors: plan.counts.errors,
      };
      const label = target === "contacts" ? "Kontakte" : "Produkte";
      await ctx.runMutation(internal.imports.finishInternal, {
        actorContext,
        importId: args.importId,
        stats,
        log: [
          `${label}: ${created} angelegt, ${updated} aktualisiert, ${stats.skipped} bereits importiert, ${stats.existing} vorhanden, ${stats.duplicates} doppelt, ${stats.errors} fehlerhaft (Vorlage ${preset})`,
        ],
        today: berlinCalendarDate(Date.now()),
      });
      return { status: "done", created, skipped: stats.skipped, updated };
    } catch (e) {
      const message = (e as { data?: { message?: string } }).data?.message ?? String(e);
      await ctx.runMutation(internal.imports.failInternal, { actorContext, importId: args.importId, message });
      throw e;
    }
  },
});
