import { describe, expect, test } from "vitest";
import { ustAnnualMappingFor } from "../rules/ust-annual";
import { ustvaMappingFor } from "../rules/ustva";
import { computeUstAnnual, type FiledUstva, type UstAnnualInput } from "./ust-annual";
import type { Contribution } from "./ustva";

const QUARTERS = ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"];

let n = 0;
/** One journal entry's contribution to a UStVA Kennzahl. */
const c = (kz: string, part: Contribution["part"], cents: number, taxPointDate: string, entryId?: string) => {
  n++;
  return {
    kz,
    part,
    cents,
    taxPointDate,
    entryId: entryId ?? `e${n}`,
    seq: n,
    source: { kind: "salesDocument", id: `d${n}` },
  } satisfies Contribution;
};

/** A 19 % sale (base + booked VAT) on one tax point. */
const sale = (netCents: number, date: string, id?: string) => [
  c("81", "base", netCents, date, id),
  c("81", "tax", Math.round(netCents * 0.19), date, id),
];
/** Input VAT. */
const vorsteuer = (cents: number, date: string, id?: string) => [c("66", "tax", cents, date, id)];

function input(over: Partial<UstAnnualInput> = {}): UstAnnualInput {
  return {
    year: 2026,
    periods: QUARTERS,
    contributions: [],
    recordedAt: new Map(),
    ustva: ustvaMappingFor(2026),
    annual: ustAnnualMappingFor(2026),
    filed: [],
    ku: false,
    ended: true,
    ...over,
  };
}

const filed = (period: string, values: Record<string, number>, submittedAt = 1000): FiledUstva => ({
  period,
  values,
  submittedAt,
});

describe("USt-Jahreserklärung worksheet (TAX-023, UVA-03)", () => {
  test("TAX-023 the 2026 USt 2 A table is verified against the BMF Vordruck of 29.12.2025; key Zeilen/Kennzahlen pinned", () => {
    const m = ustAnnualMappingFor(2026);
    expect(m?.verifiedAgainstForm?.source).toContain("III C 3 - S 7344/00040/008/034");
    const at = (kz: string) => m?.rows.find((r) => r.kz === kz)?.zeile;
    expect([at("177"), at("275"), at("157"), at("741"), at("752"), at("781"), at("793")]).toEqual([
      24, 27, 30, 42, 45, 57, 58,
    ]);
    expect([at("846"), at("847"), at("877"), at("878"), at("209"), at("721"), at("205"), at("650")]).toEqual([
      71, 71, 73, 73, 76, 80, 81, 84,
    ]);
    expect([at("320"), at("761"), at("762"), at("467"), at("816"), at("820")]).toEqual([85, 86, 87, 89, 124, 126]);
    expect(ustAnnualMappingFor(2027)).toBeNull();
  });

  test("TAX-023 TST-TAX-35 year totals per line equal Σ of the submitted UStVAs when nothing changed (Abschlusszahlung 0)", () => {
    const contributions = [
      ...sale(1000000, "2026-02-10"),
      ...vorsteuer(19000, "2026-02-12"),
      ...sale(500000, "2026-05-10"),
      ...sale(250000, "2026-08-10"),
      ...sale(250000, "2026-11-10"),
    ];
    const sheet = computeUstAnnual(
      input({
        contributions,
        filed: [
          filed("2026-Q1", { "81": 1000000, "66": 19000, "83": 171000 }),
          filed("2026-Q2", { "81": 500000, "83": 95000 }),
          filed("2026-Q3", { "81": 250000, "83": 47500 }),
          filed("2026-Q4", { "81": 250000, "83": 47500 }),
        ],
      }),
    );
    const row = (zeile: number, kz: string | null) => sheet.rows.find((r) => r.zeile === zeile && r.kz === kz);
    expect(row(24, "177")).toMatchObject({ valueCents: 2000000, copy: "20000" });
    expect(row(24, null)).toMatchObject({ valueCents: 380000 });
    expect(row(85, "320")).toMatchObject({ valueCents: 19000, copy: "190,00" });
    expect(sheet.totals).toEqual({ verbleibendCents: 361000, vorauszahlungssollCents: 361000, abschlussCents: 0 });
    expect(row(126, "820")).toMatchObject({ valueCents: 0, copy: "0,00" });
    expect(sheet.reconciliation).toEqual({ differenceCents: 0, causes: [] });
    expect(sheet.verified).toBe(true);
    expect(sheet.guide.blocked).toBe(false);
    // zero rows: „leer lassen“; the result rows are always filled („bitte in jedem Fall ausfüllen“)
    expect(row(42, "741")?.copy).toBeNull();
  });

  test("TAX-023 TST-TAX-35 a late Sept posting after the Q3 filing → expected Abschlusszahlung, cause linked to its journal entry", () => {
    const late = sale(100000, "2026-09-28", "late1");
    const sheet = computeUstAnnual(
      input({
        contributions: [...sale(500000, "2026-08-10", "e-aug"), ...late],
        recordedAt: new Map([
          ["e-aug", 500],
          ["late1", 5000],
        ]),
        filed: [
          filed("2026-Q1", { "83": 0 }),
          filed("2026-Q2", { "83": 0 }),
          filed("2026-Q3", { "81": 500000, "83": 95000 }, 1000),
          filed("2026-Q4", { "83": 0 }),
        ],
      }),
    );
    expect(sheet.totals).toEqual({ verbleibendCents: 114000, vorauszahlungssollCents: 95000, abschlussCents: 19000 });
    expect(sheet.reconciliation.differenceCents).toBe(19000);
    expect(sheet.reconciliation.causes).toEqual([
      {
        kind: "nachgemeldet",
        period: "2026-Q3",
        label: "Nach der Voranmeldung Q3/2026 erfasst – berichtigte Voranmeldung oder Jahreserklärung",
        amountCents: 19000,
        deltas: [{ kz: "81", beforeCents: 500000, afterCents: 600000, deltaCents: 100000 }],
        entries: [{ entryId: "late1", seq: expect.any(Number), source: expect.any(Object) }],
      },
    ]);
  });

  test("TAX-023 the Sondervorauszahlung (Kz 39 of the December/Q4 filing) is part of the Vorauszahlungssoll", () => {
    const sheet = computeUstAnnual(
      input({
        periods: Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`),
        contributions: [...sale(1200000, "2026-06-10"), ...sale(100000, "2026-12-10")],
        filed: [
          filed("2026-06", { "81": 1200000, "83": 228000 }),
          // December: 19,000 € tax − 20,000 € Sondervorauszahlung
          filed("2026-12", { "81": 100000, "39": 20000, "83": -1000 }),
        ],
      }),
    );
    expect(sheet.totals).toEqual({ verbleibendCents: 247000, vorauszahlungssollCents: 247000, abschlussCents: 0 });
    // months without values and without a filing are no cause
    expect(sheet.reconciliation.causes).toEqual([]);
  });

  test("TAX-023 an unfiled period with values, an „abweichend übermittelt“ filing and base rounding are listed as causes", () => {
    const sheet = computeUstAnnual(
      input({
        contributions: [
          // Q1 50.60 € + Q2 50.60 € bases: per quarter truncated to 50 € each; the year 101.20 € → 101 €
          c("81", "base", 5060, "2026-02-01"),
          c("81", "base", 5060, "2026-05-01"),
          ...sale(100000, "2026-08-01"),
        ],
        filed: [
          filed("2026-Q1", { "81": 5000, "83": 950 }),
          {
            ...filed("2026-Q2", { "81": 5000, "83": 950 }),
            submittedValuesDiffer: true,
            elsterReportedTotalCents: 900,
          },
        ],
      }),
    );
    // year: 101 € × 19 % = 19.19 € + 1,000 € × 19 % = 190 € → 209.19 €
    expect(sheet.totals.verbleibendCents).toBe(20919);
    expect(sheet.totals.vorauszahlungssollCents).toBe(950 + 900);
    const kinds = sheet.reconciliation.causes.map((x) => [x.kind, x.period, x.amountCents]);
    expect(kinds).toEqual([
      ["abweichend_uebermittelt", "2026-Q2", 50],
      ["nicht_gemeldet", "2026-Q3", 19000],
      ["rundung", null, 19],
    ]);
    expect(sheet.reconciliation.causes.reduce((s, x) => s + x.amountCents, 0)).toBe(sheet.totals.abschlussCents);
  });

  test("TAX-023 E-UVA-07 E-UVA-20 a missing year table, an unverified table or an open year block the copy strings", () => {
    const missing = computeUstAnnual(input({ year: 2027, annual: null, ustva: ustvaMappingFor(2027) }));
    expect(missing.guide.blocked).toBe(true);
    expect(missing.blockers).toContain(
      "Die Zeilenzuordnung der Umsatzsteuererklärung für 2027 ist noch nicht hinterlegt. Bitte Update einspielen.",
    );
    const m = ustAnnualMappingFor(2026);
    if (!m) throw new Error("2026 missing");
    const { verifiedAgainstForm: _v, ...unverified } = m;
    const u = computeUstAnnual(input({ annual: unverified, contributions: sale(100000, "2026-03-01") }));
    expect(u.verified).toBe(false);
    expect(u.notices).toContain(
      "Die Ausfüllhilfe für Umsatzsteuererklärung 2026 ist noch nicht gegen das amtliche Formular geprüft. Bitte Update einspielen.",
    );
    expect(u.guide.blocked).toBe(true);
    // values stay visible
    expect(u.rows.find((r) => r.kz === "177")?.valueCents).toBe(100000);
    const open = computeUstAnnual(input({ ended: false }));
    expect(open.blockers).toContain("Das Jahr 2026 ist noch nicht abgeschlossen.");
  });

  test("TAX-023 TAX-020 review rows (Kz 48, Kz 50) are shown but never offered as copy strings in the guide", () => {
    const sheet = computeUstAnnual(
      input({
        contributions: [c("48", "base", 30000, "2026-04-01"), ...sale(100000, "2026-04-01")],
        filed: QUARTERS.map((q) =>
          filed(q, { "83": q === "2026-Q2" ? 19000 : 0, ...(q === "2026-Q2" ? { "81": 100000, "48": 30000 } : {}) }),
        ),
      }),
    );
    const kz240 = sheet.rows.find((r) => r.kz === "240");
    expect(kz240).toMatchObject({ valueCents: 30000, copy: null });
    expect(kz240?.review).toMatch(/Zeilen 51–54/);
    const guideKz = sheet.guide.steps.flatMap((s) => s.fields.map((f) => f.kz));
    expect(guideKz).not.toContain("240");
    expect(guideKz).toContain("177");
    expect(sheet.rows.find((r) => r.kz === "177")?.hint).toMatch(/Wertabgaben/);
    // columns without a Kennzahl (tax computed by the form) are no copy fields
    expect(guideKz.every((k) => k !== null)).toBe(true);
    expect(guideKz).toEqual(expect.arrayContaining(["816", "820"]));
    expect(sheet.guide.navigation.at(-1)).toBe("Umsatzsteuererklärung 2026");
    expect(sheet.guide.formYear).toBe(2026);
  });

  test("TAX-023 TAX-011 KU: only §13b/igE values; a notice explains that the KU turnover (Zeile 53) is not computed", () => {
    const sheet = computeUstAnnual(
      input({
        ku: true,
        contributions: [
          c("46", "base", 10000, "2026-03-01"),
          c("47", "tax", 1900, "2026-03-01"),
          ...sale(50000, "2026-03-01"),
        ],
        filed: [filed("2026-Q1", { "46": 10000, "47": 1900, "83": 1900 })],
      }),
    );
    expect(sheet.rows.find((r) => r.kz === "846")?.valueCents).toBe(10000);
    expect(sheet.rows.find((r) => r.kz === "177")?.valueCents).toBe(0);
    expect(sheet.totals.verbleibendCents).toBe(1900);
    expect(sheet.notices.join(" ")).toMatch(/Zeile 53/);
  });
});
