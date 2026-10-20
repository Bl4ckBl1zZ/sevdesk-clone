/**
 * Rule data of the tax reserve estimator (F08 RPT-010; E-RPT-07), versioned per Veranlagungszeitraum. Every amount
 * is an integer: euros where the statute speaks in full euros, cents for the euro-and-cent constants, coefficients
 * as integers over the stated scale (no floats on money, CLAUDE.md rule 4).
 *
 * Sources
 *  - §32a Abs. 1 EStG ab VZ 2026: https://www.gesetze-im-internet.de/estg/__32a.html (fetched 2026-10-20; Grundfreibetrag
 *    12 348 €, zones to 17 799 / 69 878 / 277 825 €, coefficients 914,51 · 1 400 · 173,10 · 2 397 · 1 034,87 ·
 *    11 135,63 · 19 470,38).
 *  - §32a Abs. 1 EStG ab VZ 2025 (Steuerfortentwicklungsgesetz v. 23.12.2024, BGBl. 2024 I Nr. 449; historical
 *    version on buzer.de): 12 096 €, 17 443 / 68 480 / 277 825 €, 932,30 · 1 400 · 176,64 · 2 397 · 1 015,13 ·
 *    10 911,92 · 19 246,67.
 *  - §3 Abs. 3 SolZG 1995 (current text, VZ 2026): Freigrenze 20 350 € / 40 700 € (Splitting); VZ 2025: 19 950 € /
 *    39 900 €. §4 SolZG: 5,5 %, at most 11,9 % of the amount above the Freigrenze; fractions of a cent are dropped.
 *  - §11 Abs. 1 S. 3 Nr. 1, Abs. 2 GewStG: Freibetrag 24 500 € (natural persons, partnerships), Gewerbeertrag
 *    rounded down to 100 €, Steuermesszahl 3,5 %. §35 Abs. 1 EStG: credit 4,0 × Messbetrag, capped at the GewSt paid.
 *  - §23 Abs. 1 KStG: 15 %.
 */

export interface EstTariff {
  /** Grundfreibetrag (euros). */
  readonly grundfreibetrag: number;
  /** Zone 2: (a · y + b) · y, y = (zvE − Grundfreibetrag) / 10 000; `a` in cents, `b` in euros. */
  readonly zone2: { readonly upTo: number; readonly aCents: number; readonly bEuro: number };
  /** Zone 3: (a · z + b) · z + c, z = (zvE − zone2.upTo) / 10 000; `a`, `c` in cents, `b` in euros. */
  readonly zone3: { readonly upTo: number; readonly aCents: number; readonly bEuro: number; readonly cCents: number };
  /** Zone 4: rate · x − minus. */
  readonly zone4: { readonly upTo: number; readonly rateBp: number; readonly minusCents: number };
  /** Zone 5: rate · x − minus. */
  readonly zone5: { readonly rateBp: number; readonly minusCents: number };
}

export interface TaxReserveRules {
  readonly version: string;
  readonly year: number;
  readonly est: EstTariff;
  readonly soli: {
    readonly rateBp: number;
    /** Freigrenze on the ESt (euros): single / Splitting. */
    readonly freigrenzeSingle: number;
    readonly freigrenzeSplitting: number;
    /** Milderungszone: at most this share of the ESt above the Freigrenze. */
    readonly milderungBp: number;
  };
  readonly gewst: {
    /** Freibetrag for natural persons and partnerships (euros). */
    readonly freibetrag: number;
    readonly messzahlBp: number;
    /** §35 EStG factor × 10 (40 = 4,0). */
    readonly par35FactorTenths: number;
  };
  readonly kst: { readonly rateBp: number };
  readonly churchTaxRatesBp: readonly number[];
  readonly source: string;
}

const COMMON = {
  gewst: { freibetrag: 24_500, messzahlBp: 350, par35FactorTenths: 40 },
  kst: { rateBp: 1500 },
  churchTaxRatesBp: [0, 800, 900],
} as const;

export const TAX_RESERVE_RULES: Readonly<Record<number, TaxReserveRules>> = {
  2025: {
    version: "tax-reserve-2025.1",
    year: 2025,
    est: {
      grundfreibetrag: 12_096,
      zone2: { upTo: 17_443, aCents: 93_230, bEuro: 1_400 },
      zone3: { upTo: 68_480, aCents: 17_664, bEuro: 2_397, cCents: 101_513 },
      zone4: { upTo: 277_825, rateBp: 4200, minusCents: 1_091_192 },
      zone5: { rateBp: 4500, minusCents: 1_924_667 },
    },
    soli: { rateBp: 550, freigrenzeSingle: 19_950, freigrenzeSplitting: 39_900, milderungBp: 1190 },
    ...COMMON,
    source: "§32a EStG i. d. F. StFeG v. 23.12.2024 (VZ 2025); §§3, 4 SolZG; §11 GewStG; §35 EStG; §23 KStG",
  },
  2026: {
    version: "tax-reserve-2026.1",
    year: 2026,
    est: {
      grundfreibetrag: 12_348,
      zone2: { upTo: 17_799, aCents: 91_451, bEuro: 1_400 },
      zone3: { upTo: 69_878, aCents: 17_310, bEuro: 2_397, cCents: 103_487 },
      zone4: { upTo: 277_825, rateBp: 4200, minusCents: 1_113_563 },
      zone5: { rateBp: 4500, minusCents: 1_947_038 },
    },
    soli: { rateBp: 550, freigrenzeSingle: 20_350, freigrenzeSplitting: 40_700, milderungBp: 1190 },
    ...COMMON,
    source: "§32a EStG ab VZ 2026; §§3, 4 SolZG; §11 GewStG; §35 EStG; §23 KStG",
  },
};

/** E-RPT-07: the rules of `year`, or of the last known year before it with the banner text. */
export function taxReserveRulesFor(year: number): { rules: TaxReserveRules; banner: string | null } {
  const exact = TAX_RESERVE_RULES[year];
  if (exact) return { rules: exact, banner: null };
  const years = Object.keys(TAX_RESERVE_RULES)
    .map(Number)
    .sort((a, b) => a - b);
  const fallbackYear = [...years].reverse().find((y) => y < year) ?? (years[0] as number);
  const rules = TAX_RESERVE_RULES[fallbackYear] as TaxReserveRules;
  return {
    rules,
    banner: `Tarif ${year} noch nicht hinterlegt – Berechnung mit Tarif ${fallbackYear}.`,
  };
}
