/**
 * Document tax cases (03 §0.2 `TaxCase`). The derivation per document lives with the sales documents (F04); contacts
 * may carry a `defaultTaxCase` override (F02 CON-044) and show a derived default for a typical supply (CON-045).
 */
export const TAX_CASES = [
  "domestic",
  "kleinunternehmer",
  "eu_b2b_service",
  "intra_community_supply",
  "export",
  "not_taxable_domestic",
  "reverse_charge_13b",
  "exempt_4",
  "unknown_imported",
] as const;

export type TaxCase = (typeof TAX_CASES)[number];

export type SelectableTaxCase = Exclude<TaxCase, "unknown_imported">;

/** Tax cases an owner may choose as a contact default (never the archive-only `unknown_imported`, CON-044). */
export const SELECTABLE_TAX_CASES = TAX_CASES.filter((c): c is SelectableTaxCase => c !== "unknown_imported");

export const TAX_CASE_LABELS: Readonly<Record<TaxCase, string>> = {
  domestic: "Inland (steuerpflichtig)",
  kleinunternehmer: "Kleinunternehmer (§ 19 UStG)",
  eu_b2b_service: "EU-B2B-Leistung (Reverse Charge)",
  intra_community_supply: "Innergemeinschaftliche Lieferung",
  export: "Ausfuhrlieferung (Drittland)",
  not_taxable_domestic: "Nicht im Inland steuerbar",
  reverse_charge_13b: "Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)",
  exempt_4: "Steuerfrei (§ 4 UStG)",
  unknown_imported: "Unbekannt (Import)",
};

export const isTaxCase = (v: string): v is TaxCase => (TAX_CASES as readonly string[]).includes(v);
