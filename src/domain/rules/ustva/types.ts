/**
 * Shapes of the versioned UStVA Kennzahlen mapping (F08 §4.5, TAX-003/TAX-004, UVA-03). One table per form year;
 * the journal speaks in roles and tax keys (`taxKey` on base lines, VAT roles on tax lines), the table maps them to
 * Kennzahlen. Pure data; `src/domain/tax/ustva.ts` applies it.
 */

/** How a Kennzahl is filled in the form (TAX-004). */
export type KzKind =
  /** Bemessungsgrundlage; the form computes the tax from the whole-euro base at `rateBp` (81, 86, 87, 89, 93). */
  | "base_computed"
  /** Bemessungsgrundlage without a computed tax column (41, 43, 48, 21, 60, 45, 46, 84, 50). */
  | "base"
  /** Steuerbetrag in euro and cent, entered as booked (47, 85, 66, 61, 62, 67, 39). */
  | "tax"
  /** Verbleibende Vorauszahlung / Überschuss (83), computed per form arithmetic. */
  | "total";

/** Side that increases the Kennzahl: revenue bases and output VAT are credits, purchases and input VAT debits. */
export type KzSign = "credit" | "debit";

export interface KzDef {
  readonly kz: string;
  readonly label: string;
  readonly kind: KzKind;
  readonly sign?: KzSign;
  /** base_computed: rate the form applies to the base. */
  readonly rateBp?: number;
  /** base: the separate tax Kennzahl that belongs to it (46 → 47, 84 → 85). */
  readonly taxKz?: string;
  /** Kz 83 arithmetic: +1 adds, −1 subtracts the (form) tax of this Kennzahl; 0 = not part of Kz 83. */
  readonly kz83: 1 | -1 | 0;
  /** TAX-011 / E-UVA-15: Kennzahlen a Kleinunternehmer reports (§13b / igE liabilities only). */
  readonly ku?: true;
}

/** A VAT role line maps to the tax of a Kennzahl; `byBaseKey` picks it from the entry's base line tax keys. */
export interface TaxRoleRule {
  /** Default Kennzahl whose tax this line is (base_computed: „laut Buchhaltung“; tax: the value itself). */
  readonly kz: string;
  /** Overrides by the Kennzahl of the entry's base lines of the same family (81 → 50 for write-offs; 46 → 47). */
  readonly byBaseKz?: Readonly<Record<string, string>>;
  /** Family of base Kennzahlen that share the tax point with this line (base lines without own tax point). */
  readonly family: string;
}

export interface UstvaMapping {
  /** e.g. "ustva-2026.2"; stored on every filing as `ruleVersion`. */
  readonly version: string;
  readonly formYear: number;
  /**
   * E-UVA-07/E-UVA-20: absent = not yet checked against the official Vordruck → values shown with a banner, the
   * Mein ELSTER instructions and the submission record are blocked (block rather than guess).
   */
  readonly verifiedAgainstForm?: { readonly formName: string; readonly formYear: number; readonly verifiedOn: string };
  readonly fields: readonly KzDef[];
  /** Base lines by role (checked first; S10/S11 advances, write-offs, recoveries). */
  readonly baseByRole: Readonly<Record<string, { kz: string; family: string }>>;
  /** Base lines by tax key (posting engine `taxKey`). */
  readonly baseByTaxKey: Readonly<Record<string, { kz: string; family: string }>>;
  /** VAT lines by role. */
  readonly taxByRole: Readonly<Record<string, TaxRoleRule>>;
  /** TAX-004: rounding of bases to whole euros (decided default: truncate toward zero ⚠). */
  readonly baseRounding: "truncate";
}
