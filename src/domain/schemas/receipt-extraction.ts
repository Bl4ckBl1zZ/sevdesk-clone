/**
 * OCR output schema (F06 §4.4, INB-025). All amounts are **decimal strings** — the domain converts them to integer
 * cents (src/domain/inbox/ocr.ts); no floating-point money ever enters the books (GOBD-03).
 *
 *  - `ReceiptExtraction` is the schema of F06 §4.4 verbatim (zod v4).
 *  - `ReceiptExtractionWire` is what the model is asked to return via structured outputs. The Messages API requires
 *    `additionalProperties: false` on every object, so the record `fieldConfidence` is sent as an array of
 *    `{ field, confidence }` pairs, and constraints JSON-schema structured outputs cannot express (string length,
 *    array maximum, number range) are enforced afterwards by `ReceiptExtraction.parse` in `extractionFromWire`.
 */
import { z } from "zod";

const supplier = {
  name: z.string(),
  address: z.string().nullable(),
  vatId: z.string().nullable(),
  taxNumber: z.string().nullable(),
  iban: z.string().nullable(),
  email: z.string().nullable(),
};

const DOCUMENT_TYPES = ["invoice", "receipt", "credit_note", "customs_notice", "other"] as const;
const PAYMENT_HINTS = ["paid_card", "paid_cash", "paid_paypal", "direct_debit", "transfer_due", "unknown"] as const;

export const ReceiptExtraction = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  supplier: z.object(supplier),
  buyerName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(), // YYYY-MM-DD
  supplyDate: z.string().nullable(),
  supplyPeriod: z.object({ from: z.string(), to: z.string() }).nullable(),
  dueDate: z.string().nullable(),
  currency: z.string().length(3),
  totals: z.object({ net: z.string().nullable(), vat: z.string().nullable(), gross: z.string() }),
  vatLines: z.array(z.object({ ratePercent: z.string(), net: z.string(), vat: z.string() })),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.string().nullable(),
        net: z.string().nullable(),
        gross: z.string().nullable(),
        ratePercent: z.string().nullable(),
      }),
    )
    .max(50),
  skonto: z.object({ percent: z.string(), days: z.number().int() }).nullable(),
  paymentHint: z.enum(PAYMENT_HINTS),
  hospitality: z.object({ isRestaurant: z.boolean(), tip: z.string().nullable(), tseDataPresent: z.boolean() }),
  categoryHint: z.string().nullable(),
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)),
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtraction>;

/** The structured-output shape sent to the model (see the module comment). */
export const ReceiptExtractionWire = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  supplier: z.object(supplier),
  buyerName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  supplyDate: z.string().nullable(),
  supplyPeriod: z.object({ from: z.string(), to: z.string() }).nullable(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  totals: z.object({ net: z.string().nullable(), vat: z.string().nullable(), gross: z.string() }),
  vatLines: z.array(z.object({ ratePercent: z.string(), net: z.string(), vat: z.string() })),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.string().nullable(),
      net: z.string().nullable(),
      gross: z.string().nullable(),
      ratePercent: z.string().nullable(),
    }),
  ),
  skonto: z.object({ percent: z.string(), days: z.number().int() }).nullable(),
  paymentHint: z.enum(PAYMENT_HINTS),
  hospitality: z.object({ isRestaurant: z.boolean(), tip: z.string().nullable(), tseDataPresent: z.boolean() }),
  categoryHint: z.string().nullable(),
  fieldConfidence: z.array(z.object({ field: z.string(), confidence: z.number() })),
});
export type ReceiptExtractionWire = z.infer<typeof ReceiptExtractionWire>;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Wire → spec shape. The model output is untrusted input (INB-030): confidences are clamped to [0, 1], the line
 * list is cut to 50, the currency upper-cased; anything else that violates §4.4 throws (zod error) and the caller
 * falls back to manual entry.
 */
export function extractionFromWire(w: ReceiptExtractionWire): ReceiptExtraction {
  const fieldConfidence: Record<string, number> = {};
  for (const { field, confidence } of w.fieldConfidence) {
    const key = field.trim();
    if (key) fieldConfidence[key] = clamp01(confidence);
  }
  return ReceiptExtraction.parse({
    ...w,
    currency: w.currency.trim().toUpperCase(),
    lineItems: w.lineItems.slice(0, 50),
    fieldConfidence,
  });
}
