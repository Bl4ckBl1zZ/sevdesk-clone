/**
 * Purchase vouchers (Belege / Ausgaben) — shared shapes (F06 §3.4–3.10, 03 §6 `vouchers`, `voucherLines`).
 *
 * Conventions (02 §5): money in integer cents (document currency unless suffixed `Eur`), rates in basis points,
 * quantities in milli, business dates `YYYY-MM-DD`. Pure types and enum lists; no I/O.
 */
import type { SupplyDate } from "../accounting/events";

export const VOUCHER_DIRECTIONS = ["expense", "income"] as const;
export type VoucherDirection = (typeof VOUCHER_DIRECTIONS)[number];

export const VOUCHER_KINDS = ["standard", "bewirtung", "eigenbeleg", "asset", "tax_payment", "private"] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];

export const VOUCHER_STATUSES = ["draft", "open", "scheduled", "partially_paid", "paid", "cancelled"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

/** 03 §6 `vouchers.taxRule`; the last three are income rules (VOU-010, delta D-02). */
export const EXPENSE_TAX_RULES = [
  "input_vat_deductible",
  "no_input_vat",
  "reverse_charge_13b_de",
  "reverse_charge_eu",
  "reverse_charge_non_eu",
  "intra_community_acquisition",
  "import_vat",
  "kleinunternehmer_supplier",
] as const;
export const INCOME_TAX_RULES = ["output_vat", "exempt_income", "not_taxable"] as const;
export const TAX_RULES = [...EXPENSE_TAX_RULES, ...INCOME_TAX_RULES] as const;
export type ExpenseTaxRule = (typeof EXPENSE_TAX_RULES)[number];
export type IncomeTaxRule = (typeof INCOME_TAX_RULES)[number];
export type TaxRule = (typeof TAX_RULES)[number];

/** VOU-022: the supplier shows net only, the business self-assesses the German VAT (§13b / §1a UStG). */
export const SELF_ASSESSMENT_RULES = [
  "reverse_charge_13b_de",
  "reverse_charge_eu",
  "reverse_charge_non_eu",
  "intra_community_acquisition",
] as const satisfies readonly TaxRule[];
export type SelfAssessmentRule = (typeof SELF_ASSESSMENT_RULES)[number];

export const isSelfAssessment = (rule: string): rule is SelfAssessmentRule =>
  (SELF_ASSESSMENT_RULES as readonly string[]).includes(rule);
export const isIncomeRule = (rule: string): rule is IncomeTaxRule =>
  (INCOME_TAX_RULES as readonly string[]).includes(rule);
export const isTaxRule = (rule: string): rule is TaxRule => (TAX_RULES as readonly string[]).includes(rule);

export type PriceMode = "net" | "gross";

/** VOU-065: the owner's answer to „Anlagegut?“ for a line above the recording threshold. */
export const ASSET_DECISIONS = ["gwg", "pool", "asset", "none"] as const;
export type AssetDecision = (typeof ASSET_DECISIONS)[number];

/** F08 TAX-018 subtypes of a `tax_payment` voucher (posting §4.2.6 X1–X7). */
export const TAX_PAYMENT_SUBTYPES = [
  "ust_prepayment",
  "sondervorauszahlung",
  "ust_annual",
  "gewerbesteuer",
  "est_private",
  "kst",
] as const;
export type TaxPaymentSubtype = (typeof TAX_PAYMENT_SUBTYPES)[number];

export const FX_SOURCES = ["bmf_monthly", "ecb_daily", "manual", "transaction"] as const;
export type FxSource = (typeof FX_SOURCES)[number];

/** 03 §0.2 `FxRate`: "1 EUR = x FC" as a decimal string (≤ 6 decimals). */
export interface VoucherFxRate {
  rate: string;
  source: FxSource;
  sourceText?: string;
  date: string;
}

/** One stored voucher line (03 §6 `voucherLines`), amounts in the document currency. */
export interface VoucherLine {
  account: string;
  description?: string;
  quantityMilli?: number;
  netCents: number;
  vatRateBp: number;
  vatCents: number;
  grossCents: number;
  selfAssessedVatCents?: number;
  netEurCents?: number;
  vatEurCents?: number;
  /** Bewirtung 30 % (expense split) or a private share (expense and VAT reduced), VOU-027. */
  nonDeductibleShareBp?: number;
  assetDecision?: AssetDecision;
  costCenterId?: string;
}

export interface RateTotal {
  rateBp: number;
  netCents: number;
  vatCents: number;
}

/** 03 §6 `vouchers.totals` (document currency). */
export interface VoucherTotals {
  netCents: number;
  vatCents: number;
  grossCents: number;
  selfAssessedVatCents: number;
  byRate: RateTotal[];
}

export interface VoucherTotalsEur {
  netCents: number;
  vatCents: number;
  grossCents: number;
  selfAssessedVatCents: number;
}

export type { SupplyDate };
