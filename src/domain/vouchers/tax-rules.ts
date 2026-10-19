/**
 * Voucher tax rules (F06 §3.5 VOU-020…028, VOU-043; EC-VOU-05/06/10/11/12/13/14).
 *
 * Rates are date-effective rule data (`src/domain/rules/vat-rates.ts`): a rate is „German on the supply date“ if a
 * German rate key (standard, reduced, restaurant food, zero) resolves to it on that date (UST-15, RI-22). Rates that
 * were German on another date (16 % in 2026) are `rate_not_valid_on_date` (EC-VOU-06); rates that never were German
 * (20 %, 21 %, 25 %) are foreign VAT (EC-VOU-05). Pure; dates passed in.
 */
import { formatBasisPoints } from "../money";
import { type Issue, issue } from "../result";
import { lookupRule } from "../rules/rule-table";
import { VAT_RATE_KEYS, type VatRateKey } from "../rules/vat-rates";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { EXPENSE_TAX_RULES, INCOME_TAX_RULES, isSelfAssessment, type TaxRule, type VoucherDirection } from "./types";

/** Rate keys a purchase line can carry (the exempt key has rate 0 with category E — covered by `zero`). */
const GERMAN_KEYS: readonly VatRateKey[] = ["standard", "reduced", "restaurant_food", "zero"];

/** All German rates (basis points) valid on `date`; 0 % is always allowed (tips, exempt items). */
export function germanRatesOn(date: CalendarDate): number[] {
  const out = new Set<number>([0]);
  for (const key of GERMAN_KEYS) {
    const r = lookupRule(VAT_RATE_KEYS[key], date);
    if (r.ok) out.add(r.value.value.rateBp);
  }
  return [...out].sort((a, b) => b - a);
}

/** Every rate that was German at some point (history of the rule tables). */
export function everGermanRates(): number[] {
  const out = new Set<number>([0]);
  for (const key of GERMAN_KEYS) for (const e of VAT_RATE_KEYS[key].entries) out.add(e.value.rateBp);
  return [...out];
}

export type RateIssue = Issue<"rate_foreign" | "rate_not_valid_on_date" | "rate_required">;

/**
 * VOU-004: lines of `input_vat_deductible` and self-assessment rules need a German rate valid on the supply date.
 * Self-assessment lines need a rate > 0 (the German rate the business owes).
 */
export function checkVoucherRate(rateBp: number, taxRule: TaxRule, supplyDate: CalendarDate): RateIssue | null {
  if (taxRule !== "input_vat_deductible" && taxRule !== "output_vat" && !isSelfAssessment(taxRule)) return null;
  const rate = formatBasisPoints(rateBp);
  if (!germanRatesOn(supplyDate).includes(rateBp)) {
    if (!everGermanRates().includes(rateBp)) {
      return issue(
        "rate_foreign",
        `${rate} % ist kein deutscher Steuersatz. Ausländische Umsatzsteuer ist nicht als Vorsteuer abziehbar – bitte ‚Kein Vorsteuerabzug‘ wählen.`,
        { rateBp },
      );
    }
    return issue("rate_not_valid_on_date", `Der Steuersatz ${rate} % galt am ${formatGermanDate(supplyDate)} nicht.`, {
      rateBp,
      date: supplyDate,
    });
  }
  if (isSelfAssessment(taxRule) && rateBp === 0) {
    return issue(
      "rate_required",
      "Bei Reverse Charge und innergemeinschaftlichem Erwerb trägt jede Position den deutschen Steuersatz, den Sie schulden.",
    );
  }
  return null;
}

export const KU_INPUT_VAT_INFO =
  "Als Kleinunternehmer sind Sie nicht zum Vorsteuerabzug berechtigt. Die USt wird als Aufwand gebucht.";

/**
 * VOU-026 / KU-01: while the company is Kleinunternehmer on the supply date, input VAT is never deductible —
 * `input_vat_deductible` becomes `no_input_vat` (VAT is part of the expense). Self-assessment rules stay (the output
 * VAT is still owed, posted without input-VAT deduction).
 */
export function effectiveTaxRule(rule: TaxRule, companyIsKu: boolean): { rule: TaxRule; info?: string } {
  if (companyIsKu && rule === "input_vat_deductible") return { rule: "no_input_vat", info: KU_INPUT_VAT_INFO };
  return { rule };
}

/** Is input VAT (incl. self-assessed input VAT) deducted for this rule under the company's status? */
export const deductsInputVat = (rule: TaxRule, companyIsKu: boolean): boolean =>
  !companyIsKu && (rule === "input_vat_deductible" || isSelfAssessment(rule) || rule === "import_vat");

export function rulesFor(direction: VoucherDirection): readonly TaxRule[] {
  return direction === "income" ? INCOME_TAX_RULES : EXPENSE_TAX_RULES;
}

/** Plain-language labels and explanations for the tax-rule select (F06 §6.3). */
export const TAX_RULE_LABEL_DE: Readonly<Record<TaxRule, string>> = {
  input_vat_deductible: "Vorsteuerabzug",
  no_input_vat: "Kein Vorsteuerabzug",
  reverse_charge_13b_de: "Reverse Charge Inland (§ 13b)",
  reverse_charge_eu: "Reverse Charge EU",
  reverse_charge_non_eu: "Reverse Charge Drittland",
  intra_community_acquisition: "Innergemeinschaftlicher Erwerb",
  import_vat: "Einfuhrumsatzsteuer",
  kleinunternehmer_supplier: "Lieferant ist Kleinunternehmer",
  output_vat: "Umsatzsteuerpflichtige Einnahme",
  exempt_income: "Steuerfreie Einnahme",
  not_taxable: "Nicht steuerbare Einnahme",
};

export const TAX_RULE_HELP_DE: Readonly<Record<TaxRule, string>> = {
  input_vat_deductible: "Die ausgewiesene deutsche Umsatzsteuer wird als Vorsteuer abgezogen.",
  no_input_vat:
    "Der Bruttobetrag ist Aufwand (ausländische USt, private Anteile, nicht abziehbar oder Rechnung fehlt).",
  reverse_charge_13b_de:
    "Bauleistungen u. Ä. eines inländischen Unternehmers: Sie schulden die USt, ziehen sie als Vorsteuer wieder ab.",
  reverse_charge_eu: "Reverse Charge EU: Sie schulden die USt, ziehen sie als Vorsteuer wieder ab.",
  reverse_charge_non_eu:
    "Leistung eines Unternehmers außerhalb der EU: Sie schulden die USt, ziehen sie als Vorsteuer wieder ab.",
  intra_community_acquisition:
    "Ware aus einem anderen EU-Land: Sie versteuern den Erwerb und ziehen die Steuer als Vorsteuer ab.",
  import_vat: "Zollbescheid: die Einfuhrumsatzsteuer ist als Vorsteuer abziehbar.",
  kleinunternehmer_supplier: "Der Lieferant weist keine Umsatzsteuer aus (§ 19 UStG).",
  output_vat: "Einnahme mit deutscher Umsatzsteuer, die Sie abführen.",
  exempt_income: "Steuerfreie Einnahme (z. B. Versicherungsleistung, Zinsen).",
  not_taxable: "Nicht steuerbare Einnahme (z. B. Erstattung, Schadenersatz).",
};

export type TaxRuleCheckIssue = Issue<
  "ku_supplier_vat" | "reverse_charge_vat_shown" | "own_vat_id_missing" | "supplier_vat_id_not_eu"
>;

const EU_PREFIXES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "XI",
]);

/** EU (non-DE) VAT ID prefix (VOU-023). */
export function isForeignEuVatId(vatId: string | undefined): boolean {
  const v = (vatId ?? "").toUpperCase().replace(/[\s.-]/g, "");
  return v.length > 4 && EU_PREFIXES.has(v.slice(0, 2));
}

/**
 * Rule-level checks: EC-VOU-10 (VAT with a KU supplier), EC-VOU-12 (RC with VAT shown), EC-VOU-13 (RC EU / igE
 * without EU VAT ID, warning) and EC-VOU-14 (igE without own USt-IdNr, error).
 */
export function checkTaxRule(input: {
  taxRule: TaxRule;
  vatShownCents: number;
  supplierVatId?: string;
  ownVatId?: string;
}): { errors: TaxRuleCheckIssue[]; warnings: TaxRuleCheckIssue[] } {
  const errors: TaxRuleCheckIssue[] = [];
  const warnings: TaxRuleCheckIssue[] = [];
  if (input.taxRule === "kleinunternehmer_supplier" && input.vatShownCents !== 0) {
    errors.push(issue("ku_supplier_vat", "Kleinunternehmer weisen keine Umsatzsteuer aus. Bitte Steuerregel prüfen."));
  }
  if (isSelfAssessment(input.taxRule) && input.vatShownCents !== 0) {
    errors.push(
      issue(
        "reverse_charge_vat_shown",
        "Bei Reverse Charge darf der Lieferant keine Umsatzsteuer ausweisen. Bitte Steuerregel oder Beträge prüfen.",
      ),
    );
  }
  if (
    (input.taxRule === "reverse_charge_eu" || input.taxRule === "intra_community_acquisition") &&
    !isForeignEuVatId(input.supplierVatId)
  ) {
    warnings.push(issue("supplier_vat_id_not_eu", "USt-IdNr des Lieferanten fehlt oder ist keine EU-Nummer."));
  }
  if (input.taxRule === "intra_community_acquisition" && !input.ownVatId?.trim()) {
    errors.push(
      issue(
        "own_vat_id_missing",
        "Für innergemeinschaftliche Erwerbe ist Ihre USt-IdNr erforderlich (Einstellungen › Unternehmen).",
      ),
    );
  }
  return { errors, warnings };
}

/**
 * VOU-043: tax-rule suggestion from the supplier — EU VAT ID and no VAT shown → `reverse_charge_eu` (services) or
 * `intra_community_acquisition` (goods; the user picks); non-EU supplier → `reverse_charge_non_eu`; supplier marked
 * Kleinunternehmer → `kleinunternehmer_supplier`. Domestic suppliers with VAT → `input_vat_deductible`.
 * Never applied without confirmation.
 */
export function suggestTaxRule(input: {
  supplierVatId?: string;
  supplierCountry?: string;
  supplierIsKu?: boolean;
  vatShown: boolean;
  goods?: boolean;
}): { rule: TaxRule; alternatives: TaxRule[]; reason: string } {
  if (input.supplierIsKu) {
    return { rule: "kleinunternehmer_supplier", alternatives: [], reason: "Lieferant ist Kleinunternehmer" };
  }
  const country = (input.supplierCountry ?? input.supplierVatId?.slice(0, 2) ?? "DE").toUpperCase();
  const eu = isForeignEuVatId(input.supplierVatId) || (EU_PREFIXES.has(country) && country !== "DE");
  if (eu && !input.vatShown) {
    return input.goods
      ? {
          rule: "intra_community_acquisition",
          alternatives: ["reverse_charge_eu"],
          reason: "EU-Lieferant ohne USt-Ausweis (Ware)",
        }
      : {
          rule: "reverse_charge_eu",
          alternatives: ["intra_community_acquisition"],
          reason: "EU-Lieferant ohne USt-Ausweis",
        };
  }
  if (country !== "DE" && country !== "GR" && !EU_PREFIXES.has(country) && !input.vatShown) {
    return { rule: "reverse_charge_non_eu", alternatives: ["no_input_vat"], reason: "Lieferant außerhalb der EU" };
  }
  if (country !== "DE" && input.vatShown) {
    return { rule: "no_input_vat", alternatives: [], reason: "Ausländische Umsatzsteuer ist nicht abziehbar" };
  }
  return { rule: "input_vat_deductible", alternatives: ["no_input_vat"], reason: "Inländischer Lieferant" };
}
