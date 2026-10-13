/**
 * Sales-document schemas (F04 §5, 05 §4.3): the draft body (header + lines, integer money per 02 §5), the mark-sent
 * and retraction bodies (SND-07, SND-18) and the export request (SND-16). Shared by the editor, the Convex mutations
 * and — later — REST and MCP; the domain validators (`validateDocument`) run on the parsed values.
 */
import { z } from "zod";
import { SEND_CHANNELS } from "../documents/dispatch";
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
});

export const draftSchema = z.object({
  type: z.literal("invoice"),
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
