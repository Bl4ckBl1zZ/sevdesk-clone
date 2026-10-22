/**
 * Tax reserve estimator (F08 RPT-010, RPT-011; E-RPT-07, E-RPT-08). Pure, integer arithmetic on BigInt; `today` is
 * passed in. The result is always an estimate: `estimate: true`, the disclaimer „Schätzung – keine Steuerberatung“,
 * every assumption and input listed — never a filing value. UI, REST and MCP pass this object through unchanged.
 *
 *  (a) USt: open liability of the current and not yet paid periods (input).
 *  (b) ESt for natural persons / partners (per share): projected profit − deductions → zvE → §32a (single/Splitting);
 *      §35 credit; Soli on the ESt after §35 (Freigrenze, Milderungszone); KiSt on the ESt before §35 (§51a Abs. 2
 *      S. 3 EStG).
 *  (c) GewSt for Gewerbetreibende: (Gewinn − Freibetrag, rounded down to 100 €) × 3,5 % × Hebesatz.
 *  (d) Corporations: KSt 15 % + Soli 5,5 % (no Freigrenze) + GewSt without Freibetrag.
 */
import { floorDiv, formatEuro, roundHalfAway } from "../money";
import { type EstTariff, type TaxReserveRules, taxReserveRulesFor } from "../rules/tax-reserve";

export const TAX_RESERVE_DISCLAIMER = "Schätzung – keine Steuerberatung";
export const LOSS_NOTICE = "Verlust – es wird keine Einkommensteuer geschätzt.";

export type TaxEntity = "natural" | "partnership" | "corporation";

export interface TaxReserveInput {
  year: number;
  today: string;
  entity: TaxEntity;
  /** Gewerbetreibender (GewSt); false for Freiberufler / PartG. Corporations are always gewerblich. */
  gewerbe: boolean;
  /** Profit of the year up to `today` (EÜR cash basis or accrual result), cents. */
  ytdProfitCents: number;
  profitBasis: "euer" | "accrual";
  /**
   * AST-013: AfA of the year from the asset register — posted so far (contained in `ytdProfitCents`) and planned
   * for the whole year. When given, AfA is not annualised but taken from the plan.
   */
  afa?: { postedYtdCents: number; plannedYearCents: number };
  profitOverrideCents?: number;
  /** Deductions (Sonderausgaben, außergewöhnliche Belastungen …) per person, cents. */
  deductionsCents?: number;
  splitting: boolean;
  churchTaxBp: 0 | 800 | 900;
  /** Hebesatz in basis points of the Messbetrag (400 % = 40 000). */
  hebesatzBp?: number;
  partners?: readonly { name: string; shareBp: number }[];
  prepaidCents: { est: number; gewst: number; kst: number };
  ust: { openCents: number; periods: readonly string[] };
}

export interface PersonTax {
  name: string;
  shareBp: number;
  profitCents: number;
  zveCents: number;
  estTariffCents: number;
  par35CreditCents: number;
  estCents: number;
  soliCents: number;
  churchTaxCents: number;
  totalCents: number;
}

export interface TaxReserveResult {
  estimate: true;
  disclaimer: typeof TAX_RESERVE_DISCLAIMER;
  year: number;
  ruleVersion: string;
  ruleSource: string;
  banner: string | null;
  notices: string[];
  profit: { ytdCents: number; projectedCents: number; basis: "override" | "annualised"; monthsElapsed: number };
  ust: { openCents: number; periods: string[] };
  persons: PersonTax[];
  gewst: { gewerbeertragCents: number; messbetragCents: number; gewstCents: number } | null;
  kst: { kstCents: number; soliCents: number } | null;
  annualCents: number;
  prepaidCents: number;
  remainingCents: number;
  reserveNowCents: number;
  monthlyCents: number;
  monthsLeft: number;
  assumptions: string[];
  inputs: Record<string, string | number | boolean | null>;
}

const B = BigInt;
const n = (v: bigint) => Number(v);
/** Cents → full euros, rounded down (zvE, Gewerbeertrag). */
const euroFloor = (c: number) => n(floorDiv(B(c), 100n));

/** §32a Abs. 1 EStG: tariff tax in euros for a zvE in euros (already rounded down). */
export function estTariff(zveEuro: number, t: EstTariff): number {
  const x = B(Math.max(0, Math.trunc(zveEuro)));
  if (x <= B(t.grundfreibetrag)) return 0;
  if (x <= B(t.zone2.upTo)) {
    // (a/100 · d/10⁴ + b) · d/10⁴ = (a · d + b · 10⁶) · d / 10¹⁰
    const d = x - B(t.grundfreibetrag);
    return n(floorDiv((B(t.zone2.aCents) * d + B(t.zone2.bEuro) * 1_000_000n) * d, 10_000_000_000n));
  }
  if (x <= B(t.zone3.upTo)) {
    const d = x - B(t.zone2.upTo);
    const num = (B(t.zone3.aCents) * d + B(t.zone3.bEuro) * 1_000_000n) * d + B(t.zone3.cCents) * 100_000_000n;
    return n(floorDiv(num, 10_000_000_000n));
  }
  const z = x <= B(t.zone4.upTo) ? t.zone4 : t.zone5;
  // rate/10⁴ · x − minus/100 = (rate · x − minus · 100) / 10⁴
  return n(floorDiv(B(z.rateBp) * x - B(z.minusCents) * 100n, 10_000n));
}

/** ESt in euros: single or Splitting (2 × tariff of half the zvE, §32a Abs. 5). */
export function estOf(zveEuro: number, t: EstTariff, splitting: boolean): number {
  const x = Math.max(0, Math.trunc(zveEuro));
  return splitting ? 2 * estTariff(Math.trunc(x / 2), t) : estTariff(x, t);
}

/** §4 SolZG on an ESt in cents: 5,5 %, at most 11,9 % of the amount above the Freigrenze; cents truncated. */
export function soliOf(estCents: number, rules: TaxReserveRules, splitting: boolean): number {
  const freigrenzeCents = (splitting ? rules.soli.freigrenzeSplitting : rules.soli.freigrenzeSingle) * 100;
  if (estCents <= freigrenzeCents) return 0;
  const full = floorDiv(B(estCents) * B(rules.soli.rateBp), 10_000n);
  const capped = floorDiv(B(estCents - freigrenzeCents) * B(rules.soli.milderungBp), 10_000n);
  return n(full < capped ? full : capped);
}

/** §11 GewStG: Messbetrag and GewSt in cents for a Gewerbeertrag (profit, cents). */
export function gewstOf(
  profitCents: number,
  rules: TaxReserveRules,
  hebesatzBp: number,
  withFreibetrag: boolean,
): { gewerbeertragCents: number; messbetragCents: number; gewstCents: number } {
  const euros = euroFloor(profitCents);
  const afterFreibetrag = euros - (withFreibetrag ? rules.gewst.freibetrag : 0);
  const rounded = afterFreibetrag > 0 ? Math.floor(afterFreibetrag / 100) * 100 : 0;
  const mess = n(floorDiv(B(rounded) * 100n * B(rules.gewst.messzahlBp), 10_000n));
  const gewst = n(floorDiv(B(mess) * B(hebesatzBp), 10_000n));
  return { gewerbeertragCents: rounded * 100, messbetragCents: mess, gewstCents: gewst };
}

function monthsElapsedOf(year: number, today: string): number {
  const ty = Number(today.slice(0, 4));
  if (ty > year) return 12;
  if (ty < year) return 0;
  return Number(today.slice(5, 7));
}

export function estimateTaxReserve(input: TaxReserveInput): TaxReserveResult {
  const { rules, banner } = taxReserveRulesFor(input.year);
  const notices: string[] = [];
  const assumptions: string[] = [];
  const elapsed = monthsElapsedOf(input.year, input.today);
  const monthsLeft = 12 - elapsed;

  // projected annual profit
  let projected: number;
  let basis: "override" | "annualised";
  if (input.profitOverrideCents !== undefined) {
    projected = input.profitOverrideCents;
    basis = "override";
    assumptions.push(`Jahresgewinn vorgegeben: ${formatEuro(projected)}.`);
  } else {
    const afa = input.afa && (input.afa.postedYtdCents !== 0 || input.afa.plannedYearCents !== 0) ? input.afa : null;
    const beforeAfa = input.ytdProfitCents + (afa?.postedYtdCents ?? 0);
    const annualised = elapsed > 0 ? n(roundHalfAway(B(beforeAfa) * 12n, B(elapsed))) : 0;
    projected = annualised - (afa?.plannedYearCents ?? 0);
    basis = "annualised";
    assumptions.push(
      afa
        ? `Jahresgewinn hochgerechnet: ${formatEuro(beforeAfa)} vor AfA in ${elapsed} ${elapsed === 1 ? "Monat" : "Monaten"} × 12 / ${elapsed} − geplante AfA ${formatEuro(afa.plannedYearCents)} = ${formatEuro(projected)} (${input.profitBasis === "euer" ? "EÜR, Zufluss/Abfluss" : "Soll-Ergebnis"}).`
        : `Jahresgewinn hochgerechnet: ${formatEuro(input.ytdProfitCents)} in ${elapsed} ${elapsed === 1 ? "Monat" : "Monaten"} × 12 / ${elapsed} = ${formatEuro(projected)} (${input.profitBasis === "euer" ? "EÜR, Zufluss/Abfluss" : "Soll-Ergebnis"}).`,
    );
    if (afa) {
      assumptions.push(
        `AfA laut Anlagenverzeichnis: ${formatEuro(afa.postedYtdCents)} gebucht, ${formatEuro(afa.plannedYearCents)} im Jahr geplant – nicht hochgerechnet, sondern mit dem Plan angesetzt.`,
      );
    }
  }

  const hebesatz = input.hebesatzBp ?? 40_000;
  const deductions = Math.max(0, input.deductionsCents ?? 0);
  const persons: PersonTax[] = [];
  let gewst: TaxReserveResult["gewst"] = null;
  let kst: TaxReserveResult["kst"] = null;

  if (projected <= 0) notices.push(LOSS_NOTICE); // E-RPT-08

  if (input.entity === "corporation") {
    const zveEuro = Math.max(0, euroFloor(projected));
    const kstCents = n(floorDiv(B(zveEuro) * 100n * B(rules.kst.rateBp), 10_000n));
    kst = { kstCents, soliCents: n(floorDiv(B(kstCents) * B(rules.soli.rateBp), 10_000n)) };
    gewst = gewstOf(Math.max(0, projected), rules, hebesatz, false);
    assumptions.push(
      "Körperschaft: Körperschaftsteuer 15 % zzgl. Solidaritätszuschlag 5,5 %, Gewerbesteuer ohne Freibetrag.",
    );
  } else {
    if (input.gewerbe) gewst = gewstOf(Math.max(0, projected), rules, hebesatz, true);
    const partners =
      input.entity === "partnership" && input.partners && input.partners.length > 0
        ? input.partners
        : [{ name: input.entity === "partnership" ? "Gesellschafter" : "Inhaber/in", shareBp: 10_000 }];
    const shares = partners.map((p) => ({
      ...p,
      profitCents: n(roundHalfAway(B(projected) * B(p.shareBp), 10_000n)),
    }));
    for (const p of shares) {
      const zveCents = Math.max(0, p.profitCents - deductions);
      const zveEuro = euroFloor(zveCents);
      const tariffCents = estOf(zveEuro, rules.est, input.splitting) * 100;
      // §35 EStG: share of 4,0 × Messbetrag, capped at the GewSt paid (share) and the ESt attributable (= full ESt
      // while the business is the only income — assumption below)
      let credit = 0;
      if (gewst) {
        const messShare = n(roundHalfAway(B(gewst.messbetragCents) * B(p.shareBp), 10_000n));
        const gewstShare = n(roundHalfAway(B(gewst.gewstCents) * B(p.shareBp), 10_000n));
        credit = Math.min(n(floorDiv(B(messShare) * B(rules.gewst.par35FactorTenths), 10n)), gewstShare, tariffCents);
      }
      const est = tariffCents - credit;
      const soli = soliOf(est, rules, input.splitting);
      const church = n(floorDiv(B(tariffCents) * B(input.churchTaxBp), 10_000n));
      persons.push({
        name: p.name,
        shareBp: p.shareBp,
        profitCents: p.profitCents,
        zveCents: zveEuro * 100,
        estTariffCents: tariffCents,
        par35CreditCents: credit,
        estCents: est,
        soliCents: soli,
        churchTaxCents: church,
        totalCents: est + soli + church,
      });
    }
    assumptions.push(
      input.splitting ? "Zusammenveranlagung (Splittingtarif)." : "Einzelveranlagung (Grundtarif).",
      deductions > 0
        ? `Abzüge (Sonderausgaben u. a.) je Person: ${formatEuro(deductions)}.`
        : "Keine Abzüge (Sonderausgaben, Vorsorgeaufwendungen) berücksichtigt.",
      "Keine weiteren Einkünfte; Kinderfreibeträge nicht berücksichtigt.",
      input.churchTaxBp > 0
        ? `Kirchensteuer ${input.churchTaxBp / 100} % auf die Einkommensteuer vor Gewerbesteueranrechnung (§ 51a EStG).`
        : "Keine Kirchensteuer.",
    );
    if (input.entity === "partnership") {
      assumptions.push(
        `Gewinnverteilung: ${partners.map((p) => `${p.name} ${p.shareBp / 100} %`).join(", ")}; je Gesellschafter dieselben Abzüge und Veranlagungsart.`,
      );
    }
    if (gewst) {
      assumptions.push(
        "Gewerbesteueranrechnung (§ 35 EStG): 4,0 × Messbetrag, höchstens die Gewerbesteuer und die anteilige Einkommensteuer (gewerbliche Einkünfte als einzige Einkünfte angenommen).",
      );
    }
  }
  if (gewst) {
    assumptions.push(`Gewerbesteuer: Hebesatz ${hebesatz / 100} %, keine Hinzurechnungen oder Kürzungen.`);
  } else if (input.entity !== "corporation") {
    assumptions.push("Keine Gewerbesteuer (freiberufliche Tätigkeit).");
  }

  const annual =
    persons.reduce((s, p) => s + p.totalCents, 0) + (gewst?.gewstCents ?? 0) + (kst ? kst.kstCents + kst.soliCents : 0);
  const prepaid = input.prepaidCents.est + input.prepaidCents.gewst + input.prepaidCents.kst;
  const remaining = Math.max(0, annual - prepaid);
  const accrued = n(roundHalfAway(B(annual) * B(elapsed), 12n));
  const incomeNow = Math.max(0, accrued - prepaid);
  const reserveNow = Math.max(0, input.ust.openCents) + incomeNow;
  const monthly = monthsLeft > 0 ? n(roundHalfAway(B(Math.max(0, remaining - incomeNow)), B(monthsLeft))) : 0;
  assumptions.push(
    `Vorauszahlungen ${input.year} laut erfassten Steuerzahlungen: ${formatEuro(prepaid)}.`,
    `Rücklage jetzt = offene Umsatzsteuer + anteilige Jahressteuer (${elapsed}/12) − Vorauszahlungen; Monatsbetrag = Rest verteilt auf ${monthsLeft} ${monthsLeft === 1 ? "Monat" : "Monate"}.`,
    "Keine Steuerberatung und kein Wert für eine Steuererklärung.",
  );

  return {
    estimate: true,
    disclaimer: TAX_RESERVE_DISCLAIMER,
    year: input.year,
    ruleVersion: rules.version,
    ruleSource: rules.source,
    banner,
    notices,
    profit: { ytdCents: input.ytdProfitCents, projectedCents: projected, basis, monthsElapsed: elapsed },
    ust: { openCents: input.ust.openCents, periods: [...input.ust.periods] },
    persons,
    gewst,
    kst,
    annualCents: annual,
    prepaidCents: prepaid,
    remainingCents: remaining,
    reserveNowCents: reserveNow,
    monthlyCents: monthly,
    monthsLeft,
    assumptions,
    inputs: {
      year: input.year,
      entity: input.entity,
      gewerbe: input.gewerbe,
      profitOverrideCents: input.profitOverrideCents ?? null,
      deductionsCents: deductions,
      splitting: input.splitting,
      churchTaxBp: input.churchTaxBp,
      hebesatzBp: gewst ? hebesatz : null,
      ytdProfitCents: input.ytdProfitCents,
      profitBasis: input.profitBasis,
    },
  };
}
