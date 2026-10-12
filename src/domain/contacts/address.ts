/**
 * Contact addresses (F02 §3.2, §5.2; 03 §0.2 `PostalAddress`, §2 `contactAddresses`). Postal-code formats per country
 * (CON-025), billing-address completeness for finalisation (CON-022) and the default-per-type rule (CON-020).
 */
import { type FieldIssue, fieldIssue, type Validation } from "./core";

export const ADDRESS_TYPES = ["billing", "delivery", "other"] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

export const ADDRESS_TYPE_LABELS: Readonly<Record<AddressType, string>> = {
  billing: "Rechnungsadresse",
  delivery: "Lieferadresse",
  other: "Weitere Adresse",
};

export interface PostalAddress {
  readonly name: string;
  readonly name2?: string | undefined;
  readonly department?: string | undefined;
  readonly street: string;
  readonly street2?: string | undefined;
  readonly postalCode: string;
  readonly city: string;
  readonly countryCode: string;
  readonly poBox?: string | undefined;
}

/** CON-025: postal-code formats; other countries accept 2–10 characters. */
const POSTAL_CODE: Readonly<Record<string, RegExp>> = {
  DE: /^\d{5}$/,
  AT: /^\d{4}$/,
  CH: /^\d{4}$/,
  NL: /^\d{4} ?[A-Z]{2}$/i,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/,
  PL: /^\d{2}-\d{3}$/,
  GB: /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i,
};

export function isValidPostalCodeFor(countryCode: string, postalCode: string): boolean {
  const code = postalCode.trim();
  const re = POSTAL_CODE[countryCode.toUpperCase()];
  return re ? re.test(code) : /^[A-Za-z0-9 -]{2,10}$/.test(code);
}

const regionNames = new Intl.DisplayNames(["de"], { type: "region" });

/** German country name (Intl.DisplayNames). */
export function countryNameDe(code: string): string {
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** ISO 3166-1 alpha-2 code known to Intl, plus `XI` (Northern Ireland, 03 §0.2). */
export function isKnownCountry(code: string): boolean {
  const c = code.toUpperCase();
  if (c === "XI") return true;
  if (!/^[A-Z]{2}$/.test(c)) return false;
  return countryNameDe(c) !== c;
}

/** §5.2 address rules (name defaults to the display name, CON-021, so it is never blank when stored). */
export function validateAddress(a: PostalAddress): Validation {
  const errors: FieldIssue[] = [];
  const max = (field: keyof PostalAddress, n: number) => {
    const value = a[field];
    if (typeof value === "string" && value.trim().length > n) {
      errors.push(fieldIssue(field, "TOO_LONG", `Der Text ist zu lang (max. ${n} Zeichen).`, { max: n }));
    }
  };
  max("name", 160);
  max("name2", 160);
  max("department", 80);
  max("street", 100);
  max("street2", 100);
  max("city", 80);
  max("poBox", 30);
  if (!isKnownCountry(a.countryCode)) {
    errors.push(fieldIssue("countryCode", "COUNTRY_INVALID", "Bitte ein Land auswählen."));
  } else if (a.postalCode.trim() !== "" && !isValidPostalCodeFor(a.countryCode, a.postalCode)) {
    errors.push(
      fieldIssue(
        "postalCode",
        "POSTAL_CODE_INVALID",
        `Die Postleitzahl passt nicht zum Land ${countryNameDe(a.countryCode)}.`,
        { country: a.countryCode },
      ),
    );
  }
  return { errors, warnings: [] };
}

/**
 * CON-022 (T-CON-032): a billing address is complete with street or P.O. box, postal code, city and country.
 * Returns the German names of the missing parts; the finalisation guard (F04) turns them into
 * `CONTACT_ADDRESS_INCOMPLETE`.
 */
export function missingBillingParts(a: PostalAddress | null | undefined): string[] {
  if (!a) return ["Rechnungsadresse"];
  const missing: string[] = [];
  if (!a.street.trim() && !(a.poBox ?? "").trim()) missing.push("Straße oder Postfach");
  if (!a.postalCode.trim()) missing.push("Postleitzahl");
  if (!a.city.trim()) missing.push("Ort");
  if (!a.countryCode.trim()) missing.push("Land");
  return missing;
}

export function checkBillingAddressComplete(a: PostalAddress | null | undefined): FieldIssue | null {
  const missing = missingBillingParts(a);
  if (missing.length === 0) return null;
  return fieldIssue(
    "billingAddress",
    "CONTACT_ADDRESS_INCOMPLETE",
    `Rechnungsadresse unvollständig: ${missing.join(", ")} fehlt.`,
    { fields: missing.join(", ") },
  );
}

/** One line for lists and pickers: "Hauptstr. 1, 10115 Berlin". */
export function formatAddressLine(a: PostalAddress): string {
  const street = a.street.trim() || (a.poBox ? `Postfach ${a.poBox}` : "");
  const place = [a.postalCode, a.city].filter((s) => s.trim()).join(" ");
  const country = a.countryCode !== "DE" ? countryNameDe(a.countryCode) : "";
  return [street, place, country].filter(Boolean).join(", ");
}

export interface StoredAddress {
  readonly id: string;
  readonly type: AddressType;
  readonly isDefault: boolean;
  readonly archivedAt?: number | undefined;
}

/**
 * CON-020: exactly one default per type among active addresses. Given the stored addresses and the id that should be
 * the default of its type, returns the ids whose `isDefault` must flip to false (and whether the target must be set).
 */
export function defaultChanges(
  addresses: readonly StoredAddress[],
  target: { id: string; type: AddressType; wantsDefault: boolean },
): { unset: string[]; setTarget: boolean } {
  const active = addresses.filter((a) => a.archivedAt === undefined && a.type === target.type);
  const others = active.filter((a) => a.id !== target.id);
  if (target.wantsDefault) return { unset: others.filter((a) => a.isDefault).map((a) => a.id), setTarget: true };
  // The first active address of a type is always the default.
  return { unset: [], setTarget: !others.some((a) => a.isDefault) };
}

/** After removing/archiving the default of a type, the next active one becomes the default (CON-020). */
export function nextDefaultAfterRemoval(
  addresses: readonly StoredAddress[],
  removed: { id: string; type: AddressType },
): string | null {
  const remaining = addresses.filter((a) => a.id !== removed.id && a.type === removed.type && !a.archivedAt);
  if (remaining.some((a) => a.isDefault)) return null;
  return remaining[0]?.id ?? null;
}
