/**
 * Generic CSV import for contacts and products (F09 IMP-012, GOBD-03): one CSV file per import project
 * (`imports.source = "generic_csv"`), decoded with the shared reader (encoding UTF-8/Windows-1252, delimiter
 * detection — src/domain/csv), mapped by header name (saved presets, IMP-017 model), validated row by row with the
 * same schemas as the REST API and the UI forms (`contactCreateSchema`, `productSchema` via the F02/F03 row mappers),
 * then planned against the local data:
 *
 *   new        — will be created at commit
 *   skip       — already imported: the idempotency key SHA-256(preset, key column value) is in `importedRecords`
 *   existing   — the same contact/product already exists (number → USt-IdNr → e-mail; products: article number)
 *   update     — contacts with the option „Vorhandene Kontakte aktualisieren“ (E-IMP-17): the mapped, non-empty
 *                Stammdaten of the row are written onto the existing contact (number, addresses and channels stay)
 *   duplicate  — the same key appears earlier in the file
 *   error      — the row fails validation (listed, exported as error CSV, not imported)
 *
 * Invalid rows do not block the commit: the preview lists them and the commit creates the rest (TST-IMP-12).
 * Pure apart from the WebCrypto SHA-256 (async), like the audit chain.
 */
import { canonicalize } from "../../audit/canonical";
import { sha256Hex } from "../../audit/chain";
import { foldSearch, normalizeContactNumber } from "../../contacts/core";
import { type ImportRowValues, rowToFormValues } from "../../contacts/csv-io";
import { type CsvRecord, writeCsv } from "../../csv/csv";
import { normalizeNumber } from "../../numbering/format";
import { productImportForm, productRow } from "../../products/csv-io";
import { type ContactFormValues, contactCreateSchema, emptyContactForm } from "../../schemas/contacts";
import { productSchema } from "../../schemas/products";
import { importPrivacyNotice } from "../privacy-notice";
import { type ColumnMapping, checkMapping, type MappingCheck, positionalMapping } from "../sevdesk/mapping";

export const GENERIC_CSV_IMPORTER_VERSION = "generic-csv-import@1";
export const GENERIC_TARGETS = ["contacts", "products"] as const;
export type GenericTarget = (typeof GENERIC_TARGETS)[number];
export const isGenericTarget = (v: string): v is GenericTarget => (GENERIC_TARGETS as readonly string[]).includes(v);

export const GENERIC_TARGET_LABELS: Readonly<Record<GenericTarget, string>> = {
  contacts: "Kontakte",
  products: "Produkte",
};

/** `importedRecords.externalType` per target (the externalId is the idempotency key). */
export const GENERIC_EXTERNAL_TYPES: Readonly<Record<GenericTarget, string>> = {
  contacts: "generic_csv:contact",
  products: "generic_csv:product",
};

/** Preset name used in the idempotency key when the owner maps without a saved preset. */
export const presetLabel = (target: GenericTarget, preset?: string): string =>
  preset?.trim() ? preset.trim() : `ohne Vorlage (${GENERIC_TARGET_LABELS[target]})`;

/** IMP-012: idempotency key = SHA-256 of (preset, key column value). */
export const idempotencyKey = (preset: string, keyValue: string): Promise<string> =>
  sha256Hex(canonicalize([preset, keyValue]));

/** Required columns (E-IMP-21 semantics): products need number + name, contacts a company or last name column. */
export function checkGenericMapping(
  target: GenericTarget,
  headers: readonly string[],
  mapping: ColumnMapping,
): MappingCheck {
  return checkMapping(target, headers, mapping);
}

export type GenericRowStatus = "new" | "skip" | "existing" | "update" | "duplicate" | "error";

export const GENERIC_STATUS_LABELS: Readonly<Record<GenericRowStatus, string>> = {
  new: "Neu",
  skip: "Bereits importiert",
  existing: "Existiert bereits",
  update: "Wird aktualisiert",
  duplicate: "Doppelt in der Datei",
  error: "Fehler",
};

interface RowKeys {
  readonly number?: string;
  readonly email?: string;
  readonly vatId?: string;
}

export interface ParsedGenericRow {
  readonly line: number;
  readonly cells: readonly string[];
  /** Validation error („Zeile n: …“); set → the row is not imported. */
  readonly error?: string;
  readonly display: string;
  readonly keys: RowKeys;
  /** The key column value (`number:K-1`, `email:…`, `vatId:…`, `name:<folded>|<plz>`). */
  readonly keyValue: string;
  /** Contacts: create-form values (contactCreateSchema input); products: product form (productSchema input). */
  readonly values?: ImportRowValues | ReturnType<typeof productImportForm>;
  readonly categoryPath?: string;
  readonly idempotencyKey?: string;
}

const lower = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();
const normVatId = (v: unknown) =>
  String(v ?? "")
    .toUpperCase()
    .replace(/[\s.-]/g, "");

function issueText(line: number, issues: readonly { message: string; path: readonly PropertyKey[] }[]): string {
  const i = issues[0];
  const path = i?.path.length ? ` (${i.path.map(String).join(".")})` : "";
  return `Zeile ${line}: ${i?.message ?? "Ungültige Zeile."}${path}`;
}

/** Step 1: every record → validated values and its dedupe keys (no local data needed). */
export function parseGenericRows(
  target: GenericTarget,
  table: { headers: readonly string[]; records: readonly CsvRecord[] },
  mapping: ColumnMapping,
  rateBpToday: (key: string) => number | undefined,
): ParsedGenericRow[] {
  const positions = positionalMapping<string>(table.headers, mapping);
  return table.records.map((record): ParsedGenericRow => {
    const { line, cells } = record;
    if (target === "contacts") {
      const values = rowToFormValues(cells, positions as Parameters<typeof rowToFormValues>[1], emptyContactForm());
      const c = values.contact;
      const display = values.billingAddress.name ?? "";
      const keys: RowKeys = {
        ...(String(c.number ?? "").trim() ? { number: normalizeContactNumber(String(c.number)) } : {}),
        ...(lower(values.channels.find((ch) => ch.type === "email")?.value)
          ? { email: lower(values.channels.find((ch) => ch.type === "email")?.value) }
          : {}),
        ...(normVatId(c.vatId) ? { vatId: normVatId(c.vatId) } : {}),
      };
      const keyValue = keys.number
        ? `number:${keys.number}`
        : keys.email
          ? `email:${keys.email}`
          : keys.vatId
            ? `vatId:${keys.vatId}`
            : `name:${foldSearch(display)}|${(values.billingAddress.postalCode ?? "").trim()}`;
      const parsed = contactCreateSchema.safeParse(values);
      if (!parsed.success) return { line, cells, display, keys, keyValue, error: issueText(line, parsed.error.issues) };
      return { line, cells, display, keys, keyValue, values };
    }
    const r = productRow(cells, positions as Parameters<typeof productRow>[1], line, rateBpToday);
    const number = r.values?.number.trim() ?? "";
    const display = r.values?.name ?? "";
    const keys: RowKeys = number ? { number: normalizeNumber(number) } : {};
    const keyValue = number ? `number:${normalizeNumber(number)}` : "";
    if (!r.values) {
      return { line, cells, display, keys, keyValue, error: r.errors.map((e) => e.message).join(" ") };
    }
    if (!number) {
      return {
        line,
        cells,
        display,
        keys,
        keyValue,
        error: `Zeile ${line}: Artikelnummer fehlt (sie ist der Schlüssel für wiederholte Importe).`,
      };
    }
    const form = productImportForm(r.values, "");
    const check = productSchema.safeParse(form);
    if (!check.success) return { line, cells, display, keys, keyValue, error: issueText(line, check.error.issues) };
    return { line, cells, display, keys, keyValue, values: form, categoryPath: r.values.categoryPath };
  });
}

/** Adds the idempotency key to every valid row. */
export async function withIdempotencyKeys(
  rows: readonly ParsedGenericRow[],
  preset: string,
): Promise<ParsedGenericRow[]> {
  return Promise.all(
    rows.map(async (r) => (r.error ? r : { ...r, idempotencyKey: await idempotencyKey(preset, r.keyValue) })),
  );
}

/** What the local snapshot must contain (read-only lookups; business tables are never touched by a preview). */
export interface GenericLookupKeys {
  readonly idempotencyKeys: string[];
  readonly numbers: string[];
  readonly emails: string[];
  readonly vatIds: string[];
}

export function genericKeys(rows: readonly ParsedGenericRow[]): GenericLookupKeys {
  const valid = rows.filter((r) => !r.error);
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  return {
    idempotencyKeys: uniq(valid.map((r) => r.idempotencyKey)),
    numbers: uniq(valid.map((r) => r.keys.number)),
    emails: uniq(valid.map((r) => r.keys.email)),
    vatIds: uniq(valid.map((r) => r.keys.vatId)),
  };
}

/** Local matches by key (values: local ids). Contacts by normalised number / upper-case VAT ID / lower-case e-mail. */
export interface GenericLocalState {
  readonly imported: Readonly<Record<string, string>>;
  readonly contactsByNumber: Readonly<Record<string, string>>;
  readonly contactsByEmail: Readonly<Record<string, string>>;
  readonly contactsByVatId: Readonly<Record<string, string>>;
  readonly productsByNumber: Readonly<Record<string, string>>;
  /** Contact number per local contact id (E-IMP-17 message „Kontakt existiert bereits ({nr})“). */
  readonly contactNumbers?: Readonly<Record<string, string>>;
}

/** E-IMP-17: what happens to rows matching an existing contact (products are always skipped). */
export type OnExisting = "skip" | "update";

export interface PlannedGenericRow extends ParsedGenericRow {
  readonly status: GenericRowStatus;
  readonly message?: string;
  /** Local record the row duplicates / was imported as. */
  readonly localId?: string;
}

export interface GenericPlan {
  readonly target: GenericTarget;
  readonly rows: PlannedGenericRow[];
  readonly counts: {
    rows: number;
    new: number;
    existing: number;
    updates: number;
    skipped: number;
    duplicates: number;
    errors: number;
  };
}

const KEY_LABELS = { number: "Nummer", vatId: "USt-IdNr", email: "E-Mail-Adresse", name: "Name und PLZ" } as const;

/** Step 2: plan every row against the local data (IMP-012 dedupe by number / e-mail / USt-IdNr, IMP-006 skip). */
export function buildGenericPlan(
  target: GenericTarget,
  rows: readonly ParsedGenericRow[],
  local: GenericLocalState,
  options: { onExisting?: OnExisting } = {},
): GenericPlan {
  const update = target === "contacts" && options.onExisting === "update";
  const seen = new Map<string, number>();
  const planned = rows.map((r): PlannedGenericRow => {
    if (r.error) return { ...r, status: "error", message: r.error };
    const imported = r.idempotencyKey ? local.imported[r.idempotencyKey] : undefined;
    if (imported) {
      return { ...r, status: "skip", localId: imported, message: `Zeile ${r.line} wurde bereits importiert.` };
    }
    // In-file duplicates (same number, USt-IdNr or e-mail as an earlier row; products: article number).
    const fileKeys: [keyof typeof KEY_LABELS, string | undefined][] =
      target === "contacts"
        ? [
            ["number", r.keys.number],
            ["vatId", r.keys.vatId],
            ["email", r.keys.email],
          ]
        : [["number", r.keys.number]];
    if (!r.keys.number && !r.keys.vatId && !r.keys.email) fileKeys.push(["name", r.keyValue]);
    for (const [k, value] of fileKeys) {
      if (!value) continue;
      const first = seen.get(`${k}|${value}`);
      if (first !== undefined) {
        const label = k === "number" ? (target === "products" ? "Artikelnummer" : "Kontaktnummer") : KEY_LABELS[k];
        return { ...r, status: "duplicate", message: `Zeile ${r.line} hat dieselbe ${label} wie Zeile ${first}.` };
      }
    }
    for (const [k, value] of fileKeys) if (value) seen.set(`${k}|${value}`, r.line);
    // Existing data (CON-141 match order: number → USt-IdNr → e-mail).
    const hit: [string | undefined, string][] =
      target === "contacts"
        ? [
            [r.keys.number ? local.contactsByNumber[r.keys.number] : undefined, `Kontaktnummer ${r.keys.number}`],
            [r.keys.vatId ? local.contactsByVatId[r.keys.vatId] : undefined, `USt-IdNr ${r.keys.vatId}`],
            [r.keys.email ? local.contactsByEmail[r.keys.email] : undefined, `E-Mail-Adresse ${r.keys.email}`],
          ]
        : [[r.keys.number ? local.productsByNumber[r.keys.number] : undefined, `Artikelnummer ${r.keys.number}`]];
    const match = hit.find(([id]) => id !== undefined);
    if (match?.[0] && target === "contacts") {
      // E-IMP-17: „Zeile {n}: Kontakt existiert bereits ({nr}).“ — skipped or updated per option.
      const nr = local.contactNumbers?.[match[0]] ?? match[1];
      const message = `Zeile ${r.line}: Kontakt existiert bereits (${nr}).`;
      return update
        ? { ...r, status: "update", localId: match[0], message: `${message} Die Stammdaten werden aktualisiert.` }
        : { ...r, status: "existing", localId: match[0], message };
    }
    if (match?.[0]) {
      return {
        ...r,
        status: "existing",
        localId: match[0],
        message: `Zeile ${r.line}: ${match[1]} existiert bereits – wird nicht erneut angelegt.`,
      };
    }
    return { ...r, status: "new" };
  });
  const count = (s: GenericRowStatus) => planned.filter((r) => r.status === s).length;
  return {
    target,
    rows: planned,
    counts: {
      rows: planned.length,
      new: count("new"),
      existing: count("existing"),
      updates: count("update"),
      skipped: count("skip"),
      duplicates: count("duplicate"),
      errors: count("error"),
    },
  };
}

/** Rows listed in the preview (and the error CSV): everything that is not created. */
export interface GenericProblem {
  readonly line: number;
  readonly status: Exclude<GenericRowStatus, "new">;
  readonly message: string;
  readonly cells: readonly string[];
}

/** IMP-009-style stored preview: counts, 10 samples, the not-imported rows (≤ `limit`). */
export function summarizeGenericPlan(plan: GenericPlan, limit = 1000) {
  const problems: GenericProblem[] = plan.rows
    .filter((r): r is PlannedGenericRow & { status: GenericProblem["status"] } => r.status !== "new")
    .map((r) => ({ line: r.line, status: r.status, message: r.message ?? "", cells: [...r.cells] }));
  return {
    target: plan.target,
    counts: plan.counts,
    samples: plan.rows
      .filter((r) => r.status === "new")
      .slice(0, 10)
      .map((r) => ({ line: r.line, display: r.display, key: r.keyValue })),
    problems: problems.slice(0, limit),
    problemsTotal: problems.length,
    /** E-IMP-18 (DSGVO Art. 14): personal data from another system → note the source in the processing record. */
    notices: plan.target === "contacts" ? [importPrivacyNotice("einem anderen System (CSV-Datei)")] : [],
  };
}
export type GenericPreviewSummary = ReturnType<typeof summarizeGenericPlan>;

/** Preview hash input: file, target, mapping, preset and the per-row decisions (a changed local state → stale). */
export function genericPreviewHashInput(input: {
  fileSha256: string;
  target: GenericTarget;
  columns: ColumnMapping;
  preset: string;
  plan: GenericPlan;
  onExisting?: OnExisting;
}): string {
  return canonicalize({
    file: input.fileSha256,
    target: input.target,
    columns: input.columns,
    preset: input.preset,
    ...(input.onExisting === "update" ? { onExisting: "update" } : {}),
    rows: input.plan.rows.map((r) => [r.line, r.status, r.idempotencyKey ?? null, r.localId ?? null]),
  });
}

/** „Fehler-CSV herunterladen“: line, status and message in front of the original cells (UTF-8 BOM, `;`). */
export function genericErrorCsv(headers: readonly string[], problems: readonly GenericProblem[]): string {
  return writeCsv(
    ["Zeile", "Status", "Meldung", ...headers],
    problems.map((p) => [p.line, GENERIC_STATUS_LABELS[p.status], p.message, ...p.cells]),
  );
}

/** Contact form keys an import column can update (Stammdaten only; the number is the identity and never changes). */
const UPDATABLE_CONTACT_KEYS = new Set<string>(
  Object.keys(emptyContactForm()).filter((k) => k !== "number" && k !== "status" && k !== "parentId"),
);

/**
 * E-IMP-17 „Aktualisieren“: the existing contact's form with every mapped column of the row that carries a value
 * (an empty cell never clears a field). Addresses and communication channels are not touched. `null` = no change.
 */
export function mergeImportedContact(
  existing: ContactFormValues,
  row: ImportRowValues,
  mappedFields: readonly string[],
): ContactFormValues | null {
  const empty = emptyContactForm() as unknown as Record<string, unknown>;
  const incoming = row.contact as unknown as Record<string, unknown>;
  const next = { ...existing } as unknown as Record<string, unknown>;
  let changed = false;
  for (const key of mappedFields) {
    if (!UPDATABLE_CONTACT_KEYS.has(key) || !(key in incoming)) continue;
    const value = incoming[key];
    if (JSON.stringify(value) === JSON.stringify(empty[key])) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (JSON.stringify(value) === JSON.stringify(next[key])) continue;
    next[key] = value;
    changed = true;
  }
  return changed ? (next as unknown as ContactFormValues) : null;
}
