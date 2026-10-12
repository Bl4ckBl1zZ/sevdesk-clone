/**
 * EU VAT territory for USt-IdNr purposes (F02 CON-025, CON-043, CON-050, CON-E10/E12; UST-20/21/23). Prefixes as
 * used in VAT IDs: Greece is `EL`, Northern Ireland `XI` (goods only, from 2021-01-01), the United Kingdom `GB`
 * until the end of the Brexit transition period (2020-12-31). Date-effective: a membership change is new data.
 *
 * Distinct from `eu-eea.ts` (AO-06 server location: EEA incl. IS/LI/NO, ISO country codes, GB out from 2020-02-01).
 */
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule } from "./rule-table";

const EU27 = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
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
] as const;

export interface EuVatTerritory {
  /** VAT-ID prefixes of member states (incl. XI where applicable). */
  readonly prefixes: readonly string[];
  /** Prefixes valid for goods only (intra-Community supply), not for EU B2B services (CON-E10). */
  readonly goodsOnly: readonly string[];
}

export const EU_VAT_TERRITORY = defineRuleTable<EuVatTerritory>("eu_vat_territory", [
  {
    validFrom: "2013-07-01",
    validTo: "2020-12-31",
    value: { prefixes: [...EU27, "GB"], goodsOnly: [] },
    source:
      "Art. 52 EUV (EU-28 seit Beitritt Kroatiens am 01.07.2013); Art. 126, 127 Austrittsabkommen EU–UK (Übergangszeitraum bis 31.12.2020)",
  },
  {
    validFrom: "2021-01-01",
    value: { prefixes: [...EU27, "XI"], goodsOnly: ["XI"] },
    source:
      "Art. 52 EUV (EU-27); Art. 8 Protokoll zu Irland/Nordirland zum Austrittsabkommen (Präfix XI nur für Warenlieferungen)",
  },
]);

/** VAT-ID prefix → ISO 3166-1 country code of the address (EL → GR, XI → GB). */
export function vatPrefixToCountry(prefix: string): string {
  if (prefix === "EL") return "GR";
  if (prefix === "XI") return "GB";
  return prefix;
}

/** ISO country code → VAT-ID prefix (GR → EL). Northern Ireland cannot be derived from "GB" alone. */
export function countryToVatPrefix(country: string): string {
  return country === "GR" ? "EL" : country;
}

/** Prefixes on `date`; empty when no row covers it (callers then treat every prefix as non-EU). */
export function euVatPrefixesAt(date: CalendarDate): EuVatTerritory {
  const row = lookupRule(EU_VAT_TERRITORY, date);
  return row.ok ? row.value.value : { prefixes: [], goodsOnly: [] };
}

export function isEuVatPrefix(prefix: string, date: CalendarDate): boolean {
  return euVatPrefixesAt(date).prefixes.includes(prefix.toUpperCase());
}

/** EU member state for VAT purposes by ISO country code (address country) on `date`. */
export function isEuVatCountry(country: string, date: CalendarDate): boolean {
  return isEuVatPrefix(countryToVatPrefix(country.toUpperCase()), date);
}
