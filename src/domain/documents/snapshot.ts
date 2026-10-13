/**
 * The immutable document snapshot (F04 DOC-27, 03 §4 `documentSnapshots.json`, 02 §5 "Snapshots").
 *
 * Canonical JSON of the full EN 16931 + render model, frozen in the finalisation transaction. Every artifact (PDF,
 * ZUGFeRD/XRechnung XML, "Kopie", "Lesefassung") is rendered from this object only (DOC-28, EC-DOC-97/98), so it
 * carries everything the renderers need: the seller and buyer blocks as read in the commit transaction (DOC-22,
 * EC-DOC-01/02), all lines incl. headings/texts/subtotals, the computed totals and VAT breakdown, references
 * (BT-10…BT-16, BG-3), the resolved texts and legal notes (DOC-17, INV-23), payment terms and means (DOC-50/51),
 * the supply date/period (UST-08), final-invoice deductions (INV-06…09), the FX data (MISC-08) and the rule/layout
 * versions used (DOC-13, DOC-54).
 *
 * Conventions (02 §5): money in integer cents (`*Cents`), unit prices in 1/10,000 (`*Micros`), quantities in 1/1,000
 * (`*Milli`), rates in basis points, business dates as "YYYY-MM-DD". Cancellations and credit corrections store
 * negative quantities and totals (F04 App. A.8); the XML serializer writes them as positive credit-note amounts.
 */
import { canonicalize } from "../audit/canonical";
import { sha256Hex } from "../audit/chain";
import type { FooterCompany } from "../company/footer";
import type { NoteTextId } from "../rules/note-texts";
import type { VatCategory } from "../tax/vat-category";
import { daysInMonth } from "../time/calendar-date";

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** 03 §4 `SalesDocType`. `self_billing` is P3 and has no renderer yet. */
export type SalesDocType =
  | "quote"
  | "order_confirmation"
  | "delivery_note"
  | "proforma"
  | "invoice"
  | "advance_invoice"
  | "partial_invoice"
  | "final_invoice"
  | "cancellation"
  | "correction"
  | "self_billing"
  | "reminder";

/** 03 §0.2 `TaxCase`. */
export type TaxCase =
  | "domestic"
  | "kleinunternehmer"
  | "eu_b2b_service"
  | "intra_community_supply"
  | "export"
  | "not_taxable_domestic"
  | "reverse_charge_13b"
  | "exempt_4"
  | "unknown_imported";

/** 03 §4 `einvoice.format`. */
export type EinvoiceFormat = "zugferd_en16931" | "zugferd_xrechnung" | "xrechnung_cii" | "xrechnung_ubl" | "none";

/** F04 App. D: the ER-03 decision. */
export type Er03Decision = "MUST_E" | "PDF_NEEDS_CONSENT" | "MAY_PAPER_OR_PDF" | "NOT_REQUIRED";

/** 03 §0.2 `SupplyDate`. */
export type SupplyDate =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "period"; readonly from: string; readonly to: string }
  | { readonly kind: "month"; readonly month: string };

/** 03 §0.2 `PostalAddress`. */
export interface SnapshotAddress {
  readonly name?: string;
  readonly name2?: string;
  readonly department?: string;
  readonly street: string;
  readonly street2?: string;
  readonly postalCode: string;
  readonly city: string;
  /** ISO 3166-1 alpha-2 (incl. "XI"). */
  readonly countryCode: string;
  readonly poBox?: string;
}

/** BT-34 / BT-49 electronic address with its scheme (EM = e-mail, 0204 = Leitweg-ID, 9930 = DE VAT ID). */
export interface ElectronicAddress {
  readonly scheme: "EM" | "0204" | "9930" | "0088" | "9958";
  readonly value: string;
}

/**
 * Seller block (BG-4) frozen from the company profile in the commit transaction; Storno/corrections copy the block of
 * the original (F01 SET-022, EC-DOC-70). Shape-compatible with the Geschäftsbrief footer (F01 §5.2, MAIL-03).
 */
export interface SnapshotSeller extends FooterCompany {
  /** BT-34 (mandatory in XRechnung, PEPPOL-EN16931-R020). */
  readonly electronicAddress?: ElectronicAddress;
  /** Kleinunternehmer at the supply date (KU-02). */
  readonly kleinunternehmer: boolean;
  /** Taxation method valid at the document date (UST-13). */
  readonly vatAccounting: "soll" | "ist";
}

/** Buyer block (BG-7) frozen from the contact in the commit transaction (DOC-22). */
export interface SnapshotBuyer {
  /** BT-44 */ readonly name: string;
  /** BT-45 trading name */ readonly tradeName?: string;
  /** Kleinbetragsrechnung (DOC-44) may omit the address. */
  readonly address?: SnapshotAddress;
  /** BT-46 customer number */ readonly contactNumber?: string;
  /** BT-48 */ readonly vatId?: string;
  readonly taxNumber?: string;
  /** BT-47 register number, e.g. "HRB 4711 B" (§13b fallback for BR-AE-02). */
  readonly registerNumber?: string;
  /** BT-49 as stored on the contact (else the invoice e-mail with scheme EM, App. A.3). */
  readonly electronicAddress?: ElectronicAddress;
  readonly invoiceEmail?: string;
  /** BG-9 contact person */
  readonly contactPerson?: { readonly name?: string; readonly phone?: string; readonly email?: string };
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
}

export interface SnapshotItemLine {
  readonly kind: "item";
  /** BT-126 line ID (position number among item lines, 1-based). */
  readonly position: number;
  /** BT-153 */ readonly name: string;
  /** BT-154 plain text (rich text already flattened). */
  readonly description?: string;
  /** BT-127 note: text of the heading/text lines directly above (App. A.1), plus the gross-mode discount note. */
  readonly note?: string;
  /** BT-129, negative on cancellations and credit corrections. */
  readonly quantityMilli: number;
  /** BT-130 UN/ECE Rec 20/21 code. */
  readonly unitCode: string;
  /** Printed unit label in the document language (03 `units.label`), frozen at finalisation. */
  readonly unitLabel?: string;
  /** Unit price as entered (net or gross per `priceMode`). */
  readonly unitPriceMicros: number;
  readonly discount?:
    | { readonly kind: "percent"; readonly bp: number }
    | { readonly kind: "amount"; readonly cents: number };
  /** BG-30 */ readonly vatCategory: VatCategory;
  readonly vatRateBp: number;
  /** Rule row the rate came from (DOC-13), e.g. "standard@2021-01-01". */
  readonly vatRuleRowId?: string;
  readonly exemptionReasonCode?: string;
  readonly exemptionReasonText?: string;
  /** BT-131 line net (gross mode: allocated per App. E.3 step 4). */
  readonly netCents: number;
  /** Gross mode: entered line gross (App. E.3 step 1). */
  readonly grossCents?: number;
  /** BG-26 */ readonly period?: { readonly from: string; readonly to: string };
  /** BT-155 */ readonly itemNumber?: string;
  /** BT-156 */ readonly buyerItemNumber?: string;
  /** Quotes only: excluded from totals and XML (QUO-02). */
  readonly optional?: boolean;
  /** §35a (MISC-07). */
  readonly isLaborCost?: boolean;
}

export interface SnapshotTextLine {
  readonly kind: "heading" | "text";
  readonly text: string;
}

export interface SnapshotSubtotalLine {
  readonly kind: "subtotal";
  readonly text: string;
  /** Running sum of the net (gross mode: gross) item amounts since the previous subtotal/heading (DOC-04). */
  readonly amountCents: number;
}

export type SnapshotLine = SnapshotItemLine | SnapshotTextLine | SnapshotSubtotalLine;

/** One VAT breakdown row (BG-23) incl. the document allowance/charge share of the group (BG-20/21). */
export interface SnapshotVatGroup {
  /** BT-118 (internal KU maps to E in the XML, App. A.9). */
  readonly category: VatCategory;
  /** BT-119 */ readonly rateBp: number;
  readonly lineNetSumCents: number;
  readonly allowanceCents: number;
  readonly chargeCents: number;
  /** BT-116 */ readonly baseCents: number;
  /** BT-117 */ readonly vatCents: number;
  /** BT-121 VATEX code */ readonly exemptionReasonCode?: string;
  /** BT-120 */ readonly exemptionReasonText?: string;
  /** Gross mode (DOC-10). */
  readonly enteredGrossCents?: number;
  readonly grossDeviationCents?: number;
  /** Foreign currency: VAT of the group in EUR (App. E.6). */
  readonly vatEurCents?: number;
}

export interface SnapshotTotals {
  /** BT-106 */ readonly lineNetSumCents: number;
  /** BT-107 */ readonly allowanceTotalCents: number;
  /** BT-108 */ readonly chargeTotalCents: number;
  /** BT-109 */ readonly netCents: number;
  /** BT-110 */ readonly vatCents: number;
  /** BT-112 */ readonly grossCents: number;
  /** BT-113 = Σ deductions[].deductedGrossCents (03 `advancesDeductedGrossCents`). */
  readonly advancesDeductedGrossCents: number;
  /** BT-114, always 0 in v1 (F04 9.12). */
  readonly roundingCents: number;
  /** BT-115, may be ≤ 0 on final invoices (INV-06, EC-DOC-45/47). */
  readonly payableCents: number;
  readonly byGroup: readonly SnapshotVatGroup[];
  /** BT-111 (foreign currency only). */
  readonly vatEurCents?: number;
  /** §35a labour subtotal (App. E.7), B2C only. */
  readonly labor?: { readonly netCents: number; readonly vatCents: number; readonly grossCents: number };
}

/** Document-level discount or surcharge (BG-20/BG-21); amounts per group live in `totals.byGroup`. */
export interface SnapshotAdjustment {
  readonly type: "allowance" | "charge";
  readonly percentBp?: number;
  readonly reason: string;
  /** UNTDID 5189 (allowance, default "95") / 7161 (charge, default "ZZZ"). */
  readonly reasonCode?: string;
}

/** A deducted advance/partial invoice (03 `deductions[]`, App. E.4). */
export interface SnapshotDeduction {
  readonly advanceNumber: string;
  readonly advanceDate: string;
  /** Date the (last) payment was received, for the BT-22 deduction line (App. A.6). */
  readonly paidOn?: string;
  readonly byGroup: readonly {
    readonly category: VatCategory;
    readonly rateBp: number;
    readonly netCents: number;
    readonly vatCents: number;
    readonly grossCents: number;
  }[];
  readonly deductedGrossCents: number;
  readonly partiallyPaid: boolean;
}

/** BG-3 preceding invoice reference. */
export interface PrecedingInvoiceRef {
  /** BT-25 */ readonly number: string;
  /** BT-26 */ readonly date: string;
  readonly role: "original" | "advance" | "earlier_correction";
}

export interface SnapshotReferences {
  /** BT-10 as resolved for this document and format (App. A.3); absent if none applies. */
  readonly buyerReference?: string;
  /** BT-12 contract reference / recurring template reference (ER-04). */
  readonly contractReference?: string;
  /** BT-13 customer purchase order. */
  readonly orderReference?: string;
  /** BT-14 our order confirmation number in the chain. */
  readonly salesOrderReference?: string;
  /** BT-16 (one delivery note) — several notes are listed in `deliveryNoteNumbers` and printed / noted. */
  readonly deliveryNoteNumbers?: readonly string[];
  /** BT-11 */ readonly projectReference?: string;
  /** BG-3 */ readonly precedingInvoices: readonly PrecedingInvoiceRef[];
}

/** A resolved legal/standard note (F04 App. B) — placeholders already filled; never editable (INV-23). */
export interface SnapshotNote {
  readonly id: NoteTextId;
  /** Rule row used (DOC-27 `ruleVersions`). */
  readonly ruleRowId: string;
  readonly de: string;
  readonly en: string;
  /** Where the note is printed: legal block (L), title area (T) or totals (∑). */
  readonly zone: "legal" | "title" | "totals" | "payment";
  /** Also written as BT-22 note (subject code). */
  readonly xmlSubjectCode?: "REG" | "AAI" | "SUR";
}

export type PaymentMethodKind = "transfer" | "sepa_debit" | "cash" | "card" | "paypal" | "other";

export interface SnapshotPayment {
  readonly method: PaymentMethodKind;
  /** Display text of the payment method (03 `paymentMethods.text`). */
  readonly methodText?: string;
  readonly dueDays: number;
  readonly skonto?: {
    readonly percentBp: number;
    readonly days: number;
    /** documentDate + days */ readonly date: string;
    /** Skonto on the payable amount. */ readonly amountCents: number;
    readonly payableCents: number;
  };
  /** Free text of the payment terms (03 `PaymentTerms.text`). */
  readonly termsText?: string;
  /** BG-17 seller account (transfer). */
  readonly bankAccount?: {
    readonly iban: string;
    readonly bic?: string;
    readonly accountHolder: string;
    readonly bankName?: string;
  };
  /** Buyer IBAN for refunds (payable < 0, App. A.5). */
  readonly refundIban?: string;
  /** BT-83 = printed Verwendungszweck = EPC remittance: exactly the invoice number (+ optional prefix, DOC-51). */
  readonly paymentReference: string;
  /** EPC QR requested on the document (layout default or toggle); printed only when DOC-51 applies. */
  readonly showEpcQr: boolean;
}

/** Foreign-currency data (03 `FxRate`, MISC-08). */
export interface SnapshotFx {
  /** "1 EUR = x FC" as a decimal string with ≤ 6 decimals. */
  readonly rate: string;
  readonly source: "bmf_monthly" | "ecb_daily" | "manual";
  readonly sourceText?: string;
  readonly date: string;
}

/** Reminder content (F05); amounts in cents. */
export interface SnapshotReminder {
  readonly level: number;
  /** Level title from the policy step, e.g. "Zahlungserinnerung", "1. Mahnung" (F05 DUN-001). */
  readonly title: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly invoiceDueDate: string;
  readonly invoiceGrossCents: number;
  readonly paymentsReceivedCents: number;
  readonly openAmountCents: number;
  readonly feeCents: number;
  readonly interestCents: number;
  /** §288 calculation table (F05 DUN-005/020). */
  readonly interestSegments?: readonly {
    readonly from: string;
    readonly to: string;
    readonly days: number;
    readonly rateBp: number;
    readonly amountCents: number;
  }[];
  readonly flatFee40Cents: number;
  /** Later reminders show the 40 € as "bereits geltend gemacht" without adding it again (DUN-024). */
  readonly flatFeeAlreadyClaimed?: boolean;
  readonly defaultStartDate?: string;
  readonly newDueDate: string;
  /** Total claim = open + fees + interest + flat fee (if added now). */
  readonly totalCents: number;
}

export interface DocumentSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly type: SalesDocType;
  readonly correctionKind?: "credit" | "rectification";
  /** BT-1, max 36 characters (UST-06). Preview snapshots use "PREVIEW-0000". */
  readonly number: string;
  /** BT-2 */ readonly documentDate: string;
  /** BT-9 */ readonly dueDate?: string;
  /** Quotes (QUO-01). */
  readonly validUntil?: string;
  /** UST-08; mandatory for invoice types and delivery notes. */
  readonly supplyDate?: SupplyDate;
  /** True when the supply date equals the document date ("Leistungsdatum = Rechnungsdatum", DOC-21). */
  readonly supplyDateIsDocumentDate?: boolean;
  readonly language: "de" | "en";
  /** BT-5 */ readonly currency: string;
  readonly fx?: SnapshotFx;
  readonly priceMode: "net" | "gross";
  readonly taxCase: TaxCase;
  readonly flags: {
    readonly kleinbetrag?: boolean;
    readonly propertyRelated?: boolean;
    readonly constructionWork?: boolean;
    /** Delivery notes (QUO-09): print prices and totals. */
    readonly showPrices?: boolean;
    /** Advance/partial invoice number within the chain ("1. Abschlagsrechnung"). */
    readonly chainIndex?: number;
  };
  readonly seller: SnapshotSeller;
  readonly buyer: SnapshotBuyer;
  /** BG-13/BG-15 */
  readonly delivery?: { readonly address?: SnapshotAddress; readonly partyName?: string };
  readonly references: SnapshotReferences;
  readonly texts: {
    readonly subject?: string;
    readonly headText?: string;
    readonly footText?: string;
    /** Quotes and order confirmations: delivery terms (QUO-01, QUO-08), printed above the foot text. */
    readonly deliveryTerms?: string;
  };
  readonly notes: readonly SnapshotNote[];
  readonly lines: readonly SnapshotLine[];
  readonly adjustment?: SnapshotAdjustment;
  readonly totals: SnapshotTotals;
  readonly deductions?: readonly SnapshotDeduction[];
  readonly payment: SnapshotPayment;
  readonly einvoice: { readonly format: EinvoiceFormat; readonly decision?: Er03Decision };
  /** Rechnungsberichtigung: the corrected items ("Anschrift des Leistungsempfängers", INV-13). */
  readonly rectifiedFields?: readonly string[];
  readonly reminder?: SnapshotReminder;
  /** Printable custom fields (DOC-53). */
  readonly customFields?: readonly { readonly label: string; readonly value: string }[];
  /** Document attachments frozen at finalisation (DOC-18); content is not part of the snapshot. */
  readonly attachments?: readonly {
    readonly name: string;
    readonly mime: string;
    readonly sha256: string;
    readonly embedInXml: boolean;
  }[];
  /** DOC-54 */ readonly layoutVersionId: string;
  /** DOC-13/DOC-27: rule table ID → rule row ID used. */
  readonly ruleVersions: Readonly<Record<string, string>>;
}

/** Placeholder number of preview snapshots (F04 §4.6.1 step 1b). */
export const PREVIEW_NUMBER = "PREVIEW-0000";

/** Canonical JSON (RFC 8785) of a snapshot — stored as `documentSnapshots.json`. */
export const canonicalSnapshotJson = (snapshot: DocumentSnapshot): string => canonicalize(snapshot);

/** `snapshotHash` = sha256 (hex) of the canonical JSON (DOC-27, RI-01). */
export const snapshotHash = (snapshot: DocumentSnapshot): Promise<string> => sha256Hex(canonicalSnapshotJson(snapshot));

/** Item lines that count for totals and the XML (optional quote positions excluded, QUO-02). */
export const billableItems = (snapshot: Pick<DocumentSnapshot, "lines">): SnapshotItemLine[] =>
  snapshot.lines.filter((l): l is SnapshotItemLine => l.kind === "item" && !l.optional);

/** Invoice types that carry an XML at all (F04 §4.1). */
export const INVOICE_TYPES: readonly SalesDocType[] = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
  "self_billing",
];

export const isInvoiceType = (type: SalesDocType): boolean => INVOICE_TYPES.includes(type);

/** The end date of a supply date (`date`; `period.to`; last day of `month`). */
export function supplyEnd(supply: SupplyDate): string {
  if (supply.kind === "date") return supply.date;
  if (supply.kind === "period") return supply.to;
  return monthBounds(supply.month).to;
}

/** First and last day of a "YYYY-MM" month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = daysInMonth(y, m);
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
