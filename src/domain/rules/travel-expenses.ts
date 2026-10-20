/**
 * Travel expenses (Reisekosten, 01-compliance MISC-06): domestic meal allowances and mileage as date-effective
 * rule data. A rate change is a new row, never new code (ADR-005).
 *
 * - Verpflegungsmehraufwand § 9 Abs. 4a EStG (via § 4 Abs. 5 Nr. 5 EStG for the self-employed): more than 8 hours away
 *   or an arrival/departure day of a multi-day trip → partial-day rate; a full 24-hour day → full-day rate.
 *   Meals provided reduce the allowance by 20 % (breakfast) / 40 % (lunch, dinner) of the full-day rate (§ 9 Abs. 4a
 *   S. 8 EStG), never below 0.
 * - Fahrtkosten § 9 Abs. 1 Nr. 4a S. 2 EStG (Wegstreckenentschädigung, BRKG): car 0,30 €/km, other motor vehicles
 *   0,20 €/km.
 *
 * LEGAL-OPEN: 01-compliance MISC-06 / research 01 — foreign per diems (annual BMF letter) and the commuting allowance
 * (0,38 €/km from the first km since 2026, StÄndG 2025, UNSURE) are not part of this table; domestic trips only.
 */

import type { Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleOverride, type RuleRow } from "./rule-table";

export interface TravelRates {
  /** > 8 h away, and arrival/departure days of a multi-day trip. */
  readonly partialDayCents: number;
  /** Full 24-hour day away. */
  readonly fullDayCents: number;
  /** Meal reductions as basis points of the full-day rate. */
  readonly breakfastReductionBp: number;
  readonly mealReductionBp: number;
  /** Mileage per km. */
  readonly carPerKmCents: number;
  readonly otherVehiclePerKmCents: number;
}

export const TRAVEL_RATES = defineRuleTable<TravelRates>("travel_rates", [
  {
    validFrom: "2014-01-01",
    validTo: "2019-12-31",
    value: {
      partialDayCents: 1200,
      fullDayCents: 2400,
      breakfastReductionBp: 2000,
      mealReductionBp: 4000,
      carPerKmCents: 30,
      otherVehiclePerKmCents: 20,
    },
    source:
      "§ 9 Abs. 4a S. 3 EStG i. d. F. Gesetz zur Änderung und Vereinfachung der Unternehmensbesteuerung und des steuerlichen Reisekostenrechts vom 20.02.2013 (BGBl. 2013 I S. 285); § 9 Abs. 1 Nr. 4a EStG, § 5 Abs. 1 BRKG",
  },
  {
    validFrom: "2020-01-01",
    value: {
      partialDayCents: 1400,
      fullDayCents: 2800,
      breakfastReductionBp: 2000,
      mealReductionBp: 4000,
      carPerKmCents: 30,
      otherVehiclePerKmCents: 20,
    },
    source:
      "§ 9 Abs. 4a S. 3 EStG i. d. F. Gesetz zur weiteren steuerlichen Förderung der Elektromobilität vom 12.12.2019 (BGBl. 2019 I S. 2451); § 9 Abs. 1 Nr. 4a EStG, § 5 Abs. 1 BRKG",
  },
]);

export function lookupTravelRates(
  date: CalendarDate,
  overrides: readonly RuleOverride<TravelRates>[] = [],
): Result<RuleRow<TravelRates>, RuleMissing> {
  return lookupRule(TRAVEL_RATES, date, overrides);
}
