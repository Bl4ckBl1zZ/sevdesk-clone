/**
 * Date-effective thresholds and surcharges (01 KU-01, UST-14, MAHN-02/03; 10 §1 boundary values).
 */
import { ok, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleOverride, type RuleRow } from "./rule-table";

export interface KleinunternehmerLimits {
  /** Gesamtumsatz of the prior calendar year must not exceed this. */
  readonly priorYearLimitCents: number;
  /** Hard cap in the current year: the supply that crosses it and all later ones are taxed normally. */
  readonly currentYearLimitCents: number;
  /** Founding year: hard cap on the (not annualised) turnover. */
  readonly foundingYearLimitCents: number;
  /** Warning levels in basis points of a limit (F04 `ku_threshold_80` / `ku_threshold_95`). */
  readonly warnAtBp: readonly number[];
}

// LEGAL-OPEN: 01 item 2 — crossing the 100k limit is evaluated on the supply date; that supply and all later
// ones are taxed normally (KU-01). Rows before 2025 (22.000 € / 50.000 € forecast rule) are not shipped: the
// monitor only runs for current years, and earlier dates return `rule_missing` instead of a guess.
export const KLEINUNTERNEHMER_LIMITS = defineRuleTable<KleinunternehmerLimits>("kleinunternehmer_limits", [
  {
    validFrom: "2025-01-01",
    value: {
      priorYearLimitCents: 2_500_000,
      currentYearLimitCents: 10_000_000,
      foundingYearLimitCents: 2_500_000,
      warnAtBp: [8000, 9500],
    },
    source: "§ 19 Abs. 1 UStG i. d. F. JStG 2024 (BGBl. 2024 I Nr. 387)",
  },
]);

export interface KuWaiverRules {
  /** The waiver binds for at least this many calendar years, counted from the first waived year. */
  readonly bindingYears: number;
  /**
   * Latest declaration: end of February of (waived year + n); `null` = no fixed deadline in this rule row
   * (before JStG 2024 the waiver could be declared until the assessment became final — not checked).
   */
  readonly declarationYearsAfter: number | null;
}

/** KU-04, F01 SET-033: looked up by the first waived year (1 January). */
export const KU_WAIVER_RULES = defineRuleTable<KuWaiverRules>("ku_waiver", [
  {
    validFrom: "1980-01-01",
    validTo: "2024-12-31",
    value: { bindingYears: 5, declarationYearsAfter: null },
    source: "§ 19 Abs. 2 UStG a. F. (Bindung mindestens fünf Kalenderjahre)",
  },
  {
    validFrom: "2025-01-01",
    value: { bindingYears: 5, declarationYearsAfter: 2 },
    source:
      "§ 19 Abs. 3 UStG i. d. F. JStG 2024 (BGBl. 2024 I Nr. 387): Erklärung bis Ende Februar des zweitfolgenden Jahres",
  },
]);

export interface OssThreshold {
  /** EU-wide Entgelte (net, EUR) of B2C distance sales and TBE services in the prior and current year (§ 3c Abs. 4). */
  readonly limitCents: number;
}

/** UVA-07, TAX-017: above this the place of supply moves to the destination state (OSS, P4). */
export const OSS_THRESHOLD = defineRuleTable<OssThreshold>("oss_threshold", [
  {
    validFrom: "2021-07-01",
    value: { limitCents: 1_000_000 },
    source:
      "§ 3c Abs. 4 UStG i. d. F. Gesetz zur Umsetzung des Digitalpakets (BGBl. 2020 I S. 3096), Art. 59c MwStSystRL",
  },
]);

export interface BookkeepingDutyLimits {
  /** § 141 Abs. 1 Nr. 1 AO: Umsatz of the calendar year (per § 241a HGB for Einzelkaufleute alike). */
  readonly turnoverCents: number;
  /** § 141 Abs. 1 Nr. 4 AO: Gewinn aus Gewerbebetrieb of the fiscal year. */
  readonly profitCents: number;
}

/** TAX-013 (a): looked up by the year whose figures are evaluated (1 January). Earlier years are not monitored. */
export const BOOKKEEPING_DUTY_LIMITS = defineRuleTable<BookkeepingDutyLimits>("bookkeeping_duty_limits", [
  {
    validFrom: "2024-01-01",
    value: { turnoverCents: 80_000_000, profitCents: 8_000_000 },
    source:
      "§ 141 Abs. 1 AO, § 241a HGB i. d. F. Wachstumschancengesetz (BGBl. 2024 I Nr. 108), ab Wirtschaftsjahr 2024",
  },
]);

export interface IstTaxationLimit {
  /** § 20 Satz 1 Nr. 1 UStG: Gesamtumsatz of the prior calendar year. */
  readonly priorYearLimitCents: number;
}

/** TAX-013 (c): looked up by the year in which Ist-Versteuerung would continue (1 January). */
export const IST_TAXATION_LIMIT = defineRuleTable<IstTaxationLimit>("ist_taxation_limit", [
  {
    validFrom: "2024-01-01",
    value: { priorYearLimitCents: 80_000_000 },
    source: "§ 20 Satz 1 Nr. 1 UStG i. d. F. Wachstumschancengesetz (BGBl. 2024 I Nr. 108)",
  },
]);

export interface KleinbetragLimit {
  /** Gross amount in EUR (DOC-56: evaluated in EUR). */
  readonly limitCents: number;
}

export const KLEINBETRAG_LIMIT = defineRuleTable<KleinbetragLimit>("kleinbetragsrechnung_limit", [
  {
    validFrom: "2007-01-01",
    validTo: "2016-12-31",
    value: { limitCents: 15_000 },
    source: "§ 33 UStDV a. F. (150 €)",
  },
  {
    validFrom: "2017-01-01",
    value: { limitCents: 25_000 },
    source: "§ 33 UStDV i. d. F. Zweites Bürokratieentlastungsgesetz (BGBl. 2017 I S. 2143)",
  },
]);

/** UST-14: Kleinbetragsrechnung only if the gross (EUR) is ≤ the limit at the invoice date. */
export function isWithinKleinbetragLimit(
  grossEurCents: number,
  date: CalendarDate,
  overrides: readonly RuleOverride<KleinbetragLimit>[] = [],
): Result<boolean, RuleMissing> {
  const r = lookupRule(KLEINBETRAG_LIMIT, date, overrides);
  return r.ok ? ok(grossEurCents <= r.value.value.limitCents) : r;
}

export interface VerzugSurcharges {
  /** § 288 Abs. 1 BGB: a consumer is involved. */
  readonly b2cBp: number;
  /** § 288 Abs. 2 BGB: no consumer involved. */
  readonly b2bBp: number;
  /** § 288 Abs. 5 BGB: flat fee, B2B only, once per claim (MAHN-03). */
  readonly flatFeeB2bCents: number;
}

// Values since the Gesetz zur Bekämpfung von Zahlungsverzug im Geschäftsverkehr. Per Art. 229 § 34 EGBGB the new
// rules apply to obligations arising after 28.07.2014; older claims are out of scope (time-barred by now).
export const VERZUG_SURCHARGES = defineRuleTable<VerzugSurcharges>("verzug_surcharges", [
  {
    validFrom: "2014-07-29",
    value: { b2cBp: 500, b2bBp: 900, flatFeeB2bCents: 4000 },
    source:
      "§ 288 Abs. 1, 2 und 5 BGB i. d. F. Gesetz zur Bekämpfung von Zahlungsverzug im Geschäftsverkehr (BGBl. 2014 I S. 1218)",
  },
]);

export const lookupVerzugSurcharges = (
  date: CalendarDate,
  overrides: readonly RuleOverride<VerzugSurcharges>[] = [],
): Result<RuleRow<VerzugSurcharges>, RuleMissing> => lookupRule(VERZUG_SURCHARGES, date, overrides);

export interface PaymentTermLimits {
  /** § 271a Abs. 1 BGB: longer terms between businesses are effective only if expressly agreed and not grossly unfair. */
  readonly businessMaxDays: number;
  /** § 271a Abs. 2 BGB: a public authority as debtor — over 30 days only if expressly agreed and objectively justified. */
  readonly publicAuthorityMaxDays: number;
}

// LEGAL-OPEN: 01 MAHN-06 — the EU Late Payment Regulation (2023 proposal, hard 30-day maximum) is not adopted; if
// it is, a new row (or an owner override, SET-121) changes the PAY-054/EC-DUE-05 warning without code changes.
export const PAYMENT_TERM_LIMITS = defineRuleTable<PaymentTermLimits>("payment_term_limits", [
  {
    validFrom: "2014-07-29",
    value: { businessMaxDays: 60, publicAuthorityMaxDays: 30 },
    source: "§ 271a BGB i. d. F. Gesetz zur Bekämpfung von Zahlungsverzug im Geschäftsverkehr (BGBl. 2014 I S. 1218)",
  },
]);

export const lookupPaymentTermLimits = (
  date: CalendarDate,
  overrides: readonly RuleOverride<PaymentTermLimits>[] = [],
): Result<RuleRow<PaymentTermLimits>, RuleMissing> => lookupRule(PAYMENT_TERM_LIMITS, date, overrides);
