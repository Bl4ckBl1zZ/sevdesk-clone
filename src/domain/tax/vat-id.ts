/**
 * USt-IdNr format validation (UST-04; F01 SET-031; F02 CON-050, §5.4). Format only — the qualified/simple online
 * check (eVatR / VIES, MISC-04) is an action outside the domain.
 */
import { err, type Issue, issue, ok, type Result } from "../result";

/** Patterns after the country prefix (F02 §5.4). EU member states plus XI (Northern Ireland, goods). */
const PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{10}01$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

export type VatIdIssueCode = "vat_id_format_invalid" | "vat_id_checksum" | "vat_id_not_eu";

export interface VatId {
  readonly vatId: string;
  readonly countryCode: string;
  /** Set when the input was converted (Greek IDs use EL, not GR). */
  readonly hint?: "gr_converted_to_el";
}

/** ISO 7064 MOD 11,10 check digit over the first 8 digits of a German USt-IdNr. */
export function deVatIdCheckDigit(first8: string): number {
  let product = 10;
  for (const ch of first8) {
    let sum = (Number(ch) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = 11 - product;
  return check === 10 ? 0 : check;
}

export function validateVatId(input: string): Result<VatId, Issue<VatIdIssueCode>> {
  let value = input.toUpperCase().replace(/[\s.-]/g, "");
  let hint: VatId["hint"];
  if (value.startsWith("GR")) {
    value = `EL${value.slice(2)}`;
    hint = "gr_converted_to_el";
  }
  const prefix = value.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(prefix)) {
    return err(issue("vat_id_format_invalid", "Die USt-IdNr muss mit einem Länderkürzel beginnen (z. B. DE)."));
  }
  const pattern = PATTERNS[prefix];
  if (!pattern) {
    return err(
      issue(
        "vat_id_not_eu",
        "Nur EU-USt-IdNrs können hier eingetragen werden. Ausländische Steuernummern bitte im Feld „Steuernummer“ erfassen.",
        { country: prefix },
      ),
    );
  }
  const body = value.slice(2);
  if (!pattern.test(body)) {
    return err(issue("vat_id_format_invalid", `Die USt-IdNr hat nicht das Format für ${prefix}.`, { country: prefix }));
  }
  if (prefix === "DE" && deVatIdCheckDigit(body.slice(0, 8)) !== Number(body.slice(8))) {
    return err(issue("vat_id_checksum", "Die USt-IdNr ist ungültig (Prüfziffer stimmt nicht)."));
  }
  return ok(hint ? { vatId: value, countryCode: prefix, hint } : { vatId: value, countryCode: prefix });
}
