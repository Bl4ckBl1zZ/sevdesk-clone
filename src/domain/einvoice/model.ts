/**
 * EN 16931 semantic model (02 §2 "Own EN 16931 model", ADR-007). Syntax-neutral: the CII and UBL serializers write
 * exactly this object. Amounts are integer cents, quantities 1/1,000, prices 1/10,000, rates basis points — the
 * serializers format them as decimals. Field comments name the business terms (BT/BG).
 */

/** UNTDID 1001 subset used by F04 App. A.2 (BR-DE-17). */
export type InvoiceTypeCode = "380" | "381" | "384" | "326" | "386" | "389" | "875" | "876" | "877";

/** UNCL5305 (KU is mapped to E by the mapper, App. A.9). */
export type XmlVatCategory = "S" | "Z" | "E" | "AE" | "K" | "G" | "O";

/** BT-24 values (F04 App. A.1). */
export const CUSTOMIZATION_ID = {
  en16931: "urn:cen.eu:en16931:2017",
  xrechnung: "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
} as const;

/** BT-23 (XRechnung, PEPPOL billing process). */
export const BUSINESS_PROCESS_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

export type En16931Profile = keyof typeof CUSTOMIZATION_ID;

export interface XmlAddress {
  /** BT-35 / BT-50 / BT-75 */ readonly line1?: string;
  /** BT-36 / BT-51 / BT-76 */ readonly line2?: string;
  /** BT-162 / BT-163 / BT-165 */ readonly line3?: string;
  /** BT-37 / BT-52 / BT-77 */ readonly city?: string;
  /** BT-38 / BT-53 / BT-78 */ readonly postalCode?: string;
  /** BT-40 / BT-55 / BT-80 */ readonly countryCode: string;
}

export interface XmlElectronicAddress {
  readonly scheme: string;
  readonly value: string;
}

export interface XmlSeller {
  /** BT-27 */ readonly name: string;
  /** BT-28 */ readonly tradeName?: string;
  /** BT-29 */ readonly identifier?: string;
  /** BT-30 */ readonly registerNumber?: string;
  /** BT-31 */ readonly vatId?: string;
  /** BT-32 (scheme FC) */ readonly taxNumber?: string;
  /** BT-33 */ readonly legalInfo?: string;
  /** BT-34 */ readonly electronicAddress?: XmlElectronicAddress;
  /** BG-5 */ readonly address: XmlAddress;
  /** BG-6 */ readonly contact?: { readonly name?: string; readonly phone?: string; readonly email?: string };
}

export interface XmlBuyer {
  /** BT-44 */ readonly name: string;
  /** BT-45 */ readonly tradeName?: string;
  /** BT-46 */ readonly identifier?: string;
  /** BT-47 */ readonly registerNumber?: string;
  /** BT-48 */ readonly vatId?: string;
  /** BT-49 */ readonly electronicAddress?: XmlElectronicAddress;
  /** BG-8 */ readonly address: XmlAddress;
  /** BG-9 */ readonly contact?: { readonly name?: string; readonly phone?: string; readonly email?: string };
}

export interface XmlNote {
  /** BT-21 (UNTDID 4451) */ readonly subjectCode?: string;
  /** BT-22 */ readonly text: string;
}

export interface XmlPaymentMeans {
  /** BT-81 (UNTDID 4461) */ readonly code: string;
  /** BT-82 */ readonly text?: string;
  /** BT-83 */ readonly remittance?: string;
  /** BG-17 */ readonly account?: { readonly iban: string; readonly name?: string; readonly bic?: string };
}

export interface XmlAllowanceCharge {
  readonly charge: boolean;
  /** BT-92 / BT-99 */ readonly amountCents: number;
  /** BT-93 / BT-100 */ readonly baseCents?: number;
  /** BT-94 / BT-101 */ readonly percentBp?: number;
  /** BT-95 / BT-102 */ readonly category: XmlVatCategory;
  /** BT-96 / BT-103 (absent for O) */ readonly rateBp: number | null;
  /** BT-97 / BT-104 */ readonly reason?: string;
  /** BT-98 / BT-105 */ readonly reasonCode?: string;
}

export interface XmlVatBreakdown {
  /** BT-116 */ readonly baseCents: number;
  /** BT-117 */ readonly vatCents: number;
  /** BT-118 */ readonly category: XmlVatCategory;
  /** BT-119 (absent for O) */ readonly rateBp: number | null;
  /** BT-120 */ readonly exemptionReason?: string;
  /** BT-121 */ readonly exemptionReasonCode?: string;
}

export interface XmlLine {
  /** BT-126 */ readonly id: string;
  /** BT-127 */ readonly note?: string;
  /** BT-129 */ readonly quantityMilli: number;
  /** BT-130 */ readonly unitCode: string;
  /** BT-131 */ readonly netCents: number;
  /** BG-26 */ readonly period?: { readonly from: string; readonly to: string };
  /** BG-27 line allowance (net mode discounts, App. A.10) */
  readonly allowance?: {
    readonly amountCents: number;
    readonly baseCents: number;
    readonly percentBp?: number;
    readonly reason: string;
    readonly reasonCode: string;
  };
  /** BT-146 net price in 1/10,000 (or cents·100 when the base quantity is used) */ readonly priceMicros: number;
  /** BT-149 base quantity (1/1,000), only when the price is given for a base quantity (App. E.3 step 5) */
  readonly baseQuantityMilli?: number;
  /** BT-151 */ readonly category: XmlVatCategory;
  /** BT-152 (absent for O) */ readonly rateBp: number | null;
  /** BT-153 */ readonly name: string;
  /** BT-154 */ readonly description?: string;
  /** BT-155 */ readonly sellerItemId?: string;
  /** BT-156 */ readonly buyerItemId?: string;
}

export interface XmlAttachment {
  /** BT-122 */ readonly id: string;
  /** BT-123 */ readonly description?: string;
  /** BT-125 */ readonly base64: string;
  readonly mime: string;
  readonly filename: string;
}

export interface En16931Invoice {
  readonly profile: En16931Profile;
  /** BT-24 */ readonly customizationId: string;
  /** BT-23 */ readonly businessProcessId?: string;
  /** BT-1 */ readonly number: string;
  /** BT-2 */ readonly issueDate: string;
  /** BT-3 */ readonly typeCode: InvoiceTypeCode;
  /** BT-5 */ readonly currency: string;
  /** BT-6 */ readonly taxCurrency?: "EUR";
  /** BT-9 */ readonly dueDate?: string;
  /** BT-10 */ readonly buyerReference?: string;
  /** BT-11 */ readonly projectReference?: string;
  /** BT-12 */ readonly contractReference?: string;
  /** BT-13 */ readonly orderReference?: string;
  /** BT-14 */ readonly salesOrderReference?: string;
  /** BT-16 */ readonly despatchAdviceReference?: string;
  /** BT-20 */ readonly paymentTerms?: string;
  /** BG-1 */ readonly notes: readonly XmlNote[];
  /** BG-3 */ readonly precedingInvoices: readonly { readonly number: string; readonly date: string }[];
  readonly seller: XmlSeller;
  readonly buyer: XmlBuyer;
  /** BG-13 */
  readonly delivery?: {
    readonly partyName?: string;
    readonly address?: XmlAddress /** BT-72 */;
    readonly date?: string;
  };
  /** BG-14 */ readonly invoicePeriod?: { readonly from: string; readonly to: string };
  /** BG-16 */ readonly paymentMeans: readonly XmlPaymentMeans[];
  /** BG-20 / BG-21 */ readonly allowanceCharges: readonly XmlAllowanceCharge[];
  /** BG-22 */
  readonly totals: {
    /** BT-106 */ readonly lineNetCents: number;
    /** BT-107 */ readonly allowanceCents: number;
    /** BT-108 */ readonly chargeCents: number;
    /** BT-109 */ readonly taxExclusiveCents: number;
    /** BT-110 */ readonly vatCents: number;
    /** BT-111 */ readonly vatAccountingCurrencyCents?: number;
    /** BT-112 */ readonly taxInclusiveCents: number;
    /** BT-113 */ readonly prepaidCents: number;
    /** BT-114 */ readonly roundingCents: number;
    /** BT-115 */ readonly payableCents: number;
  };
  /** BG-23 */ readonly vatBreakdown: readonly XmlVatBreakdown[];
  /** BG-24 */ readonly attachments: readonly XmlAttachment[];
  /** BG-25 */ readonly lines: readonly XmlLine[];
}
