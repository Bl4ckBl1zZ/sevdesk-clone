/**
 * BT-3 invoice type code per document type and the "Bauleistung" flag (F04 App. A.2, §4.1, BR-DE-17, T-TAB-05).
 * Quotes, order confirmations, delivery notes, proforma and reminders have no XML → null.
 *
 * Open question 9.1 (01 open item 8): 326 for advance/partial invoices and 381 for Storno/credit corrections are
 * verified against the KoSIT bundle by the golden suite (T-GLD-13/17/33, docs/adr/0004). 386 (prepayment) and 876
 * (partial final construction invoice) are not used.
 */
import type { SalesDocType } from "../documents/snapshot";
import type { InvoiceTypeCode } from "./model";

export function invoiceTypeCode(input: {
  readonly type: SalesDocType;
  readonly correctionKind?: "credit" | "rectification" | undefined;
  readonly constructionWork?: boolean | undefined;
}): InvoiceTypeCode | null {
  const construction = input.constructionWork === true;
  switch (input.type) {
    case "invoice":
      return "380";
    case "advance_invoice":
    case "partial_invoice":
      return construction ? "875" : "326";
    case "final_invoice":
      return construction ? "877" : "380";
    case "cancellation":
      return "381";
    case "correction":
      return input.correctionKind === "rectification" ? "384" : "381";
    case "self_billing":
      return "389";
    default:
      return null;
  }
}

/** Credit-note semantics (UBL root `CreditNote`, positive amounts — App. A.2/A.8). */
export const isCreditNote = (code: InvoiceTypeCode): boolean => code === "381";
