/**
 * DATEV-02 / F09 EXP-005, EXP-007: DATEV BU-Schlüssel (Steuerschlüssel) per journal tax key — date-effective data.
 *
 * Only the long-standing standard keys are shipped: 2 = Umsatzsteuer 7 %, 3 = Umsatzsteuer 19 %, 8 = Vorsteuer 7 %,
 * 9 = Vorsteuer 19 %, 40 = Aufhebung der Automatik (used for the rounding correction line, F09 §4.1.4).
 * LEGAL-OPEN (F09 open item 5, DATEV-02): keys for igE, §13b, EU services, igL, exempt and non-taxable turnover
 * depend on the DATEV client setup and the Steuerberater; they are not shipped. Those postings must use DATEV
 * automatic accounts (the shipped SKR revenue/expense accounts for these cases are automatic or carry no tax);
 * a non-automatic account with such a tax key is a blocking validation error until a key is configured here.
 */
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleTable } from "./rule-table";

export interface DatevBuValue {
  /** Journal tax key → BU-Schlüssel. */
  readonly keys: Readonly<Record<string, string>>;
  /** Tax key → VAT rate in basis points (DATEV recomputes VAT from the gross with this rate). */
  readonly rates: Readonly<Record<string, number>>;
}

export type DatevBuRow = DatevBuValue;

export const DATEV_BU_CORRECTION = "40";

export const DATEV_BU_TABLE: RuleTable<DatevBuValue> = defineRuleTable<DatevBuValue>("datev-bu-schluessel", [
  {
    validFrom: "2021-01-01",
    value: {
      keys: { USt19: "3", USt7: "2", VSt19: "9", VSt7: "8" },
      rates: { USt19: 1900, USt7: 700, VSt19: 1900, VSt7: 700 },
    },
    source: "DATEV Steuerschlüssel (BU-Schlüssel) der Standardkontenrahmen SKR 03/04",
  },
]);

export function datevBuRow(date: string): DatevBuValue | null {
  const r = lookupRule(DATEV_BU_TABLE, date as CalendarDate);
  return r.ok ? r.value.value : null;
}
