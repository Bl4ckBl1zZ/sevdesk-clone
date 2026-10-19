/**
 * Received E-Rechnung (F06 INB-021…047, ER-02): the syntax-neutral EN 16931 view of an inbound XRechnung (UBL/CII) or
 * ZUGFeRD/Factur-X XML. Plain JSON only (strings, numbers, booleans, arrays, objects; absent fields are omitted), so
 * the parsed model can be stored on the inbox item and rendered by the readable view (INB-040). Amounts are integer
 * cents (signed as printed — credit notes usually print positive amounts with TypeCode 381), quantities 1/1,000,
 * prices 1/10,000, rates basis points. BG-24 attachment bytes are returned separately by the parser (INB-041).
 */

export type EinvoiceProfile = "XRECHNUNG" | "EN16931" | "BASIC" | "EXTENDED" | "BASIC-WL" | "MINIMUM" | "UNKNOWN";

/** BT-20 Skonto in the KoSIT `#SKONTO#` syntax (INB-043). */
export interface SkontoTerm {
  percentBp: number;
  days: number;
  baseCents?: number;
}

export interface ReceivedAddress {
  /** BT-35 / BT-50 */ line1?: string;
  /** BT-36 / BT-51 */ line2?: string;
  /** BT-37 / BT-52 */ city?: string;
  /** BT-38 / BT-53 */ postalCode?: string;
  /** BT-40 / BT-55 */ countryCode?: string;
}

export interface ReceivedElectronicAddress {
  scheme: string;
  value: string;
}

export interface ReceivedLine {
  /** BT-126 */ id: string;
  /** BT-153 */ name: string;
  /** BT-154 */ description?: string;
  /** BT-129 */ quantityMilli: number;
  /** BT-130 */ unitCode?: string;
  /** BT-131 */ netCents: number;
  /** BT-146 */ unitPriceMicros?: number;
  /** BT-151 (UNCL5305) */ category: string;
  /** BT-152 */ rateBp: number;
}

export interface ReceivedAllowanceCharge {
  charge: boolean;
  /** BT-92 / BT-99 */ amountCents: number;
  /** BT-97 / BT-104 */ reason?: string;
  /** BT-95 / BT-102 */ category: string;
  /** BT-96 / BT-103 */ rateBp: number;
}

export interface ReceivedVatBreakdown {
  /** BT-118 */ category: string;
  /** BT-119 */ rateBp: number;
  /** BT-116 */ taxableCents: number;
  /** BT-117 */ taxCents: number;
  /** BT-120 */ exemptionReason?: string;
}

export interface ReceivedTotals {
  /** BT-106 */ lineTotalCents: number;
  /** BT-107 */ allowanceTotalCents: number;
  /** BT-108 */ chargeTotalCents: number;
  /** BT-109 */ taxExclusiveCents: number;
  /** BT-110 */ taxCents: number;
  /** BT-112 */ taxInclusiveCents: number;
  /** BT-113 */ prepaidCents: number;
  /** BT-114 */ roundingCents: number;
  /** BT-115 */ payableCents: number;
}

export interface ReceivedInvoice {
  syntax: "ubl" | "cii";
  /** BT-24 */ guidelineId?: string;
  profile: EinvoiceProfile;
  /** MINIMUM / BASIC-WL: „keine E-Rechnung i.S.d. § 14 UStG“ (INB-023, EC-INB-09). */
  notEInvoice: boolean;
  /** BT-3 */ typeCode: string;
  /** BT-1 */ number: string;
  /** BT-2 (YYYY-MM-DD) */ issueDate: string;
  /** BT-9 */ dueDate?: string;
  /** BT-5 */ currency: string;
  /** BT-6 */ vatCurrency?: string;
  /** BT-111 */ taxTotalVatCurrencyCents?: number;
  /** BT-10 */ buyerReference?: string;
  /** BT-12 */ contractRef?: string;
  /** BT-13 */ orderRef?: string;
  /** BG-3 / BT-25, BT-26 */ precedingInvoices: { number: string; date?: string }[];
  /** BT-72 */ supplyDate?: string;
  /** BG-14 */ period?: { from: string; to: string };
  /** BT-22 */ notes: string[];
  seller: {
    /** BT-27 */ name: string;
    /** BT-28 */ tradeName?: string;
    /** BT-31 */ vatId?: string;
    /** BT-32 */ taxNumber?: string;
    /** BT-34 */ electronicAddress?: ReceivedElectronicAddress;
    /** BT-43 */ email?: string;
    /** BG-5 */ address: ReceivedAddress;
  };
  buyer: {
    /** BT-44 */ name?: string;
    /** BT-48 */ vatId?: string;
    /** BT-49 */ electronicAddress?: ReceivedElectronicAddress;
    /** BG-8 */ address?: ReceivedAddress;
  };
  /** BG-10 */ payee?: { name: string };
  payment: {
    /** BT-81 */ meansCode?: string;
    /** BT-84 (normalised: upper case, no spaces) */ iban?: string;
    /** BT-86 */ bic?: string;
    /** BT-85 */ accountName?: string;
    /** BT-20 */ termsText?: string;
    skonto: SkontoTerm[];
  };
  /** BG-25 */ lines: ReceivedLine[];
  /** BG-20 / BG-21 (document level) */ allowancesCharges: ReceivedAllowanceCharge[];
  /** BG-23 */ vatBreakdown: ReceivedVatBreakdown[];
  /** BG-22 */ totals: ReceivedTotals;
  /** BG-24 (metadata; bytes are returned by the parser separately) */
  attachments: { id?: string; description?: string; filename: string; mime: string }[];
}

/** One BG-24 attachment with its decoded bytes (INB-041: extracted, hashed and listed; the XML stays unchanged). */
export interface ReceivedAttachment {
  filename: string;
  mime: string;
  description?: string;
  bytes: Uint8Array;
}
