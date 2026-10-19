/**
 * Sales-document schemas (F04 §5, 05 §4.3): the draft body (header + lines, integer money per 02 §5), the mark-sent
 * and retraction bodies (SND-07, SND-18) and the export request (SND-16). Shared by the editor, the Convex mutations
 * and — later — REST and MCP; the domain validators (`validateDocument`) run on the parsed values.
 */
import { z } from "zod";
import { SEND_CHANNELS } from "../documents/dispatch";
import { DRAFT_TYPES, INVOICE_DRAFT_TYPES } from "../documents/doc-types";
import { TAX_CASES } from "../tax/tax-case";
import { isCalendarDate } from "../time/calendar-date";

const calendarDate = z.string().refine(isCalendarDate, { message: "Ungültiges Datum (JJJJ-MM-TT)." });
const int = () => z.number().int();
const optionalText = (max: number) => z.string().max(max).optional();

export const VAT_CATEGORIES = ["S", "Z", "E", "AE", "K", "G", "O", "KU"] as const;
export const EINVOICE_FORMATS = [
  "zugferd_en16931",
  "zugferd_xrechnung",
  "xrechnung_cii",
  "xrechnung_ubl",
  "none",
] as const;

export const supplyDateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), date: calendarDate }),
  z.object({ kind: z.literal("period"), from: calendarDate, to: calendarDate }),
  z.object({ kind: z.literal("month"), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
]);

export const postalAddressSchema = z.object({
  name: z.string().max(250),
  name2: optionalText(250),
  department: optionalText(250),
  street: z.string().max(250),
  street2: optionalText(250),
  postalCode: z.string().max(20),
  city: z.string().max(250),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  poBox: optionalText(50),
});

export const discountSchema = z.object({
  kind: z.enum(["percent", "amount"]),
  valueBp: int().min(0).max(10_000).optional(),
  amountCents: int().optional(),
});

export const draftLineSchema = z.object({
  kind: z.enum(["item", "heading", "text", "subtotal"]),
  productId: z.string().optional(),
  productType: z.enum(["good", "service"]).optional(),
  productSyncedVersion: int().optional(),
  name: z.string().max(5000).optional(),
  description: z.string().max(20_000).optional(),
  quantityMilli: int().min(-999_999_999_999).max(999_999_999_999).optional(),
  unitCode: z.string().max(10).optional(),
  unitPriceMicros: int().min(-999_999_999_999_999).max(999_999_999_999_999).optional(),
  discount: discountSchema.optional(),
  vatRateKey: z.string().max(40).optional(),
  vatCategoryOverride: z.enum(VAT_CATEGORIES).optional(),
  exemptionReasonCode: z.string().max(40).optional(),
  exemptionReasonText: z.string().max(500).optional(),
  placeOfSupplyRule: z.string().max(40).optional(),
  reverseCharge13b: z.string().max(40).optional(),
  linePeriod: z.object({ from: calendarDate, to: calendarDate }).optional(),
  isLaborCost: z.boolean().optional(),
  itemNumber: z.string().max(100).optional(),
  revenueAccount: z.string().max(20).optional(),
  /** Quotes only (DOC-04, QUO-02): not in the totals. */
  optional: z.boolean().optional(),
  /** Set by conversions (§4.3.3); the editor keeps it, it is never typed in. */
  sourceLineId: z.string().optional(),
});

export { INVOICE_DRAFT_TYPES };

/** Standalone advance chain: the customer's order (number + date) the Abschlagsrechnungen refer to (INV-03). */
export const chainOrderSchema = z.object({ number: z.string().max(200), date: calendarDate });

export const draftSchema = z.object({
  type: z.enum(DRAFT_TYPES),
  contactId: z.string().optional(),
  billingAddress: postalAddressSchema.optional(),
  deliveryAddress: postalAddressSchema.optional(),
  supplyDate: supplyDateSchema.optional(),
  supplyDateMode: z.enum(["explicit", "document_date"]),
  documentDate: calendarDate.optional(),
  backdateReason: optionalText(1000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  fxRateToEur: z
    .object({
      rate: z.string().regex(/^\d+(\.\d{1,6})?$/),
      source: z.enum(["bmf_monthly", "ecb_daily", "manual"]),
      sourceText: optionalText(200),
      date: calendarDate,
    })
    .optional(),
  priceMode: z.enum(["net", "gross"]),
  taxCaseOverride: z
    .object({ taxCase: z.enum(TAX_CASES).exclude(["unknown_imported"]), reason: z.string().max(1000) })
    .optional(),
  subject: optionalText(5000),
  headText: optionalText(100_000),
  footText: optionalText(100_000),
  buyerReference: optionalText(1000),
  orderReference: optionalText(1000),
  contractReference: optionalText(1000),
  paymentTerms: z.object({
    dueDays: int().min(0).max(3650),
    skontoPercentBp: int().min(0).max(10_000).optional(),
    skontoDays: int().min(0).max(3650).optional(),
    text: optionalText(2000),
  }),
  paymentMethodId: z.string().optional(),
  bankAccountId: z.string().optional(),
  showEpcQr: z.boolean(),
  kleinbetrag: z.boolean().optional(),
  propertyRelated: z.boolean().optional(),
  constructionWork: z.boolean().optional(),
  /** UST-24: margin scheme / travel service declared — finalisation is always blocked (out of scope v1). */
  marginScheme: z.boolean().optional(),
  documentDiscount: z
    .object({
      kind: z.enum(["percent", "amount"]),
      valueBp: int().min(0).max(10_000).optional(),
      amountCents: int().min(0).optional(),
      isSurcharge: z.boolean(),
      reason: optionalText(500),
    })
    .optional(),
  language: z.enum(["de", "en"]),
  einvoiceFormat: z.enum(EINVOICE_FORMATS).optional(),
  internalNote: optionalText(10_000),
  /** Quotes (QUO-01): explicit validity; default documentDate + quoteValidityDays at finalisation. */
  validUntil: calendarDate.optional(),
  /** Quotes and order confirmations (QUO-01/08): „Lieferbedingungen“. */
  deliveryTerms: optionalText(5000),
  /** Delivery notes (QUO-09): print prices (default off). */
  showPrices: z.boolean().optional(),
  chainOrder: chainOrderSchema.optional(),
  lines: z.array(draftLineSchema).max(2500),
});

export type DraftValues = z.infer<typeof draftSchema>;

/** Mark-sent body (SND-07). */
export const markSentSchema = z.object({
  sentOn: calendarDate,
  channel: z.enum(SEND_CHANNELS as unknown as [string, ...string[]]),
  note: optionalText(2000),
  electronicConfirmed: z.boolean().optional(),
  artifactIds: z.array(z.string()).max(50),
  suppliedSha256: z.record(z.string(), z.string()).optional(),
});

export type MarkSentValues = z.infer<typeof markSentSchema>;

/** Retraction body (SND-18). */
export const retractMarkSchema = z.object({
  retractsId: z.string(),
  reason: z.string().max(2000),
});

/** Export request (SND-16, SND-05). */
export const exportRequestSchema = z.object({
  entry: z.enum(["default", "zugferd_pdf", "xml", "xrechnung_with_reading", "pdf", "zip"]),
  original: z.boolean().optional(),
  reason: optionalText(2000),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

// ── quotes and conversions (F04 §4.2, §4.3, §7.1) ──────────────────────────────────────────────────────────────

export const CONVERSION_TARGETS = ["order_confirmation", "delivery_note", "proforma", "invoice"] as const;

/** `POST /{type}/{id}/convert` (§4.3.1): target, full/quantity mode, chosen optional lines. */
export const convertSchema = z.object({
  to: z.enum(CONVERSION_TARGETS),
  mode: z.enum(["full", "quantities"]).optional(),
  /** Quantity per source line id (quantity mode, or overrides in full mode). */
  quantities: z.record(z.string(), int().min(0).max(999_999_999_999)).optional(),
  optionalLineIds: z.array(z.string()).max(2500).optional(),
  /** Converting a finalised/sent/expired quote into an order or invoice records the acceptance first (§4.2.1). */
  acceptSource: z.boolean().optional(),
});

export type ConvertValues = z.infer<typeof convertSchema>;

/** Collective invoice from delivery notes (QUO-11). */
export const collectiveSchema = z.object({ deliveryNoteIds: z.array(z.string()).min(1).max(200) });

/** 03 `acceptance.channel` without the portal (F10 deferred): „manuell“ covers letter, in person, other. */
export const ACCEPTANCE_CHANNELS = ["email", "phone", "manual"] as const;

/** „Als angenommen markieren“ (QUO-05, §4.2.1). */
export const acceptQuoteSchema = z.object({
  date: calendarDate,
  byName: z.string().trim().min(1).max(250),
  channel: z.enum(ACCEPTANCE_CHANNELS),
  note: optionalText(2000),
  /** Explicit confirmation for an expired quote (`accept_late`). */
  late: z.boolean().optional(),
});

export type AcceptQuoteValues = z.infer<typeof acceptQuoteSchema>;

export const rejectQuoteSchema = z.object({
  date: calendarDate,
  reason: optionalText(2000),
});

export type RejectQuoteValues = z.infer<typeof rejectQuoteSchema>;

/** Withdraw a quote/order/delivery note/proforma (§4.2: `withdraw` → cancelled, number stays used). */
export const withdrawSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

/** „Wieder öffnen“ of a rejected quote (§4.2.1: reason). */
export const reopenSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

/** „Neue Version“ (QUO-06, §6.3): optional reason, recorded in the audit log. */
export const reviseSchema = z.object({ reason: optionalText(2000) });

/** „Erhalten“ of a delivery note (QUO-09). */
export const markReceivedSchema = z.object({ date: calendarDate, byName: z.string().trim().min(1).max(250) });
