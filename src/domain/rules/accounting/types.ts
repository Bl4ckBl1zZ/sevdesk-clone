/**
 * Shapes of the chart-of-accounts seed and the role mapping (F08 §4.1, ACC-007/ACC-008, 03 §8 `ledgerAccounts`,
 * `accountRoleMappings`). Pure data types; the tables live next to this file.
 */
export type Chart = "SKR03" | "SKR04";
export const CHARTS_LIST: readonly Chart[] = ["SKR03", "SKR04"];

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense" | "neutral";

/** Semantic EÜR keys (F08 §4.6). The per-year line mapping (`euer-<year>`) follows in P3. */
export const EUER_KEYS = [
  "BE.KU",
  "BE.STPFL",
  "BE.STFREI",
  "BE.UST_VEREINNAHMT",
  "BE.UST_ERSTATTET",
  "BE.ANLAGEN_VERAEUSSERUNG",
  "BE.ENTNAHMEN",
  "BE.SONSTIGE",
  "BA.WAREN",
  "BA.FREMDLEISTUNGEN",
  "BA.PERSONAL",
  "BA.AFA_BEWEGLICH",
  "BA.AFA_IMMATERIELL",
  "BA.GWG",
  "BA.SAMMELPOSTEN_AUFLOESUNG",
  "BA.RESTBUCHWERT",
  "BA.RAUMKOSTEN",
  "BA.KFZ",
  "BA.REISE",
  "BA.BEWIRTUNG_ABZIEHBAR",
  "BA.BEWIRTUNG_NICHT_ABZIEHBAR",
  "BA.GESCHENKE",
  "BA.GESCHENKE_NICHT_ABZIEHBAR",
  "BA.GEWERBESTEUER",
  "BA.VORSTEUER",
  "BA.UST_GEZAHLT",
  "BA.ZINSEN",
  "BA.SONSTIGE",
  "PRIVAT.ENTNAHME",
  "PRIVAT.EINLAGE",
  "NONE",
] as const;
export type EuerKey = (typeof EUER_KEYS)[number];

/** BWA group keys (F08 §4.9). */
export const BWA_GROUPS = [
  "UMSATZ",
  "WAREN",
  "PERSONAL",
  "RAUM",
  "STEUERN_VERS",
  "KFZ",
  "WERBE_REISE",
  "AFA",
  "REPARATUR",
  "SONSTIGE",
  "NEUTRAL_AUFWAND",
  "NEUTRAL_ERTRAG",
  "ZINS",
  "NONE",
] as const;
export type BwaGroup = (typeof BWA_GROUPS)[number];

/** One seeded account (03 §8 `ledgerAccounts` with `isSystem: true`). */
export interface ChartAccount {
  readonly number: string;
  /** DATEV wording (shortened where DATEV's label exceeds the UI width). */
  readonly name: string;
  readonly type: AccountType;
  /** DATEV automatic account: VAT is derived by DATEV, no BU key in the export (F08 §4.1.1 "Auto"). */
  readonly automaticVatAccount?: true;
  readonly euerKey: EuerKey;
  readonly bwaGroup: BwaGroup;
  /** Durchlaufende Posten (VOU-011). */
  readonly passThrough?: true;
  /**
   * `false` = the number is a standard DATEV number chosen without a Steuerberater check and not backed by the
   * decided defaults of F08 §4.1.1 (LEGAL-OPEN: F08-Q1). Shown with a ⚠ hint in the chart UI.
   */
  readonly verified: boolean;
}

export interface ChartSeed {
  readonly chart: Chart;
  readonly accounts: readonly ChartAccount[];
}

/** One row of the shipped role mapping (F08 §4.1.1). `null` = UNSURE: ships unmapped and blocks its postings. */
export interface RoleMappingRow {
  readonly role: string;
  readonly SKR03: string | null;
  readonly SKR04: string | null;
  /** ⚠ in F08 §4.1.1: used as shipped, shown with a ⚠ badge (LEGAL-OPEN: F08-Q1). */
  readonly uncertain?: true;
}

export interface RoleMappingSeed {
  /** e.g. "roles-2026.2"; stored on every journal entry as `roleMappingVersion` (ACC-003). */
  readonly version: string;
  readonly rows: readonly RoleMappingRow[];
}
