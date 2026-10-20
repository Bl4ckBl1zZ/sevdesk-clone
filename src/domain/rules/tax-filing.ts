/**
 * Filing-period and deadline rule data (F08 TAX-001, TAX-002, TAX-019; UVA-01, UVA-02, AO-02). Date-effective
 * (CLAUDE.md rule 2): thresholds by the year the period is chosen for, the Neugründer rule by that year, the
 * annual-return deadline for self-filers (no Steuerberater, owner decision B5) by the tax year.
 */
import type { Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleOverride, type RuleRow } from "./rule-table";

export interface UstvaPeriodLimits {
  /** Prior-year tax above this → monthly UStVA (§ 18 Abs. 2 S. 2 UStG). */
  readonly monthlyAboveCents: number;
  /** Prior-year tax up to this → exemption from the UStVA possible on application (§ 18 Abs. 2 S. 3 UStG). */
  readonly waiverUpToCents: number;
}

export const USTVA_PERIOD_LIMITS = defineRuleTable<UstvaPeriodLimits>("ustva_period_limits", [
  {
    validFrom: "2009-01-01",
    validTo: "2024-12-31",
    value: { monthlyAboveCents: 750_000, waiverUpToCents: 100_000 },
    source: "§ 18 Abs. 2 UStG i. d. F. des Steuerbürokratieabbaugesetzes (BGBl. 2008 I S. 2850): 7.500 € / 1.000 €",
  },
  {
    validFrom: "2025-01-01",
    value: { monthlyAboveCents: 900_000, waiverUpToCents: 200_000 },
    source:
      "§ 18 Abs. 2 UStG i. d. F. des Vierten Bürokratieentlastungsgesetzes (BGBl. 2024 I Nr. 323): 9.000 € / 2.000 €",
  },
]);

export interface NeugruenderRule {
  /** Founding year and following year: monthly UStVA (§ 18 Abs. 2 S. 4 UStG). */
  readonly monthlyForFounders: boolean;
}

// LEGAL-OPEN: 01-compliance open item 3 (Neugründer monthly filing from 2027 ⚠). Decided default: the period is what
// the Finanzamt notified (entered by the owner); the suggestion follows this table.
export const NEUGRUENDER_RULE = defineRuleTable<NeugruenderRule>("ustva_neugruender", [
  {
    validFrom: "2002-01-01",
    validTo: "2020-12-31",
    value: { monthlyForFounders: true },
    source: "§ 18 Abs. 2 S. 4 UStG (Neugründer: Gründungsjahr und Folgejahr monatlich)",
  },
  {
    validFrom: "2021-01-01",
    validTo: "2026-12-31",
    value: { monthlyForFounders: false },
    source:
      "§ 18 Abs. 2 S. 6 UStG i. d. F. des Dritten Bürokratieentlastungsgesetzes (BGBl. 2019 I S. 1746): ausgesetzt 2021–2026",
  },
  {
    validFrom: "2027-01-01",
    value: { monthlyForFounders: true },
    source: "§ 18 Abs. 2 S. 4 UStG nach Ablauf der Aussetzung (⚠ LEGAL-OPEN 01-compliance open item 3)",
  },
]);

export interface AnnualReturnDeadline {
  /** Deadline in the year after the tax year (§ 149 Abs. 2 AO, self-filers). */
  readonly month: number;
  readonly day: number;
  /** Reminders before the deadline (days). */
  readonly remindDaysBefore: readonly number[];
}

// LEGAL-OPEN: F08 open question 16 — transitional extensions only as new rows (rule data).
export const ANNUAL_RETURN_DEADLINE = defineRuleTable<AnnualReturnDeadline>("annual_return_deadline_self", [
  {
    validFrom: "2024-01-01",
    value: { month: 7, day: 31, remindDaysBefore: [42, 7] },
    source: "§ 149 Abs. 2 S. 1 AO (Abgabe ohne Steuerberater: 31. Juli des Folgejahres)",
  },
]);

export const lookupUstvaPeriodLimits = (
  date: CalendarDate,
  overrides: readonly RuleOverride<UstvaPeriodLimits>[] = [],
): Result<RuleRow<UstvaPeriodLimits>, RuleMissing> => lookupRule(USTVA_PERIOD_LIMITS, date, overrides);

export const lookupNeugruenderRule = (date: CalendarDate): Result<RuleRow<NeugruenderRule>, RuleMissing> =>
  lookupRule(NEUGRUENDER_RULE, date);

export const lookupAnnualReturnDeadline = (date: CalendarDate): Result<RuleRow<AnnualReturnDeadline>, RuleMissing> =>
  lookupRule(ANNUAL_RETURN_DEADLINE, date);
