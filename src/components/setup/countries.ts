/**
 * Select options for countries and Bundesländer (UI only). The EU/EEA list is rule data in
 * src/domain/rules/eu-eea.ts (AO-06, SET-046); names come from Intl.DisplayNames.
 */
import { currentEuEeaCountries, isEuEeaCountry } from "@/domain/rules/eu-eea";
import { BUNDESLAND_NAMES, type Bundesland } from "@/domain/tax/tax-number";

const OTHER = ["CH", "GB", "US", "CA"] as const;

const regionNames = new Intl.DisplayNames(["de"], { type: "region" });

export function countryName(code: string): string {
  return regionNames.of(code) ?? code;
}

export const isEuEea = (code: string): boolean => isEuEeaCountry(code);

/** EU/EEA first (Germany on top), then common non-EU locations. */
export function countryOptions(): { value: string; label: string }[] {
  const byName = (a: string, b: string) => countryName(a).localeCompare(countryName(b), "de");
  const eu = [
    "DE",
    ...currentEuEeaCountries()
      .filter((c) => c !== "DE")
      .sort(byName),
  ];
  return [...eu, ...[...OTHER].sort(byName)].map((c) => ({ value: c, label: countryName(c) }));
}

/** German federal states for the regional Steuernummer format (F01 SET-030). */
export const BUNDESLAENDER = (Object.entries(BUNDESLAND_NAMES) as [Bundesland, string][]).map(
  ([code, name]) => [code, name] as const,
);
