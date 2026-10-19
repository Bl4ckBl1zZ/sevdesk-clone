import { normalizeContactNumber } from "../../src/domain/contacts/core";
import {
  checkGenericMapping,
  GENERIC_CSV_IMPORTER_VERSION,
  GENERIC_EXTERNAL_TYPES,
  GENERIC_TARGET_LABELS,
  type GenericLocalState,
  type GenericLookupKeys,
  type GenericTarget,
} from "../../src/domain/import/generic/csv-import";
import { applyPreset, autoMap, type ColumnMapping } from "../../src/domain/import/sevdesk/mapping";
import { normalizeNumber } from "../../src/domain/numbering/format";
import { contactCreateSchema } from "../../src/domain/schemas/contacts";
import { productSchema } from "../../src/domain/schemas/products";
import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { parse } from "../lib/parse";
import { auditedInsert } from "./audit";
import { createContact } from "./contacts";
import { assertEditable, type ImportRow, patchWorkspace, requireImport, requireRunning } from "./imports";
import { createProduct, ensureCategoryPath } from "./products";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Generic CSV import projects for contacts and products (F09 IMP-012). Same `imports` lifecycle as the sevdesk
 * import (IMP-023: uploaded → previewed → running → done/failed, discard before the commit): the project holds one
 * CSV file whose `kind` is the target (`contacts` | `products`), its mapping (with the preset name) and the stored
 * preview. The commit creates the new rows through the normal contact/product model (same validation as the API)
 * and records each in `importedRecords` with externalId = SHA-256(preset, key column value), so a re-import skips.
 */

const SOURCE = "generic_csv" as const;

export async function requireGenericImport(ctx: ReadCtx, importId: Id<"imports">): Promise<ImportRow> {
  const row = await requireImport(ctx, importId);
  if (row.source !== SOURCE) {
    throw appError("invalid_input", "Dieser Import ist kein CSV-Import für Kontakte oder Produkte.");
  }
  return row;
}

export const genericTargetOf = (row: ImportRow): GenericTarget | null => {
  const kind = row.files[0]?.kind;
  return kind === "contacts" || kind === "products" ? kind : null;
};

export async function createGenericImport(ctx: ModelCtx): Promise<Id<"imports">> {
  return auditedInsert(
    ctx,
    "imports",
    {
      source: SOURCE,
      files: [],
      status: "uploaded",
      revision: 0,
      stats: {},
      log: [],
      importerVersion: GENERIC_CSV_IMPORTER_VERSION,
      startedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "import.create", label: "CSV-Import" },
  );
}

/** IMP-017 model: the newest saved preset of the target that maps every required field, else the automatic mapping. */
async function initialMapping(
  ctx: ReadCtx,
  target: GenericTarget,
  headers: readonly string[],
): Promise<{ columns: ColumnMapping; preset?: string }> {
  const presets = await ctx.db
    .query("importMappingPresets")
    .withIndex("by_kind", (q) => q.eq("source", SOURCE).eq("fileKind", target))
    .collect();
  for (const p of presets.sort((a, b) => b.createdAt - a.createdAt)) {
    const applied = applyPreset(headers, p.columns);
    if (checkGenericMapping(target, headers, applied).missing.length === 0) return { columns: applied, preset: p.name };
  }
  return { columns: autoMap(target, headers) };
}

export interface GenericFileInput {
  storageId: Id<"_storage">;
  sha256: string;
  bytes: number;
  mime: string;
  name: string;
  target: GenericTarget;
  encoding: string;
  delimiter: string;
  headers: string[];
  samples: string[][];
  rows: number;
}

/** One CSV per project: a new upload replaces the previous file (its blob is deleted; nothing was imported yet). */
export async function setGenericFile(ctx: ModelCtx, importId: Id<"imports">, f: GenericFileInput): Promise<void> {
  const row = await requireGenericImport(ctx, importId);
  assertEditable(row);
  const { columns, preset } = await initialMapping(ctx, f.target, f.headers);
  const file = {
    id: "f1",
    storageId: f.storageId,
    sha256: f.sha256,
    bytes: f.bytes,
    mime: f.mime,
    name: f.name.slice(0, 255),
    detectedKind: f.target,
    kind: f.target,
    encoding: f.encoding,
    delimiter: f.delimiter,
    headers: f.headers,
    samples: f.samples,
    rows: f.rows,
  };
  await patchWorkspace(
    ctx,
    row,
    { files: [file], mapping: { f1: { columns: { ...columns }, ...(preset ? { preset } : {}) } } },
    "import.files",
    `${file.name} (${GENERIC_TARGET_LABELS[f.target]})`,
  );
  for (const old of row.files) if (old.storageId !== f.storageId) await ctx.storage.delete(old.storageId);
}

/** Switch between Kontakte and Produkte (re-maps the headers). */
export async function setGenericTarget(ctx: ModelCtx, importId: Id<"imports">, target: GenericTarget): Promise<void> {
  const row = await requireGenericImport(ctx, importId);
  assertEditable(row);
  const file = row.files[0];
  if (!file) throw appError("invalid_input", "Bitte zuerst eine CSV-Datei hochladen.");
  if (file.kind === target) return;
  const { columns, preset } = await initialMapping(ctx, target, file.headers ?? []);
  await patchWorkspace(
    ctx,
    row,
    {
      files: [{ ...file, kind: target }],
      mapping: { [file.id]: { columns: { ...columns }, ...(preset ? { preset } : {}) } },
    },
    "import.files",
    `${file.name} (${GENERIC_TARGET_LABELS[target]})`,
  );
}

/** Column mapping (target field → header) with optional „Als Vorlage speichern“ (importMappingPresets). */
export async function setGenericMapping(
  ctx: ModelCtx,
  importId: Id<"imports">,
  input: { columns: Record<string, string>; preset?: string; savePreset?: boolean },
): Promise<void> {
  const row = await requireGenericImport(ctx, importId);
  assertEditable(row);
  const file = row.files[0];
  const target = genericTargetOf(row);
  if (!file || !target) throw appError("invalid_input", "Bitte zuerst eine CSV-Datei hochladen.");
  const columns = Object.fromEntries(Object.entries(input.columns).filter(([, h]) => h !== ""));
  for (const header of Object.values(columns)) {
    if (!(file.headers ?? []).includes(header)) {
      throw appError("invalid_input", `Die Spalte „${header}“ gibt es in ${file.name} nicht.`);
    }
  }
  const preset = input.preset?.trim().slice(0, 80) || undefined;
  if (input.savePreset && !preset) throw appError("invalid_input", "Bitte einen Namen für die Vorlage angeben.");
  await patchWorkspace(
    ctx,
    row,
    { mapping: { [file.id]: { columns, ...(preset ? { preset } : {}) } } },
    "import.mapping",
    file.name,
  );
  if (input.savePreset && preset) {
    await auditedInsert(
      ctx,
      "importMappingPresets",
      {
        source: SOURCE,
        fileKind: target,
        name: preset,
        columns,
        shipped: false,
        unsure: false,
        createdAt: ctx.now(),
        actor: ctx.actor,
      },
      { action: "import.preset", label: preset },
    );
  }
}

async function contactIdByNumber(ctx: ReadCtx, n: string) {
  return (
    await ctx.db
      .query("contacts")
      .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeContactNumber(n)))
      .first()
  )?._id;
}
async function contactIdByVatId(ctx: ReadCtx, vatId: string) {
  return (
    await ctx.db
      .query("contacts")
      .withIndex("by_vatId", (q) => q.eq("vatId", vatId))
      .first()
  )?._id;
}
async function contactIdByEmail(ctx: ReadCtx, email: string) {
  for (const value of new Set([email, email.toLowerCase()])) {
    const ch = await ctx.db
      .query("contactChannels")
      .withIndex("by_type_value", (q) => q.eq("type", "email").eq("value", value))
      .first();
    if (ch) return ch.contactId;
  }
  return undefined;
}
async function productIdByNumber(ctx: ReadCtx, n: string) {
  return (
    await ctx.db
      .query("products")
      .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeNumber(n)))
      .first()
  )?._id;
}

/** The local data the preview depends on (read-only). */
export async function genericLocalState(
  ctx: ReadCtx,
  target: GenericTarget,
  keys: GenericLookupKeys,
): Promise<GenericLocalState> {
  const imported: Record<string, string> = {};
  for (const k of keys.idempotencyKeys) {
    const hit = await ctx.db
      .query("importedRecords")
      .withIndex("by_external", (q) => q.eq("externalType", GENERIC_EXTERNAL_TYPES[target]).eq("externalId", k))
      .first();
    if (hit) imported[k] = hit.localId;
  }
  const collect = async (values: readonly string[], find: (v: string) => Promise<string | undefined>) => {
    const out: Record<string, string> = {};
    for (const value of values) {
      const id = await find(value);
      if (id) out[value] = id;
    }
    return out;
  };
  if (target === "products") {
    return {
      imported,
      contactsByNumber: {},
      contactsByEmail: {},
      contactsByVatId: {},
      productsByNumber: await collect(keys.numbers, (n) => productIdByNumber(ctx, n)),
    };
  }
  return {
    imported,
    contactsByNumber: await collect(keys.numbers, (n) => contactIdByNumber(ctx, n)),
    contactsByEmail: await collect(keys.emails, (e) => contactIdByEmail(ctx, e)),
    contactsByVatId: await collect(keys.vatIds, (v) => contactIdByVatId(ctx, v)),
    productsByNumber: {},
  };
}

export interface GenericCommitRow {
  line: number;
  idempotencyKey: string;
  keyValue: string;
  number?: string;
  email?: string;
  vatId?: string;
  values: unknown;
  categoryPath?: string;
}

/** IMP-014/IMP-008: imported audit entries name the source, the importer version, the import and the preset. */
export const genericAuditReason = (importId: Id<"imports">, preset: string): string =>
  `CSV-Import, ${GENERIC_CSV_IMPORTER_VERSION}, Import ${importId}, Vorlage ${preset}`;

/**
 * One commit batch. Each row is re-checked inside the transaction: an existing idempotency key (IMP-006) or a
 * contact/product created meanwhile with the same number / USt-IdNr / e-mail is skipped, never duplicated.
 */
export async function commitGenericRows(
  ctx: ModelCtx,
  importId: Id<"imports">,
  input: { target: GenericTarget; preset: string; rows: readonly GenericCommitRow[] },
): Promise<{ created: number; skipped: number }> {
  const row = await requireRunning(ctx, importId);
  if (row.source !== SOURCE) throw appError("invalid_input", "Dieser Import ist kein CSV-Import.");
  const externalType = GENERIC_EXTERNAL_TYPES[input.target];
  let created = 0;
  let skipped = 0;
  for (const r of input.rows) {
    const done = await ctx.db
      .query("importedRecords")
      .withIndex("by_external", (q) => q.eq("externalType", externalType).eq("externalId", r.idempotencyKey))
      .first();
    if (done) {
      skipped++;
      continue;
    }
    let localId: string;
    if (input.target === "contacts") {
      const existing =
        (r.number ? await contactIdByNumber(ctx, r.number) : undefined) ??
        (r.vatId ? await contactIdByVatId(ctx, r.vatId) : undefined) ??
        (r.email ? await contactIdByEmail(ctx, r.email) : undefined);
      if (existing) {
        skipped++;
        continue;
      }
      localId = (await createContact(ctx, parse(contactCreateSchema, r.values))).id;
    } else {
      if (r.number && (await productIdByNumber(ctx, r.number))) {
        skipped++;
        continue;
      }
      const categoryId = r.categoryPath ? await ensureCategoryPath(ctx, r.categoryPath) : undefined;
      const form = { ...(r.values as Record<string, unknown>), categoryId: categoryId ?? "" };
      localId = (await createProduct(ctx, parse(productSchema, form))).id;
    }
    await auditedInsert(
      ctx,
      "importedRecords",
      {
        importId,
        externalType,
        externalId: r.idempotencyKey,
        table: input.target,
        localId,
      },
      {
        action: "import.record",
        label: `${externalType} ${r.keyValue} (Zeile ${r.line})`,
        reason: genericAuditReason(importId, input.preset),
      },
    );
    created++;
  }
  return { created, skipped };
}
