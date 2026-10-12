/**
 * Account roles (F08 ACC-008, §4.1.1). The posting matrix speaks only in roles; `resolve.ts` turns them into SKR
 * accounts through the versioned mapping. A role is either a static name from the shipped mapping
 * (`receivable`, `vat.output.19`, …) or the parametric bank role `bank.<bankAccountId>` (`.fx` for a foreign-currency
 * pocket), which resolves to that `bankAccounts` row's own ledger account (03 §1, BNK-001).
 */

import type { LegalForm } from "../company/legal-forms";
import { ROLE_MAPPING_ROWS } from "../rules/accounting";

export type AccountRole = string;

export const STATIC_ROLES: readonly string[] = ROLE_MAPPING_ROWS.map((r) => r.role);

/** UNSURE roles (F08 §4.1.1): shipped unmapped, every posting that needs them is blocked until mapped. */
export const UNSURE_ROLES: readonly string[] = ROLE_MAPPING_ROWS.filter((r) => r.SKR03 === null).map((r) => r.role);

/** ⚠ roles: used as shipped, shown with a ⚠ badge (LEGAL-OPEN: F08-Q1). */
export const UNCERTAIN_ROLES: readonly string[] = ROLE_MAPPING_ROWS.filter((r) => r.uncertain).map((r) => r.role);

export const bankRole = (bankAccountId: string): AccountRole => `bank.${bankAccountId}`;

export type ParsedRole =
  | { kind: "static"; role: string }
  | { kind: "bank"; bankAccountId: string; fx: boolean }
  | { kind: "unknown"; role: string };

export function parseRole(role: AccountRole): ParsedRole {
  if (STATIC_ROLES.includes(role)) return { kind: "static", role };
  const m = /^bank\.([A-Za-z0-9_-]+)(\.fx)?$/.exec(role);
  if (m?.[1]) return { kind: "bank", bankAccountId: m[1], fx: m[2] === ".fx" };
  return { kind: "unknown", role };
}

export const isAccountRole = (role: string): boolean => parseRole(role).kind !== "unknown";

/** VAT rate (basis points) → role suffix. Only the current German rates have roles (F08 §4.1.1). */
export function rateSuffix(rateBp: number): "19" | "7" | null {
  if (rateBp === 1900) return "19";
  if (rateBp === 700) return "7";
  return null;
}

/**
 * Legal forms whose private postings go to `shareholder.clearing` instead of `private.*` (ACC-028; decided
 * conservative default incl. GmbH & Co. KG).
 */
export const CORPORATION_FORMS: readonly LegalForm[] = ["gmbh", "ug", "ag", "gmbh_co_kg"];
export const isCorporation = (legalForm: LegalForm): boolean => CORPORATION_FORMS.includes(legalForm);

/** German labels for „Rollen & Standardkonten“ (F08 §6) and the „Warum dieses Konto?“ explanation. */
export const ROLE_LABEL_DE: Readonly<Record<string, string>> = {
  cash: "Kasse",
  transit: "Geldtransit",
  receivable: "Forderungen aus Lieferungen und Leistungen",
  payable: "Verbindlichkeiten aus Lieferungen und Leistungen",
  "advance.received.19": "Erhaltene Anzahlungen 19 % USt",
  "advance.received.7": "Erhaltene Anzahlungen 7 % USt",
  "vat.output.19": "Umsatzsteuer 19 %",
  "vat.output.7": "Umsatzsteuer 7 %",
  "vat.output.notdue.19": "Umsatzsteuer nicht fällig 19 % (Ist-Versteuerung)",
  "vat.output.notdue.7": "Umsatzsteuer nicht fällig 7 % (Ist-Versteuerung)",
  "vat.input.19": "Abziehbare Vorsteuer 19 %",
  "vat.input.7": "Abziehbare Vorsteuer 7 %",
  "vat.input.notyet": "Vorsteuer noch nicht abziehbar",
  "vat.input.ige.19": "Vorsteuer aus innergemeinschaftlichem Erwerb 19 %",
  "vat.input.ige.7": "Vorsteuer aus innergemeinschaftlichem Erwerb 7 %",
  "vat.output.ige.19": "Umsatzsteuer aus innergemeinschaftlichem Erwerb 19 %",
  "vat.output.ige.7": "Umsatzsteuer aus innergemeinschaftlichem Erwerb 7 %",
  "vat.input.13b.19": "Vorsteuer nach § 13b UStG 19 %",
  "vat.output.13b.19": "Umsatzsteuer nach § 13b UStG 19 %",
  "vat.import": "Entstandene Einfuhrumsatzsteuer",
  "vat.prepayment": "Umsatzsteuer-Vorauszahlungen",
  "vat.special_prepayment": "Umsatzsteuer-Vorauszahlung 1/11",
  "vat.prior_year": "Umsatzsteuer Vorjahr",
  "private.withdrawal": "Privatentnahmen",
  "private.deposit": "Privateinlagen",
  "private.taxes": "Privatsteuern",
  "shareholder.clearing": "Verrechnungskonto Gesellschafter",
  "revenue.domestic.19": "Erlöse 19 % USt",
  "revenue.domestic.7": "Erlöse 7 % USt",
  "revenue.zero_pv": "Erlöse 0 % (§ 12 Abs. 3 UStG, Photovoltaik)",
  "revenue.icsupply": "Steuerfreie innergemeinschaftliche Lieferungen",
  "revenue.export": "Steuerfreie Ausfuhrlieferungen",
  "revenue.eu_service_rc": "Erlöse EU-Leistungen (Leistungsempfänger schuldet USt)",
  "revenue.13b_domestic": "Erlöse aus Leistungen nach § 13b UStG",
  "revenue.not_taxable": "Im Inland nicht steuerbare Umsätze",
  "revenue.exempt_4": "Steuerfreie Umsätze § 4 Nr. 8 ff. UStG",
  "revenue.ku": "Erlöse als Kleinunternehmer (§ 19 UStG)",
  "revenue.withdrawal.19": "Unentgeltliche Wertabgaben 19 %",
  "revenue.withdrawal.7": "Unentgeltliche Wertabgaben 7 %",
  "skonto.granted.19": "Gewährte Skonti 19 %",
  "skonto.granted.7": "Gewährte Skonti 7 %",
  "skonto.received.19": "Erhaltene Skonti 19 %",
  "skonto.received.7": "Erhaltene Skonti 7 %",
  "writeoff.19": "Forderungsverluste 19 %",
  "writeoff.7": "Forderungsverluste 7 %",
  "writeoff.0": "Forderungsverluste (ohne USt)",
  "writeoff.recovery": "Erträge aus abgeschriebenen Forderungen",
  "income.interest_default": "Verzugszinsen / sonstige Zinserträge",
  "income.other_nontaxable": "Sonstige Erträge (Mahngebühren, Pauschalen)",
  "expense.bank_fees": "Nebenkosten des Geldverkehrs",
  "expense.goods.19": "Wareneingang 19 %",
  "expense.goods.7": "Wareneingang 7 %",
  "expense.services": "Fremdleistungen",
  "expense.ige.19": "Innergemeinschaftlicher Erwerb 19 %",
  "expense.ige.7": "Innergemeinschaftlicher Erwerb 7 %",
  "expense.13b_eu.19": "Sonstige Leistungen EU-Unternehmer 19 % (§ 13b)",
  "expense.13b_foreign.19": "Leistungen ausländischer Unternehmer 19 % (§ 13b)",
  "expense.13b_domestic.19": "Bauleistungen inländischer Unternehmer 19 % (§ 13b)",
  "expense.entertainment": "Bewirtungskosten (abziehbar)",
  "expense.entertainment.nd": "Nicht abzugsfähige Bewirtungskosten",
  "expense.staff_events": "Freiwillige soziale Aufwendungen",
  "expense.fx_loss": "Aufwendungen aus Kursdifferenzen",
  "income.fx_gain": "Erträge aus Kursdifferenzen",
  "expense.trade_tax": "Gewerbesteuer",
  "expense.corp_tax": "Körperschaftsteuer",
  "asset.office": "Büroeinrichtung",
  "asset.vehicle": "Pkw",
  "asset.software": "Software",
  "asset.gwg": "Geringwertige Wirtschaftsgüter",
  "asset.pool": "Sammelposten",
  "afa.tangible": "Abschreibungen auf Sachanlagen",
  "afa.vehicle": "Abschreibungen auf Kfz",
  "afa.intangible": "Abschreibungen auf immaterielle Wirtschaftsgüter",
  "afa.gwg": "Sofortabschreibung GWG",
  "afa.pool": "Abschreibungen auf Sammelposten",
  "afa.extraordinary": "Außerplanmäßige Abschreibungen",
  "disposal.rbw.loss": "Anlagenabgang Restbuchwert (Buchverlust)",
  "disposal.rbw.gain": "Anlagenabgang Restbuchwert (Buchgewinn)",
  "disposal.proceeds.loss.19": "Erlöse aus Anlagenverkäufen 19 % (Buchverlust)",
  "disposal.proceeds.gain.19": "Erlöse aus Anlagenverkäufen 19 % (Buchgewinn)",
  "opening.gl": "Saldenvorträge Sachkonten",
  "opening.debtors": "Saldenvorträge Debitoren",
  "opening.creditors": "Saldenvorträge Kreditoren",
};

export function roleLabel(role: AccountRole): string {
  const parsed = parseRole(role);
  if (parsed.kind === "bank") return parsed.fx ? "Fremdwährungskonto" : "Bankkonto";
  return ROLE_LABEL_DE[role] ?? role;
}
