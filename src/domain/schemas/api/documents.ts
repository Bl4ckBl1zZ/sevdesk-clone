import { z } from "zod";
import type {} from "zod-openapi";
import { type DocumentIdType, decodeDocumentId, decodeId, encodeDocumentId, encodeId } from "../../api/ids";
import { snakeCase } from "../../api/problems";
import type { DisplayStatusResult } from "../../documents/display-status";
import type { DraftType } from "../../documents/doc-types";
import type { SalesDocType } from "../../documents/snapshot";
import { TAX_CASES } from "../../tax/tax-case";
import { ACCEPTANCE_CHANNELS, CONVERSION_TARGETS, type DraftValues } from "../documents";
import { decimalString, decimalToScaled, isoDate, listEnvelope, listQuery, scaledToDecimal, toInstant } from "./common";

/**
 * Sales documents on the wire (05 §3, §4.3; F04 §7.1): snake_case, quantities as decimal strings with ≤ 3 decimals,
 * unit prices with ≤ 4, money in `*_cents`, dates `YYYY-MM-DD`, IDs prefixed by type (`quo_`, `ord_`, `dln_`, `inv_`).
 * The wire maps onto the shared draft schema (src/domain/schemas/documents.ts), so REST, MCP and the UI share one
 * validation; every rule runs in Convex.
 */

// ── resources ────────────────────────────────────────────────────────────────────────────────────────
export interface DocumentResourceDef {
  /** URL segment below /api/v1. */
  readonly path: "quotes" | "order-confirmations" | "delivery-notes" | "invoices";
  /** Draft types this resource serves (invoices: standard and proforma in this slice). */
  readonly types: readonly DraftType[];
  readonly idType: DocumentIdType;
  readonly tag: string;
  readonly singular: string;
  readonly plural: string;
  readonly schemaPrefix: string;
}

export const DOCUMENT_RESOURCES: readonly DocumentResourceDef[] = [
  {
    path: "quotes",
    types: ["quote"],
    idType: "quote",
    tag: "Angebote",
    singular: "Angebot",
    plural: "Angebote",
    schemaPrefix: "Quote",
  },
  {
    path: "order-confirmations",
    types: ["order_confirmation"],
    idType: "order_confirmation",
    tag: "Auftragsbestätigungen",
    singular: "Auftragsbestätigung",
    plural: "Auftragsbestätigungen",
    schemaPrefix: "OrderConfirmation",
  },
  {
    path: "delivery-notes",
    types: ["delivery_note"],
    idType: "delivery_note",
    tag: "Lieferscheine",
    singular: "Lieferschein",
    plural: "Lieferscheine",
    schemaPrefix: "DeliveryNote",
  },
  {
    path: "invoices",
    types: ["invoice", "proforma"],
    idType: "invoice",
    tag: "Rechnungen",
    singular: "Rechnung",
    plural: "Rechnungen",
    schemaPrefix: "Invoice",
  },
];

/** The resource of a document type (for links between documents of different resources). */
export const resourceOf = (type: SalesDocType): DocumentResourceDef | undefined =>
  DOCUMENT_RESOURCES.find((r) => (r.types as readonly string[]).includes(type));

/** `invoice_type` of the invoices resource (05 §4.3; advance/partial/final/cancellation follow with their slices). */
export const INVOICE_TYPES_WIRE = ["standard", "proforma"] as const;
const invoiceTypeOf = (t: SalesDocType) => (t === "proforma" ? "proforma" : t === "invoice" ? "standard" : t);

export function encodeDoc(type: SalesDocType, id: string): string {
  return encodeDocumentId(type as DocumentIdType, id);
}

export function decodeDoc(res: DocumentResourceDef, value: string): string | null {
  return decodeDocumentId(res.idType, value);
}

/** Decodes a document ID of any sales-document prefix (delivery notes of a collective invoice). */
export function decodeAnyDoc(value: string, type: DocumentIdType): string | null {
  return decodeDocumentId(type, value);
}

// ── input ────────────────────────────────────────────────────────────────────────────────────────────
const str = (max: number) => z.string().max(max);

const supplyDateWire = z
  .union([
    z.object({ kind: z.literal("date"), date: isoDate }),
    z.object({ kind: z.literal("period"), from: isoDate, to: isoDate }),
    z.object({ kind: z.literal("month"), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
    z.literal("same_as_document_date"),
  ])
  .meta({ description: 'Leistungsdatum/-zeitraum oder "same_as_document_date"' });

export const documentLineWire = z
  .object({
    kind: z.enum(["item", "heading", "text", "subtotal"]).default("item"),
    product_id: str(80).optional().meta({ description: "prd_… — übernimmt Name, Preis, Einheit, Steuerschlüssel" }),
    name: str(5000).optional(),
    description: str(20_000).optional(),
    quantity: decimalString(3, "Menge (≤ 3 Nachkommastellen)", "10").optional(),
    unit_code: str(10).optional().meta({ example: "HUR", description: "UN/ECE-Einheit (Standard C62 = Stück)" }),
    unit_price: decimalString(4, "Einzelpreis (netto oder brutto je price_mode)", "95.00").optional(),
    discount_percent: decimalString(2, "Positionsrabatt in Prozent", "10").optional(),
    vat_rate_key: str(40).optional().meta({ example: "standard" }),
    product_type: z.enum(["good", "service"]).optional(),
    reverse_charge_13b: str(40).optional(),
    line_period: z.object({ from: isoDate, to: isoDate }).optional(),
    optional: z.boolean().optional().meta({ description: "Nur Angebote: optionale Position (nicht in der Summe)" }),
    is_labor_cost: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "DocumentLineInput" });
export type DocumentLineWire = z.infer<typeof documentLineWire>;

const documentFieldsWire = {
  contact_id: str(80).optional().meta({ description: "con_…" }),
  invoice_type: z.enum(INVOICE_TYPES_WIRE).optional().meta({ description: "Nur /invoices: standard oder proforma" }),
  document_date: isoDate.optional().meta({ description: "Belegdatum (Standard: Tag der Fertigstellung)" }),
  supply_date: supplyDateWire.optional(),
  price_mode: z.enum(["net", "gross"]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  language: z.enum(["de", "en"]).optional(),
  subject: str(5000).optional(),
  head_text: str(100_000).optional(),
  foot_text: str(100_000).optional(),
  buyer_reference: str(1000).optional(),
  order_reference: str(1000).optional(),
  contract_reference: str(1000).optional(),
  payment_terms: z
    .object({
      due_days: z.number().int().min(0).max(3650),
      skonto_percent: decimalString(2, "Skonto in Prozent", "2").optional(),
      skonto_days: z.number().int().min(0).max(3650).optional(),
    })
    .optional(),
  valid_until: isoDate.optional().meta({ description: "Nur Angebote (QUO-01)" }),
  delivery_terms: str(5000).optional().meta({ description: "Angebote und Auftragsbestätigungen" }),
  show_prices: z.boolean().optional().meta({ description: "Nur Lieferscheine: Preise drucken (QUO-09)" }),
  tax_case_override: z
    .object({ tax_case: z.enum(TAX_CASES).exclude(["unknown_imported"]), reason: str(1000) })
    .optional(),
  internal_note: str(10_000).optional(),
};

export const documentCreateWire = z
  .object({ ...documentFieldsWire, lines: z.array(documentLineWire).max(2500) })
  .strict()
  .meta({ id: "DocumentCreate" });
export type DocumentCreateWire = z.infer<typeof documentCreateWire>;

export const documentPatchWire = z
  .object({
    ...documentFieldsWire,
    lines: z.array(documentLineWire).max(2500).optional().meta({ description: "Ersetzt alle Positionen" }),
    version: z.number().int().min(1).optional(),
  })
  .strict()
  .meta({ id: "DocumentPatch" });
export type DocumentPatchWire = z.infer<typeof documentPatchWire>;

export const finalizeWire = z
  .object({
    version: z.number().int().min(1),
    document_date: isoDate.optional(),
    backdate_reason: str(1000).optional(),
    overrides: z
      .object({ vat_id_unverified_reason: str(1000).optional(), rc13b_confirmation: str(1000).optional() })
      .optional(),
  })
  .strict()
  .meta({ id: "DocumentFinalize" });

export const convertWire = z
  .object({
    to: z.enum(CONVERSION_TARGETS),
    mode: z.enum(["full", "quantities"]).optional(),
    lines: z
      .array(z.object({ source_line_id: str(80), quantity: decimalString(3, "Menge", "4") }))
      .max(2500)
      .optional(),
    optional_line_ids: z.array(str(80)).max(2500).optional(),
    accept_source: z.boolean().optional().meta({ description: "Angebot vor dem Umwandeln als angenommen markieren" }),
    delivery_note_ids: z
      .array(str(80))
      .max(200)
      .optional()
      .meta({ description: "Nur Lieferscheine: weitere Lieferscheine für eine Sammelrechnung (QUO-11)" }),
  })
  .strict()
  .meta({ id: "DocumentConvert" });

export const acceptWire = z
  .object({
    date: isoDate,
    accepted_by: str(250).min(1),
    channel: z.enum(ACCEPTANCE_CHANNELS),
    note: str(2000).optional(),
    late: z.boolean().optional().meta({ description: "Abgelaufenes Angebot trotzdem annehmen" }),
  })
  .strict()
  .meta({ id: "QuoteAccept" });

export const rejectWire = z
  .object({ date: isoDate, reason: str(2000).optional() })
  .strict()
  .meta({ id: "QuoteReject" });
export const reasonWire = z
  .object({ reason: str(2000).min(3) })
  .strict()
  .meta({ id: "Reason" });
export const reviseWire = z
  .object({ reason: str(2000).optional() })
  .strict()
  .meta({ id: "QuoteRevise" });
export const receivedWire = z
  .object({ date: isoDate, received_by: str(250).min(1) })
  .strict()
  .meta({ id: "DeliveryNoteReceived" });

export const documentListQuery = listQuery.omit({ updated_since: true }).extend({
  status: str(40).optional().meta({ description: "Gespeicherter Status (draft, finalized, sent, accepted, …)" }),
  contact_id: str(80).optional(),
  q: str(200).optional().meta({ description: "Kundenname" }),
  invoice_type: z.enum(INVOICE_TYPES_WIRE).optional(),
});

// ── wire → draft ─────────────────────────────────────────────────────────────────────────────────────
export interface WireIssue {
  field: string;
  message: string;
}

export interface DraftDefaults {
  currency: string;
  language: "de" | "en";
  priceMode: "net" | "gross";
  paymentTerms: { dueDays: number; skontoPercentBp?: number; skontoDays?: number };
}

/** One wire line → draft line; product lines are merged with the product's values by the caller. */
export function lineToDraft(l: DocumentLineWire, i: number, issues: WireIssue[]): DraftValues["lines"][number] {
  const out: Record<string, unknown> = { kind: l.kind };
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== "") out[k] = v;
  };
  if (l.product_id) {
    const raw = decodeId("products", l.product_id);
    if (!raw) issues.push({ field: `lines[${i}].product_id`, message: "Unbekannte Produkt-ID." });
    else out.productId = raw;
  }
  set("name", l.name);
  set("description", l.description);
  if (l.quantity !== undefined) set("quantityMilli", decimalToScaled(l.quantity, 3));
  set("unitCode", l.unit_code ?? (l.kind === "item" && !l.product_id ? "C62" : undefined));
  if (l.unit_price !== undefined) set("unitPriceMicros", decimalToScaled(l.unit_price, 4));
  if (l.discount_percent !== undefined) {
    const bp = decimalToScaled(l.discount_percent, 2);
    if (bp !== null && bp > 0) out.discount = { kind: "percent", valueBp: bp };
  }
  set("vatRateKey", l.vat_rate_key ?? (l.kind === "item" && !l.product_id ? "standard" : undefined));
  set("productType", l.product_type ?? (l.kind === "item" && !l.product_id ? "service" : undefined));
  set("reverseCharge13b", l.reverse_charge_13b);
  set("linePeriod", l.line_period);
  if (l.optional) out.optional = true;
  if (l.is_labor_cost) out.isLaborCost = true;
  return out as DraftValues["lines"][number];
}

/** Wire body (create, or a patch merged onto the current values) → the shared draft body. */
export function wireToDraft(
  w: Omit<DocumentCreateWire, "lines"> & { lines: DraftValues["lines"] },
  type: DraftType,
  defaults: DraftDefaults,
  base?: DraftValues,
): { values: DraftValues; issues: WireIssue[] } {
  const issues: WireIssue[] = [];
  let contactId = base?.contactId;
  if (w.contact_id !== undefined) {
    const raw = decodeId("contacts", w.contact_id);
    if (!raw) issues.push({ field: "contact_id", message: "Unbekannte Kontakt-ID." });
    else contactId = raw;
  }
  const supply = w.supply_date;
  const supplyPart: Pick<DraftValues, "supplyDate" | "supplyDateMode"> =
    supply === undefined
      ? base
        ? { supplyDateMode: base.supplyDateMode, ...(base.supplyDate ? { supplyDate: base.supplyDate } : {}) }
        : { supplyDateMode: "explicit" }
      : supply === "same_as_document_date"
        ? { supplyDateMode: "document_date" }
        : { supplyDateMode: "explicit", supplyDate: supply as DraftValues["supplyDate"] & object };
  const terms = w.payment_terms
    ? {
        dueDays: w.payment_terms.due_days,
        ...(w.payment_terms.skonto_percent
          ? { skontoPercentBp: decimalToScaled(w.payment_terms.skonto_percent, 2) ?? 0 }
          : {}),
        ...(w.payment_terms.skonto_days !== undefined ? { skontoDays: w.payment_terms.skonto_days } : {}),
      }
    : (base?.paymentTerms ?? defaults.paymentTerms);
  const pick = <K extends keyof DraftValues>(key: K, wire: DraftValues[K] | undefined) =>
    wire !== undefined ? (wire === "" ? {} : { [key]: wire }) : base?.[key] !== undefined ? { [key]: base[key] } : {};
  const values = {
    ...(base ?? {}),
    type,
    ...(contactId ? { contactId } : {}),
    ...supplyPart,
    currency: w.currency ?? base?.currency ?? defaults.currency,
    priceMode: w.price_mode ?? base?.priceMode ?? defaults.priceMode,
    language: w.language ?? base?.language ?? defaults.language,
    paymentTerms: terms,
    showEpcQr: base?.showEpcQr ?? true,
    ...pick("documentDate", w.document_date as DraftValues["documentDate"]),
    ...pick("subject", w.subject),
    ...pick("headText", w.head_text),
    ...pick("footText", w.foot_text),
    ...pick("buyerReference", w.buyer_reference),
    ...pick("orderReference", w.order_reference),
    ...pick("contractReference", w.contract_reference),
    ...pick("validUntil", w.valid_until as DraftValues["validUntil"]),
    ...pick("deliveryTerms", w.delivery_terms),
    ...pick("showPrices", w.show_prices),
    ...pick("internalNote", w.internal_note),
    ...(w.tax_case_override
      ? { taxCaseOverride: { taxCase: w.tax_case_override.tax_case, reason: w.tax_case_override.reason } }
      : {}),
    lines: w.lines,
  } as DraftValues;
  if (supply === undefined && !base) delete (values as { supplyDate?: unknown }).supplyDate;
  return { values, issues };
}

// ── draft/document → wire ────────────────────────────────────────────────────────────────────────────
export interface DocumentRecord {
  _id: string;
  _creationTime: number;
  type: SalesDocType;
  status: string;
  number?: string;
  revision?: number;
  contactId?: string;
  contactName?: string;
  documentDate?: string;
  supplyDate?: unknown;
  supplyDateMode: string;
  dueDate?: string;
  validUntil?: string;
  currency: string;
  priceMode: string;
  taxCase: string;
  subject?: string;
  headText?: string;
  footText?: string;
  orderReference?: string;
  buyerReference?: string;
  deliveryTerms?: string;
  showPrices?: boolean;
  totals: {
    netCents: number;
    vatCents: number;
    grossCents: number;
    payableCents: number;
    byGroup: { category: string; rateBp: number; netCents: number; vatCents: number }[];
  };
  paymentStatus?: string;
  openAmountCents?: number;
  artifactStatus?: string;
  originId?: string;
  chainRootId?: string;
  sourceDocumentIds?: string[];
  coverage?: { coveredBp: number };
  acceptance?: { date: string; byName: string; channel: string; note?: string; snapshotHash: string };
  rejection?: { date: string; reason?: string };
  received?: { date: string; byName: string };
  cancellation?: { reason: string };
  sentOn?: string;
  version: number;
  createdBy: string;
}

export interface LineRecord {
  _id: string;
  kind: string;
  name?: string;
  description?: string;
  quantityMilli?: number;
  unitCode?: string;
  unitPriceMicros?: number;
  discount?: { kind: string; valueBp?: number };
  vatRateKey?: string;
  vatCategory?: string;
  vatRateBp?: number;
  lineNetCents?: number;
  optional?: boolean;
  sourceLineId?: string;
  invoicedQtyMilli?: number;
  deliveredQtyMilli?: number;
  productId?: string;
}

const dec = (v: number | undefined, scale: number) => (v === undefined ? null : scaledToDecimal(v, scale));

export function serializeLine(l: LineRecord) {
  return {
    id: `lin_${l._id}`,
    kind: l.kind,
    name: l.name ?? null,
    description: l.description ?? null,
    ...(l.kind === "item"
      ? {
          product_id: l.productId ? encodeId("products", l.productId) : null,
          quantity: dec(l.quantityMilli, 3),
          unit_code: l.unitCode ?? null,
          unit_price: dec(l.unitPriceMicros, 4),
          discount_percent: l.discount?.kind === "percent" ? dec(l.discount.valueBp, 2) : null,
          vat_rate_key: l.vatRateKey ?? null,
          vat_category: l.vatCategory ?? null,
          vat_rate_bp: l.vatRateBp ?? null,
          net_cents: l.lineNetCents ?? null,
          optional: l.optional === true,
          source_line_id: l.sourceLineId ? `lin_${l.sourceLineId}` : null,
          invoiced_quantity: dec(l.invoicedQtyMilli, 3),
          delivered_quantity: dec(l.deliveredQtyMilli, 3),
        }
      : {}),
  };
}

/** `lin_<id>` → raw line id. */
export const decodeLineId = (value: string): string | null =>
  /^lin_[0-9a-zA-Z]{16,64}$/.test(value) ? value.slice(4) : null;

export function serializeDocument(
  d: DocumentRecord,
  lines: readonly LineRecord[],
  extra: {
    displayStatus: DisplayStatusResult;
    related: Record<string, string>;
    validation?: { code: string; severity: string; message: string; rule: string; field: string | null }[] | null;
    canFinalize?: boolean | null;
  },
) {
  const ref = (id: string | undefined) =>
    id && extra.related[id] ? encodeDoc(extra.related[id] as SalesDocType, id) : null;
  return {
    id: encodeDoc(d.type, d._id),
    type: d.type,
    ...(d.type === "invoice" || d.type === "proforma" ? { invoice_type: invoiceTypeOf(d.type) } : {}),
    status: d.status,
    display_status: extra.displayStatus.token,
    display_status_label: extra.displayStatus.label,
    number: d.number ?? null,
    revision: d.revision ?? null,
    contact_id: d.contactId ? encodeId("contacts", d.contactId) : null,
    contact_name: d.contactName ?? null,
    document_date: d.documentDate ?? null,
    supply_date:
      d.supplyDateMode === "document_date" && !d.supplyDate ? "same_as_document_date" : (d.supplyDate ?? null),
    due_date: d.dueDate ?? null,
    valid_until: d.validUntil ?? null,
    currency: d.currency,
    price_mode: d.priceMode,
    tax_case: d.taxCase,
    subject: d.subject ?? null,
    head_text: d.headText ?? null,
    foot_text: d.footText ?? null,
    order_reference: d.orderReference ?? null,
    buyer_reference: d.buyerReference ?? null,
    delivery_terms: d.deliveryTerms ?? null,
    show_prices: d.type === "delivery_note" ? d.showPrices === true : null,
    lines: lines.map(serializeLine),
    totals: {
      net_cents: d.totals.netCents,
      vat_cents: d.totals.vatCents,
      gross_cents: d.totals.grossCents,
      payable_cents: d.totals.payableCents,
      by_group: d.totals.byGroup.map((g) => ({
        category: g.category,
        rate_bp: g.rateBp,
        net_cents: g.netCents,
        vat_cents: g.vatCents,
      })),
    },
    payment_status: d.paymentStatus ?? null,
    open_amount_cents: d.openAmountCents ?? null,
    artifact_status: d.artifactStatus ?? null,
    origin_id: ref(d.originId),
    chain_root_id: ref(d.chainRootId),
    source_document_ids: (d.sourceDocumentIds ?? []).map((s) => ref(s)).filter((x): x is string => x !== null),
    invoiced_percent: d.coverage ? d.coverage.coveredBp / 100 : null,
    acceptance: d.acceptance
      ? {
          date: d.acceptance.date,
          accepted_by: d.acceptance.byName,
          channel: d.acceptance.channel,
          note: d.acceptance.note ?? null,
          snapshot_hash: d.acceptance.snapshotHash,
        }
      : null,
    rejection: d.rejection ? { date: d.rejection.date, reason: d.rejection.reason ?? null } : null,
    received: d.received ? { date: d.received.date, received_by: d.received.byName } : null,
    withdrawal_reason: d.cancellation?.reason ?? null,
    sent_on: d.sentOn ?? null,
    ...(extra.validation
      ? {
          validation: {
            can_finalize: extra.canFinalize === true,
            errors: extra.validation.filter((f) => f.severity === "E").map(findingOut),
            warnings: extra.validation.filter((f) => f.severity !== "E").map(findingOut),
          },
        }
      : {}),
    version: d.version,
    created_by: { actor: d.createdBy },
    created_at: toInstant(d._creationTime),
  };
}

const findingOut = (f: { code: string; message: string; rule: string; field: string | null }) => ({
  code: f.code,
  rule: f.rule,
  message: f.message,
  ...(f.field ? { field: f.field } : {}),
});

// ── OpenAPI output schemas (descriptive; the handlers build the objects above) ────────────────────────
const lineOut = z
  .object({
    id: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    quantity: z.string().nullable().optional(),
    unit_price: z.string().nullable().optional(),
    net_cents: z.number().nullable().optional(),
    optional: z.boolean().optional(),
    source_line_id: z.string().nullable().optional(),
  })
  .passthrough()
  .meta({ id: "DocumentLine" });

export const documentOut = z
  .object({
    id: z.string().meta({ example: "quo_k57f3x2m9q8w1e4r6t" }),
    type: z.string(),
    status: z.string(),
    display_status: z.string(),
    number: z.string().nullable(),
    contact_id: z.string().nullable(),
    document_date: z.string().nullable(),
    valid_until: z.string().nullable(),
    lines: z.array(lineOut),
    totals: z.object({ net_cents: z.number(), vat_cents: z.number(), gross_cents: z.number() }).passthrough(),
    version: z.number(),
  })
  .passthrough()
  .meta({ id: "SalesDocument" });

export const documentList = listEnvelope(documentOut, "SalesDocumentList");

export const chainOut = z
  .object({
    data: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        status: z.string(),
        number: z.string().nullable(),
        gross_cents: z.number(),
        invoiced_percent: z.number().nullable(),
      }),
    ),
    invoiced_percent: z.number(),
  })
  .meta({ id: "DocumentChain" });

export const convertOut = z
  .object({ document: documentOut, notices: z.array(z.string()) })
  .meta({ id: "DocumentConvertResult" });

// ── form paths → wire fields (Convex validation issues, finalisation findings) ────────────────────────
const FORM_TO_WIRE: Readonly<Record<string, string>> = {
  quantityMilli: "quantity",
  unitPriceMicros: "unit_price",
  discount: "discount_percent",
  skontoPercentBp: "skonto_percent",
  supplyDateMode: "supply_date",
  byName: "accepted_by",
  quantities: "lines",
  optionalLineIds: "optional_line_ids",
  acceptSource: "accept_source",
  deliveryNoteIds: "delivery_note_ids",
};

export function documentFieldMapper(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(".").filter((p) => p !== "values" && p !== "valueBp");
  if (parts.length === 0) return undefined;
  return parts
    .map((p) => FORM_TO_WIRE[p] ?? (/^\d+$/.test(p) ? `[${p}]` : snakeCase(p)))
    .join(".")
    .replace(/\.\[/g, "[");
}
