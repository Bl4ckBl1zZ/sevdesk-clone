/**
 * EU/EEA member states (AO-06 server location, F01 SET-046; DSGVO-04 non-EU endpoints, SET-048).
 * Date-effective: membership changes (e.g. the United Kingdom left on 31.01.2020).
 */
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule } from "./rule-table";

export const EU_EEA_COUNTRIES = defineRuleTable<readonly string[]>("eu_eea_countries", [
  {
    validFrom: "2020-02-01",
    value: [
      // EU-27
      "AT",
      "BE",
      "BG",
      "CY",
      "CZ",
      "DE",
      "DK",
      "EE",
      "ES",
      "FI",
      "FR",
      "GR",
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
      // EEA (EWR-Abkommen)
      "IS",
      "LI",
      "NO",
    ],
    source: "Art. 52 EUV; EWR-Abkommen (IS, LI, NO); Austritt des Vereinigten Königreichs zum 31.01.2020",
  },
]);

/** Member states on `date` (empty if no row covers the date — callers treat that as "not EU"). */
export function euEeaCountriesAt(date: CalendarDate): readonly string[] {
  const row = lookupRule(EU_EEA_COUNTRIES, date);
  return row.ok ? row.value.value : [];
}

/** Current member list (latest row) for present-state checks such as the server location (SET-046). */
export function currentEuEeaCountries(): readonly string[] {
  return EU_EEA_COUNTRIES.entries.at(-1)?.value ?? [];
}

export function isEuEeaCountry(code: string, date?: CalendarDate): boolean {
  return (date ? euEeaCountriesAt(date) : currentEuEeaCountries()).includes(code.toUpperCase());
}
