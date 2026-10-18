/**
 * sevdesk tax-rule labels → our tax case (F09 §4.3.2, IMP-010). Versioned data: a new or renamed sevdesk label is a
 * new row and a new version, never new code. Labels are compared after `normalizeHeader` (case, umlauts,
 * punctuation).
 *
 * SEVDESK-LAYOUT-UNSURE: the label texts are the ones shown in sevdesk's „Steuerregel“ selector per research 07/08;
 * whether the invoice list CSV exports them (and in which spelling) is unknown until the owner provides samples
 * (F09 open item 9). Anything not listed — OSS labels in particular — imports as `unknown_imported`.
 */
import type { TaxCase } from "../../tax/tax-case";
import type { VatCategory } from "../../tax/vat-category";

export const SEVDESK_TAX_LABELS_VERSION = "sevdesk-tax-labels@2026-10-18";

export interface SevdeskTaxLabel {
  /** Label texts as exported (first = canonical). */
  readonly labels: readonly string[];
  readonly taxCase: Exclude<TaxCase, "unknown_imported">;
  /** VAT category of the summary lines; `S` takes the rate from the data. */
  readonly category: VatCategory;
}

export const SEVDESK_TAX_LABELS: readonly SevdeskTaxLabel[] = [
  { labels: ["Umsatzsteuerpflichtige Umsätze"], taxCase: "domestic", category: "S" },
  { labels: ["Ausfuhren"], taxCase: "export", category: "G" },
  { labels: ["Innergemeinschaftliche Lieferungen"], taxCase: "intra_community_supply", category: "K" },
  { labels: ["Steuerfreie Umsätze §4", "Steuerfreie Umsätze § 4"], taxCase: "exempt_4", category: "E" },
  {
    labels: ["Reverse Charge gem. §13b UStG", "Reverse Charge gem. § 13b UStG"],
    taxCase: "reverse_charge_13b",
    category: "AE",
  },
  {
    labels: ["Kleinunternehmer (keine USt)", "Kleinunternehmer", "§19 UStG", "§ 19 UStG"],
    taxCase: "kleinunternehmer",
    category: "KU",
  },
  { labels: ["Nicht im Inland steuerbare Leistung"], taxCase: "not_taxable_domestic", category: "O" },
  {
    labels: ["Reverse Charge gem. §18b UStG", "Reverse Charge gem. § 18b UStG"],
    taxCase: "eu_b2b_service",
    category: "AE",
  },
];

/** Normalised label fragments that mark OSS / distance sales (always `unknown_imported`, never guessed). */
export const SEVDESK_OSS_MARKERS: readonly string[] = ["oss", "one stop shop", "fernverkauf", "fernverkaeufe"];
