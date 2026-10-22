/**
 * F09 IMP-013: shipped column presets for the generic CSV import (target field → header in the file), offered next to
 * the owner's saved presets. Applied by normalised header name (`applyPreset`), so case, spacing and punctuation
 * differences do not matter; headers the file does not have are simply left unmapped.
 *
 * UNSURE (IMP-013 „header names to verify against a real export"): the lexoffice header names below are not verified
 * against a real lexoffice export — the presets are flagged `unsure` and labelled „(ungeprüft)"; the owner checks the
 * mapping before the preview. Replace them once a real export is available.
 */
import type { ContactImportField } from "../../contacts/csv-io";
import type { ProductImportField } from "../../products/csv-io";
import type { GenericTarget } from "./csv-import";

export interface ShippedPreset {
  /** Stable id (not a Convex id): `shipped:<name>`. */
  readonly id: string;
  readonly name: string;
  readonly target: GenericTarget;
  readonly columns: Readonly<Record<string, string>>;
  readonly unsure: boolean;
}

const LEXOFFICE_CONTACTS: Partial<Record<ContactImportField, string>> = {
  number: "Kundennummer",
  organizationName: "Firmenname",
  salutation: "Anrede",
  academicTitle: "Titel",
  firstName: "Vorname",
  lastName: "Nachname",
  street: "Straße",
  postalCode: "PLZ",
  city: "Ort",
  countryCode: "Land",
  email: "E-Mail",
  phone: "Telefon",
  vatId: "USt-IdNr.",
  taxNumber: "Steuernummer",
  notes: "Notiz",
};

const LEXOFFICE_PRODUCTS: Partial<Record<ProductImportField, string>> = {
  number: "Artikelnummer",
  name: "Bezeichnung",
  description: "Beschreibung",
  unit: "Einheit",
  netPrice: "Nettopreis",
  grossPrice: "Bruttopreis",
  vat: "Steuersatz",
};

export const SHIPPED_PRESETS: readonly ShippedPreset[] = [
  {
    id: "shipped:lexoffice-contacts",
    name: "lexoffice Kontakte (ungeprüft)",
    target: "contacts",
    columns: LEXOFFICE_CONTACTS as Record<string, string>,
    unsure: true,
  },
  {
    id: "shipped:lexoffice-products",
    name: "lexoffice Artikel (ungeprüft)",
    target: "products",
    columns: LEXOFFICE_PRODUCTS as Record<string, string>,
    unsure: true,
  },
];

export const shippedPresetsFor = (target: GenericTarget): ShippedPreset[] =>
  SHIPPED_PRESETS.filter((p) => p.target === target);
