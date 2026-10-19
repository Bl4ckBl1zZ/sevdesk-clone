/**
 * Invoice editor state (F04 §6.2): German text inputs per field, converted to the integer draft body of the shared
 * zod schema (`draftSchema`) before every check/save. Only parsing and formatting — tax, totals and validation are
 * computed by Convex (`invoices.check`) with the domain functions.
 */

import { type DraftType, isInvoiceDraftType } from "@/domain/documents/doc-types";
import { formatBasisPoints, formatMicros, formatMilli } from "@/domain/money/format";
import { parseBasisPoints, parseMicros, parseMilli } from "@/domain/money/parse";
import type { DraftValues } from "@/domain/schemas/documents";
import type { CalendarDate } from "@/domain/time/calendar-date";

type DraftLineValues = DraftValues["lines"][number];

export interface EditorLine {
  readonly key: string;
  readonly kind: DraftLineValues["kind"];
  readonly name: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitCode: string;
  readonly price: string;
  /** Line discount in percent ("10" = 10 %). */
  readonly discount: string;
  readonly vatRateKey: string;
  readonly productType: "good" | "service";
  readonly reverseCharge13b: string;
  /** PRD-053: revenue account copied from the product, editable per line in drafts ("" = default mapping). */
  readonly revenueAccount: string;
  /** DOC-53: line cost centre ("" = the document's). */
  readonly costCenterId: string;
  readonly isLaborCost: boolean;
  /** Quotes only (DOC-04, QUO-02): not in the totals, chosen on conversion. */
  readonly optional: boolean;
  /** Fields copied from a product that the editor does not show (kept unchanged). */
  readonly extra: Partial<DraftLineValues>;
}

export interface EditorState {
  /** Document type of the draft (fixed once saved; F04 §4.1). */
  readonly type: DraftType;
  /** Standalone advance chain: the customer's order the Abschlagsrechnungen refer to (INV-03). */
  readonly chainOrderNumber: string;
  readonly chainOrderDate: string;
  readonly contactId: string;
  readonly supplyDateMode: "explicit" | "document_date";
  readonly supplyKind: "date" | "period";
  readonly supplyDate: string;
  readonly supplyFrom: string;
  readonly supplyTo: string;
  readonly priceMode: "net" | "gross";
  readonly dueDays: string;
  readonly skontoPercent: string;
  readonly skontoDays: string;
  readonly subject: string;
  readonly headText: string;
  readonly footText: string;
  readonly buyerReference: string;
  readonly orderReference: string;
  readonly kleinbetrag: boolean;
  readonly constructionWork: boolean;
  readonly marginScheme: boolean;
  readonly einvoiceFormat: string;
  readonly bankAccountId: string;
  readonly paymentMethodId: string;
  readonly showEpcQr: boolean;
  readonly language: "de" | "en";
  readonly currency: string;
  /** Quotes (QUO-01): empty = document date + `quoteValidityDays`. */
  readonly validUntil: string;
  /** Quotes and order confirmations (QUO-01, QUO-08). */
  readonly deliveryTerms: string;
  /** Delivery notes (QUO-09): print prices and totals. */
  readonly showPrices: boolean;
  /** DOC-53: document cost centre, tags and custom fields. */
  readonly costCenterId: string;
  readonly tags: readonly string[];
  readonly customFields: Readonly<Record<string, string | number | boolean>>;
  /** DOC-54: "" = the default layout of the document type. */
  readonly layoutId: string;
  readonly lines: readonly EditorLine[];
}

/** Which header fields a type shows and sends (F04 §3.2, §6.2). */
export const typeFeatures = (type: DraftType) => ({
  validUntil: type === "quote",
  deliveryTerms: type === "quote" || type === "order_confirmation",
  optionalLines: type === "quote",
  showPrices: type === "delivery_note",
  /** Supply date optional („voraussichtlich“) on quotes and orders; mandatory on invoices and delivery notes. */
  supplyOptional: type === "quote" || type === "order_confirmation",
  payment: type !== "delivery_note",
  einvoice: isInvoiceDraftType(type),
  invoiceFlags: isInvoiceDraftType(type),
  epcQr: isInvoiceDraftType(type) || type === "proforma",
});

let seq = 0;
export const newKey = (): string => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export function emptyLine(kind: DraftLineValues["kind"] = "item"): EditorLine {
  return {
    key: newKey(),
    kind,
    name: "",
    description: "",
    quantity: kind === "item" ? "1" : "",
    unitCode: kind === "item" ? "C62" : "",
    price: "",
    discount: "",
    vatRateKey: "standard",
    productType: "service",
    reverseCharge13b: "",
    revenueAccount: "",
    costCenterId: "",
    isLaborCost: false,
    optional: false,
    extra: {},
  };
}

export function emptyEditor(today: string, defaults: Partial<EditorState> = {}): EditorState {
  return {
    type: "invoice",
    chainOrderNumber: "",
    chainOrderDate: "",
    contactId: "",
    supplyDateMode: "explicit",
    supplyKind: "date",
    supplyDate: today,
    supplyFrom: "",
    supplyTo: "",
    priceMode: "net",
    dueDays: "14",
    skontoPercent: "",
    skontoDays: "",
    subject: "",
    headText: "",
    footText: "",
    buyerReference: "",
    orderReference: "",
    kleinbetrag: false,
    constructionWork: false,
    marginScheme: false,
    einvoiceFormat: "",
    bankAccountId: "",
    paymentMethodId: "",
    showEpcQr: true,
    language: "de",
    currency: "EUR",
    validUntil: "",
    deliveryTerms: "",
    showPrices: false,
    costCenterId: "",
    tags: [],
    customFields: {},
    layoutId: "",
    lines: [emptyLine()],
    ...defaults,
  };
}

export function lineFromValues(l: DraftLineValues): EditorLine {
  const {
    kind,
    name,
    description,
    quantityMilli,
    unitCode,
    unitPriceMicros,
    discount,
    vatRateKey,
    productType,
    reverseCharge13b,
    revenueAccount,
    costCenterId,
    isLaborCost,
    optional,
    ...extra
  } = l;
  return {
    key: newKey(),
    kind,
    name: name ?? "",
    description: description ?? "",
    quantity: quantityMilli !== undefined ? formatMilli(quantityMilli) : "",
    unitCode: unitCode ?? "",
    price: unitPriceMicros !== undefined ? formatMicros(unitPriceMicros) : "",
    discount: discount?.kind === "percent" && discount.valueBp ? formatBasisPoints(discount.valueBp) : "",
    vatRateKey: vatRateKey ?? "standard",
    productType: productType ?? "service",
    reverseCharge13b: reverseCharge13b ?? "",
    revenueAccount: revenueAccount ?? "",
    costCenterId: costCenterId ?? "",
    isLaborCost: isLaborCost ?? false,
    optional: optional ?? false,
    extra,
  };
}

export function editorFromValues(v: DraftValues): EditorState {
  const s = v.supplyDate;
  return {
    type: v.type,
    chainOrderNumber: v.chainOrder?.number ?? "",
    chainOrderDate: v.chainOrder?.date ?? "",
    contactId: v.contactId ?? "",
    supplyDateMode: v.supplyDateMode,
    supplyKind: s?.kind === "period" ? "period" : "date",
    supplyDate: s?.kind === "date" ? s.date : "",
    supplyFrom: s?.kind === "period" ? s.from : "",
    supplyTo: s?.kind === "period" ? s.to : "",
    priceMode: v.priceMode,
    dueDays: String(v.paymentTerms.dueDays),
    skontoPercent: v.paymentTerms.skontoPercentBp ? formatBasisPoints(v.paymentTerms.skontoPercentBp) : "",
    skontoDays: v.paymentTerms.skontoDays !== undefined ? String(v.paymentTerms.skontoDays) : "",
    subject: v.subject ?? "",
    headText: v.headText ?? "",
    footText: v.footText ?? "",
    buyerReference: v.buyerReference ?? "",
    orderReference: v.orderReference ?? "",
    kleinbetrag: v.kleinbetrag ?? false,
    constructionWork: v.constructionWork ?? false,
    marginScheme: v.marginScheme ?? false,
    einvoiceFormat: v.einvoiceFormat ?? "",
    bankAccountId: v.bankAccountId ?? "",
    paymentMethodId: v.paymentMethodId ?? "",
    showEpcQr: v.showEpcQr,
    language: v.language,
    currency: v.currency,
    validUntil: v.validUntil ?? "",
    deliveryTerms: v.deliveryTerms ?? "",
    showPrices: v.showPrices ?? false,
    costCenterId: v.costCenterId ?? "",
    tags: v.tags ?? [],
    customFields: v.customFields ?? {},
    layoutId: v.layoutId ?? "",
    lines: v.lines.map(lineFromValues),
  };
}

export interface EditorError {
  readonly field: string;
  readonly message: string;
}

const opt = (s: string) => (s.trim() ? s.trim() : undefined);

function lineToValues(l: EditorLine, index: number, errors: EditorError[], type: DraftType): DraftLineValues {
  if (l.kind !== "item") {
    return { kind: l.kind, ...(opt(l.name) ? { name: l.name.trim() } : {}) };
  }
  const out: Record<string, unknown> = {
    ...l.extra,
    kind: "item",
    productType: l.productType,
    vatRateKey: l.vatRateKey,
  };
  if (opt(l.name)) out.name = l.name.trim();
  if (opt(l.description)) out.description = l.description.trim();
  if (opt(l.unitCode)) out.unitCode = l.unitCode.trim();
  if (opt(l.quantity)) {
    const q = parseMilli(l.quantity);
    if (q.ok) out.quantityMilli = q.value;
    else errors.push({ field: `lines.${index}.quantity`, message: `Position ${index + 1}: Menge ungültig.` });
  }
  if (opt(l.price)) {
    const p = parseMicros(l.price);
    if (p.ok) out.unitPriceMicros = p.value;
    else errors.push({ field: `lines.${index}.price`, message: `Position ${index + 1}: Preis ungültig.` });
  }
  if (opt(l.discount)) {
    const d = parseBasisPoints(l.discount);
    if (d.ok && d.value <= 10_000) out.discount = { kind: "percent", valueBp: d.value };
    else errors.push({ field: `lines.${index}.discount`, message: `Position ${index + 1}: Rabatt ungültig.` });
  } else delete out.discount;
  if (opt(l.reverseCharge13b)) out.reverseCharge13b = l.reverseCharge13b;
  else delete out.reverseCharge13b;
  if (opt(l.revenueAccount)) out.revenueAccount = l.revenueAccount.trim();
  else delete out.revenueAccount;
  if (l.costCenterId) out.costCenterId = l.costCenterId;
  else delete out.costCenterId;
  if (l.isLaborCost) out.isLaborCost = true;
  else delete out.isLaborCost;
  if (l.optional && typeFeatures(type).optionalLines) out.optional = true;
  else delete out.optional;
  return out as DraftLineValues;
}

/** Editor → draft body; parse errors are returned for the inputs (the server validates the rest). */
export function toDraftValues(s: EditorState): { values: DraftValues; errors: EditorError[] } {
  const errors: EditorError[] = [];
  const dueDays = Number.parseInt(s.dueDays, 10);
  if (!Number.isInteger(dueDays) || dueDays < 0) errors.push({ field: "dueDays", message: "Zahlungsziel ungültig." });
  const skonto = opt(s.skontoPercent) ? parseBasisPoints(s.skontoPercent) : null;
  if (skonto && !skonto.ok) errors.push({ field: "skontoPercent", message: "Skonto ungültig." });
  const skontoDays = opt(s.skontoDays) ? Number.parseInt(s.skontoDays, 10) : undefined;
  const supplyDate: DraftValues["supplyDate"] =
    s.supplyDateMode === "document_date"
      ? undefined
      : s.supplyKind === "period"
        ? s.supplyFrom && s.supplyTo
          ? { kind: "period", from: s.supplyFrom as CalendarDate, to: s.supplyTo as CalendarDate }
          : undefined
        : s.supplyDate
          ? { kind: "date", date: s.supplyDate as CalendarDate }
          : undefined;
  const f = typeFeatures(s.type);
  const chainOrder =
    (s.type === "advance_invoice" || s.type === "partial_invoice") && opt(s.chainOrderNumber) && s.chainOrderDate
      ? { chainOrder: { number: s.chainOrderNumber.trim(), date: s.chainOrderDate as CalendarDate } }
      : {};
  const values: DraftValues = {
    type: s.type,
    ...chainOrder,
    ...(s.contactId ? { contactId: s.contactId } : {}),
    supplyDateMode: s.supplyDateMode,
    ...(supplyDate ? { supplyDate } : {}),
    currency: s.currency,
    priceMode: s.priceMode,
    paymentTerms: {
      dueDays: Number.isInteger(dueDays) && dueDays >= 0 ? dueDays : 0,
      ...(skonto?.ok && skonto.value > 0 ? { skontoPercentBp: skonto.value } : {}),
      ...(skontoDays !== undefined && Number.isInteger(skontoDays) ? { skontoDays } : {}),
    },
    ...(s.bankAccountId ? { bankAccountId: s.bankAccountId } : {}),
    ...(s.paymentMethodId ? { paymentMethodId: s.paymentMethodId } : {}),
    showEpcQr: s.showEpcQr,
    ...(s.kleinbetrag && f.invoiceFlags ? { kleinbetrag: true } : {}),
    ...(s.constructionWork && f.invoiceFlags ? { constructionWork: true } : {}),
    ...(s.marginScheme && f.invoiceFlags ? { marginScheme: true } : {}),
    ...(opt(s.subject) ? { subject: s.subject.trim() } : {}),
    ...(opt(s.headText) ? { headText: s.headText.trim() } : {}),
    ...(opt(s.footText) ? { footText: s.footText.trim() } : {}),
    ...(opt(s.buyerReference) ? { buyerReference: s.buyerReference.trim() } : {}),
    ...(opt(s.orderReference) ? { orderReference: s.orderReference.trim() } : {}),
    language: s.language,
    ...(s.einvoiceFormat && f.einvoice ? { einvoiceFormat: s.einvoiceFormat as DraftValues["einvoiceFormat"] } : {}),
    ...(f.validUntil && s.validUntil ? { validUntil: s.validUntil as CalendarDate } : {}),
    ...(f.deliveryTerms && opt(s.deliveryTerms) ? { deliveryTerms: s.deliveryTerms.trim() } : {}),
    ...(f.showPrices && s.showPrices ? { showPrices: true } : {}),
    ...(s.costCenterId ? { costCenterId: s.costCenterId } : {}),
    ...(s.tags.length ? { tags: [...s.tags] } : {}),
    ...(Object.keys(s.customFields).length ? { customFields: { ...s.customFields } } : {}),
    ...(s.layoutId ? { layoutId: s.layoutId } : {}),
    lines: s.lines.map((l, i) => lineToValues(l, i, errors, s.type)),
  };
  return { values, errors };
}
