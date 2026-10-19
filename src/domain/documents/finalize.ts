/**
 * Finalisation helpers (F04 §4.6, DOC-24…DOC-27, DOC-40): dates, retention, frozen texts and the `SnapshotInput`
 * the commit transaction feeds into `buildSnapshot()`. Pure; the model layer supplies the context it read inside
 * the transaction and the number it assigned.
 */
import { formatCents } from "../money/format";
import { lookupExemptionReason } from "../rules/exemption-reasons";
import { retentionUntilFor } from "../rules/retention";
import { renderTemplate } from "../templates/placeholders";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { finalDeductions } from "./advances";
import type { SnapshotInput, SnapshotInputLine } from "./build-snapshot";
import { detectRectifiedFields, RECTIFIED_FIELD_LABELS } from "./corrections";
import { type DocumentContext, type DraftDocument, type ResolvedDraft, toLineDiscount, vatAccountingAt } from "./draft";
import { isChainType } from "./relations";
import type { EinvoiceFormat, Er03Decision, SalesDocType, SupplyDate } from "./snapshot";
import { rectificationView } from "./validate/chain";
import type { EinvoicePlan } from "./validate/einvoice-plan";

// ── retention (DOC-40, GOBD-20, UST-50) ─────────────────────────────────────────────────────────────────────────

export type RetentionClass = "vouchers8" | "letters6";

const LETTERS: readonly SalesDocType[] = ["quote", "order_confirmation", "delivery_note", "proforma", "reminder"];

/** §4.1 retention column. */
export const retentionClassFor = (type: SalesDocType): RetentionClass =>
  LETTERS.includes(type) ? "letters6" : "vouchers8";

/** 31.12. of (document year + N): vouchers8 → 8 years, letters6 → 6 years (T-DOC-026). */
export function retentionUntil(type: SalesDocType, documentDate: string): string {
  return retentionUntilFor(retentionClassFor(type), documentDate) as string;
}

// ── dates ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** DOC-50: due date = document date + due days (0 = sofort). */
export const dueDateFor = (documentDate: string, dueDays: number): string =>
  addDays(documentDate as CalendarDate, dueDays);

/** DOC-21: "Leistungsdatum = Rechnungsdatum" resolves to `{kind: "date"}` at finalisation. */
export function finalSupplyDate(draft: DraftDocument, documentDate: string): SupplyDate | undefined {
  return draft.supplyDateMode === "document_date" ? { kind: "date", date: documentDate } : draft.supplyDate;
}

/** DOC-25 / EC-010: the counter period key uses the Berlin document date ("YYYY-MM"). */
export const numberPeriodOf = (documentDate: string): string => documentDate.slice(0, 7);

// ── texts (DOC-17, SET-084): placeholders resolved and frozen as plain text ─────────────────────────────────────

const TYPE_LABEL_DE: Partial<Record<SalesDocType, string>> = {
  invoice: "Rechnung",
  advance_invoice: "Abschlagsrechnung",
  partial_invoice: "Teilrechnung",
  final_invoice: "Schlussrechnung",
  cancellation: "Stornorechnung",
  correction: "Rechnungskorrektur",
  quote: "Angebot",
  order_confirmation: "Auftragsbestätigung",
  delivery_note: "Lieferschein",
  proforma: "Proforma-Rechnung",
};

/** Rich text (sanitised HTML) → plain text for the snapshot (PDF and BT-22 use plain text). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface TextValuesInput {
  readonly draft: DraftDocument;
  readonly ctx: DocumentContext;
  readonly resolved: ResolvedDraft;
  readonly number: string;
  readonly documentDate: string;
  readonly dueDate?: string | undefined;
}

/** Placeholder values available at finalisation (F01 §5.6 subset that a plain invoice can fill). */
export function placeholderValues(i: TextValuesInput): Record<string, string | boolean | undefined> {
  const s = i.ctx.company.seller;
  const b = i.ctx.contact?.buyer;
  const t = i.resolved.totals;
  const de = (d: string | undefined) => (d ? formatGermanDate(d as CalendarDate) : undefined);
  const money = (c: number | undefined) =>
    c === undefined ? undefined : `${formatCents(c)} ${i.draft.currency === "EUR" ? "€" : i.draft.currency}`;
  const supply = i.resolved.supplyDate;
  return {
    "company.name": s.name,
    "company.tradeName": s.tradeName,
    "company.street": s.address.street,
    "company.postalCode": s.address.postalCode,
    "company.city": s.address.city,
    "company.contactName": s.contact.name,
    "company.phone": s.contact.phone,
    "company.email": s.contact.email,
    "company.website": s.contact.website,
    "company.vatId": s.vatId,
    "company.taxNumber": s.taxNumber,
    "contact.name": b?.name,
    "contact.number": b?.contactNumber,
    "contact.fullName": b?.contactPerson?.name ?? b?.name,
    "contact.street": b?.address?.street,
    "contact.postalCode": b?.address?.postalCode,
    "contact.city": b?.address?.city,
    "contact.vatId": b?.vatId,
    "contact.buyerReference": i.ctx.contact?.buyerReference,
    "contact.isConsumer": b?.isConsumer ?? false,
    "contact.isPublicAuthority": b?.isPublicAuthority ?? false,
    "contact.letterSalutation": "Sehr geehrte Damen und Herren",
    "document.typeLabel": TYPE_LABEL_DE[i.draft.type],
    "document.number": i.number,
    "document.date": de(i.documentDate),
    "document.supplyDate":
      supply?.kind === "date"
        ? de(supply.date)
        : supply?.kind === "period"
          ? `${de(supply.from)} – ${de(supply.to)}`
          : supply?.month,
    "document.subject": i.draft.subject,
    "document.dueDate": de(i.dueDate),
    "document.dueDays": String(i.draft.paymentTerms.dueDays),
    "document.netTotal": money(t?.taxExclusiveCents),
    "document.vatTotal": money(t?.vatTotalCents),
    "document.grossTotal": money(t?.grossCents),
    "document.payableAmount": money(t?.payableCents),
    "document.currency": i.draft.currency,
    "document.orderReference": i.draft.orderReference,
    "document.buyerReference": i.draft.buyerReference ?? i.ctx.contact?.buyerReference,
    "document.contractReference": i.draft.contractReference,
    "document.hasSkonto": !!i.draft.paymentTerms.skontoPercentBp,
    "document.isKleinunternehmer": i.resolved.kleinunternehmer,
    "date.today": de(i.ctx.today),
    "date.year": i.documentDate.slice(0, 4),
  };
}

export function resolveText(
  text: string | undefined,
  values: Record<string, string | boolean | undefined>,
): string | undefined {
  if (!text?.trim()) return undefined;
  const out = htmlToPlainText(renderTemplate(text, values));
  return out === "" ? undefined : out;
}

// ── snapshot input (step 1b preview / step 2d commit) ───────────────────────────────────────────────────────────

export interface FinalizeParams {
  readonly number: string;
  readonly documentDate: string;
  readonly layoutVersionId: string;
  readonly plan: EinvoicePlan;
  /** Chain references read in the commit transaction: BT-14 order confirmation, BT-16 delivery notes (QUO-11). */
  readonly chainReferences?: {
    readonly salesOrderReference?: string | undefined;
    readonly deliveryNoteNumbers?: readonly string[] | undefined;
  };
}

/** QUO-01: „Gültig bis“ = the chosen date, else document date + `quoteValidityDays` (default 30). */
export function validUntilFor(
  draft: Pick<DraftDocument, "type" | "validUntil">,
  documentDate: string,
  quoteValidityDays = 30,
): string | undefined {
  if (draft.type !== "quote") return undefined;
  return draft.validUntil ?? addDays(documentDate as CalendarDate, quoteValidityDays);
}

/** Types with a due date and payment block (invoice family and proforma, App. F). */
const DUE_TYPES: readonly SalesDocType[] = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "proforma",
];

export function buildSnapshotInput(
  draft: DraftDocument,
  ctx: DocumentContext,
  resolved: ResolvedDraft,
  p: FinalizeParams,
): SnapshotInput {
  const contact = ctx.contact;
  if (!contact) throw new Error("contact_missing");
  const documentDate = p.documentDate;
  const supplyDate = finalSupplyDate(draft, documentDate);
  const dueDate = DUE_TYPES.includes(draft.type) ? dueDateFor(documentDate, draft.paymentTerms.dueDays) : undefined;
  const validUntil = validUntilFor(draft, documentDate, ctx.company.quoteValidityDays);
  const values = placeholderValues({ draft, ctx, resolved, number: p.number, documentDate, dueDate });
  const byIndex = new Map(resolved.lines.map((l) => [l.index, l]));
  const lines: SnapshotInputLine[] = draft.lines.map((l, index) => {
    if (l.kind === "heading" || l.kind === "text") return { kind: l.kind, text: l.name ?? l.description ?? "" };
    if (l.kind === "subtotal") return { kind: "subtotal", ...(l.name ? { text: l.name } : {}) };
    const r = byIndex.get(index);
    const category = r?.vatCategory ?? "S";
    const discount = toLineDiscount(l.discount);
    const exemption =
      category === "E" && l.exemptionReasonCode
        ? lookupExemptionReason(l.exemptionReasonCode, documentDate as CalendarDate)
        : null;
    const unitLabel = l.unitCode ? ctx.unitLabels?.[l.unitCode]?.[draft.language] : undefined;
    return {
      kind: "item",
      name: l.name ?? "",
      ...(l.description ? { description: htmlToPlainText(l.description) } : {}),
      quantityMilli: l.quantityMilli ?? 0,
      unitCode: l.unitCode ?? "C62",
      ...(unitLabel ? { unitLabel } : {}),
      unitPriceMicros: l.unitPriceMicros ?? 0,
      ...(discount ? { discount } : {}),
      vatCategory: category,
      vatRateBp: r?.vatRateBp ?? 0,
      ...(r?.vatRuleRowId ? { vatRuleRowId: r.vatRuleRowId } : {}),
      ...(category === "E" && l.exemptionReasonCode ? { exemptionReasonCode: l.exemptionReasonCode } : {}),
      ...(category === "E" && l.exemptionReasonText ? { exemptionReasonText: l.exemptionReasonText } : {}),
      ...(exemption?.ok ? { exemptionParagraph: exemption.value.ustgNr } : {}),
      ...(category === "AE" && l.reverseCharge13b ? { reverseCharge13b: l.reverseCharge13b } : {}),
      ...(l.linePeriod ? { period: l.linePeriod } : {}),
      ...(l.itemNumber ? { itemNumber: l.itemNumber } : {}),
      ...(l.isLaborCost ? { isLaborCost: true } : {}),
      ...(l.optional && draft.type === "quote" ? { optional: true } : {}),
    };
  });
  const adj = draft.documentDiscount;
  const adjustment =
    adj && (adj.kind === "percent" ? adj.valueBp : adj.amountCents)
      ? {
          type: adj.isSurcharge ? ("charge" as const) : ("allowance" as const),
          ...(adj.kind === "percent" ? { percentBp: adj.valueBp } : { amountCents: adj.amountCents }),
          reason: adj.reason?.trim() || (adj.isSurcharge ? "Zuschlag" : "Rabatt"),
        }
      : undefined;
  const propertyRelated =
    draft.propertyRelated || draft.lines.some((l) => l.kind === "item" && l.placeOfSupplyRule === "property");
  const subject = resolveText(draft.subject, values);
  const headText = resolveText(draft.headText, values);
  const footText = resolveText(draft.footText, values);
  const deliveryTerms = draft.deliveryTerms?.trim();
  const refs = p.chainReferences;
  const decision: Er03Decision = p.plan.er03.decision;
  const format: EinvoiceFormat = p.plan.format;
  const chain = isChainType(draft.type) ? ctx.relations?.chain : undefined;
  const original = draft.type === "correction" || draft.type === "cancellation" ? ctx.relations?.original : undefined;
  const deductions = draft.type === "final_invoice" && chain ? finalDeductions(chain.final) : [];
  const rectified =
    draft.type === "correction" && draft.correctionKind === "rectification" && original
      ? detectRectifiedFields(original.snapshot, rectificationView(draft, ctx, resolved, original.snapshot))
      : [];
  return {
    type: draft.type,
    ...(draft.type === "correction" ? { correctionKind: draft.correctionKind ?? "credit" } : {}),
    number: p.number,
    documentDate,
    ...(dueDate ? { dueDate } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(supplyDate ? { supplyDate } : {}),
    ...(draft.supplyDateMode === "document_date" ? { supplyDateIsDocumentDate: true } : {}),
    language: draft.language,
    currency: draft.currency,
    ...(draft.currency !== "EUR" && draft.fxRateToEur ? { fx: draft.fxRateToEur } : {}),
    priceMode: draft.priceMode,
    taxCase: resolved.taxCase,
    flags: {
      ...(draft.kleinbetrag ? { kleinbetrag: true } : {}),
      ...(propertyRelated ? { propertyRelated: true } : {}),
      ...(draft.constructionWork ? { constructionWork: true } : {}),
      ...(draft.type === "delivery_note" && draft.showPrices ? { showPrices: true } : {}),
      ...(chain ? { chainIndex: chain.index } : {}),
    },
    seller: {
      ...ctx.company.seller,
      kleinunternehmer: resolved.kleinunternehmer,
      vatAccounting: vatAccountingAt(ctx.company, documentDate),
    },
    buyer: contact.buyer,
    ...(draft.deliveryAddress ? { delivery: { address: draft.deliveryAddress } } : {}),
    references: {
      ...(draft.buyerReference?.trim() ? { buyerReference: draft.buyerReference.trim() } : {}),
      ...(contact.buyerReference?.trim() ? { contactBuyerReference: contact.buyerReference.trim() } : {}),
      ...(draft.contractReference?.trim() ? { contractReference: draft.contractReference.trim() } : {}),
      ...(draft.orderReference?.trim() ? { orderReference: draft.orderReference.trim() } : {}),
      ...(refs?.salesOrderReference ? { salesOrderReference: refs.salesOrderReference } : {}),
      ...(refs?.deliveryNoteNumbers?.length ? { deliveryNoteNumbers: [...refs.deliveryNoteNumbers] } : {}),
    },
    ...(chain
      ? { chain: { orderLabel: chain.orderLabel, orderNumber: chain.orderNumber, orderDate: chain.orderDate } }
      : {}),
    ...(original ? { original: { number: original.number, date: original.documentDate } } : {}),
    ...(original?.earlierCorrections.length ? { earlierCorrections: original.earlierCorrections } : {}),
    ...(deductions.length ? { deductions } : {}),
    // INV-13: printed as German labels ("Berichtigt: Anschrift des Leistungsempfängers"); the document keeps the keys.
    ...(rectified.length ? { rectifiedFields: rectified.map((f) => RECTIFIED_FIELD_LABELS[f] ?? f) } : {}),
    texts: {
      ...(subject ? { subject } : {}),
      ...(headText ? { headText } : {}),
      ...(footText ? { footText } : {}),
      ...(deliveryTerms && (draft.type === "quote" || draft.type === "order_confirmation") ? { deliveryTerms } : {}),
    },
    lines,
    ...(adjustment ? { adjustment } : {}),
    payment: {
      method: ctx.paymentMethod.kind,
      ...(ctx.paymentMethod.text ? { methodText: ctx.paymentMethod.text } : {}),
      dueDays: draft.paymentTerms.dueDays,
      ...(draft.paymentTerms.skontoPercentBp && draft.paymentTerms.skontoDays
        ? { skonto: { percentBp: draft.paymentTerms.skontoPercentBp, days: draft.paymentTerms.skontoDays } }
        : {}),
      ...(draft.paymentTerms.text ? { termsText: draft.paymentTerms.text } : {}),
      ...(ctx.bankAccount ? { bankAccount: ctx.bankAccount } : {}),
      ...(ctx.company.paymentReferencePrefix ? { paymentReferencePrefix: ctx.company.paymentReferencePrefix } : {}),
      showEpcQr: draft.showEpcQr,
    },
    einvoice: { format, decision },
    layoutVersionId: p.layoutVersionId,
  };
}
