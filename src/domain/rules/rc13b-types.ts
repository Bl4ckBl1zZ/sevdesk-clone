/**
 * §13b Abs. 2 UStG reverse-charge types (03 §0.2 `Rc13bType`, F03 PRD-009a, UST-22, EC-046/047/049). Products carry
 * a type key; the paragraph (printed in the `rc_13b` note) and the UStVA Kennzahl come from this date-effective table
 * (data, not code). A product with an unknown key is refused (`RC13B_TYPE_UNKNOWN`, T-PRD-055).
 *
 * LEGAL-OPEN: F03 PRD-009a / README A17 — the rows start at 2021-01-01, the date from which all ten types are in force
 * (§ 13b Abs. 2 Nr. 12 UStG telecommunication resellers, JStG 2020). Earlier start dates per type (for imported or
 * late documents) are added when verified; until then a supply before 2021-01-01 finds no row (`rule_missing`).
 */
import { err, type Issue, issue, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleRow, type RuleTable } from "./rule-table";

export interface Rc13bTypeValue {
  /** Number in § 13b Abs. 2 UStG, filled into the `rc_13b` note ("Nr. {nr}"). */
  readonly paragraphNr: string;
  /** German label for selects. */
  readonly labelDe: string;
  /** Goods (metals, electronics, scrap, gold) or services. */
  readonly supply: "goods" | "services" | "both";
  /** UStVA Kennzahl of the supplier (Umsätze nach § 13b Abs. 5 UStG). */
  readonly ustvaKz: "60";
}

const FROM = "2021-01-01";
const SOURCE = "§ 13b Abs. 2 und 5 UStG i. d. F. JStG 2020 (BGBl. 2020 I S. 3096); UStVA Kz 60";

function rc(id: string, value: Rc13bTypeValue): RuleTable<Rc13bTypeValue> {
  return defineRuleTable<Rc13bTypeValue>(id, [{ validFrom: FROM, value, source: SOURCE }]);
}

export const RC13B_TYPES = {
  construction: rc("construction", { paragraphNr: "4", labelDe: "Bauleistungen", supply: "services", ustvaKz: "60" }),
  cleaning: rc("cleaning", { paragraphNr: "8", labelDe: "Gebäudereinigung", supply: "services", ustvaKz: "60" }),
  scrap: rc("scrap", { paragraphNr: "7", labelDe: "Schrott und Altmetalle", supply: "goods", ustvaKz: "60" }),
  metals: rc("metals", {
    paragraphNr: "11",
    labelDe: "Edelmetalle und unedle Metalle",
    supply: "goods",
    ustvaKz: "60",
  }),
  electronics: rc("electronics", {
    paragraphNr: "10",
    labelDe: "Mobilfunkgeräte, Tablets, Spielkonsolen, integrierte Schaltkreise",
    supply: "goods",
    ustvaKz: "60",
  }),
  gold: rc("gold", { paragraphNr: "9", labelDe: "Goldlieferungen", supply: "goods", ustvaKz: "60" }),
  emission_allowances: rc("emission_allowances", {
    paragraphNr: "6",
    labelDe: "Emissionszertifikate",
    supply: "services",
    ustvaKz: "60",
  }),
  energy_reseller: rc("energy_reseller", {
    paragraphNr: "5 Buchst. b",
    labelDe: "Gas und Elektrizität an Wiederverkäufer",
    supply: "goods",
    ustvaKz: "60",
  }),
  telecom_reseller: rc("telecom_reseller", {
    paragraphNr: "12",
    labelDe: "Telekommunikationsdienstleistungen an Wiederverkäufer",
    supply: "services",
    ustvaKz: "60",
  }),
  property: rc("property", {
    paragraphNr: "3",
    labelDe: "Umsätze, die unter das Grunderwerbsteuergesetz fallen",
    supply: "both",
    ustvaKz: "60",
  }),
} as const satisfies Record<string, RuleTable<Rc13bTypeValue>>;

export type Rc13bType = keyof typeof RC13B_TYPES;

export const isRc13bType = (key: string): key is Rc13bType => Object.hasOwn(RC13B_TYPES, key);

type Unknown = Issue<"RC13B_TYPE_UNKNOWN">;

export function lookupRc13bType(
  key: string,
  date: CalendarDate,
): Result<RuleRow<Rc13bTypeValue>, Unknown | RuleMissing> {
  if (!isRc13bType(key)) {
    return err(issue("RC13B_TYPE_UNKNOWN", "Unbekannte Art der Steuerschuldnerschaft nach § 13b UStG.", { key }));
  }
  return lookupRule(RC13B_TYPES[key], date);
}
