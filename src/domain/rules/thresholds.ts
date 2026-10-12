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
