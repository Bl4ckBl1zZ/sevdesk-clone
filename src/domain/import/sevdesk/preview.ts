/**
 * sevdesk export import preview (F09 IMP-009) and commit plan: uploaded files + mapping + the owner's resolutions +
 * a snapshot of the relevant local data → per-record plan (new / existing / skip / excluded / error), findings,
 * PDF matches, number-range proposals, open items. Computed without touching business tables; the commit
 * re-computes it and refuses a stale preview (E-IMP-27) by comparing `previewHashInput`.
 *
 * Two steps so the server only reads what it needs: `parseImportFiles` (pure parsing) → `lookupKeys` (what the
 * local snapshot must contain) → `buildPlan`.
 */
import { canonicalize } from "../../audit/canonical";
import { foldSearch, normalizeContactNumber } from "../../contacts/core";
import { type ImportRowValues, rowToFormValues } from "../../contacts/csv-io";
import type { CsvRecord } from "../../csv/csv";
import { formatCents } from "../../money/format";
import { normalizeNumber } from "../../numbering/format";
import { productImportForm, productRow } from "../../products/csv-io";
import { lookupVatRate } from "../../rules/vat-rates";
import { contactCreateSchema, emptyContactForm } from "../../schemas/contacts";
import { productSchema } from "../../schemas/products";
import { type CalendarDate, formatGermanDate } from "../../time/calendar-date";
import { type DateFormat, detectDateFormat, detectNumberFormat, type NumberFormat } from "./formats";
import { type ImportedDocument, INVOICE_TYPES_WITH_OPEN_ITEMS, openVatSplit, parseInvoiceRow } from "./invoices";
import {
  type ColumnMapping,
  checkMapping,
  type ImportFileKind,
  type MappedCsvKind,
  type MappingCheck,
  missingColumnMessage,
  parsePerRate,
  positionalMapping,
} from "./mapping";
import { type LocalRange, proposeContinuation, type RangeProposal } from "./number-pattern";
import { matchFiles, type PdfMatchResult } from "./pdf-match";
import { type ImportFinding, rowRefOf } from "./types";

export const SEVDESK_IMPORTER_VERSION = "sevdesk-export-import@1";

/** `importedRecords.externalType` per record kind (IMP-006). */
export const EXTERNAL_TYPES = {
  contact: "sevdesk.contact",
  product: "sevdesk.product",
  document: "sevdesk.document",
  file: "sevdesk.file",
  /** One marker per import: its open items were posted as F08 opening receivables (IMP-007). */
  opening: "sevdesk.opening_receivables",
} as const;
export const importedKey = (externalType: string, externalId: string) => `${externalType}|${externalId}`;

// ── inputs ────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportFileInput {
  readonly id: string;
  readonly name: string;
  readonly sha256: string;
  readonly kind: ImportFileKind;
  readonly ignored?: boolean;
  /** CSV kinds: decoded table. */
  readonly table?: { readonly headers: string[]; readonly records: CsvRecord[] };
}

export interface FileMappingInput {
  readonly columns: ColumnMapping;
  readonly numberFormat?: NumberFormat;
  readonly dateFormat?: DateFormat;
}

export interface ImportResolutions {
  /** Row references `<fileId>:<line>` excluded from the commit. */
  readonly excluded?: readonly string[];
  /** Manual PDF assignment: document key → file id (E-IMP-22/E-IMP-23). */
  readonly pdfAssignments?: Readonly<Record<string, string>>;
  /** Entered open amounts in EUR cents: document key → cents (E-IMP-30, E-IMP-33). */
  readonly openAmounts?: Readonly<Record<string, number>>;
}

export interface LocalImportState {
  readonly today: CalendarDate;
  /** `importedKey(externalType, externalId)` → local id (records of earlier imports). */
  readonly imported: Readonly<Record<string, string>>;
  /** Normalised numbers present in `numberRegister`. */
  readonly registerNumbers: Readonly<Record<string, true>>;
  /** Normalised contact number → contact. */
  readonly contactsByNumber: Readonly<Record<string, { id: string; name: string; vatId?: string }>>;
  /** Folded display name → contact ids. */
  readonly contactsByName: Readonly<Record<string, string[]>>;
  /** Normalised product number → product id. */
  readonly productsByNumber: Readonly<Record<string, string>>;
  /** Normalised document number → local sales document (Storno/Korrektur references). */
  readonly documentsByNumber: Readonly<Record<string, { id: string; type: string }>>;
  readonly ranges: readonly LocalRange[];
  /**
   * F08 opening balance at the Buchungsbeginn (IMP-007, ACC-013); `null`/absent = no Buchungsbeginn set yet.
   * `receivablesPosted`: the fiscal year already has a (non-reversed) receivables opening posting.
   */
  readonly opening?: OpeningContext | null;
}

export interface OpeningContext {
  readonly date: CalendarDate;
  readonly fiscalYear: number;
  readonly receivablesPosted: boolean;
  /** Taxation method at the Buchungsbeginn: under Ist the open items carry their not-due VAT (UVA-06). */
  readonly taxedAs: "soll" | "ist";
}

/** One F08 opening receivable per open imported invoice (IMP-007). */
export interface OpeningItemPlan {
  readonly key: string;
  readonly openCents: number;
  readonly notDueVat: { rateBp: number; vatCents: number }[];
}

// ── step 1: parse ─────────────────────────────────────────────────────────────────────────────────────

export interface ParsedContact {
  readonly key: string;
  readonly rowRef: string;
  readonly fileId: string;
  readonly line: number;
  readonly number?: string;
  readonly name: string;
  readonly postalCode: string;
  readonly vatId?: string;
  readonly values: ImportRowValues;
  readonly fingerprint: string;
}

export interface ParsedProduct {
  readonly key: string;
  readonly rowRef: string;
  readonly fileId: string;
  readonly line: number;
  readonly number: string;
  readonly name: string;
  readonly categoryPath: string;
  readonly form: ReturnType<typeof productImportForm>;
  readonly fingerprint: string;
}

export interface FileSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ImportFileKind;
  readonly ignored: boolean;
  readonly rows: number;
  readonly mapping?: MappingCheck;
  readonly numberFormat?: NumberFormat | "ambiguous";
  readonly dateFormat?: DateFormat | "ambiguous";
  readonly blocked: boolean;
}

export interface ParsedImport {
  readonly files: FileSummary[];
  readonly contacts: ParsedContact[];
  readonly products: ParsedProduct[];
  readonly documents: ImportedDocument[];
  readonly documentFiles: { id: string; name: string; sha256: string; kind: "pdf" | "xml" }[];
  readonly findings: ImportFinding[];
  readonly skippedDrafts: number;
  readonly skippedReminders: number;
}

const rowFingerprint = (headers: readonly string[], cells: readonly string[]) =>
  JSON.stringify(headers.map((h, i) => `${h}=${(cells[i] ?? "").trim()}`).sort());

function invoiceDetectionValues(table: NonNullable<ImportFileInput["table"]>, mapping: ColumnMapping) {
  const col = (target: string) => {
    const header = mapping[target];
    const i = header === undefined ? -1 : table.headers.indexOf(header);
    return i < 0 ? [] : table.records.map((r) => r.cells[i] ?? "");
  };
  const amountTargets = Object.keys(mapping).filter(
    (t) => ["net", "vat", "gross", "paid", "open"].includes(t) || parsePerRate(t) !== null,
  );
  return {
    amounts: amountTargets.flatMap(col),
    dates: ["documentDate", "supplyDate", "dueDate", "sentOn"].flatMap(col),
  };
}

export function parseImportFiles(
  files: readonly ImportFileInput[],
  mappings: Readonly<Record<string, FileMappingInput>>,
  today: CalendarDate,
): ParsedImport {
  const findings: ImportFinding[] = [];
  const summaries: FileSummary[] = [];
  const contacts: ParsedContact[] = [];
  const products: ParsedProduct[] = [];
  const documents: ImportedDocument[] = [];
  const documentFiles: ParsedImport["documentFiles"] = [];
  let skippedDrafts = 0;
  let skippedReminders = 0;
  const rateBpToday = (key: string) => {
    const r = lookupVatRate(key, today);
    return r.ok ? r.value.value.rateBp : undefined;
  };

  for (const file of files) {
    const at = { fileId: file.id, fileName: file.name };
    const base = { id: file.id, name: file.name, kind: file.kind, ignored: file.ignored === true };
    if (file.ignored) {
      summaries.push({ ...base, rows: 0, blocked: false });
      continue;
    }
    if (file.kind === "pdf" || file.kind === "xml") {
      documentFiles.push({ id: file.id, name: file.name, sha256: file.sha256, kind: file.kind });
      summaries.push({ ...base, rows: 0, blocked: false });
      continue;
    }
    if (file.kind !== "contacts" && file.kind !== "products" && file.kind !== "invoices") {
      const message =
        file.kind === "unknown"
          ? `Datei ${file.name} wurde nicht erkannt. Bitte Dateiart wählen oder ignorieren.`
          : file.kind === "zip"
            ? `ZIP-Archive werden in dieser Version noch nicht entpackt – bitte ${file.name} entpacken und die enthaltenen Dateien einzeln hochladen.`
            : `${file.name}: Diese Dateiart wird erst in einer späteren Ausbaustufe übernommen (P2) und jetzt ignoriert.`;
      findings.push({ code: file.kind === "unknown" ? "E-IMP-20" : "IMP-018", severity: "warning", message, ...at });
      summaries.push({ ...base, rows: 0, blocked: false });
      continue;
    }
    const kind: MappedCsvKind = file.kind;
    const table = file.table;
    if (!table) {
      findings.push({
        code: "E-IMP-15",
        severity: "error",
        message: `${file.name} konnte nicht gelesen werden.`,
        ...at,
      });
      summaries.push({ ...base, rows: 0, blocked: true });
      continue;
    }
    const mapping = mappings[file.id]?.columns ?? {};
    const check = checkMapping(kind, table.headers, mapping);
    let blocked = false;
    for (const target of check.missing) {
      findings.push({
        code: "E-IMP-21",
        severity: "error",
        message: missingColumnMessage(file.name, kind, target),
        ...at,
      });
      blocked = true;
    }
    let numberFormat: NumberFormat | "ambiguous" | undefined;
    let dateFormat: DateFormat | "ambiguous" | undefined;
    if (kind === "invoices") {
      const values = invoiceDetectionValues(table, mapping);
      const nd = detectNumberFormat(values.amounts);
      const dd = detectDateFormat(values.dates);
      numberFormat = mappings[file.id]?.numberFormat ?? (nd.kind === "decided" ? nd.value : "ambiguous");
      dateFormat = mappings[file.id]?.dateFormat ?? (dd.kind === "decided" ? dd.value : "ambiguous");
      if (numberFormat === "ambiguous" || dateFormat === "ambiguous") {
        findings.push({
          code: "E-IMP-26",
          severity: "error",
          message: `Zahlen-/Datumsformat in ${file.name} ist nicht eindeutig. Bitte Format wählen.`,
          ...at,
        });
        blocked = true;
      }
    }
    summaries.push({
      ...base,
      rows: table.records.length,
      mapping: check,
      ...(numberFormat ? { numberFormat } : {}),
      ...(dateFormat ? { dateFormat } : {}),
      blocked,
    });
    if (blocked) continue;

    for (const record of table.records) {
      const rowRef = rowRefOf(file.id, record.line);
      const rowAt = { ...at, line: record.line, rowRef };
      if (kind === "contacts") {
        const values = rowToFormValues(record.cells, positionalMapping(table.headers, mapping), emptyContactForm());
        const parsed = contactCreateSchema.safeParse(values);
        const c = values.contact as Record<string, unknown>;
        const name = values.billingAddress.name ?? "";
        if (!parsed.success) {
          const i = parsed.error.issues[0];
          findings.push({
            code: "E-IMP-16",
            severity: "error",
            message: `Zeile ${record.line}: ${i?.message ?? "Ungültige Zeile."}${i?.path.length ? ` (${i.path.join(".")})` : ""}`,
            ...rowAt,
          });
          continue;
        }
        const number = String(c.number ?? "").trim();
        const postalCode = values.billingAddress.postalCode ?? "";
        const vatId = String(c.vatId ?? "").trim();
        contacts.push({
          key: number ? `n:${normalizeContactNumber(number)}` : `h:${foldSearch(name)}|${postalCode.trim()}`,
          rowRef,
          fileId: file.id,
          line: record.line,
          ...(number ? { number } : {}),
          name,
          postalCode,
          ...(vatId ? { vatId } : {}),
          values,
          fingerprint: rowFingerprint(table.headers, record.cells),
        });
      } else if (kind === "products") {
        const parsed = productRow(record.cells, positionalMapping(table.headers, mapping), record.line, rateBpToday);
        if (!parsed.values) {
          findings.push({
            code: "E-IMP-16",
            severity: "error",
            message: parsed.errors.map((e) => e.message).join(" "),
            ...rowAt,
          });
          continue;
        }
        if (!parsed.values.number) {
          findings.push({
            code: "E-IMP-16",
            severity: "error",
            message: `Zeile ${record.line}: Artikelnummer fehlt (sie ist der Schlüssel für wiederholte Importe).`,
            ...rowAt,
          });
          continue;
        }
        const form = productImportForm(parsed.values, "");
        const check = productSchema.safeParse(form);
        if (!check.success) {
          findings.push({
            code: "E-IMP-16",
            severity: "error",
            message: `Zeile ${record.line}: ${check.error.issues[0]?.message ?? "Ungültige Zeile."}`,
            ...rowAt,
          });
          continue;
        }
        products.push({
          key: normalizeNumber(parsed.values.number),
          rowRef,
          fileId: file.id,
          line: record.line,
          number: parsed.values.number,
          name: parsed.values.name,
          categoryPath: parsed.values.categoryPath,
          form,
          fingerprint: rowFingerprint(table.headers, record.cells),
        });
      } else {
        const r = parseInvoiceRow(record.line, record.cells, table.headers, mapping, {
          fileId: file.id,
          fileName: file.name,
          numberFormat: numberFormat as NumberFormat,
          dateFormat: dateFormat as DateFormat,
        });
        findings.push(...r.findings);
        if (r.kind === "skipped") {
          if (r.reason === "draft") skippedDrafts++;
          else skippedReminders++;
        } else if (r.doc) documents.push(r.doc);
      }
    }
  }
  if (skippedDrafts > 0) {
    findings.push({
      code: "IMP-018",
      severity: "info",
      message: `${skippedDrafts} Entwürfe werden nicht übernommen (keine Nummer; bei Bedarf neu anlegen).`,
    });
  }
  if (skippedReminders > 0) {
    findings.push({
      code: "IMP-018",
      severity: "info",
      message: `${skippedReminders} Mahnungen werden nicht übernommen.`,
    });
  }
  return { files: summaries, contacts, products, documents, documentFiles, findings, skippedDrafts, skippedReminders };
}

// ── step 2: keys the local snapshot must cover ────────────────────────────────────────────────────────

export interface LookupKeys {
  readonly imported: string[];
  readonly registerNumbers: string[];
  readonly contactNumbers: string[];
  readonly contactNames: string[];
  readonly productNumbers: string[];
  readonly documentNumbers: string[];
}

export function lookupKeys(parsed: ParsedImport): LookupKeys {
  const docNumbers = parsed.documents.map((d) => normalizeNumber(d.number));
  const refs = parsed.documents.flatMap((d) => (d.referenceNumber ? [normalizeNumber(d.referenceNumber)] : []));
  return {
    imported: [
      ...parsed.contacts.map((c) => importedKey(EXTERNAL_TYPES.contact, c.key)),
      ...parsed.products.map((p) => importedKey(EXTERNAL_TYPES.product, p.key)),
      ...parsed.documents.map((d) => importedKey(EXTERNAL_TYPES.document, d.key)),
      ...parsed.documents.map((d) => importedKey(EXTERNAL_TYPES.contact, minimalKey(d.customerName))),
      ...parsed.documentFiles.map((f) => importedKey(EXTERNAL_TYPES.file, f.sha256)),
    ],
    registerNumbers: [...new Set(docNumbers)],
    contactNumbers: [
      ...new Set([
        ...parsed.contacts.flatMap((c) => (c.number ? [normalizeContactNumber(c.number)] : [])),
        ...parsed.documents.flatMap((d) => (d.customerNumber ? [normalizeContactNumber(d.customerNumber)] : [])),
      ]),
    ],
    contactNames: [...new Set(parsed.documents.map((d) => foldSearch(d.customerName)).filter(Boolean))],
    productNumbers: [...new Set(parsed.products.map((p) => p.key))],
    documentNumbers: [...new Set(refs)],
  };
}

// ── step 3: plan ──────────────────────────────────────────────────────────────────────────────────────

export type RecordStatus = "new" | "existing" | "skip" | "excluded" | "error";

export interface PlannedContact extends ParsedContact {
  readonly status: RecordStatus;
  readonly localId?: string;
}
export interface PlannedProduct extends ParsedProduct {
  readonly status: RecordStatus;
  readonly localId?: string;
}

export type ContactRef =
  | { readonly kind: "import"; readonly key: string }
  | { readonly kind: "local"; readonly id: string }
  | { readonly kind: "minimal"; readonly key: string };

export interface PlannedDocument {
  readonly doc: ImportedDocument;
  readonly status: Exclude<RecordStatus, "existing">;
  readonly localId?: string;
  readonly contact?: ContactRef;
  readonly correctsKey?: string;
  readonly correctsLocalId?: string;
  readonly finalStatus: "sent" | "cancelled";
  readonly paymentStatus?: "open" | "partially_paid" | "paid";
  readonly openAmountCents?: number;
  readonly pdfFileId?: string;
  readonly deviations: string[];
}

export interface MinimalContact {
  readonly key: string;
  readonly name: string;
  readonly customerNumber?: string;
  readonly localId?: string;
}

export interface ImportPlan {
  readonly files: FileSummary[];
  readonly contacts: PlannedContact[];
  readonly products: PlannedProduct[];
  readonly documents: PlannedDocument[];
  readonly minimalContacts: MinimalContact[];
  readonly findings: ImportFinding[];
  readonly pdf: PdfMatchResult;
  readonly documentFiles: ParsedImport["documentFiles"];
  readonly numberRanges: RangeProposal[];
  readonly openItems: { count: number; totalCents: number };
  /** Opening receivables posted at commit through F08 (`null` = no open items). */
  readonly opening: (Omit<OpeningContext, "receivablesPosted"> & { items: OpeningItemPlan[] }) | null;
  readonly counts: Readonly<Record<string, number>>;
  /** Errors on rows/files that would be committed — commit is refused while > 0. */
  readonly blocking: number;
}

export const minimalKey = (name: string) => `m:${foldSearch(name)}`;

/** E-IMP-24: same key twice — identical content counts once, different content blocks all copies. */
function dedupe<T extends { key: string; fingerprint: string; rowRef: string; line: number; fileId: string }>(
  items: readonly T[],
  label: (t: T) => string,
  findings: ImportFinding[],
  fileName: (id: string) => string,
): { kept: T[]; conflicted: Set<string>; dropped: number } {
  const byKey = new Map<string, T[]>();
  for (const i of items) byKey.set(i.key, [...(byKey.get(i.key) ?? []), i]);
  const kept: T[] = [];
  const conflicted = new Set<string>();
  let dropped = 0;
  for (const group of byKey.values()) {
    const first = group[0] as T;
    if (group.every((g) => g.fingerprint === first.fingerprint)) {
      kept.push(first);
      dropped += group.length - 1;
      continue;
    }
    const files = [...new Set(group.map((g) => fileName(g.fileId)))].join(", ");
    for (const g of group) {
      conflicted.add(g.rowRef);
      findings.push({
        code: "E-IMP-24",
        severity: "error",
        message: `${label(g)} ist mehrfach mit unterschiedlichen Werten enthalten (${files}).`,
        fileId: g.fileId,
        fileName: fileName(g.fileId),
        line: g.line,
        rowRef: g.rowRef,
        key: g.key,
      });
      kept.push(g);
    }
  }
  return { kept, conflicted, dropped };
}

export function buildPlan(
  parsed: ParsedImport,
  local: LocalImportState,
  resolutions: ImportResolutions = {},
): ImportPlan {
  const findings: ImportFinding[] = [...parsed.findings];
  const excluded = new Set(resolutions.excluded ?? []);
  const fileName = (id: string) => parsed.files.find((f) => f.id === id)?.name ?? id;
  const errorRows = new Set(findings.filter((f) => f.severity === "error" && f.rowRef).map((f) => f.rowRef as string));
  const isImported = (type: string, key: string) => local.imported[importedKey(type, key)];

  // ── contacts ──
  const cd = dedupe(parsed.contacts, (c) => `Kontakt ${c.number ?? c.name}`, findings, fileName);
  const contacts: PlannedContact[] = cd.kept.map((c) => {
    if (excluded.has(c.rowRef)) return { ...c, status: "excluded" };
    if (cd.conflicted.has(c.rowRef)) return { ...c, status: "error" };
    const prior = isImported(EXTERNAL_TYPES.contact, c.key);
    if (prior) return { ...c, status: "skip", localId: prior };
    const existing = c.number ? local.contactsByNumber[normalizeContactNumber(c.number)] : undefined;
    if (existing) {
      findings.push({
        code: "E-IMP-05",
        severity: "info",
        message: `Kontakt ${c.number} existiert bereits – wird verknüpft, nicht überschrieben.`,
        fileId: c.fileId,
        fileName: fileName(c.fileId),
        line: c.line,
        rowRef: c.rowRef,
        key: c.key,
      });
      return { ...c, status: "existing", localId: existing.id };
    }
    return { ...c, status: "new" };
  });

  // ── products ──
  const pd = dedupe(parsed.products, (p) => `Artikel ${p.number}`, findings, fileName);
  const products: PlannedProduct[] = pd.kept.map((p) => {
    if (excluded.has(p.rowRef)) return { ...p, status: "excluded" };
    if (pd.conflicted.has(p.rowRef)) return { ...p, status: "error" };
    const prior = isImported(EXTERNAL_TYPES.product, p.key);
    if (prior) return { ...p, status: "skip", localId: prior };
    const existing = local.productsByNumber[p.key];
    if (existing) {
      findings.push({
        code: "E-IMP-05",
        severity: "info",
        message: `Artikel ${p.number} existiert bereits – wird nicht überschrieben.`,
        fileId: p.fileId,
        fileName: fileName(p.fileId),
        line: p.line,
        rowRef: p.rowRef,
        key: p.key,
      });
      return { ...p, status: "existing", localId: existing };
    }
    return { ...p, status: "new" };
  });

  // ── documents ──
  const dd = dedupe(parsed.documents, (d) => d.number, findings, fileName);
  const docs = dd.kept;
  const byNumber = new Map<string, ImportedDocument[]>();
  for (const d of docs)
    byNumber.set(normalizeNumber(d.number), [...(byNumber.get(normalizeNumber(d.number)) ?? []), d]);
  const contactByNumber = new Map<string, PlannedContact>();
  const contactByName = new Map<string, PlannedContact[]>();
  for (const c of contacts) {
    if (c.status === "excluded" || c.status === "error") continue;
    if (c.number) contactByNumber.set(normalizeContactNumber(c.number), c);
    const n = foldSearch(c.name);
    contactByName.set(n, [...(contactByName.get(n) ?? []), c]);
  }
  const minimal = new Map<string, MinimalContact>();
  const planned: PlannedDocument[] = [];
  let nameMatched = 0;
  for (const d of docs) {
    const at = { fileId: d.fileId, fileName: fileName(d.fileId), line: d.line, rowRef: d.rowRef, key: d.key };
    const rowError = (code: string, message: string) => findings.push({ code, severity: "error", message, ...at });
    const base = { doc: d, deviations: [...d.deviations], finalStatus: "sent" as const };
    if (excluded.has(d.rowRef)) {
      planned.push({ ...base, status: "excluded" });
      continue;
    }
    if (dd.conflicted.has(d.rowRef) || errorRows.has(d.rowRef)) {
      planned.push({ ...base, status: "error" });
      continue;
    }
    const prior = isImported(EXTERNAL_TYPES.document, d.key);
    if (prior) {
      planned.push({ ...base, status: "skip", localId: prior });
      continue;
    }
    let blocked = false;
    // IMP-004 / E-IMP-06 / RI-02: the number must be unique in the register and inside the upload.
    if (local.registerNumbers[normalizeNumber(d.number)]) {
      rowError("E-IMP-06", `Rechnungsnummer ${d.number} existiert bereits. Bitte Nummernkreise prüfen.`);
      blocked = true;
    } else if ((byNumber.get(normalizeNumber(d.number)) ?? []).length > 1) {
      rowError("E-IMP-24", `${d.number} ist mehrfach mit unterschiedlichen Belegarten enthalten.`);
      blocked = true;
    }
    // IMP-021 contact linking: customer number → exact name → minimal contact (E-IMP-25).
    let contact: ContactRef | undefined;
    const num = d.customerNumber ? normalizeContactNumber(d.customerNumber) : undefined;
    const viaImport = num ? contactByNumber.get(num) : undefined;
    const viaLocal = num ? local.contactsByNumber[num] : undefined;
    if (viaImport) {
      contact = viaImport.localId ? { kind: "local", id: viaImport.localId } : { kind: "import", key: viaImport.key };
    } else if (viaLocal) contact = { kind: "local", id: viaLocal.id };
    else if (d.customerName) {
      const n = foldSearch(d.customerName);
      const imp = contactByName.get(n) ?? [];
      const loc = local.contactsByName[n] ?? [];
      const only = imp.length + loc.length === 1 ? (imp[0] ?? loc[0]) : undefined;
      if (only) {
        nameMatched++;
        contact =
          typeof only === "string"
            ? { kind: "local", id: only }
            : only.localId
              ? { kind: "local", id: only.localId }
              : { kind: "import", key: only.key };
        findings.push({
          code: "IMP-021",
          severity: "warning",
          message: `${d.number}: Kunde „${d.customerName}“ per Name zugeordnet – bitte prüfen.`,
          ...at,
        });
      } else {
        const key = minimalKey(d.customerName);
        const prior = isImported(EXTERNAL_TYPES.contact, key);
        if (!minimal.has(key)) {
          minimal.set(key, {
            key,
            name: d.customerName,
            ...(d.customerNumber ? { customerNumber: d.customerNumber } : {}),
            ...(prior ? { localId: prior } : {}),
          });
        }
        contact = prior ? { kind: "local", id: prior } : { kind: "minimal", key };
      }
    } else {
      rowError("E-IMP-16", `Zeile ${d.line}: Kunde fehlt (weder Kundennummer noch Name).`);
      blocked = true;
    }
    // References of Storno / Korrektur (§4.3.3, E-IMP-31).
    let correctsKey: string | undefined;
    let correctsLocalId: string | undefined;
    if (d.type === "cancellation" || d.type === "correction") {
      const ref = d.referenceNumber ? normalizeNumber(d.referenceNumber) : undefined;
      const inImport = ref
        ? (byNumber.get(ref) ?? []).find((x) => INVOICE_TYPES_WITH_OPEN_ITEMS.includes(x.type))
        : undefined;
      const inLocal = ref ? local.documentsByNumber[ref] : undefined;
      if (inImport) correctsKey = inImport.key;
      else if (inLocal) correctsLocalId = inLocal.id;
      else {
        findings.push({
          code: "E-IMP-31",
          severity: "warning",
          message: `${d.number}: Bezug zur ursprünglichen Rechnung nicht gefunden – als eigenständiger Beleg archiviert.`,
          ...at,
        });
      }
    }
    // Open items (IMP-007, E-IMP-30, E-IMP-33).
    let openAmountCents: number | undefined;
    let paymentStatus: PlannedDocument["paymentStatus"];
    const entered = resolutions.openAmounts?.[d.key];
    if (INVOICE_TYPES_WITH_OPEN_ITEMS.includes(d.type) && !d.cancelledByStatus) {
      const fromExport = d.currency === "EUR" || d.openAmountCents === 0 ? d.openAmountCents : undefined;
      openAmountCents = entered ?? fromExport;
      if (openAmountCents === undefined) {
        rowError("E-IMP-30", `Offener Betrag für ${d.number} nicht ermittelbar. Bitte eintragen.`);
        blocked = true;
      } else if (openAmountCents < 0 || (d.currency === "EUR" && openAmountCents > d.totals.grossCents)) {
        rowError("E-IMP-30", `Der eingetragene offene Betrag für ${d.number} ist ungültig.`);
        blocked = true;
      } else {
        paymentStatus =
          openAmountCents === 0 ? "paid" : openAmountCents >= d.totals.grossCents ? "open" : "partially_paid";
      }
    }
    planned.push({
      ...base,
      status: blocked ? "error" : "new",
      ...(contact ? { contact } : {}),
      ...(correctsKey ? { correctsKey } : {}),
      ...(correctsLocalId ? { correctsLocalId } : {}),
      ...(openAmountCents !== undefined ? { openAmountCents } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
    });
  }
  if (minimal.size > 0) {
    const n = planned.filter((p) => p.contact?.kind === "minimal").length;
    findings.push({
      code: "E-IMP-25",
      severity: "warning",
      message: `${n} Belege verweisen auf unbekannte Kunden – Kontakte werden unvollständig angelegt.`,
    });
  }
  // A Storno in the same upload cancels its original (§4.3.3).
  const cancelledKeys = new Set(
    planned.flatMap((p) =>
      p.doc.type === "cancellation" && p.correctsKey && p.status === "new" ? [p.correctsKey] : [],
    ),
  );
  const docs2 = planned.map((p): PlannedDocument => {
    const cancelled = p.doc.cancelledByStatus || cancelledKeys.has(p.doc.key);
    if (!cancelled) return p;
    const { openAmountCents: _o, paymentStatus: _p, ...rest } = p;
    return { ...rest, finalStatus: "cancelled" };
  });

  // ── Buchungsbeginn and F08 opening balance (IMP-007, ACC-013; E-IMP-10/34/35/36) ──
  const opening = local.opening ?? null;
  const docs3 = docs2.map((p): PlannedDocument => {
    if (p.status !== "new") return p;
    const block = (code: string, message: string): PlannedDocument => {
      findings.push({
        code,
        severity: "error",
        message,
        fileId: p.doc.fileId,
        fileName: fileName(p.doc.fileId),
        line: p.doc.line,
        rowRef: p.doc.rowRef,
        key: p.doc.key,
      });
      return { ...p, status: "error" };
    };
    // E-IMP-10: the spec offers „buchen“ for documents in the booked period; P1 has no import posting, so they are
    // blocked (conservative: never archive a booked-period invoice without its journal entry).
    if (opening && p.doc.documentDate >= opening.date) {
      return block(
        "E-IMP-10",
        `${p.doc.number} liegt am oder nach dem Buchungsbeginn (${formatGermanDate(opening.date)}). Buchen beim Import ist noch nicht möglich – bitte Buchungsbeginn prüfen oder Zeile ausschließen.`,
      );
    }
    if ((p.openAmountCents ?? 0) <= 0) return p;
    // E-IMP-33: F08 opening items are EUR only and compare the open amount with the gross; a foreign-currency gross
    // would make both wrong. Blocked in P1 (conservative); the owner enters the receivable in EUR by hand.
    if (p.doc.currency !== "EUR") {
      return block(
        "E-IMP-33",
        `${p.doc.number} ist in ${p.doc.currency} – offene Posten in Fremdwährung können noch nicht in die Eröffnungsbilanz übernommen werden. Bitte Zeile ausschließen und den Posten in EUR in der Eröffnungsbilanz erfassen.`,
      );
    }
    if (!opening) {
      return block(
        "E-IMP-34",
        `${p.doc.number} ist offen. Offene Posten werden in die Eröffnungsbilanz übernommen – bitte zuerst den Buchungsbeginn festlegen.`,
      );
    }
    if (opening.receivablesPosted) {
      return block(
        "E-IMP-35",
        `${p.doc.number} ist offen, aber für ${opening.fiscalYear} sind bereits offene Forderungen in der Eröffnungsbilanz erfasst. Bitte dort stornieren oder die Zeile ausschließen.`,
      );
    }
    // LEGAL-OPEN: F09 IMP-010 — an unknown/OSS tax case under Ist: booking its VAT as not-due German VAT would declare
    // it in the UStVA on payment, omitting it could under-declare. Blocked until the owner clarifies the case.
    if (opening.taxedAs === "ist" && p.doc.taxCase === "unknown_imported" && p.doc.totals.vatCents !== 0) {
      return block(
        "E-IMP-36",
        `${p.doc.number}: Steuerfall unbekannt (z. B. OSS) – der offene Posten kann bei Ist-Versteuerung nicht mit Umsatzsteuer übernommen werden. Bitte klären oder Zeile ausschließen.`,
      );
    }
    return p;
  });

  // ── PDFs (IMP-019) ──
  const committable = docs3.filter((p) => p.status === "new");
  const pdfFiles = parsed.documentFiles.filter((f) => f.kind === "pdf");
  const pdf = matchFiles(
    committable.map((p) => ({ key: p.doc.key, number: p.doc.number })),
    pdfFiles,
    resolutions.pdfAssignments ?? {},
  );
  const withPdf = docs3.map((p): PlannedDocument => {
    if (p.status !== "new") return p;
    const at = {
      fileId: p.doc.fileId,
      fileName: fileName(p.doc.fileId),
      line: p.doc.line,
      rowRef: p.doc.rowRef,
      key: p.doc.key,
    };
    const candidates = pdf.ambiguous[p.doc.key];
    if (candidates) {
      findings.push({
        code: "E-IMP-22",
        severity: "error",
        message: `Für ${p.doc.number} passen mehrere Dateien (${candidates.map((c) => pdfFiles.find((f) => f.id === c)?.name ?? c).join(", ")}). Bitte die richtige Datei wählen.`,
        ...at,
      });
      return { ...p, status: "error" };
    }
    const fileId = pdf.matched[p.doc.key];
    if (fileId) return { ...p, pdfFileId: fileId };
    findings.push({
      code: "E-IMP-07",
      severity: "warning",
      message: `Für ${p.doc.number} wurde kein Original-PDF gefunden.`,
      ...at,
    });
    return { ...p, deviations: [...p.deviations, "Original-PDF fehlt."] };
  });
  if (pdf.orphans.length > 0) {
    findings.push({
      code: "E-IMP-23",
      severity: "warning",
      message: `${pdf.orphans.length} Dateien ohne passenden Beleg in der Liste.`,
    });
  }
  const xmlCount = parsed.documentFiles.filter((f) => f.kind === "xml").length;
  if (xmlCount > 0) {
    // LEGAL-OPEN: F09 IMP-019/open item 10 — documentArtifacts has no "xml" kind yet (03 §4); XML files are listed,
    // not archived, until the data model decides the kind (xrechnung_xml would claim an XRechnung we never validated).
    findings.push({
      code: "IMP-019",
      severity: "info",
      message: `${xmlCount} XML-Dateien werden in dieser Version noch nicht archiviert (nur PDF).`,
    });
  }

  // ── EC-190 deviations, extra checks that need the contact ──
  const contactVat = (ref: ContactRef | undefined): string | undefined => {
    if (!ref) return undefined;
    if (ref.kind === "import") return contacts.find((c) => c.key === ref.key)?.vatId;
    if (ref.kind === "local") return Object.values(local.contactsByNumber).find((c) => c.id === ref.id)?.vatId;
    return undefined;
  };
  const finalDocs = withPdf.map((p): PlannedDocument => {
    if (p.status !== "new") return p;
    const needsVatId = ["intra_community_supply", "eu_b2b_service", "reverse_charge_13b"].includes(p.doc.taxCase);
    const deviations =
      needsVatId && !contactVat(p.contact) ? [...p.deviations, "USt-IdNr. des Kunden fehlt."] : p.deviations;
    if (deviations.length > 0) {
      findings.push({
        code: "EC-190",
        severity: "info",
        message: `${p.doc.number}: ${deviations.join(" ")}`,
        fileId: p.doc.fileId,
        fileName: fileName(p.doc.fileId),
        line: p.doc.line,
        rowRef: p.doc.rowRef,
        key: p.doc.key,
      });
    }
    return { ...p, deviations };
  });

  // ── number ranges (IMP-005) ──
  const numberRanges = proposeContinuation(
    docs.map((d) => ({ type: d.type, number: d.number, documentDate: d.documentDate })),
    local.today,
    local.ranges,
  );
  for (const r of numberRanges) {
    const label = r.rangeKey === "invoice" ? "Rechnungen" : "Rechnungskorrekturen";
    if (r.ambiguous) {
      findings.push({
        code: "E-IMP-11",
        severity: "warning",
        message: `Mehrere Nummernformate erkannt (${r.candidates.map((c) => c.format).join(", ")}). Bitte Format für neue ${label} wählen.`,
      });
    }
    if (r.gapCount > 0) {
      findings.push({
        code: "E-IMP-32",
        severity: "info",
        message: `Lücken in den importierten Nummern: ${r.gaps.slice(0, 10).join(", ")}${r.gapCount > 10 ? ` … (${r.gapCount})` : ""}.`,
      });
    }
  }

  const open = finalDocs.filter((p) => p.status === "new" && (p.openAmountCents ?? 0) > 0);
  const openItems = { count: open.length, totalCents: open.reduce((s, p) => s + (p.openAmountCents ?? 0), 0) };
  const openingPlan: ImportPlan["opening"] =
    opening && open.length > 0
      ? {
          date: opening.date,
          fiscalYear: opening.fiscalYear,
          taxedAs: opening.taxedAs,
          items: open.map((p) => {
            const openCents = p.openAmountCents ?? 0;
            return {
              key: p.doc.key,
              openCents,
              notDueVat: opening.taxedAs === "ist" ? openVatSplit(p.doc, openCents) : [],
            };
          }),
        }
      : null;
  const live = (status: string) => status === "new" || status === "existing" || status === "skip";
  const blockedFiles = parsed.files.filter((f) => f.blocked).length;
  const blocking =
    blockedFiles +
    contacts.filter((c) => c.status === "error").length +
    products.filter((p) => p.status === "error").length +
    finalDocs.filter((p) => p.status === "error").length +
    findings.filter((f) => f.severity === "error" && f.rowRef && !excluded.has(f.rowRef) && !isPlanned(f.rowRef))
      .length;
  function isPlanned(rowRef: string) {
    return (
      contacts.some((c) => c.rowRef === rowRef) ||
      products.some((p) => p.rowRef === rowRef) ||
      finalDocs.some((p) => p.doc.rowRef === rowRef)
    );
  }
  const count = (list: readonly { status: string }[], s: string) => list.filter((x) => x.status === s).length;
  const newDocs = finalDocs.filter((p) => p.status === "new");
  const counts: Record<string, number> = {
    contactsNew: count(contacts, "new"),
    contactsExisting: count(contacts, "existing"),
    contactsSkipped: count(contacts, "skip"),
    contactsMinimal: [...minimal.values()].filter((m) => !m.localId).length,
    productsNew: count(products, "new"),
    productsExisting: count(products, "existing"),
    productsSkipped: count(products, "skip"),
    invoices: newDocs.filter((p) => p.doc.type !== "correction" && p.doc.type !== "cancellation").length,
    corrections: newDocs.filter((p) => p.doc.type === "correction").length,
    cancellations: newDocs.filter((p) => p.doc.type === "cancellation").length,
    documentsSkipped: count(finalDocs, "skip"),
    documentsExcluded: count(finalDocs, "excluded"),
    openItems: openItems.count,
    pdfMatched: Object.keys(pdf.matched).length,
    pdfMissing: newDocs.filter((p) => !p.pdfFileId).length,
    pdfOrphans: pdf.orphans.length,
    duplicatesDropped: cd.dropped + pd.dropped + dd.dropped + pdf.duplicates.length,
    drafts: parsed.skippedDrafts,
    nameMatched,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    rows: [...contacts, ...products].filter((x) => live(x.status)).length + newDocs.length,
  };
  return {
    files: parsed.files,
    contacts,
    products,
    documents: finalDocs,
    minimalContacts: [...minimal.values()],
    findings,
    pdf,
    documentFiles: parsed.documentFiles,
    numberRanges,
    openItems,
    opening: openingPlan,
    counts,
    blocking,
  };
}

/** Rows that still need the „ohne Original-PDF übernehmen“ confirmation (E-IMP-07). */
export const missingPdfKeys = (plan: ImportPlan): string[] =>
  plan.documents.filter((p) => p.status === "new" && !p.pdfFileId).map((p) => p.doc.key);

/**
 * IMP-009 / IMP-023: canonical content the `previewHash` is computed over — files, mapping, resolutions and every
 * plan decision that depends on local data. A changed number register, an earlier import or a new local contact
 * changes it, so a commit with the old hash is refused (E-IMP-27).
 */
export function previewHashInput(
  files: readonly ImportFileInput[],
  mappings: Readonly<Record<string, FileMappingInput>>,
  resolutions: ImportResolutions,
  plan: ImportPlan,
): string {
  return canonicalize({
    importer: SEVDESK_IMPORTER_VERSION,
    files: files.map((f) => ({ id: f.id, sha256: f.sha256, kind: f.kind, ignored: f.ignored === true })),
    mappings,
    resolutions: {
      excluded: [...(resolutions.excluded ?? [])].sort(),
      pdfAssignments: resolutions.pdfAssignments ?? {},
      openAmounts: resolutions.openAmounts ?? {},
    },
    contacts: plan.contacts.map((c) => [c.key, c.status, c.localId ?? null]),
    products: plan.products.map((p) => [p.key, p.status, p.localId ?? null]),
    documents: plan.documents.map((p) => [
      p.doc.key,
      p.status,
      p.contact ? canonicalize(p.contact) : null,
      p.pdfFileId ?? null,
      p.openAmountCents ?? null,
      p.finalStatus,
    ]),
    minimal: plan.minimalContacts.map((m) => [m.key, m.localId ?? null]),
    ranges: plan.numberRanges.map((r) => [r.rangeKey, r.candidates.map((c) => [c.format, c.next])]),
    opening: plan.opening,
  });
}

/** Compact preview stored on the `imports` row (document size limits): counts, findings (capped), samples. */
export function summarizePlan(plan: ImportPlan, findingLimit = 500) {
  const docSample = plan.documents
    .filter((p) => p.status === "new")
    .slice(0, 10)
    .map((p) => ({
      key: p.doc.key,
      number: p.doc.number,
      type: p.doc.type,
      documentDate: p.doc.documentDate,
      customerName: p.doc.customerName,
      grossCents: p.doc.totals.grossCents,
      currency: p.doc.currency,
      taxCase: p.doc.taxCase,
      finalStatus: p.finalStatus,
      ...(p.openAmountCents !== undefined ? { openAmountCents: p.openAmountCents } : {}),
      pdf: p.pdfFileId ? (plan.documentFiles.find((f) => f.id === p.pdfFileId)?.name ?? null) : null,
    }));
  return {
    counts: plan.counts,
    blocking: plan.blocking,
    files: plan.files,
    findings: plan.findings.slice(0, findingLimit),
    findingsTotal: plan.findings.length,
    numberRanges: plan.numberRanges,
    openItems: plan.openItems,
    pdf: {
      orphans: plan.pdf.orphans.map((id) => plan.documentFiles.find((f) => f.id === id)?.name ?? id),
      missing: missingPdfKeys(plan).slice(0, 200),
      ambiguous: Object.keys(plan.pdf.ambiguous),
    },
    samples: {
      contacts: plan.contacts
        .filter((c) => c.status === "new")
        .slice(0, 10)
        .map((c) => ({ key: c.key, number: c.number ?? null, name: c.name })),
      products: plan.products
        .filter((p) => p.status === "new")
        .slice(0, 10)
        .map((p) => ({ key: p.key, number: p.number, name: p.name })),
      documents: docSample,
    },
  };
}
export type PreviewSummary = ReturnType<typeof summarizePlan>;

/** Human-readable euro amount for messages. */
export const euroText = (cents: number) => `${formatCents(cents)} €`;
