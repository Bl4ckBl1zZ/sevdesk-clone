import { foldSearch, normalizeContactNumber } from "../../src/domain/contacts/core";
import { retentionUntil } from "../../src/domain/documents/finalize";
import { openVatSplit } from "../../src/domain/import/sevdesk/invoices";
import {
  applyPreset,
  autoMap,
  type ColumnMapping,
  checkMapping,
  isMappedCsvKind,
} from "../../src/domain/import/sevdesk/mapping";
import {
  EXTERNAL_TYPES,
  type LocalImportState,
  type LookupKeys,
  SEVDESK_IMPORTER_VERSION,
} from "../../src/domain/import/sevdesk/preview";
import type { ImportedDocType } from "../../src/domain/import/sevdesk/types";
import { normalizeNumber, type YearMonth } from "../../src/domain/numbering/format";
import { contactCreateSchema, emptyAddress, emptyContactForm } from "../../src/domain/schemas/contacts";
import { productSchema } from "../../src/domain/schemas/products";
import type { TaxCase } from "../../src/domain/tax/tax-case";
import type { VatCategory } from "../../src/domain/tax/vat-category";
import { addDays, type CalendarDate, daysBetween } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { parse } from "../lib/parse";
import { type OpeningReceivableInput, openingContextForImport, postOpeningBalance } from "./accounting";
import { appendAudit, auditedInsert, auditedPatch } from "./audit";
import { createContact } from "./contacts";
import { continueRangeAfterImport, listDefaultRanges, nextValue } from "./numberRanges";
import { createProduct, ensureCategoryPath } from "./products";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * sevdesk export import projects (F09 IMP-003…024, §4.3.4). The project row is a mutable workspace until the commit
 * (files, mapping, resolutions, preview); every change invalidates the preview. The commit writes archived
 * historic documents (read-only from insert: status sent/cancelled, `imported`, `origin`, `lockedAt`, original PDF
 * as artifact, imported number in the register) plus `importedRecords` for idempotent re-runs, all audited with the
 * committing actor on channel `import` (IMP-014). Parsing and the preview plan are pure (src/domain/import/sevdesk).
 */

export type ImportRow = Doc<"imports">;
export type ImportFileRow = ImportRow["files"][number];

const SOURCE = "sevdesk_export" as const;
const EDITABLE = new Set<ImportRow["status"]>(["uploaded", "previewed"]);

export const IMPORT_MESSAGES = {
  committed: "Der Import wurde bereits übernommen und kann nicht verworfen werden.",
  discarded: "Dieser Import wurde verworfen.",
  stale: "Die Vorschau ist veraltet. Bitte Vorschau neu erstellen.",
  running: "Der Import läuft bereits.",
  noBookkeepingStart:
    "Offene Posten werden in die Eröffnungsbilanz übernommen – bitte zuerst den Buchungsbeginn festlegen.",
  receivablesPosted: (year: number) =>
    `Für ${year} sind bereits offene Forderungen in der Eröffnungsbilanz erfasst. Bitte dort stornieren oder die offenen Rechnungen vom Import ausschließen.`,
} as const;

export async function requireImport(ctx: ReadCtx, importId: Id<"imports">): Promise<ImportRow> {
  const row = await ctx.db.get(importId);
  if (!row) throw appError("not_found", "Der Import existiert nicht.");
  return row;
}

function assertEditable(row: ImportRow): void {
  if (EDITABLE.has(row.status)) return;
  if (row.status === "discarded") throw appError("conflict", IMPORT_MESSAGES.discarded, { reason: "IMPORT_DISCARDED" });
  // E-IMP-28
  throw appError("conflict", IMPORT_MESSAGES.committed, { reason: "IMPORT_COMMITTED" });
}

/** Every workspace change invalidates the preview (§4.3.4 „files/mapping changed (preview invalidated)“). */
async function patchWorkspace(
  ctx: ModelCtx,
  row: ImportRow,
  patch: Partial<Pick<ImportRow, "files" | "mapping" | "resolutions">>,
  action: string,
  label: string,
): Promise<void> {
  await auditedPatch(
    ctx,
    "imports",
    row._id,
    { ...patch, status: "uploaded", revision: row.revision + 1, previewHash: undefined, preview: undefined },
    { action, label },
  );
}

// ── project lifecycle ───────────────────────────────────────────────────────────────────────────────────

export async function createImport(ctx: ModelCtx): Promise<Id<"imports">> {
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
      importerVersion: SEVDESK_IMPORTER_VERSION,
      startedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "import.create", label: "sevdesk-Export" },
  );
}

export interface NewImportFile {
  storageId: Id<"_storage">;
  sha256: string;
  bytes: number;
  mime: string;
  name: string;
  kind: string;
  encoding?: string;
  delimiter?: string;
  headers?: string[];
  samples?: string[][];
  rows?: number;
  readError?: string;
}

/** IMP-016 total upload limit per import (2 GB). */
const TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** IMP-017: the latest saved preset of the kind wins when it maps every required field, else the shipped preset. */
async function initialMapping(ctx: ReadCtx, kind: string, headers: readonly string[]): Promise<ColumnMapping | null> {
  if (!isMappedCsvKind(kind)) return null;
  const presets = await ctx.db
    .query("importMappingPresets")
    .withIndex("by_kind", (q) => q.eq("source", SOURCE).eq("fileKind", kind))
    .collect();
  for (const p of presets.sort((a, b) => b.createdAt - a.createdAt)) {
    const applied = applyPreset(headers, p.columns);
    if (checkMapping(kind, headers, applied).missing.length === 0) return applied;
  }
  return autoMap(kind, headers);
}

export async function addImportFiles(
  ctx: ModelCtx,
  importId: Id<"imports">,
  files: readonly NewImportFile[],
): Promise<{ added: string[]; duplicates: string[] }> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  const all = [...row.files];
  const mapping = { ...(row.mapping ?? {}) };
  let next = Math.max(0, ...all.map((f) => Number(f.id.slice(1)) || 0)) + 1;
  const added: string[] = [];
  const duplicates: string[] = [];
  for (const f of files) {
    // §4.3.5 step 4: identical bytes under several names count as one file.
    if (all.some((x) => x.sha256 === f.sha256)) {
      duplicates.push(f.name);
      await ctx.storage.delete(f.storageId);
      continue;
    }
    const id = `f${next++}`;
    all.push({
      id,
      storageId: f.storageId,
      sha256: f.sha256,
      bytes: f.bytes,
      mime: f.mime,
      name: f.name,
      detectedKind: f.kind,
      kind: f.kind,
      ...(f.encoding ? { encoding: f.encoding } : {}),
      ...(f.delimiter ? { delimiter: f.delimiter } : {}),
      ...(f.headers ? { headers: f.headers } : {}),
      ...(f.samples ? { samples: f.samples } : {}),
      ...(f.rows !== undefined ? { rows: f.rows } : {}),
      ...(f.readError ? { readError: f.readError } : {}),
    });
    const initial = await initialMapping(ctx, f.kind, f.headers ?? []);
    if (initial) mapping[id] = { columns: { ...initial } };
    added.push(id);
  }
  if (all.reduce((s, f) => s + f.bytes, 0) > TOTAL_MAX_BYTES) {
    throw appError("invalid_input", "Die Dateien eines Imports dürfen zusammen höchstens 2 GB groß sein.");
  }
  if (added.length > 0) {
    await patchWorkspace(ctx, row, { files: all, mapping }, "import.files", `${added.length} Dateien`);
  }
  return { added, duplicates };
}

/** IMP-016: correct the detected kind or ignore a file (E-IMP-20). */
export async function updateImportFile(
  ctx: ModelCtx,
  importId: Id<"imports">,
  fileId: string,
  patch: { kind?: string; ignored?: boolean },
): Promise<void> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  const file = row.files.find((f) => f.id === fileId);
  if (!file) throw appError("not_found", "Die Datei gehört nicht zu diesem Import.");
  const mapping = { ...(row.mapping ?? {}) };
  const kind = patch.kind ?? file.kind;
  if (patch.kind && patch.kind !== file.kind) {
    delete mapping[fileId];
    const initial = await initialMapping(ctx, patch.kind, file.headers ?? []);
    if (initial) mapping[fileId] = { columns: { ...initial } };
  }
  const files = row.files.map((f) =>
    f.id === fileId ? { ...f, kind, ...(patch.ignored !== undefined ? { ignored: patch.ignored } : {}) } : f,
  );
  await patchWorkspace(ctx, row, { files, mapping }, "import.files", file.name);
}

/** Removing a file is allowed only before the commit (§7 DELETE /imports/{id}/files/{fileId}). */
export async function removeImportFile(ctx: ModelCtx, importId: Id<"imports">, fileId: string): Promise<void> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  const file = row.files.find((f) => f.id === fileId);
  if (!file) throw appError("not_found", "Die Datei gehört nicht zu diesem Import.");
  const { [fileId]: _removed, ...mapping } = row.mapping ?? {};
  await patchWorkspace(
    ctx,
    row,
    { files: row.files.filter((f) => f.id !== fileId), mapping },
    "import.files",
    file.name,
  );
  await ctx.storage.delete(file.storageId);
}

export async function setImportMapping(
  ctx: ModelCtx,
  importId: Id<"imports">,
  fileId: string,
  value: { columns: Record<string, string>; numberFormat?: "de" | "en"; dateFormat?: "dmy" | "mdy" },
  savePresetAs?: string,
): Promise<void> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  const file = row.files.find((f) => f.id === fileId);
  if (!file) throw appError("not_found", "Die Datei gehört nicht zu diesem Import.");
  const columns = Object.fromEntries(Object.entries(value.columns).filter(([, h]) => h !== ""));
  for (const header of Object.values(columns)) {
    if (!(file.headers ?? []).includes(header)) {
      throw appError("invalid_input", `Die Spalte „${header}“ gibt es in ${file.name} nicht.`);
    }
  }
  await patchWorkspace(
    ctx,
    row,
    { mapping: { ...(row.mapping ?? {}), [fileId]: { ...value, columns } } },
    "import.mapping",
    file.name,
  );
  const name = savePresetAs?.trim();
  if (name) {
    // IMP-017 „Zuordnung speichern“: reused by later import projects of the same file kind.
    await auditedInsert(
      ctx,
      "importMappingPresets",
      {
        source: SOURCE,
        fileKind: file.kind,
        name: name.slice(0, 80),
        columns,
        shipped: false,
        unsure: false,
        createdAt: ctx.now(),
        actor: ctx.actor,
      },
      { action: "import.preset", label: name },
    );
  }
}

export interface ImportResolutionsInput {
  excluded?: string[];
  pdfAssignments?: Record<string, string>;
  openAmounts?: Record<string, number>;
}

/** PUT /imports/{id}/resolutions: PDF assignments, excluded rows, entered open amounts (invalidates the preview). */
export async function setImportResolutions(
  ctx: ModelCtx,
  importId: Id<"imports">,
  resolutions: ImportResolutionsInput,
): Promise<void> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  for (const cents of Object.values(resolutions.openAmounts ?? {})) {
    if (!Number.isSafeInteger(cents) || cents < 0)
      throw appError("invalid_input", "Offene Beträge in ganzen Cent ≥ 0.");
  }
  for (const fileId of Object.values(resolutions.pdfAssignments ?? {})) {
    if (!row.files.some((f) => f.id === fileId && f.kind === "pdf")) {
      throw appError("invalid_input", "Bitte eine hochgeladene PDF-Datei zuordnen.");
    }
  }
  await patchWorkspace(ctx, row, { resolutions }, "import.resolutions", "Auflösungen");
}

/** IMP-009: store the preview computed for `revision` (a concurrent change makes it stale on arrival). */
export async function saveImportPreview(
  ctx: ModelCtx,
  importId: Id<"imports">,
  input: { revision: number; previewHash: string; preview: unknown },
): Promise<void> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  if (row.revision !== input.revision) throw appError("conflict", IMPORT_MESSAGES.stale, { reason: "PREVIEW_STALE" });
  await auditedPatch(
    ctx,
    "imports",
    importId,
    { status: "previewed", previewHash: input.previewHash, preview: input.preview },
    { action: "import.preview", label: input.previewHash.slice(0, 12) },
  );
}

/** IMP-023 discard (E-IMP-28 after the commit started): files and preview are removed; no business data exists. */
export async function discardImport(ctx: ModelCtx, importId: Id<"imports">): Promise<void> {
  const row = await requireImport(ctx, importId);
  assertEditable(row);
  await auditedPatch(
    ctx,
    "imports",
    importId,
    { status: "discarded", files: [], previewHash: undefined, preview: undefined, finishedAt: ctx.now() },
    { action: "import.discard", label: `${row.files.length} Dateien` },
  );
  for (const f of row.files) await ctx.storage.delete(f.storageId);
}

// ── local snapshot for the preview (read-only) ─────────────────────────────────────────────────────────

export async function importLocalState(ctx: ReadCtx, keys: LookupKeys, today: CalendarDate): Promise<LocalImportState> {
  const imported: Record<string, string> = {};
  for (const k of keys.imported) {
    const sep = k.indexOf("|");
    const hit = await ctx.db
      .query("importedRecords")
      .withIndex("by_external", (q) => q.eq("externalType", k.slice(0, sep)).eq("externalId", k.slice(sep + 1)))
      .first();
    if (hit) imported[k] = hit.localId;
  }
  const registerNumbers: Record<string, true> = {};
  const documentsByNumber: Record<string, { id: string; type: string }> = {};
  for (const n of new Set([...keys.registerNumbers, ...keys.documentNumbers])) {
    const hit = await ctx.db
      .query("numberRegister")
      .withIndex("by_normalized", (q) => q.eq("normalized", n))
      .first();
    if (!hit) continue;
    if (keys.registerNumbers.includes(n)) registerNumbers[n] = true;
    if (hit.documentId) {
      const id = ctx.db.normalizeId("salesDocuments", hit.documentId);
      const doc = id ? await ctx.db.get(id) : null;
      if (doc) documentsByNumber[n] = { id: doc._id, type: doc.type };
    }
  }
  const contactsByNumber: Record<string, { id: string; name: string; vatId?: string }> = {};
  for (const n of keys.contactNumbers) {
    const c = await ctx.db
      .query("contacts")
      .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeContactNumber(n)))
      .first();
    if (c) contactsByNumber[n] = { id: c._id, name: c.displayName, ...(c.vatId ? { vatId: c.vatId } : {}) };
  }
  const contactsByName: Record<string, string[]> = {};
  if (keys.contactNames.length > 0) {
    const wanted = new Set(keys.contactNames);
    for (const c of await ctx.db.query("contacts").collect()) {
      const n = foldSearch(c.displayName);
      if (wanted.has(n) && c.status !== "archived") contactsByName[n] = [...(contactsByName[n] ?? []), c._id];
    }
  }
  const productsByNumber: Record<string, string> = {};
  for (const n of keys.productNumbers) {
    const p = await ctx.db
      .query("products")
      .withIndex("by_number", (q) => q.eq("numberNormalized", n))
      .first();
    if (p) productsByNumber[n] = p._id;
  }
  const ym: YearMonth = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const ranges: LocalImportState["ranges"][number][] = [];
  for (const r of await listDefaultRanges(ctx)) {
    const key = r.docTypes[0];
    if (key !== "invoice" && key !== "correction") continue;
    ranges.push({ rangeKey: key, format: r.format, resetPolicy: r.resetPolicy, next: await nextValue(ctx, r, ym) });
  }
  return {
    today,
    imported,
    registerNumbers,
    contactsByNumber,
    contactsByName,
    productsByNumber,
    documentsByNumber,
    ranges,
    opening: await openingContextForImport(ctx),
  };
}

// ── commit (IMP-023, §4.3.4: batches, resumable) ───────────────────────────────────────────────────────

export interface CommitDecisions {
  numberRanges: { rangeKey: string; format: string; resetPolicy: "never" | "yearly" | "monthly"; next: number }[];
  missingPdfReason?: string;
}

/** previewed → running (only with the current preview hash, E-IMP-27); failed → running resumes. */
export async function beginImportCommit(
  ctx: ModelCtx,
  importId: Id<"imports">,
  input: { previewHash: string; revision: number; decisions: CommitDecisions },
): Promise<void> {
  const row = await requireImport(ctx, importId);
  if (row.status === "running") throw appError("conflict", IMPORT_MESSAGES.running, { reason: "IMPORT_RUNNING" });
  if (row.status === "failed") {
    await auditedPatch(
      ctx,
      "imports",
      importId,
      { status: "running", error: undefined },
      {
        action: "import.commit",
        label: "Fortsetzen",
      },
    );
    return;
  }
  if (row.status !== "previewed" || row.previewHash !== input.previewHash || row.revision !== input.revision) {
    if (row.status === "done" || row.status === "discarded") assertEditable(row);
    throw appError("conflict", IMPORT_MESSAGES.stale, { reason: "PREVIEW_STALE" });
  }
  await auditedPatch(
    ctx,
    "imports",
    importId,
    { status: "running", decisions: input.decisions, committedBy: ctx.actor },
    { action: "import.commit", label: input.previewHash.slice(0, 12) },
  );
}

async function requireRunning(ctx: ReadCtx, importId: Id<"imports">): Promise<ImportRow> {
  const row = await requireImport(ctx, importId);
  if (row.status !== "running") throw appError("conflict", "Der Import läuft nicht.", { reason: "IMPORT_NOT_RUNNING" });
  return row;
}

async function importedRecord(ctx: ReadCtx, externalType: string, externalId: string) {
  return ctx.db
    .query("importedRecords")
    .withIndex("by_external", (q) => q.eq("externalType", externalType).eq("externalId", externalId))
    .first();
}

async function recordImported(
  ctx: ModelCtx,
  importId: Id<"imports">,
  externalType: string,
  externalId: string,
  table: string,
  localId: string,
): Promise<void> {
  await auditedInsert(
    ctx,
    "importedRecords",
    { importId, externalType, externalId, table, localId },
    {
      action: "import.record",
      label: `${externalType} ${externalId}`,
      reason: importAuditReason(importId),
    },
  );
}

/** IMP-008: imported audit entries name the source and the importer version. */
export const importAuditReason = (importId: Id<"imports">): string =>
  `sevdesk-Export, ${SEVDESK_IMPORTER_VERSION}, Import ${importId}`;

export async function commitImportContacts(
  ctx: ModelCtx,
  importId: Id<"imports">,
  contacts: readonly { key: string; values: unknown }[],
  minimal: readonly { key: string; name: string; customerNumber?: string }[],
): Promise<{ created: number; skipped: number }> {
  await requireRunning(ctx, importId);
  let created = 0;
  let skipped = 0;
  for (const c of contacts) {
    if (await importedRecord(ctx, EXTERNAL_TYPES.contact, c.key)) {
      skipped++;
      continue;
    }
    const r = await createContact(ctx, parse(contactCreateSchema, c.values));
    await recordImported(ctx, importId, EXTERNAL_TYPES.contact, c.key, "contacts", r.id);
    created++;
  }
  for (const m of minimal) {
    if (await importedRecord(ctx, EXTERNAL_TYPES.contact, m.key)) {
      skipped++;
      continue;
    }
    const numberFree =
      m.customerNumber &&
      !(await ctx.db
        .query("contacts")
        .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeContactNumber(m.customerNumber as string)))
        .first());
    // E-IMP-25: minimal contact from the row data, flagged „aus Import – unvollständig“.
    const values = parse(contactCreateSchema, {
      contact: {
        ...emptyContactForm(),
        kind: "organization",
        organizationName: m.name,
        number: numberFree ? m.customerNumber : "",
        roles: ["customer"],
        notes: "Aus sevdesk-Import – unvollständig (Kontakt fehlte im Kontakte-Export).",
      },
      billingAddress: { ...emptyAddress(), name: m.name },
      channels: [],
    });
    const r = await createContact(ctx, values);
    await recordImported(ctx, importId, EXTERNAL_TYPES.contact, m.key, "contacts", r.id);
    created++;
  }
  return { created, skipped };
}

export async function commitImportProducts(
  ctx: ModelCtx,
  importId: Id<"imports">,
  products: readonly { key: string; form: Record<string, unknown>; categoryPath: string }[],
): Promise<{ created: number; skipped: number }> {
  await requireRunning(ctx, importId);
  let created = 0;
  let skipped = 0;
  for (const p of products) {
    if (await importedRecord(ctx, EXTERNAL_TYPES.product, p.key)) {
      skipped++;
      continue;
    }
    const categoryId = await ensureCategoryPath(ctx, p.categoryPath);
    const r = await createProduct(ctx, parse(productSchema, { ...p.form, categoryId: categoryId ?? "" }));
    await recordImported(ctx, importId, EXTERNAL_TYPES.product, p.key, "products", r.id);
    created++;
  }
  return { created, skipped };
}

export interface ImportedDocumentPayload {
  key: string;
  type: ImportedDocType;
  number: string;
  documentDate: string;
  supplyDate?: string;
  dueDate?: string;
  sentOn: string;
  sentOnAssumed: boolean;
  customerName: string;
  currency: string;
  taxCase: TaxCase;
  groups: { category: VatCategory; rateBp: number; netCents: number; vatCents: number; grossCents: number }[];
  totals: { netCents: number; vatCents: number; grossCents: number };
  finalStatus: "sent" | "cancelled";
  paymentStatus?: "open" | "partially_paid" | "paid";
  openAmountCents?: number;
  contact: { kind: "import" | "minimal"; key: string } | { kind: "local"; id: string };
  correctsKey?: string;
  correctsLocalId?: string;
  pdfFileId?: string;
  deviations: string[];
}

const SUMMARY_LINE = "Positionen siehe Original-PDF";

/**
 * IMP-003/IMP-004/IMP-020: one archived document per payload — read-only from insert (status sent/cancelled),
 * summary lines per VAT rate, imported number in the register, original PDF archived byte-identical. Never
 * rendered, no snapshot, no journal posting (Buchungsbeginn is after the history; F08 refuses `unknown_imported`).
 */
export async function commitImportDocuments(
  ctx: ModelCtx,
  importId: Id<"imports">,
  docs: readonly ImportedDocumentPayload[],
): Promise<{ created: number; skipped: number }> {
  const row = await requireRunning(ctx, importId);
  let created = 0;
  let skipped = 0;
  const now = ctx.now();
  for (const d of docs) {
    if (await importedRecord(ctx, EXTERNAL_TYPES.document, d.key)) {
      skipped++;
      continue;
    }
    const normalized = normalizeNumber(d.number);
    // IMP-004 / E-IMP-06: authoritative re-check in the writing transaction (the preview hash is the cheap gate).
    if (
      await ctx.db
        .query("numberRegister")
        .withIndex("by_normalized", (q) => q.eq("normalized", normalized))
        .first()
    ) {
      throw appError("conflict", `Rechnungsnummer ${d.number} existiert bereits. Bitte Nummernkreise prüfen.`, {
        reason: "E_IMP_06",
      });
    }
    let contactId: Id<"contacts"> | undefined;
    if (d.contact.kind === "local") contactId = ctx.db.normalizeId("contacts", d.contact.id) ?? undefined;
    else {
      const rec = await importedRecord(ctx, EXTERNAL_TYPES.contact, d.contact.key);
      contactId = rec ? (ctx.db.normalizeId("contacts", rec.localId) ?? undefined) : undefined;
    }
    const contact = contactId ? await ctx.db.get(contactId) : null;
    if (!contact)
      throw appError("conflict", `${d.number}: Kontakt nicht gefunden.`, { reason: "IMPORT_CONTACT_MISSING" });
    let correctsId: Id<"salesDocuments"> | undefined;
    if (d.correctsKey) {
      const rec = await importedRecord(ctx, EXTERNAL_TYPES.document, d.correctsKey);
      correctsId = rec ? (ctx.db.normalizeId("salesDocuments", rec.localId) ?? undefined) : undefined;
    } else if (d.correctsLocalId) correctsId = ctx.db.normalizeId("salesDocuments", d.correctsLocalId) ?? undefined;
    const file = d.pdfFileId ? row.files.find((f) => f.id === d.pdfFileId && f.kind === "pdf") : undefined;
    if (d.pdfFileId && !file) throw appError("conflict", `${d.number}: Original-PDF nicht gefunden.`);
    const retention = retentionUntil(d.type, d.documentDate);
    const documentDate = d.documentDate as CalendarDate;
    const isOpen = (d.openAmountCents ?? 0) > 0;
    const notes = [
      "Importiert aus sevdesk-Export · archiviert.",
      ...(file ? [] : ["Original-PDF fehlt."]),
      ...(d.sentOnAssumed ? ["Versanddatum = Rechnungsdatum (Import-Annahme)."] : []),
      ...d.deviations.filter((x) => x !== "Original-PDF fehlt."),
    ].join(" ");
    const docId = await auditedInsert(
      ctx,
      "salesDocuments",
      {
        type: d.type,
        status: d.finalStatus,
        ...(d.paymentStatus ? { paymentStatus: d.paymentStatus } : {}),
        number: d.number,
        contactId: contact._id,
        contactName: d.customerName || contact.displayName,
        documentDate: d.documentDate,
        ...(d.supplyDate ? { supplyDate: { kind: "date" as const, date: d.supplyDate } } : {}),
        supplyDateMode: "explicit",
        ...(d.dueDate ? { dueDate: d.dueDate } : {}),
        currency: d.currency,
        priceMode: "net",
        taxCase: d.taxCase,
        paymentTerms: { dueDays: d.dueDate ? Math.max(0, daysBetween(documentDate, d.dueDate as CalendarDate)) : 0 },
        showEpcQr: false,
        language: "de",
        einvoice: {},
        totals: {
          netCents: d.totals.netCents,
          vatCents: d.totals.vatCents,
          grossCents: d.totals.grossCents,
          advancesDeductedGrossCents: 0,
          payableCents: d.totals.grossCents,
          byGroup: d.groups.map((g) => ({
            category: g.category,
            rateBp: g.rateBp,
            netCents: g.netCents,
            vatCents: g.vatCents,
          })),
        },
        ...(d.openAmountCents !== undefined ? { openAmountCents: d.openAmountCents } : {}),
        // §4.3.3: conservative receipt assumption for open items (unproven channel): sentOn + 3 days, basis manual.
        ...(isOpen
          ? {
              zugang: {
                date: addDays(d.sentOn as CalendarDate, 3),
                basis: "manual" as const,
                reason: "Import-Annahme: Versanddatum + 3 Tage (F09 §4.3.3)",
              },
            }
          : {}),
        ...(file ? { artifactStatus: "ready" as const } : {}),
        finalizedAt: now,
        finalizedBy: ctx.actor,
        sentAt: now,
        sentOn: d.sentOn,
        lockedAt: now,
        retentionClass: "vouchers8",
        retentionUntil: retention,
        tags: [],
        customFields: {},
        internalNote: notes,
        ...(correctsId ? { correctsId } : {}),
        ...(d.type === "correction" ? { correctionKind: "credit" as const } : {}),
        ...(d.finalStatus === "cancelled"
          ? { cancellation: { at: now, reason: "Storniert (laut sevdesk-Export)" } }
          : {}),
        imported: true,
        origin: { source: SOURCE, externalId: d.key, importId },
        createdBy: ctx.actor,
        channel: ctx.actorContext.channel,
        version: 1,
      },
      { action: "document.import", label: d.number, reason: importAuditReason(importId) },
    );
    let position = 1;
    for (const g of d.groups) {
      await auditedInsert(
        ctx,
        "documentLines",
        {
          documentId: docId,
          position: position++,
          kind: "item",
          name: SUMMARY_LINE,
          description: `Summe ${String(g.rateBp / 100).replace(".", ",")} % laut sevdesk-Export`,
          quantityMilli: 1000,
          unitPriceMicros: g.netCents * 100,
          vatCategory: g.category,
          vatRateBp: g.rateBp,
          lineNetCents: g.netCents,
          fromSummary: true,
        },
        { action: "document.import", label: d.number, reason: importAuditReason(importId) },
      );
    }
    await auditedInsert(
      ctx,
      "numberRegister",
      {
        number: d.number,
        normalized,
        docType: d.type,
        documentId: docId,
        assignedAt: now,
        status: d.finalStatus === "cancelled" ? "cancelled_by_storno" : "issued",
        imported: true,
      },
      { action: "document.import", label: d.number, reason: importAuditReason(importId) },
    );
    if (file) {
      const artifactId = await auditedInsert(
        ctx,
        "documentArtifacts",
        {
          documentId: docId,
          kind: "pdf",
          variant: "original",
          storageId: file.storageId,
          sha256: file.sha256,
          bytes: file.bytes,
          mime: "application/pdf",
          name: file.name,
          tool: { name: "sevdesk-import", version: SEVDESK_IMPORTER_VERSION },
          createdAt: now,
          retentionUntil: retention,
        },
        { action: "document.import", label: d.number, reason: importAuditReason(importId) },
      );
      await recordImported(ctx, importId, EXTERNAL_TYPES.file, file.sha256, "documentArtifacts", artifactId);
    }
    await recordImported(ctx, importId, EXTERNAL_TYPES.document, d.key, "salesDocuments", docId);
    created++;
  }
  return { created, skipped };
}

/**
 * IMP-007 / F08 ACC-013: the open invoices of this import become opening receivables (9000/9008; Ist: not-due VAT
 * per rate, pro rata by gross) through the F08 service, each linked to its archived document. Derived from the
 * documents the import created, so a resumed commit finds them too; once per import (marker in `importedRecords`).
 */
export async function commitImportOpeningItems(ctx: ModelCtx, importId: Id<"imports">): Promise<{ created: number }> {
  await requireRunning(ctx, importId);
  if (await importedRecord(ctx, EXTERNAL_TYPES.opening, importId)) return { created: 0 };
  const records = await ctx.db
    .query("importedRecords")
    .withIndex("by_import", (q) => q.eq("importId", importId))
    .collect();
  const open: Doc<"salesDocuments">[] = [];
  for (const r of records) {
    if (r.externalType !== EXTERNAL_TYPES.document) continue;
    const id = ctx.db.normalizeId("salesDocuments", r.localId);
    const doc = id ? await ctx.db.get(id) : null;
    if (doc?.imported && (doc.openAmountCents ?? 0) > 0) open.push(doc);
  }
  if (open.length === 0) return { created: 0 };
  // The preview blocked these cases (E-IMP-34/35); re-checked here because the profile may change until commit.
  const opening = await openingContextForImport(ctx);
  if (!opening) throw appError("conflict", IMPORT_MESSAGES.noBookkeepingStart, { reason: "E_IMP_34" });
  if (opening.receivablesPosted) {
    throw appError("conflict", IMPORT_MESSAGES.receivablesPosted(opening.fiscalYear), { reason: "E_IMP_35" });
  }
  const items: OpeningReceivableInput[] = open.map((doc) => {
    const openCents = doc.openAmountCents ?? 0;
    const notDueVat =
      opening.taxedAs === "ist" ? openVatSplit({ groups: doc.totals.byGroup, totals: doc.totals }, openCents) : [];
    return {
      number: doc.number ?? "",
      documentDate: doc.documentDate ?? "",
      ...(doc.dueDate ? { dueDate: doc.dueDate } : {}),
      counterpartyName: doc.contactName || (doc.number ?? ""),
      ...(doc.contactId ? { contactId: doc.contactId } : {}),
      grossCents: doc.totals.grossCents,
      openCents,
      taxedAs: opening.taxedAs,
      ...(notDueVat.length > 0 ? { notDueVat } : {}),
      documentId: doc._id,
    };
  });
  const posted = await postOpeningBalance(ctx, opening.fiscalYear, { kind: "receivables", items });
  // The opening items and their journal entry are one transaction: anything but a posting rolls both back.
  if (posted.status !== "posted" || !posted.entryIds[0]) {
    throw appError("conflict", "Die offenen Posten konnten nicht in die Eröffnungsbilanz gebucht werden.", {
      reason: "IMPORT_OPENING_NOT_POSTED",
    });
  }
  await recordImported(ctx, importId, EXTERNAL_TYPES.opening, importId, "journalEntries", posted.entryIds[0]);
  return { created: items.length };
}

export async function continueImportedRanges(
  ctx: ModelCtx,
  importId: Id<"imports">,
  decisions: CommitDecisions["numberRanges"],
  today: CalendarDate,
): Promise<void> {
  await requireRunning(ctx, importId);
  const ym = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  for (const d of decisions) await continueRangeAfterImport(ctx, d, ym);
}

/** running → done; source files stay ≥ 10 years as migration evidence (IMP-024, GOBD-20). */
export async function finishImport(
  ctx: ModelCtx,
  importId: Id<"imports">,
  input: { stats: Record<string, number>; log: string[]; today: CalendarDate; maxRetentionUntil?: string },
): Promise<void> {
  const row = await requireRunning(ctx, importId);
  const tenYears = `${Number(input.today.slice(0, 4)) + 10}-12-31`;
  const retention = input.maxRetentionUntil && input.maxRetentionUntil > tenYears ? input.maxRetentionUntil : tenYears;
  await auditedPatch(
    ctx,
    "imports",
    importId,
    {
      status: "done",
      stats: input.stats,
      log: [...row.log, ...input.log].slice(-500),
      finishedAt: ctx.now(),
      committedAt: ctx.now(),
      committedBy: ctx.actor,
      retentionUntil: retention,
    },
    { action: "import.finish", label: `${input.stats.documentsCreated ?? 0} Belege` },
  );
}

/** running → failed with the error (E-IMP-14: resumable; finished batches stay). */
export async function failImport(ctx: ModelCtx, importId: Id<"imports">, message: string): Promise<void> {
  const row = await requireImport(ctx, importId);
  if (row.status !== "running") return;
  await auditedPatch(
    ctx,
    "imports",
    importId,
    { status: "failed", error: message.slice(0, 1000), log: [...row.log, `Fehler: ${message}`].slice(-500) },
    { action: "import.fail", label: message.slice(0, 80) },
  );
}

/** Audit helper for actions that only read (the preview never writes business data). */
export async function auditImportEvent(ctx: ModelCtx, importId: Id<"imports">, action: string, label: string) {
  await appendAudit(ctx, { action, entity: { table: "imports", id: importId, label } });
}
