/**
 * UStVA Kennzahlen mapping per form year (F08 §4.5 `ustva-2026.2`, TAX-003/TAX-004, UVA-03; CLAUDE.md rule 2:
 * date-effective data, never logic). A new form year is a new table; a year without a table, or a table without
 * `verifiedAgainstForm`, shows the values with a banner while the instructions and the submission record are blocked
 * (E-UVA-07/E-UVA-20).
 *
 * LEGAL-OPEN: 01-compliance open item 6 (UStVA Vordruck 2026/2027: Kz 50/37, 73/74, base rounding). The 2026 table
 * is the decided default of F08 §4.5 (rows marked ⚠ there are used as listed; one-off Steuerberater check before
 * go-live recommended, non-blocking); every data release re-verifies labels and order against the official form.
 */
import type { KzDef, UstvaMapping } from "./types";

export type { KzDef, KzKind, KzSign, TaxRoleRule, UstvaMapping } from "./types";

/** Fields in form order (USt 1 A), with the form's computation rule per Kennzahl. */
const FIELDS_2026: readonly KzDef[] = [
  {
    kz: "41",
    label: "Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.",
    kind: "base",
    sign: "credit",
    kz83: 0,
  },
  {
    kz: "43",
    label: "Weitere steuerfreie Umsätze mit Vorsteuerabzug (z. B. Ausfuhrlieferungen)",
    kind: "base",
    sign: "credit",
    kz83: 0,
  },
  { kz: "48", label: "Steuerfreie Umsätze ohne Vorsteuerabzug", kind: "base", sign: "credit", kz83: 0 },
  {
    kz: "81",
    label: "Steuerpflichtige Umsätze zum Steuersatz von 19 %",
    kind: "base_computed",
    sign: "credit",
    rateBp: 1900,
    kz83: 1,
  },
  {
    kz: "86",
    label: "Steuerpflichtige Umsätze zum Steuersatz von 7 %",
    kind: "base_computed",
    sign: "credit",
    rateBp: 700,
    kz83: 1,
  },
  {
    kz: "87",
    label: "Umsätze zum Steuersatz von 0 % (§ 12 Abs. 3 UStG)",
    kind: "base_computed",
    sign: "credit",
    rateBp: 0,
    kz83: 1,
  },
  {
    // ⚠ F08 §4.5 / open question 4: write-offs and recoveries (Soll) use Kz 50, never Kz 81; the booked VAT
    // correction counts in Kz 83. LEGAL-OPEN: 01-compliance open item 6.
    kz: "50",
    label: "Minderung der Bemessungsgrundlage bei Uneinbringlichkeit (§ 17 Abs. 2 Nr. 1 UStG)",
    kind: "base",
    sign: "credit",
    kz83: 1,
  },
  {
    kz: "89",
    label: "Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 19 %",
    kind: "base_computed",
    sign: "debit",
    rateBp: 1900,
    kz83: 1,
    ku: true,
  },
  {
    kz: "93",
    label: "Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 7 %",
    kind: "base_computed",
    sign: "debit",
    rateBp: 700,
    kz83: 1,
    ku: true,
  },
  {
    kz: "60",
    label: "Steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer nach § 13b UStG schuldet",
    kind: "base",
    sign: "credit",
    kz83: 0,
  },
  {
    kz: "21",
    label: "Nicht steuerbare sonstige Leistungen gem. § 18b S. 1 Nr. 2 UStG (EU)",
    kind: "base",
    sign: "credit",
    kz83: 0,
  },
  {
    kz: "45",
    label: "Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)",
    kind: "base",
    sign: "credit",
    kz83: 0,
  },
  {
    kz: "46",
    label: "Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§ 13b Abs. 1 UStG)",
    kind: "base",
    sign: "debit",
    taxKz: "47",
    kz83: 0,
    ku: true,
  },
  { kz: "47", label: "Steuer zu Kz 46", kind: "tax", sign: "credit", kz83: 1, ku: true },
  {
    kz: "84",
    label: "Andere Leistungen (§ 13b Abs. 2 Nr. 1, 2, 4 bis 12 UStG)",
    kind: "base",
    sign: "debit",
    taxKz: "85",
    kz83: 0,
    ku: true,
  },
  { kz: "85", label: "Steuer zu Kz 84", kind: "tax", sign: "credit", kz83: 1, ku: true },
  { kz: "66", label: "Vorsteuerbeträge aus Rechnungen von anderen Unternehmern", kind: "tax", sign: "debit", kz83: -1 },
  {
    kz: "61",
    label: "Vorsteuerbeträge aus dem innergemeinschaftlichen Erwerb von Gegenständen",
    kind: "tax",
    sign: "debit",
    kz83: -1,
    ku: true,
  },
  { kz: "62", label: "Entstandene Einfuhrumsatzsteuer", kind: "tax", sign: "debit", kz83: -1 },
  {
    kz: "67",
    label: "Vorsteuerbeträge aus Leistungen im Sinne des § 13b UStG",
    kind: "tax",
    sign: "debit",
    kz83: -1,
    ku: true,
  },
  {
    kz: "39",
    label: "Abzug der festgesetzten Sondervorauszahlung für Dauerfristverlängerung",
    kind: "tax",
    kz83: -1,
  },
  {
    kz: "83",
    label: "Verbleibende Umsatzsteuer-Vorauszahlung bzw. verbleibender Überschuss",
    kind: "total",
    kz83: 0,
    ku: true,
  },
];

const OUT = (suffix: "19" | "7") => `out${suffix}`;

const mapping2026 = (version: string, formYear: number): Omit<UstvaMapping, "verifiedAgainstForm"> => ({
  version,
  formYear,
  fields: FIELDS_2026,
  baseByRole: {
    // S10 advance received (positive), S11 clearing of declared advances (negative)
    "advance.received.19": { kz: "81", family: OUT("19") },
    "advance.received.7": { kz: "86", family: OUT("7") },
    // P8 write-off / P9 recovery under Soll (⚠ Kz 50)
    "writeoff.19": { kz: "50", family: OUT("19") },
    "writeoff.7": { kz: "50", family: OUT("7") },
    "writeoff.recovery": { kz: "50", family: "out" },
  },
  baseByTaxKey: {
    USt19: { kz: "81", family: OUT("19") },
    USt7: { kz: "86", family: OUT("7") },
    USt0: { kz: "87", family: "zero" },
    igL: { kz: "41", family: "igL" },
    Ausfuhr: { kz: "43", family: "export" },
    Stfrei4: { kz: "48", family: "exempt" },
    "EU-RC": { kz: "21", family: "eu_rc" },
    "13b": { kz: "60", family: "13b_sale" },
    nStb: { kz: "45", family: "not_taxable" },
    igE19: { kz: "89", family: "ige19" },
    igE7: { kz: "93", family: "ige7" },
    "13b-EU19": { kz: "46", family: "13b" },
    "13b-Ausl19": { kz: "84", family: "13b" },
    "13b-Inl19": { kz: "84", family: "13b" },
  },
  taxByRole: {
    "vat.output.19": { kz: "81", byBaseKz: { "50": "50" }, family: OUT("19") },
    "vat.output.7": { kz: "86", byBaseKz: { "50": "50" }, family: OUT("7") },
    "vat.output.ige.19": { kz: "89", family: "ige19" },
    "vat.output.ige.7": { kz: "93", family: "ige7" },
    "vat.output.13b.19": { kz: "85", byBaseKz: { "46": "47", "84": "85" }, family: "13b" },
    "vat.input.19": { kz: "66", family: "in" },
    "vat.input.7": { kz: "66", family: "in" },
    "vat.input.ige.19": { kz: "61", family: "ige19" },
    "vat.input.ige.7": { kz: "61", family: "ige7" },
    "vat.input.13b.19": { kz: "67", family: "13b" },
    "vat.import": { kz: "62", family: "import" },
  },
  baseRounding: "truncate",
});

export const USTVA_MAPPINGS: Readonly<Record<number, UstvaMapping>> = {
  2026: {
    ...mapping2026("ustva-2026.2", 2026),
    verifiedAgainstForm: {
      formName: "Umsatzsteuer-Voranmeldung 2026 (USt 1 A), Kennzahlen laut F08 §4.5 (entschiedene Standardwerte)",
      formYear: 2026,
      verifiedOn: "2026-10-19",
    },
  },
  // Placeholder until the 2027 Vordruck is published and checked (E-UVA-20): values shown, instructions blocked.
  2027: mapping2026("ustva-2027.0", 2027),
};

/** The mapping of the form year (= the year of the filing period, never „the current year“, TAX-020). */
export function ustvaMappingFor(year: number): UstvaMapping | null {
  return USTVA_MAPPINGS[year] ?? null;
}
