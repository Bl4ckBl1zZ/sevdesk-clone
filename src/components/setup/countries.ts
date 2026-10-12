/**
 * Country choices for the server location (F01 SET-046, AO-06): EU/EEA first.
 * TODO(domain): the EU/EEA list is rule data and belongs in src/domain/rules (date-effective); keep in sync.
 */
export const EU_EEA = [
  "DE",
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
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
  "IS",
  "LI",
  "NO",
] as const;

const OTHER = ["CH", "GB", "US", "CA"] as const;

const regionNames = new Intl.DisplayNames(["de"], { type: "region" });

export function countryName(code: string): string {
  return regionNames.of(code) ?? code;
}

export function isEuEea(code: string): boolean {
  return (EU_EEA as readonly string[]).includes(code);
}

export function countryOptions(): { value: string; label: string }[] {
  const byName = (a: string, b: string) => countryName(a).localeCompare(countryName(b), "de");
  const eu = ["DE", ...[...EU_EEA].filter((c) => c !== "DE").sort(byName)];
  return [...eu, ...[...OTHER].sort(byName)].map((c) => ({ value: c, label: countryName(c) }));
}

/** German federal states for the regional Steuernummer format (F01 SET-030). */
export const BUNDESLAENDER = [
  ["BW", "Baden-Württemberg"],
  ["BY", "Bayern"],
  ["BE", "Berlin"],
  ["BB", "Brandenburg"],
  ["HB", "Bremen"],
  ["HH", "Hamburg"],
  ["HE", "Hessen"],
  ["MV", "Mecklenburg-Vorpommern"],
  ["NI", "Niedersachsen"],
  ["NW", "Nordrhein-Westfalen"],
  ["RP", "Rheinland-Pfalz"],
  ["SL", "Saarland"],
  ["SN", "Sachsen"],
  ["ST", "Sachsen-Anhalt"],
  ["SH", "Schleswig-Holstein"],
  ["TH", "Thüringen"],
] as const;
