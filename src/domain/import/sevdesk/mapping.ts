/**
 * sevdesk export import: header-name column mapping (F09 IMP-017, E-IMP-21) and file classification (IMP-016,
 * E-IMP-20). The importer never relies on column positions: each CSV file kind has target fields mapped to source
 * headers by normalised header name. The shipped `sevdesk-*` presets are best guesses.
 *
 * SEVDESK-LAYOUT-UNSURE: every header candidate, status label and file layout below is an assumption until the
 * owner provides sample exports (F09 §4.3, open item 9); the owner corrects the mapping in the UI.
 */
import {
  autoMapHeaders,
  CONTACT_IMPORT_FIELD_LABELS,
  CONTACT_IMPORT_FIELDS,
  type ContactImportField,
} from "../../contacts/csv-io";
import {
  autoMapProductHeaders,
  PRODUCT_IMPORT_FIELD_LABELS,
  PRODUCT_IMPORT_FIELDS,
  type ProductImportField,
} from "../../products/csv-io";
import { normalizeHeader } from "./formats";

export const IMPORT_FILE_KINDS = [
  "contacts",
  "products",
  "invoices",
  "vouchers",
  "datev",
  "pdf",
  "xml",
  "zip",
  "unknown",
] as const;
export type ImportFileKind = (typeof IMPORT_FILE_KINDS)[number];
/** CSV kinds the P1 importer maps and commits (vouchers and DATEV follow in P2, IMP-025/026). */
export type MappedCsvKind = "contacts" | "products" | "invoices";
export const isMappedCsvKind = (k: string): k is MappedCsvKind =>
  k === "contacts" || k === "products" || k === "invoices";

export const IMPORT_FILE_KIND_LABELS: Readonly<Record<ImportFileKind, string>> = {
  contacts: "Kontakte (CSV)",
  products: "Artikel (CSV)",
  invoices: "Rechnungsliste (CSV)",
  vouchers: "Belegliste (CSV, ab P2)",
  datev: "DATEV-Export (ab P2)",
  pdf: "Beleg-PDF",
  xml: "E-Rechnung (XML)",
  zip: "ZIP-Archiv",
  unknown: "Unbekannt",
};

// ── invoice list target fields (§4.3.1 row "Invoice list CSV") ─────────────────────────────────────────────

export const INVOICE_FIELDS = [
  "type",
  "number",
  "documentDate",
  "supplyDate",
  "dueDate",
  "sentOn",
  "customerNumber",
  "customerName",
  "net",
  "vat",
  "gross",
  "rate",
  "taxRule",
  "status",
  "paid",
  "open",
  "currency",
  "reference",
] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];
/** Per-rate amount columns (`net@1900`, `vat@700`, `gross@1900`) when the export splits amounts by VAT rate. */
export type PerRateField = `${"net" | "vat" | "gross"}@${number}`;
export type InvoiceTarget = InvoiceField | PerRateField;

export const INVOICE_FIELD_LABELS: Readonly<Record<InvoiceField, string>> = {
  type: "Belegart",
  number: "Rechnungsnummer",
  documentDate: "Rechnungsdatum",
  supplyDate: "Leistungsdatum",
  dueDate: "Fällig am",
  sentOn: "Versendet am",
  customerNumber: "Kundennummer",
  customerName: "Kunde",
  net: "Netto",
  vat: "Umsatzsteuer",
  gross: "Brutto",
  rate: "Steuersatz",
  taxRule: "Steuerregel",
  status: "Status",
  paid: "Bezahlter Betrag",
  open: "Offener Betrag",
  currency: "Währung",
  reference: "Bezug (Ursprungsrechnung)",
};

const REQUIRED_INVOICE: readonly InvoiceField[] = ["number", "documentDate", "gross"];

/** SEVDESK-LAYOUT-UNSURE: preset `sevdesk-invoices` — candidates in priority order (normalised). */
const INVOICE_CANDIDATES: Readonly<Record<InvoiceField, readonly string[]>> = {
  type: ["typ", "rechnungstyp", "belegart", "dokumenttyp", "art"],
  number: ["rechnungsnummer", "rechnungs nr", "rechnungsnr", "rechnung nr", "nummer", "belegnummer"],
  documentDate: ["rechnungsdatum", "datum", "belegdatum"],
  supplyDate: ["lieferdatum", "leistungsdatum", "liefer leistungsdatum"],
  dueDate: ["faellig am", "faelligkeit", "faelligkeitsdatum", "zahlungsziel datum"],
  sentOn: ["versendet am", "versanddatum", "versandt am", "gesendet am"],
  customerNumber: ["kundennummer", "kunden nr", "kundennr", "kontaktnummer"],
  customerName: ["kunde", "kundenname", "name", "empfaenger", "kontakt", "firma"],
  net: ["netto", "nettobetrag", "betrag netto", "summe netto"],
  vat: ["steuer", "ust", "mwst", "umsatzsteuer", "steuerbetrag", "ust betrag"],
  gross: ["brutto", "bruttobetrag", "betrag brutto", "summe brutto", "rechnungsbetrag", "betrag", "summe"],
  rate: ["steuersatz", "ust satz", "mwst satz", "umsatzsteuersatz"],
  taxRule: ["steuerregel", "umsatzsteuerart", "steuerart"],
  status: ["status", "rechnungsstatus"],
  paid: ["bezahlt", "bezahlter betrag", "bezahlt betrag", "gezahlt", "gezahlter betrag"],
  open: ["offen", "offener betrag", "restbetrag", "offener rechnungsbetrag"],
  currency: ["waehrung"],
  reference: ["bezug", "ursprungsrechnung", "referenz", "bezugsrechnung", "rechnungsbezug"],
};

const PER_RATE = /^(netto|ust|mwst|steuer|brutto) (\d{1,2})(?: (\d{1,2}))? ?%?$/;
const PER_RATE_FIELD: Readonly<Record<string, "net" | "vat" | "gross">> = {
  netto: "net",
  ust: "vat",
  mwst: "vat",
  steuer: "vat",
  brutto: "gross",
};

/** „Netto 19 %“ → `net@1900`; anything else → null. */
export function perRateTarget(header: string): PerRateField | null {
  const m = PER_RATE.exec(normalizeHeader(header));
  if (!m) return null;
  const kind = PER_RATE_FIELD[m[1] ?? ""];
  const bp = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return kind ? (`${kind}@${bp}` as PerRateField) : null;
}

export const parsePerRate = (target: string): { kind: "net" | "vat" | "gross"; rateBp: number } | null => {
  const m = /^(net|vat|gross)@(\d+)$/.exec(target);
  return m ? { kind: m[1] as "net" | "vat" | "gross", rateBp: Number(m[2]) } : null;
};

// ── generic mapping model ───────────────────────────────────────────────────────────────────────────────

export interface TargetFieldDef {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
}

/** Target fields per kind (required ones first in the UI). */
export function targetFields(kind: MappedCsvKind): TargetFieldDef[] {
  if (kind === "contacts") {
    return CONTACT_IMPORT_FIELDS.map((f) => ({ key: f, label: CONTACT_IMPORT_FIELD_LABELS[f], required: false }));
  }
  if (kind === "products") {
    return PRODUCT_IMPORT_FIELDS.map((f) => ({
      key: f,
      label: PRODUCT_IMPORT_FIELD_LABELS[f],
      required: f === "number" || f === "name",
    }));
  }
  return INVOICE_FIELDS.map((f) => ({
    key: f,
    label: INVOICE_FIELD_LABELS[f],
    required: REQUIRED_INVOICE.includes(f),
  }));
}

export function targetLabel(kind: MappedCsvKind, key: string): string {
  const pr = parsePerRate(key);
  if (pr) {
    const word = pr.kind === "net" ? "Netto" : pr.kind === "vat" ? "USt" : "Brutto";
    return `${word} ${String(pr.rateBp / 100).replace(".", ",")} %`;
  }
  return targetFields(kind).find((f) => f.key === key)?.label ?? key;
}

/** Target field → source header (exact header text as in the file). */
export type ColumnMapping = Readonly<Record<string, string>>;

export interface MappingCheck {
  /** Required targets without a header (E-IMP-21) — the file is blocked. */
  readonly missing: string[];
  /** Headers not mapped to any target (ignored, listed). */
  readonly unmapped: string[];
  /** Targets several headers would fit (the highest-priority one was taken; shown for review). */
  readonly conflicts: { target: string; headers: string[] }[];
  /** Mapped headers that do not exist in the file (a saved preset from another export). */
  readonly unknownHeaders: string[];
}

/** IMP-017: automatic mapping with the shipped preset of the kind. */
export function autoMap(kind: MappedCsvKind, headers: readonly string[]): ColumnMapping {
  const out: Record<string, string> = {};
  if (kind === "contacts" || kind === "products") {
    const fields: (ContactImportField | ProductImportField | null)[] =
      kind === "contacts" ? autoMapHeaders(headers) : autoMapProductHeaders(headers);
    fields.forEach((f, i) => {
      if (f && headers[i] !== undefined) out[f] = headers[i];
    });
    return out;
  }
  const normalised = headers.map(normalizeHeader);
  for (const field of INVOICE_FIELDS) {
    for (const candidate of INVOICE_CANDIDATES[field]) {
      const i = normalised.indexOf(candidate);
      if (i >= 0 && headers[i] !== undefined && !Object.values(out).includes(headers[i])) {
        out[field] = headers[i];
        break;
      }
    }
  }
  for (const h of headers) {
    const t = perRateTarget(h);
    if (t && !(t in out) && !Object.values(out).includes(h)) out[t] = h;
  }
  return out;
}

/** IMP-017: a saved preset (target → header) applied to a file by normalised header name. */
export function applyPreset(headers: readonly string[], columns: ColumnMapping): ColumnMapping {
  const byNorm = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const out: Record<string, string> = {};
  for (const [target, header] of Object.entries(columns)) {
    const hit = byNorm.get(normalizeHeader(header));
    if (hit !== undefined) out[target] = hit;
  }
  return out;
}

export function checkMapping(kind: MappedCsvKind, headers: readonly string[], mapping: ColumnMapping): MappingCheck {
  const mapped = new Set(Object.values(mapping));
  const known = new Set(headers);
  const missing = targetFields(kind)
    .filter((f) => f.required && !mapping[f.key])
    .map((f) => f.key);
  if (kind === "contacts" && !mapping.organizationName && !mapping.lastName) missing.push("organizationName");
  // Per-rate amount columns replace the total gross column.
  const perRate = Object.keys(mapping).some((k) => parsePerRate(k) !== null);
  if (kind === "invoices" && perRate && missing.includes("gross")) missing.splice(missing.indexOf("gross"), 1);
  const conflicts: { target: string; headers: string[] }[] = [];
  if (kind === "invoices") {
    const normalised = headers.map(normalizeHeader);
    for (const field of INVOICE_FIELDS) {
      const fits = headers.filter((_, i) => INVOICE_CANDIDATES[field].includes(normalised[i] ?? ""));
      if (fits.length > 1) conflicts.push({ target: field, headers: fits });
    }
  }
  return {
    missing,
    unmapped: headers.filter((h) => h !== "" && !mapped.has(h)),
    conflicts,
    unknownHeaders: [...mapped].filter((h) => !known.has(h)),
  };
}

/** E-IMP-21 message. */
export const missingColumnMessage = (fileName: string, kind: MappedCsvKind, target: string): string =>
  `In ${fileName} fehlt die Spalte für ${targetLabel(kind, target)}. Bitte Spaltenzuordnung ergänzen.`;

/** Mapping (target → header) as the position array the contact/product row mappers take. */
export function positionalMapping<F extends string>(headers: readonly string[], mapping: ColumnMapping): (F | null)[] {
  const byHeader = new Map(Object.entries(mapping).map(([target, header]) => [header, target as F]));
  const used = new Set<string>();
  return headers.map((h) => {
    const t = byHeader.get(h);
    if (!t || used.has(h)) return null;
    used.add(h);
    return t;
  });
}

// ── classification (IMP-016 §4.3.1 "detection" column) ─────────────────────────────────────────────────

const has = (normalised: readonly string[], candidates: readonly string[]) =>
  normalised.some((h) => candidates.includes(h));

/**
 * IMP-016: kind of an uploaded file from magic bytes, extension and (CSV) headers. `headers` is undefined for
 * files that are not readable as CSV. Unknown files are listed and ignored unless the owner assigns a kind
 * (E-IMP-20).
 */
export function classifyFile(input: {
  name: string;
  head: Uint8Array;
  firstLine?: string;
  headers?: readonly string[];
}): ImportFileKind {
  const h = input.head;
  const ascii = String.fromCharCode(...h.subarray(0, 8));
  const ext = (/\.([a-z0-9]+)$/i.exec(input.name)?.[1] ?? "").toLowerCase();
  if (ascii.startsWith("%PDF-")) return "pdf";
  if (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) return "zip";
  if (ext === "xml" || /^\s*(﻿)?<\?xml/.test(input.firstLine ?? "")) return "xml";
  if (/^\s*﻿?"?EXTF"?[;,]/.test(input.firstLine ?? "")) return "datev";
  if (!input.headers) return "unknown";
  const n = input.headers.map(normalizeHeader);
  const invoiceNumber = has(n, ["rechnungsnummer", "rechnungs nr", "rechnungsnr", "rechnung nr"]);
  const gross = has(n, INVOICE_CANDIDATES.gross) || n.some((x) => /^brutto \d/.test(x));
  const date = has(n, INVOICE_CANDIDATES.documentDate);
  if (invoiceNumber && gross && date) return "invoices";
  if (has(n, ["belegnummer", "belegdatum"]) && has(n, ["lieferant", "kreditor"])) return "vouchers";
  if (has(n, ["nummer"]) && gross && date && has(n, ["typ", "rechnungstyp", "belegart"])) return "invoices";
  const articleNumber = has(n, ["artikelnummer", "artikel nr", "artikelnr", "produktnummer"]);
  if (articleNumber && n.some((x) => x.includes("preis"))) return "products";
  const customerNumber = has(n, ["kundennummer", "kunden nr", "kundennr", "kontaktnummer"]);
  const name = has(n, ["name", "firma", "organisation", "nachname", "firmenname"]);
  if (customerNumber && name && !gross) return "contacts";
  return "unknown";
}
