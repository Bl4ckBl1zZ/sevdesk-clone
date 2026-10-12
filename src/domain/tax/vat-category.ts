/** VAT categories: UNCL5305 codes plus the internal Kleinunternehmer category (03 §0.2, F04 App. A.9). */
export type VatCategory =
  | "S" // standard or reduced rate (the rate distinguishes 19/7)
  | "Z" // zero rate (PV § 12 Abs. 3 UStG)
  | "E" // exempt (needs exemptionReasonCode + text)
  | "AE" // reverse charge (§ 13b domestic or EU B2B service)
  | "K" // intra-Community supply
  | "G" // export outside the EU
  | "O" // not subject to German VAT
  | "KU"; // Kleinunternehmer (internal; maps to E + note in XML)

/** Canonical order of VAT groups in totals and snapshots. */
export const VAT_CATEGORY_ORDER: readonly VatCategory[] = ["S", "Z", "E", "AE", "K", "G", "O", "KU"];
