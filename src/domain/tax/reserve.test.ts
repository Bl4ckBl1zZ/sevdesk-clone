import { describe, expect, test } from "vitest";
import { formatEuro } from "../money";
import { TAX_RESERVE_RULES, taxReserveRulesFor } from "../rules/tax-reserve";
import {
  estimateTaxReserve,
  estOf,
  estTariff,
  gewstOf,
  LOSS_NOTICE,
  soliOf,
  TAX_RESERVE_DISCLAIMER,
  type TaxReserveInput,
} from "./reserve";

const R26 = TAX_RESERVE_RULES[2026];
const R25 = TAX_RESERVE_RULES[2025];
if (!R26 || !R25) throw new Error("rules missing");

const base: TaxReserveInput = {
  year: 2026,
  today: "2026-10-20",
  entity: "natural",
  gewerbe: true,
  ytdProfitCents: 0,
  profitBasis: "euer",
  profitOverrideCents: 6_000_000,
  splitting: false,
  churchTaxBp: 0,
  hebesatzBp: 40_000,
  prepaidCents: { est: 0, gewst: 0, kst: 0 },
  ust: { openCents: 0, periods: [] },
};

describe("§32a EStG tariff (RPT-010)", () => {
  test("RPT-010 2026 tariff: Grundfreibetrag, each zone and the zone boundaries are continuous (±1 €)", () => {
    const t = R26.est;
    expect(estTariff(12_348, t)).toBe(0);
    expect(estTariff(12_349, t)).toBe(0);
    expect(estTariff(15_000, t)).toBe(435);
    expect(estTariff(30_000, t)).toBe(4_217);
    expect(estTariff(60_000, t)).toBe(14_233);
    expect(estTariff(100_000, t)).toBe(30_864); // 0,42 · 100 000 − 11 135,63
    expect(estTariff(300_000, t)).toBe(115_529); // 0,45 · 300 000 − 19 470,38
    for (const edge of [t.zone2.upTo, t.zone3.upTo, t.zone4.upTo]) {
      expect(Math.abs(estTariff(edge + 1, t) - estTariff(edge, t))).toBeLessThanOrEqual(1);
    }
  });

  test("RPT-010 zvE is rounded down to full euros; Splitting = 2 × tariff of half the zvE", () => {
    expect(estTariff(60_000.99, R26.est)).toBe(14_233);
    expect(estOf(120_001, R26.est, true)).toBe(2 * estTariff(60_000, R26.est));
  });

  test("RPT-010 2025 tariff is its own table (Grundfreibetrag 12 096 €)", () => {
    expect(estTariff(12_096, R25.est)).toBe(0);
    expect(estTariff(12_200, R25.est)).toBeGreaterThan(0);
    expect(estTariff(60_000, R25.est)).toBeGreaterThan(estTariff(60_000, R26.est));
  });
});

describe("Soli, GewSt (RPT-010)", () => {
  test("RPT-010 Soli: 0 up to the Freigrenze, Milderungszone 11,9 % above it, full 5,5 % later; cents truncated", () => {
    expect(soliOf(2_035_000, R26, false)).toBe(0);
    expect(soliOf(2_100_000, R26, false)).toBe(7_735); // 11,9 % × 650 € = 77,35 €
    expect(soliOf(4_000_000, R26, false)).toBe(220_000); // 5,5 % × 40 000 €
    expect(soliOf(4_000_000, R26, true)).toBe(0); // Splitting Freigrenze 40 700 €
  });

  test("RPT-010 GewSt: Freibetrag 24 500 €, Gewerbeertrag rounded down to 100 €, 3,5 % × Hebesatz", () => {
    expect(gewstOf(6_000_000, R26, 40_000, true)).toEqual({
      gewerbeertragCents: 3_550_000,
      messbetragCents: 124_250,
      gewstCents: 497_000,
    });
    expect(gewstOf(6_004_999, R26, 40_000, true).gewerbeertragCents).toBe(3_550_000);
    expect(gewstOf(2_000_000, R26, 40_000, true).gewstCents).toBe(0);
    expect(gewstOf(6_000_000, R26, 40_000, false).gewerbeertragCents).toBe(6_000_000);
  });
});

describe("estimateTaxReserve (RPT-010, RPT-011)", () => {
  test("RPT-010 TST-RPT-05 2026, single, profit 60 000 €, no KiSt, Gewerbe 400 %: GewSt 4 970 €, §35 credit 4 970 €, ESt 9 263 €", () => {
    const r = estimateTaxReserve(base);
    expect(r.gewst).toEqual({ gewerbeertragCents: 3_550_000, messbetragCents: 124_250, gewstCents: 497_000 });
    expect(r.persons).toEqual([
      expect.objectContaining({
        zveCents: 6_000_000,
        estTariffCents: 1_423_300,
        par35CreditCents: 497_000, // min(4 × 1 242,50; 4 970; 14 233)
        estCents: 926_300,
        soliCents: 0,
        churchTaxCents: 0,
        totalCents: 926_300,
      }),
    ]);
    expect(r.annualCents).toBe(1_423_300);
    expect(r.ruleVersion).toBe("tax-reserve-2026.1");
    expect(r.banner).toBeNull();
  });

  test("RPT-010 KiSt is computed on the ESt before the §35 credit, Soli on the ESt after it", () => {
    const r = estimateTaxReserve({ ...base, churchTaxBp: 900, profitOverrideCents: 15_000_000 });
    const p = r.persons[0];
    if (!p) throw new Error("no person");
    expect(p.churchTaxCents).toBe(Math.floor((p.estTariffCents * 900) / 10_000));
    expect(p.soliCents).toBe(soliOf(p.estTariffCents - p.par35CreditCents, R26, false));
    expect(p.par35CreditCents).toBeGreaterThan(0);
  });

  test("RPT-010 Freiberufler: no GewSt and no §35 credit", () => {
    const r = estimateTaxReserve({ ...base, gewerbe: false });
    expect(r.gewst).toBeNull();
    expect(r.persons[0]?.estCents).toBe(1_423_300);
    expect(r.assumptions).toContain("Keine Gewerbesteuer (freiberufliche Tätigkeit).");
  });

  test("RPT-010 partnership: profit split by share, ESt per partner, GewSt with Freibetrag at company level", () => {
    const r = estimateTaxReserve({
      ...base,
      entity: "partnership",
      profitOverrideCents: 12_000_000,
      partners: [
        { name: "A", shareBp: 5_000 },
        { name: "B", shareBp: 5_000 },
      ],
    });
    expect(r.persons.map((p) => p.profitCents)).toEqual([6_000_000, 6_000_000]);
    expect(r.gewst?.gewerbeertragCents).toBe(9_550_000);
    expect(r.persons[0]?.estTariffCents).toBe(1_423_300);
  });

  test("RPT-010 corporation: KSt 15 % + Soli 5,5 % + GewSt without Freibetrag", () => {
    const r = estimateTaxReserve({ ...base, entity: "corporation", profitOverrideCents: 10_000_000 });
    expect(r.kst).toEqual({ kstCents: 1_500_000, soliCents: 82_500 });
    expect(r.gewst?.gewstCents).toBe(1_400_000); // 100 000 × 3,5 % × 400 %
    expect(r.persons).toEqual([]);
    expect(r.annualCents).toBe(1_500_000 + 82_500 + 1_400_000);
  });

  test("RPT-010 E-RPT-08 a loss gives ESt 0 with an info notice", () => {
    const r = estimateTaxReserve({ ...base, profitOverrideCents: -500_000 });
    expect(r.annualCents).toBe(0);
    expect(r.persons[0]?.estCents).toBe(0);
    expect(r.notices).toContain(LOSS_NOTICE);
  });

  test("RPT-010 annualises the YTD profit, subtracts prepayments and suggests a monthly amount; USt open is reserved now", () => {
    const r = estimateTaxReserve({
      ...base,
      profitOverrideCents: undefined,
      ytdProfitCents: 4_500_000, // 9 months (Sept) → 60 000 €
      today: "2026-09-15",
      prepaidCents: { est: 300_000, gewst: 100_000, kst: 0 },
      ust: { openCents: 250_000, periods: ["2026-08"] },
    });
    expect(r.profit).toEqual({ ytdCents: 4_500_000, projectedCents: 6_000_000, basis: "annualised", monthsElapsed: 9 });
    expect(r.annualCents).toBe(1_423_300);
    expect(r.prepaidCents).toBe(400_000);
    expect(r.remainingCents).toBe(1_023_300);
    // accrued 9/12 of 14 233 € = 10 674,75 € − 4 000 € prepaid = 6 674,75 € + USt 2 500 €
    expect(r.reserveNowCents).toBe(250_000 + 1_067_475 - 400_000);
    // rest (10 233 − 6 674,75 = 3 558,25 €) over 3 months
    expect(r.monthlyCents).toBe(118_608);
  });

  test("RPT-011 the result is labelled as an estimate, lists every assumption and the inputs", () => {
    const r = estimateTaxReserve({ ...base, churchTaxBp: 800, deductionsCents: 500_000 });
    expect(r.estimate).toBe(true);
    expect(r.disclaimer).toBe(TAX_RESERVE_DISCLAIMER);
    expect(TAX_RESERVE_DISCLAIMER).toBe("Schätzung – keine Steuerberatung");
    expect(r.assumptions).toEqual(
      expect.arrayContaining([
        `Jahresgewinn vorgegeben: ${formatEuro(6_000_000)}.`,
        "Einzelveranlagung (Grundtarif).",
        `Abzüge (Sonderausgaben u. a.) je Person: ${formatEuro(500_000)}.`,
        "Kirchensteuer 8 % auf die Einkommensteuer vor Gewerbesteueranrechnung (§ 51a EStG).",
        "Gewerbesteuer: Hebesatz 400 %, keine Hinzurechnungen oder Kürzungen.",
        "Keine Steuerberatung und kein Wert für eine Steuererklärung.",
      ]),
    );
    expect(r.inputs).toMatchObject({ churchTaxBp: 800, deductionsCents: 500_000, hebesatzBp: 40_000 });
    expect(r.persons[0]?.zveCents).toBe(5_500_000);
  });

  test("RPT-010 E-RPT-07 a year without tariff uses the last known year with the banner", () => {
    expect(taxReserveRulesFor(2027)).toMatchObject({
      rules: { year: 2026 },
      banner: "Tarif 2027 noch nicht hinterlegt – Berechnung mit Tarif 2026.",
    });
    expect(estimateTaxReserve({ ...base, year: 2027, today: "2027-02-01" }).banner).toBe(
      "Tarif 2027 noch nicht hinterlegt – Berechnung mit Tarif 2026.",
    );
  });
});
