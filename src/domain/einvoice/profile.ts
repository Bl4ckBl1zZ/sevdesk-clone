/**
 * Profile detection of a received E-Rechnung from BT-24 (F06 INB-023): CII
 * `GuidelineSpecifiedDocumentContextParameter/ID`, UBL `CustomizationID`. MINIMUM and BASIC-WL are not invoices in
 * the sense of § 14 UStG (they lack the line data of EN 16931): flagged „keine E-Rechnung“ and processed as a PDF
 * invoice whose header values are prefilled from the XML (EC-INB-09, golden V7, EC-102). Pure.
 */
import type { EinvoiceProfile } from "./received";

const RULES: readonly { profile: EinvoiceProfile; test: (id: string) => boolean }[] = [
  { profile: "XRECHNUNG", test: (id) => id.includes("xrechnung") },
  { profile: "MINIMUM", test: (id) => id.includes("minimum") },
  // BASIC-WL before BASIC: the WL URN contains "basic".
  { profile: "BASIC-WL", test: (id) => /basic[-_]?wl/.test(id) },
  { profile: "EXTENDED", test: (id) => id.includes("extended") },
  { profile: "BASIC", test: (id) => /(factur-x\.eu|zugferd\.de)[^#]*:basic\b/.test(id) },
  // EN 16931 itself, ZUGFeRD/Factur-X EN16931 (formerly COMFORT) and other CIUS that claim compliance (Peppol BIS).
  { profile: "EN16931", test: (id) => id.startsWith("urn:cen.eu:en16931:2017") },
];

export function detectProfile(guidelineId: string | undefined): { profile: EinvoiceProfile; notEInvoice: boolean } {
  const id = (guidelineId ?? "").trim().toLowerCase();
  const profile = id ? (RULES.find((r) => r.test(id))?.profile ?? "UNKNOWN") : "UNKNOWN";
  return { profile, notEInvoice: profile === "MINIMUM" || profile === "BASIC-WL" };
}

/** EC-INB-09. */
export const notEInvoiceMessage = (profile: EinvoiceProfile): string =>
  `Keine E-Rechnung i.S.d. § 14 UStG (Profil ${profile}). Maßgeblich ist die PDF-Darstellung.`;
