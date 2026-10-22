import { describe, expect, test } from "vitest";
import { voucherInputVatDeducted, voucherLineBaseCents } from "../accounting/post-vouchers";
import { JSTG_2026_ASSET_THRESHOLDS_DRAFT } from "../rules/afa";
import { calendarDate } from "../time/calendar-date";
import { planDisposal } from "./disposal";
import { assetDraftsFromVoucher } from "./from-voucher";
import { afaRoleFor, allowedMethods, assetClassOf, validateAssetSetup } from "./methods";
import { anlagenspiegel, gwgList, poolSummary } from "./report";
import { afaForecast, depreciationPlan, depreciationTable, sumThrough } from "./schedule";

const d = calendarDate;
const jstg = [{ ...JSTG_2026_ASSET_THRESHOLDS_DRAFT, id: "jstg" }];
const sumYear = (rows: { period: string; amountCents: number }[], y: number) =>
  rows.filter((r) => r.period.startsWith(String(y))).reduce((s, r) => s + r.amountCents, 0);

const planOf = (input: Parameters<typeof depreciationPlan>[0]) => {
  const r = depreciationPlan(input);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("AST-003 methods valid for the acquisition date (afaRules)", () => {
  test("AST-003 TST-AST-12 E-AST-01 acquisition on 2025-06-30: degressive not offered", () => {
    const opts = allowedMethods({ acquisitionDate: d("2025-06-30"), costCents: 1_000_000, assetClass: "movable" });
    const deg = opts.find((o) => o.method === "degressive");
    expect(deg?.allowed).toBe(false);
    expect(deg?.message).toBe("Degressive AfA ist für Anschaffungen am 30.06.2025 nicht zulässig.");
    const r = validateAssetSetup({
      acquisitionDate: d("2025-06-30"),
      costCents: 1_000_000,
      method: "degressive",
      assetClass: "movable",
      usefulLifeMonths: 120,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E-AST-01");
    const ok = allowedMethods({ acquisitionDate: d("2025-07-01"), costCents: 1_000_000, assetClass: "movable" });
    expect(ok.find((o) => o.method === "degressive")?.allowed).toBe(true);
  });

  test("AST-003 E-AST-02 degressive only for movable assets", () => {
    const r = validateAssetSetup({
      acquisitionDate: d("2026-03-01"),
      costCents: 500_000,
      method: "degressive",
      assetClass: "intangible",
      usefulLifeMonths: 36,
    });
    expect(!r.ok && r.error.message).toBe("Degressive AfA gilt nur für bewegliche Wirtschaftsgüter.");
  });

  test("AST-003 AST-005 degressive rate = min(30 %, 3 × linear) is stored with the rule version", () => {
    const r = validateAssetSetup({
      acquisitionDate: d("2026-03-01"),
      costCents: 500_000,
      method: "degressive",
      assetClass: "movable",
      usefulLifeMonths: 180,
    });
    expect(r.ok && r.value.degressiveRateBp).toBe(2000);
    expect(r.ok && r.value.ruleVersion).toContain("afa_rules@2025-07-01");
  });

  test("AST-003 TST-AST-04 EC-175 E-AST-03 GWG limit by acquisition date: 900 € on the JStG validFrom with the row activated", () => {
    const at = (date: string, overrides = jstg) =>
      validateAssetSetup({
        acquisitionDate: d(date),
        costCents: 90_000,
        method: "gwg",
        assetClass: "movable",
        thresholdOverrides: overrides,
      });
    expect(at("2027-01-01").ok).toBe(true);
    const before = at("2026-12-31");
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.error.code).toBe("E-AST-03");
      expect(before.error.message).toBe(
        "GWG-Grenze am 31.12.2026: 800 € netto. Dieses Wirtschaftsgut muss aktiviert werden.",
      );
    }
    // The shipped (disabled) state: 2027 still uses 800 €.
    expect(at("2027-01-01", []).ok).toBe(false);
  });

  test("AST-003 E-AST-05 Sammelposten not offered after abolition (JStG row active)", () => {
    const r = validateAssetSetup({
      acquisitionDate: d("2027-02-01"),
      costCents: 50_000,
      method: "pool",
      assetClass: "movable",
      thresholdOverrides: jstg,
    });
    expect(!r.ok && r.error.message).toBe("Sammelposten ist für Anschaffungen ab 01.01.2027 nicht mehr zulässig.");
    const opts = allowedMethods({
      acquisitionDate: d("2027-02-01"),
      costCents: 50_000,
      assetClass: "movable",
      thresholdOverrides: jstg,
    });
    expect(opts.find((o) => o.method === "pool")?.allowed).toBe(false);
  });

  test("AST-003 E-AST-11 useful life required for linear", () => {
    const r = validateAssetSetup({
      acquisitionDate: d("2026-03-01"),
      costCents: 500_000,
      method: "linear",
      assetClass: "movable",
    });
    expect(!r.ok && r.error.message).toBe("Bitte Nutzungsdauer angeben (AfA-Tabelle).");
  });

  test("AST-006 E-AST-15 e-vehicle special AfA needs the qualifying confirmation", () => {
    const base = {
      acquisitionDate: d("2026-02-01"),
      costCents: 5_000_000,
      method: "ev_special" as const,
      assetClass: "movable" as const,
    };
    const r = validateAssetSetup(base);
    expect(!r.ok && r.error.message).toBe("Die Sonder-AfA gilt nur für neue, rein elektrische Fahrzeuge.");
    const ok = validateAssetSetup({ ...base, evQualified: true });
    expect(ok.ok && ok.value.evScheduleBp).toEqual([7500, 1000, 500, 500, 300, 200]);
  });

  test("AST-008 TST-AST-05 E-AST-04 year choice Sammelposten 2026 blocks a GWG for a 600 € item in 2026", () => {
    const r = validateAssetSetup({
      acquisitionDate: d("2026-05-01"),
      costCents: 60_000,
      method: "gwg",
      assetClass: "movable",
      yearPolicy: "pool",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("E-AST-04");
      expect(r.error.message).toBe(
        "Für 2026 wurde bereits Sammelposten gewählt. Die Wahl gilt einheitlich für alle Wirtschaftsgüter von 250,01 € bis 1.000 €.",
      );
    }
    const pool = validateAssetSetup({
      acquisitionDate: d("2026-05-01"),
      costCents: 60_000,
      method: "pool",
      assetClass: "movable",
      yearPolicy: "gwg",
    });
    expect(!pool.ok && pool.error.code).toBe("E-AST-04");
    // Items outside 250,01–1.000 € are not affected by the yearly choice; the decision reports the implied choice.
    const small = validateAssetSetup({
      acquisitionDate: d("2026-05-01"),
      costCents: 20_000,
      method: "gwg",
      assetClass: "movable",
      yearPolicy: "pool",
    });
    expect(small.ok && small.value.yearChoice).toBe(null);
    const first = validateAssetSetup({
      acquisitionDate: d("2026-05-01"),
      costCents: 90_000,
      method: "pool",
      assetClass: "movable",
    });
    expect(first.ok && first.value.yearChoice).toBe("pool");
  });

  test("AST-001 asset class and AfA role from the account (SKR03/SKR04)", () => {
    expect(assetClassOf("SKR03", "0420")).toBe("movable");
    expect(assetClassOf("SKR03", "0027")).toBe("intangible");
    expect(assetClassOf("SKR03", "0090")).toBe("immovable");
    expect(assetClassOf("SKR04", "0520")).toBe("movable");
    expect(assetClassOf("SKR04", "0135")).toBe("intangible");
    expect(assetClassOf("SKR03", "1200")).toBe(null);
    expect(afaRoleFor("linear", "SKR03", "0320")).toBe("afa.vehicle");
    expect(afaRoleFor("linear", "SKR04", "0135")).toBe("afa.intangible");
    expect(afaRoleFor("degressive", "SKR03", "0420")).toBe("afa.tangible");
    expect(afaRoleFor("gwg", "SKR03", "0480")).toBe("afa.gwg");
    expect(afaRoleFor("pool", "SKR04", "0675")).toBe("afa.pool");
  });
});

describe("AST-004…AST-008 depreciation schedules", () => {
  test("AST-004 linear monthly pro rata, the last month absorbs the remainder", () => {
    const plan = planOf({
      acquisitionDate: d("2026-03-20"),
      costCents: 100_000,
      method: "linear",
      usefulLifeMonths: 36,
    });
    expect(plan).toHaveLength(36);
    expect(plan[0]).toMatchObject({ period: "2026-03", amountCents: 2778 });
    expect(plan.at(-1)?.period).toBe("2029-02");
    expect(plan.reduce((s, r) => s + r.amountCents, 0)).toBe(100_000);
    expect(plan.at(-1)?.amountCents).toBe(100_000 - 2778 * 35);
    expect(plan.at(-1)?.bookValueAfterCents).toBe(0);
  });

  test("AST-004 Erinnerungswert 1 € (configurable, default off)", () => {
    const plan = planOf({
      acquisitionDate: d("2026-01-01"),
      costCents: 120_000,
      method: "linear",
      usefulLifeMonths: 12,
      erinnerungswert: true,
    });
    expect(plan.reduce((s, r) => s + r.amountCents, 0)).toBe(119_900);
    expect(plan.at(-1)?.bookValueAfterCents).toBe(100);
  });

  test("AST-005 TST-AST-01 machine 10,000 € acquired 2025-08-15, 10 years, degressive → year 1 = 1,250.00 €", () => {
    const plan = planOf({
      acquisitionDate: d("2025-08-15"),
      costCents: 1_000_000,
      method: "degressive",
      usefulLifeMonths: 120,
      degressiveRateBp: 3000,
    });
    expect(sumYear(plan, 2025)).toBe(125_000);
    expect(plan[0]).toMatchObject({ period: "2025-08", amountCents: 25_000 });
    // 2026: 30 % of 8,750 €
    expect(sumYear(plan, 2026)).toBe(262_500);
    expect(plan.reduce((s, r) => s + r.amountCents, 0)).toBe(1_000_000);
  });

  test("AST-005 TST-AST-02 switch to linear in the first year where linear ≥ degressive", () => {
    const plan = planOf({
      acquisitionDate: d("2026-01-01"),
      costCents: 1_000_000,
      method: "degressive",
      usefulLifeMonths: 120,
      degressiveRateBp: 3000,
    });
    const years = Array.from({ length: 10 }, (_, i) => sumYear(plan, 2026 + i));
    // degressive 3,000 · 2,100 · 1,470 · 1,029 · 720.30 · 504.21 · 352.95 €; in 2033 linear (823.54 / 3) wins.
    expect(years.slice(0, 3)).toEqual([300_000, 210_000, 147_000]);
    const switchYear = plan.find((r) => r.switchedToLinear)?.period.slice(0, 4);
    expect(switchYear).toBeDefined();
    const idx = Number(switchYear) - 2026;
    // From the switch on, the yearly amounts are equal (remaining book value / remaining life), last one absorbs.
    const linear = years.slice(idx);
    expect(Math.max(...linear) - Math.min(...linear)).toBeLessThanOrEqual(1);
    // In the switch year linear ≥ degressive, one year before it was not.
    const bvBefore = 1_000_000 - years.slice(0, idx).reduce((s, x) => s + x, 0);
    expect(Math.round(bvBefore / (10 - idx))).toBeGreaterThanOrEqual(Math.round(bvBefore * 0.3));
    expect(years.reduce((s, x) => s + x, 0)).toBe(1_000_000);
  });

  test("AST-006 TST-AST-10 e-vehicle 50,000 € acquired 2026-02-01 → 37,500 € in 2026, then 10/5/5/3/2 %", () => {
    const plan = planOf({
      acquisitionDate: d("2026-02-01"),
      costCents: 5_000_000,
      method: "ev_special",
      evScheduleBp: [7500, 1000, 500, 500, 300, 200],
    });
    expect([2026, 2027, 2028, 2029, 2030, 2031].map((y) => sumYear(plan, y))).toEqual([
      3_750_000, 500_000, 250_000, 250_000, 150_000, 100_000,
    ]);
    expect(plan[0]?.period).toBe("2026-02");
  });

  test("AST-007 TST-AST-03 laptop 799 € net on 2026-03-01: GWG written off in 03/2026 and listed", () => {
    const plan = planOf({ acquisitionDate: d("2026-03-01"), costCents: 79_900, method: "gwg" });
    expect(plan).toEqual([{ period: "2026-03", amountCents: 79_900, bookValueAfterCents: 0, fiscalYear: 2026 }]);
    const list = gwgList(
      [
        {
          id: "a1",
          inventoryNumber: "AV-00001",
          name: "Laptop",
          acquisitionDate: "2026-03-01",
          costCents: 79_900,
          method: "gwg",
          voucherNumber: "BE-2026-00007",
        },
        {
          id: "a2",
          inventoryNumber: "AV-00002",
          name: "Maus",
          acquisitionDate: "2026-03-02",
          costCents: 2_900,
          method: "gwg",
        },
        {
          id: "a3",
          inventoryNumber: "AV-00003",
          name: "Monitor",
          acquisitionDate: "2025-12-02",
          costCents: 30_000,
          method: "gwg",
        },
      ],
      { from: "2026-01-01", to: "2026-12-31" },
    );
    expect(list.map((r) => r.inventoryNumber)).toEqual(["AV-00001"]);
    expect(list[0]?.voucherNumber).toBe("BE-2026-00007");
  });

  test("AST-008 TST-AST-06 E-AST-07 pool 2026 with 3 items 3,000 € → 600 € per year 2026–2030; disposal changes nothing", () => {
    const items = [100_000, 90_000, 110_000].map((c, i) => ({
      id: `p${i}`,
      plan: planOf({ acquisitionDate: d("2026-04-10"), costCents: c, method: "pool" }),
      costCents: c,
    }));
    for (const it of items)
      expect(it.plan.map((r) => r.period)).toEqual(["2026-12", "2027-12", "2028-12", "2029-12", "2030-12"]);
    const perYear = [2026, 2027, 2028, 2029, 2030].map((y) => items.reduce((s, it) => s + sumYear(it.plan, y), 0));
    expect(perYear).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    const disp = planDisposal({
      method: "pool",
      costCents: 100_000,
      plan: items[0]?.plan ?? [],
      postedPeriods: ["2026-12"],
      disposal: { date: d("2027-05-01"), kind: "sale", proceedsNetCents: 50_000 },
    });
    expect(disp.ok && disp.value.kind).toBe("pool_unchanged");
    expect(disp.ok && disp.value.kind === "pool_unchanged" && disp.value.info).toBe(
      "Der Sammelposten wird unverändert fortgeführt (§ 6 Abs. 2a EStG).",
    );
    const summary = poolSummary(
      items.map((it, i) => ({
        id: it.id,
        poolYear: 2026,
        costCents: it.costCents,
        inventoryNumber: `AV-${i}`,
        name: "x",
      })),
      2027,
    );
    expect(summary).toEqual([
      expect.objectContaining({ poolYear: 2026, costCents: 300_000, afaYearCents: 60_000, bookValueEndCents: 180_000 }),
    ]);
  });

  test("AST-004 sumThrough sums the plan up to and including a month", () => {
    const plan = planOf({
      acquisitionDate: d("2026-01-10"),
      costCents: 360_000,
      method: "linear",
      usefulLifeMonths: 36,
    });
    expect(sumThrough(plan, "2026-06")).toBe(60_000);
  });
});

describe("AST-010 disposal (EC-176)", () => {
  const plan = planOf({ acquisitionDate: d("2026-01-10"), costCents: 360_000, method: "linear", usefulLifeMonths: 36 });

  test("AST-010 TST-AST-07 EC-176 E-AST-06 linear 3,600 € sold 2026-06-15 for 3,000 €: AfA Jan–Jun 600 €, RBW 3,000 €, no gain", () => {
    const r = planDisposal({
      method: "linear",
      costCents: 360_000,
      plan,
      postedPeriods: ["2026-01", "2026-02", "2026-03"],
      disposal: { date: d("2026-06-15"), kind: "sale", proceedsNetCents: 300_000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== "rbw") return;
    expect(r.value.catchUp.map((x) => x.period)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(r.value.catchUp.reduce((s, x) => s + x.amountCents, 0)).toBe(30_000);
    expect(r.value.afaThroughDisposalCents).toBe(60_000);
    expect(r.value.rbwCents).toBe(300_000);
    expect(r.value.result).toEqual({ gainCents: 0, lossCents: 0, kind: "loss" });
  });

  test("AST-010 E-AST-08 disposal date before the last posted AfA period is blocked", () => {
    const r = planDisposal({
      method: "linear",
      costCents: 360_000,
      plan,
      postedPeriods: ["2026-01", "2026-02", "2026-03", "2026-04"],
      disposal: { date: d("2026-03-15"), kind: "scrap" },
    });
    expect(!r.ok && r.error.message).toBe("Abgangsdatum liegt vor der letzten gebuchten AfA (04/2026).");
  });

  test("AST-010 sale above the book value is a gain; scrap is a loss of the RBW", () => {
    const sale = planDisposal({
      method: "linear",
      costCents: 360_000,
      plan,
      postedPeriods: [],
      disposal: { date: d("2026-06-30"), kind: "sale", proceedsNetCents: 350_000 },
    });
    expect(sale.ok && sale.value.kind === "rbw" && sale.value.result).toEqual({
      gainCents: 50_000,
      lossCents: 0,
      kind: "gain",
    });
    const scrap = planDisposal({
      method: "linear",
      costCents: 360_000,
      plan,
      postedPeriods: [],
      disposal: { date: d("2026-06-30"), kind: "scrap" },
    });
    expect(scrap.ok && scrap.value.kind === "rbw" && scrap.value.result).toEqual({
      gainCents: 0,
      lossCents: 300_000,
      kind: "loss",
    });
  });

  test("AST-010 a sale needs the net proceeds", () => {
    const r = planDisposal({
      method: "linear",
      costCents: 360_000,
      plan,
      postedPeriods: [],
      disposal: { date: d("2026-06-30"), kind: "sale" },
    });
    expect(r.ok).toBe(false);
  });
});

describe("AST-012 Anlagenspiegel", () => {
  test("AST-012 TST-AST-11 columns reconcile (AK 01.01. + Zugänge − Abgänge; Buchwert 31.12.)", () => {
    const rows = anlagenspiegel(
      [
        // held from 2025, depreciating
        {
          id: "a",
          inventoryNumber: "AV-1",
          name: "Maschine",
          account: "0420",
          acquisitionDate: "2025-08-15",
          costCents: 1_000_000,
          method: "degressive",
        },
        // bought and sold in 2026
        {
          id: "b",
          inventoryNumber: "AV-2",
          name: "Notebook",
          account: "0420",
          acquisitionDate: "2026-01-10",
          costCents: 360_000,
          method: "linear",
          disposal: { date: "2026-06-15", kind: "sale" },
        },
        // GWG of 2026 (Zugang and Abgang in the same year)
        {
          id: "c",
          inventoryNumber: "AV-3",
          name: "Laptop",
          account: "0480",
          acquisitionDate: "2026-03-01",
          costCents: 79_900,
          method: "gwg",
        },
        // disposed in 2025 — not in 2026
        {
          id: "d",
          inventoryNumber: "AV-4",
          name: "Alt",
          account: "0420",
          acquisitionDate: "2024-01-01",
          costCents: 50_000,
          method: "linear",
          disposal: { date: "2025-03-01", kind: "scrap" },
        },
      ],
      {
        a: [
          { date: "2025-12-31", kind: "afa", amountCents: 125_000 },
          { date: "2026-12-31", kind: "afa", amountCents: 262_500 },
        ],
        b: [
          { date: "2026-06-30", kind: "afa", amountCents: 60_000 },
          { date: "2026-06-30", kind: "rbw", amountCents: 300_000 },
        ],
        c: [{ date: "2026-03-31", kind: "afa", amountCents: 79_900 }],
      },
      { from: "2026-01-01", to: "2026-12-31" },
    );
    const a = rows.assets.find((r) => r.id === "a");
    expect(a).toMatchObject({
      akStartCents: 1_000_000,
      additionsCents: 0,
      disposalsCents: 0,
      afaYearCents: 262_500,
      accumulatedEndCents: 387_500,
      bookValueStartCents: 875_000,
      bookValueEndCents: 612_500,
    });
    const b = rows.assets.find((r) => r.id === "b");
    expect(b).toMatchObject({
      additionsCents: 360_000,
      disposalsCents: 360_000,
      afaYearCents: 60_000,
      bookValueEndCents: 0,
    });
    const c = rows.assets.find((r) => r.id === "c");
    expect(c).toMatchObject({
      additionsCents: 79_900,
      disposalsCents: 79_900,
      afaYearCents: 79_900,
      bookValueEndCents: 0,
    });
    expect(rows.assets.find((r) => r.id === "d")).toBeUndefined();
    const t = rows.total;
    expect(t.akStartCents + t.additionsCents - t.disposalsCents).toBe(t.akEndCents);
    expect(t.akEndCents - t.accumulatedEndCents).toBe(t.bookValueEndCents);
    expect(t.bookValueStartCents + t.additionsCents - t.afaYearCents - t.rbwYearCents).toBe(t.bookValueEndCents);
    expect(t.bookValueEndCents).toBe(612_500);
    expect(rows.groups.map((g) => g.account)).toEqual(["0420", "0480"]);
  });
});

describe("AST-002 assets from voucher lines", () => {
  test("AST-002 one asset per item, cost split with the remainder on the first items; GWG/pool on their accounts", () => {
    const drafts = assetDraftsFromVoucher(
      [
        {
          index: 0,
          account: "0420",
          description: "Bürostuhl",
          quantityMilli: 3000,
          baseCents: 100_000,
          assetDecision: "gwg",
        },
        { index: 1, account: "0420", description: "Schreibtisch", baseCents: 150_000, assetDecision: "asset" },
        { index: 2, account: "4930", description: "Papier", baseCents: 2_000 },
        { index: 3, account: "0420", baseCents: 60_000, assetDecision: "pool" },
      ],
      "Anlage aus Beleg BE-2026-00001",
      { gwg: "0480", pool: "0485" },
    );
    expect(drafts.map((x) => [x.name, x.account, x.costCents, x.method, x.setupRequired])).toEqual([
      ["Bürostuhl (1/3)", "0480", 33_334, "gwg", false],
      ["Bürostuhl (2/3)", "0480", 33_333, "gwg", false],
      ["Bürostuhl (3/3)", "0480", 33_333, "gwg", false],
      ["Schreibtisch", "0420", 150_000, "linear", true],
      ["Anlage aus Beleg BE-2026-00001", "0485", 60_000, "pool", false],
    ]);
  });

  test("AST-002 E-AST-12 cost = net with deducted input VAT, gross for a Kleinunternehmer, minus a private share", () => {
    const line = { netCents: 100_000, vatCents: 19_000 };
    expect(voucherLineBaseCents(line, "input_vat_deductible", false)).toBe(100_000);
    expect(voucherLineBaseCents(line, "input_vat_deductible", true)).toBe(119_000);
    expect(voucherLineBaseCents({ netCents: 100_000, vatCents: 0 }, "reverse_charge_eu", true)).toBe(100_000);
    expect(voucherLineBaseCents({ ...line, nonDeductibleShareBp: 2000 }, "input_vat_deductible", false)).toBe(80_000);
    expect(voucherInputVatDeducted("input_vat_deductible", false)).toBe(true);
    expect(voucherInputVatDeducted("input_vat_deductible", true)).toBe(false);
  });

  test("AST-013 depreciation table per asset (planned vs posted) and the AfA forecast of a year", () => {
    const linear = planOf({
      acquisitionDate: d("2026-01-10"),
      costCents: 360_000,
      method: "linear",
      usefulLifeMonths: 36,
    });
    const gwg = planOf({ acquisitionDate: d("2026-11-03"), costCents: 79_900, method: "gwg" });
    const table = depreciationTable(linear, new Set(["2026-01", "2026-02", "2026-03"]));
    expect(table.slice(0, 4).map((r) => [r.period, r.amountCents, r.status])).toEqual([
      ["2026-01", 10_000, "posted"],
      ["2026-02", 10_000, "posted"],
      ["2026-03", 10_000, "posted"],
      ["2026-04", 10_000, "planned"],
    ]);
    expect(table.at(-1)).toMatchObject({ period: "2028-12", bookValueAfterCents: 0, status: "planned" });
    const f = afaForecast(
      [
        { plan: linear, postedPeriods: new Set(["2026-01", "2026-02", "2026-03"]) },
        { plan: gwg, postedPeriods: new Set() },
      ],
      2026,
    );
    expect(f).toEqual({
      year: 2026,
      postedCents: 30_000,
      plannedYearCents: 120_000 + 79_900,
      remainingCents: 90_000 + 79_900,
      byMonth: expect.arrayContaining([
        { period: "2026-11", cents: 10_000 + 79_900 },
        { period: "2026-12", cents: 10_000 },
      ]),
    });
    expect(f.byMonth).toHaveLength(12);
  });

  test("AST-007 E-AST-16 an item ≤ 250 € net may be registered: allowed, expensed in full in its month, not in the GWG list", () => {
    const setup = validateAssetSetup({
      acquisitionDate: d("2026-05-12"),
      costCents: 19_900,
      method: "gwg",
      assetClass: "movable",
    });
    expect(setup.ok).toBe(true);
    const plan = planOf({ acquisitionDate: d("2026-05-12"), costCents: 19_900, method: "gwg" });
    expect(plan).toEqual([{ period: "2026-05", amountCents: 19_900, bookValueAfterCents: 0, fiscalYear: 2026 }]);
    const list = gwgList(
      [
        {
          id: "a1",
          inventoryNumber: "AV-00009",
          name: "Tastatur",
          acquisitionDate: "2026-05-12",
          costCents: 19_900,
          method: "gwg",
        },
      ],
      { from: "2026-01-01", to: "2026-12-31" },
    );
    expect(list).toEqual([]);
  });
});
