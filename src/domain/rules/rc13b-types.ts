/**
 * § 13b UStG reverse-charge types — the single date-effective table `rc13bTypes` (03 §0.2 `Rc13bType`).
 *
 * Consumers:
 * - F03 PRD-009a / T-PRD-055: `products.reverseCharge13b` must be a key of this table (`isRc13bType`); the product
 *   form lists `labelDe`; copied to `documentLines.reverseCharge13b`.
 * - F04 App. B `rc_13b` / App. C / UST-22: the snapshot fills `paragraphNr` into the note "Steuerschuldnerschaft des
 *   Leistungsempfängers (§ 13b Abs. 2 Nr. {nr}, Abs. 5 UStG)" and records the row in `ruleVersions["rc13b:<type>"]`;
 *   the e-invoice serialises the line as category AE.
 * - F08 UStVA: the supplier reports these supplies in Kz 60 (`ustvaKz`).
 *
 * Table ids are `rc13b_<type>` (row ids `rc13b_<type>@<validFrom>`, 03 ruleOverrides `ruleSet: "rc13bTypes"`).
 *
 * LEGAL-OPEN: F03 PRD-009a / README A17 — every row starts at 2021-01-01, the date from which all ten types are in
 * force in the wording and numbering cited here (§ 13b Abs. 2 Nr. 12 UStG telecommunication resellers, JStG 2020).
 * Several types are older (e.g. Bauleistungen since 2004), but the "Abs. 2 Nr. …" numbering dates from the 2010
 * restructuring and labels changed later (Nr. 10 tablets/consoles since 2014-10-01), so earlier rows are added per
 * type only once verified; until then a supply before 2021-01-01 finds no row (`rule_missing`), never a wrong cite.
 */
import { err, type Issue, issue, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleRow, type RuleTable } from "./rule-table";

export interface Rc13bTypeValue {
  /** Number in § 13b Abs. 2 UStG as cited in the `rc_13b` note ("Nr. {nr}"), e.g. "4" or "5 Buchst. b". */
  readonly paragraphNr: string;
  /** German label for selects and the rule overview (F01 SET-120). */
  readonly labelDe: string;
  /** Goods (metals, electronics, scrap, gold), services, or both (property). */
  readonly supply: "goods" | "services" | "both";
  /** UStVA Kennzahl of the supplier (steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer schuldet). */
  readonly ustvaKz: "60";
}

const FROM = "2021-01-01";
const source = (nr: string) =>
  `§ 13b Abs. 2 Nr. ${nr}, Abs. 5 UStG i. d. F. JStG 2020 (BGBl. 2020 I S. 3096); UStVA Kz 60`;

function rc(type: string, value: Rc13bTypeValue, validFrom = FROM): RuleTable<Rc13bTypeValue> {
  return defineRuleTable<Rc13bTypeValue>(`rc13b_${type}`, [{ validFrom, value, source: source(value.paragraphNr) }]);
}

export const RC13B_TYPES = {
  property: rc("property", {
    paragraphNr: "3",
    labelDe: "Umsätze, die unter das Grunderwerbsteuergesetz fallen",
    supply: "both",
    ustvaKz: "60",
  }),
  construction: rc("construction", { paragraphNr: "4", labelDe: "Bauleistungen", supply: "services", ustvaKz: "60" }),
  energy_reseller: rc("energy_reseller", {
    paragraphNr: "5 Buchst. b",
    labelDe: "Gas und Elektrizität an Wiederverkäufer",
    supply: "goods",
    ustvaKz: "60",
  }),
  emission_allowances: rc("emission_allowances", {
    paragraphNr: "6",
    labelDe: "Übertragung von Emissionszertifikaten",
    supply: "services",
    ustvaKz: "60",
  }),
  scrap: rc("scrap", {
    paragraphNr: "7",
    labelDe: "Lieferung von Schrott und Altmetall (Anlage 3)",
    supply: "goods",
    ustvaKz: "60",
  }),
  cleaning: rc("cleaning", { paragraphNr: "8", labelDe: "Gebäudereinigung", supply: "services", ustvaKz: "60" }),
  gold: rc("gold", { paragraphNr: "9", labelDe: "Lieferung von Gold", supply: "goods", ustvaKz: "60" }),
  electronics: rc("electronics", {
    paragraphNr: "10",
    labelDe: "Mobilfunkgeräte, Tablets, Spielekonsolen, integrierte Schaltkreise",
    supply: "goods",
    ustvaKz: "60",
  }),
  metals: rc("metals", {
    paragraphNr: "11",
    labelDe: "Lieferung von Metallen (Anlage 4)",
    supply: "goods",
    ustvaKz: "60",
  }),
  telecom_reseller: rc("telecom_reseller", {
    paragraphNr: "12",
    labelDe: "Telekommunikationsdienstleistungen an Wiederverkäufer",
    supply: "services",
    ustvaKz: "60",
  }),
} as const satisfies Record<string, RuleTable<Rc13bTypeValue>>;

export type Rc13bType = keyof typeof RC13B_TYPES;

export const RC13B_TYPE_KEYS = Object.keys(RC13B_TYPES) as Rc13bType[];

export const isRc13bType = (key: string): key is Rc13bType => Object.hasOwn(RC13B_TYPES, key);

/**
 * Row of `type` on `date`. Rule-level error codes are lower snake case like `rule_missing` (F04 validation code
 * `rc13b_type_unknown`); the product field maps an unknown key to its own `RC13B_TYPE_UNKNOWN` (T-PRD-055).
 */
export function lookupRc13bType(
  type: string,
  date: CalendarDate,
): Result<RuleRow<Rc13bTypeValue>, RuleMissing | Issue<"rc13b_type_unknown">> {
  if (!isRc13bType(type)) {
    return err(
      issue("rc13b_type_unknown", `Unbekannte Art der Steuerschuldnerschaft nach § 13b UStG „${type}“.`, { type }),
    );
  }
  return lookupRule(RC13B_TYPES[type], date);
}

/** Current German label of a type (latest row) for selects; falls back to the key. */
export function rc13bLabelDe(type: Rc13bType): string {
  return RC13B_TYPES[type].entries.at(-1)?.value.labelDe ?? type;
}
