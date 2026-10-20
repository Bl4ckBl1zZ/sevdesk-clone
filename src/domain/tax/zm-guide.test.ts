import { describe, expect, test } from "vitest";
import { elsterGuideFor } from "../rules/elster";
import { ustvaMappingFor } from "../rules/ustva";
import { buildSvzGuide, buildUstvaGuide, buildZmGuide } from "./elster-guide";
import { type Contribution, computeUstva, type TaxJournalEntry } from "./ustva";
import { computeZm, reconcileZmWithUstva, zmContributions, zmCsv } from "./zm";

const M = ustvaMappingFor(2026) as NonNullable<ReturnType<typeof ustvaMappingFor>>;

const entry = (id: string, taxKey: string, cents: number, vatId: string, tp = "2026-08-15"): TaxJournalEntry => ({
  id,
  seq: Number(id.replace(/\D/g, "")) || 1,
  date: tp,
  recordedAt: 1,
  source: { kind: "salesDocument", id },
  text: `Rechnung ${id}`,
  lines: [
    { account: "1400", role: "receivable", debitCents: cents, creditCents: 0 },
    { account: "8125", taxKey, debitCents: 0, creditCents: cents, taxPointDate: tp },
  ],
  counterparty: { vatId, name: `Kunde ${id}` },
});

const contribution = (kz: string, part: "base" | "tax", cents: number): Contribution => ({
  kz,
  part,
  cents,
  taxPointDate: "2026-09-10",
  entryId: `e-${kz}-${part}`,
  seq: 1,
  source: { kind: "salesDocument", id: `d-${kz}` },
});

describe("ZM (TAX-009, TAX-010, UVA-05)", () => {
  test("TAX-009 TAX-010 UVA-05 TST-TAX-11 two EU customers (L and S) in Q3 → rows per USt-IdNr and type; Σ L = Kz 41, Σ S = Kz 21", () => {
    const entries = [
      entry("e1", "igL", 1_000_050, "FR 12 345678901"),
      entry("e2", "igL", 200_000, "FR12345678901", "2026-09-02"),
      entry("e3", "EU-RC", 300_099, "ATU12345678"),
      entry("e4", "EU-RC", -50_000, "ATU12345678", "2026-09-20"),
    ];
    const zm = computeZm("2026-Q3", entries.flatMap(zmContributions));
    expect(zm.rows.map((r) => [r.countryCode, r.vatNumber, r.type, r.euros])).toEqual([
      ["AT", "U12345678", "S", 2500],
      ["FR", "12345678901", "L", 12000],
    ]);
    expect(zm.totalsByType).toEqual({ L: 12000, S: 2500, D: 0 });
    expect(zm.monthlyRequired).toBe(false);
    expect(reconcileZmWithUstva(zm, 12000, 2500)).toEqual([]);
    expect(reconcileZmWithUstva(zm, 12001, 2500)).toEqual(["ZM-Summe (12000 €) weicht von UStVA Kz 41 (12001 €) ab."]);
    expect(zmCsv(zm)).toBe(
      "Laenderkennzeichen,USt-IdNr.,Betrag(EUR),Art der Leistung\r\nAT,U12345678,2500,S\r\nFR,12345678901,12000,L\r\n",
    );
  });

  test("TAX-009 goods above 50,000 € in a quarter → monthly ZM required (rule data); missing USt-IdNr warns", () => {
    const zm = computeZm("2026-Q3", [entry("e9", "igL", 5_000_001, "")].flatMap(zmContributions));
    expect(zm.monthlyRequired).toBe(true);
    expect(zm.warnings).toHaveLength(2);
  });

  test("TAX-020 TST-TAX-26 ZM guide: navigation, one row per USt-IdNr with copy strings, blocked without USt-IdNr", () => {
    const zm = computeZm("2026-Q3", [entry("e1", "igL", 100_000, "FR12345678901")].flatMap(zmContributions));
    const g = buildZmGuide(zm, 2026, elsterGuideFor("zm", 2026), { today: "2026-10-19", sheetHash: "h" });
    expect(g.blocked).toBe(false);
    expect(g.navigation.at(-1)).toBe("Zusammenfassende Meldung");
    expect(g.steps[0]?.rows).toEqual([
      {
        countryCode: "FR",
        vatNumber: "12345678901",
        type: "L",
        euros: 1000,
        copy: { amount: "1000", vatNumber: "12345678901" },
      },
    ]);
    const bad = computeZm("2026-Q3", [entry("e2", "igL", 100_000, "")].flatMap(zmContributions));
    expect(buildZmGuide(bad, 2026, elsterGuideFor("zm", 2026), { today: "2026-10-19", sheetHash: "h" }).blocked).toBe(
      true,
    );
  });
});

describe("Mein ELSTER guide (TAX-020)", () => {
  const sheet = computeUstva(
    "2026-12",
    [contribution("81", "base", 123456), contribution("81", "tax", 23457), contribution("66", "tax", 1900)],
    M,
    { ku: false },
  );

  test("TAX-020 TST-TAX-26 UStVA guide: path, form year, fields in form order, copy strings; every non-zero Kz exactly once", () => {
    const g = buildUstvaGuide(sheet, elsterGuideFor("ustva", 2026), { today: "2026-12-30", sheetHash: "abc" });
    expect(g.blocked).toBe(false);
    expect(g.formYear).toBe(2026);
    expect(g.navigation).toEqual([
      "Formulare & Leistungen",
      "Alle Formulare",
      "Unternehmen",
      "Umsatzsteuer",
      "Umsatzsteuer-Voranmeldung 2026",
    ]);
    const fields = g.steps.flatMap((s) => s.fields);
    const nonZero = fields.filter((f) => f.copy !== null).map((f) => [f.kz, f.copy]);
    expect(nonZero).toEqual([
      ["81", "1234"],
      ["66", "19,00"],
      ["83", "215,46"],
    ]);
    // every Kennzahl of the sheet appears exactly once
    const kzs = fields.map((f) => f.kz);
    expect(new Set(kzs).size).toBe(kzs.length);
    expect(kzs.sort()).toEqual(sheet.fields.map((f) => f.kz).sort());
    expect(fields.find((f) => f.kz === "86")?.copy).toBeNull(); // „leer lassen“
    expect(g.checklist).toContain("Die ELSTER-Vorschau zeigt in Kz 83 denselben Betrag wie diese Seite.");
  });

  test("TAX-020 E-UVA-22 a December period filed in January warns about the form year", () => {
    const g = buildUstvaGuide(sheet, elsterGuideFor("ustva", 2026), { today: "2027-01-08", sheetHash: "abc" });
    expect(g.formYearWarning).toBe("Achtung: Formular 2026 wählen, nicht 2027.");
  });

  test("TAX-007 TAX-020 TST-TAX-34 the correction guide starts with „Berichtigte Anmeldung: Ja (Kz 10 = 1)“ and complete values", () => {
    const g = buildUstvaGuide(sheet, elsterGuideFor("ustva", 2026), {
      today: "2027-01-08",
      sheetHash: "abc",
      correction: true,
    });
    expect(g.steps[0]?.instruction).toBe("Berichtigte Anmeldung: Ja (Kz 10 = 1)");
    expect(g.steps.flatMap((s) => s.fields).find((f) => f.kz === "81")?.copy).toBe("1234");
  });

  test("TAX-020 E-UVA-03 E-UVA-20 TST-TAX-30 blockers or unverified data block the guide (copy disabled)", () => {
    const blocked = buildUstvaGuide(sheet, elsterGuideFor("ustva", 2026), {
      today: "2026-12-30",
      sheetHash: "abc",
      blockers: ["Es gibt 1 Entwürfe mit Leistungsdatum im Zeitraum. Bitte fertigstellen oder löschen."],
    });
    expect(blocked.blocked).toBe(true);
    const m2027 = ustvaMappingFor(2027) as NonNullable<ReturnType<typeof ustvaMappingFor>>;
    const s2027 = computeUstva("2027-01", [], m2027, { ku: false });
    const g2027 = buildUstvaGuide(s2027, elsterGuideFor("ustva", 2027), { today: "2027-02-01", sheetHash: "x" });
    expect(g2027.blocked).toBe(true);
    expect(g2027.blockers).toContain(
      "Die Ausfüllhilfe für Umsatzsteuer-Voranmeldung 2027 ist noch nicht gegen das amtliche Formular geprüft. Bitte Update einspielen.",
    );
    const none = buildUstvaGuide(s2027, null, { today: "2027-02-01", sheetHash: "x" });
    expect(none.blockers).toContain(
      "Die Kennzahlen-Zuordnung für 2027 ist noch nicht hinterlegt. Bitte Update einspielen.",
    );
  });

  test("TAX-002 TAX-020 USt 1 H guide shows Kz 38 with its copy string", () => {
    const g = buildSvzGuide(200_000, 2026, elsterGuideFor("ust1h", 2026), { today: "2026-02-01", sheetHash: "s" });
    expect(g.steps[0]?.fields).toEqual([
      {
        kz: "38",
        label: "Sondervorauszahlung (1/11 der Vorauszahlungen des Vorjahres)",
        valueCents: 200_000,
        copy: "2000,00",
      },
    ]);
    expect(g.blocked).toBe(false);
  });
});
