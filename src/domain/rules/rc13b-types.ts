/**
 * § 13b UStG service/goods types (03 §0.2 `Rc13bType`, F04 App. B `rc_13b`, App. C). The paragraph number fills the
 * `{nr}` placeholder of the note "Steuerschuldnerschaft des Leistungsempfängers (§ 13b Abs. 2 Nr. {nr}, Abs. 5 UStG)".
 */
import { err, type Issue, issue, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleRow } from "./rule-table";

export interface Rc13bTypeValue {
  /** "4", "5b", … — § 13b Abs. 2 Nr. */
  readonly nr: string;
  readonly label: string;
}

const type = (id: string, nr: string, label: string, validFrom = "2007-01-01") =>
  defineRuleTable<Rc13bTypeValue>(`rc13b_${id}`, [
    { validFrom, value: { nr, label }, source: `§ 13b Abs. 2 Nr. ${nr} UStG` },
  ]);

export const RC13B_TYPES = {
  property: type("property", "3", "Umsätze, die unter das Grunderwerbsteuergesetz fallen"),
  construction: type("construction", "4", "Bauleistungen"),
  energy_reseller: type("energy_reseller", "5b", "Gas, Elektrizität, Wärme, Kälte an Wiederverkäufer"),
  emission_allowances: type("emission_allowances", "6", "Übertragung von Emissionszertifikaten", "2010-07-01"),
  scrap: type("scrap", "7", "Lieferung von Schrott und Altmetall (Anlage 3)", "2011-01-01"),
  cleaning: type("cleaning", "8", "Gebäudereinigung", "2011-01-01"),
  gold: type("gold", "9", "Lieferung von Gold", "2011-01-01"),
  electronics: type(
    "electronics",
    "10",
    "Mobilfunkgeräte, Tablets, Spielekonsolen, integrierte Schaltkreise",
    "2011-07-01",
  ),
  metals: type("metals", "11", "Lieferung von Metallen (Anlage 4)", "2014-10-01"),
  telecom_reseller: type(
    "telecom_reseller",
    "12",
    "Telekommunikationsdienstleistungen an Wiederverkäufer",
    "2021-01-01",
  ),
} as const;

export type Rc13bType = keyof typeof RC13B_TYPES;

export function lookupRc13bType(
  id: string,
  date: CalendarDate,
): Result<RuleRow<Rc13bTypeValue>, RuleMissing | Issue<"rc13b_type_unknown">> {
  if (!Object.hasOwn(RC13B_TYPES, id)) {
    return err(issue("rc13b_type_unknown", `Unbekannte § 13b-Art „${id}“.`, { id }));
  }
  return lookupRule(RC13B_TYPES[id as Rc13bType], date);
}
