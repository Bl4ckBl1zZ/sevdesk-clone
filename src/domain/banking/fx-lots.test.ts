import { describe, expect, test } from "vitest";
import { FX_MESSAGES, outflowCost, pocketBasis, realisedFx } from "./fx-lots";

describe("BNK-028 moving-average EUR cost of a currency pocket (F08 R1/R2, EC-144)", () => {
  test("EC-BNK-26 T07-032 §4.5 (a) EUR→USD: lot cost = EUR side (920,00 for 1.000,00 USD), no FX result at purchase", () => {
    const basis = pocketBasis([{ eurCents: 92_000, fxMinor: 100_000 }]);
    expect(basis).toEqual({ eurCents: 92_000, fxMinor: 100_000, complete: true });
  });

  test("EC-BNK-26 T07-032 §4.5 (b) USD→EUR: 500 USD at the average 0,92 = 460,00; 465,00 received → FX gain 5,00", () => {
    const basis = pocketBasis([{ eurCents: 92_000, fxMinor: 100_000 }]);
    const cost = outflowCost(basis, 50_000);
    expect(cost).toEqual({ ok: true, value: 46_000 });
    expect(realisedFx(46_500, 46_000)).toBe(500);
    // A worse rate is a loss.
    expect(realisedFx(45_000, 46_000)).toBe(-1_000);
  });

  test("BNK-028 the average moves with each inflow; outflows lower EUR and USD proportionally", () => {
    const basis = pocketBasis([
      { eurCents: 92_000, fxMinor: 100_000 }, // 0,92
      { eurCents: 47_000, fxMinor: 50_000 }, // 0,94 → average 139.000 / 150.000
      { eurCents: -46_333, fxMinor: -50_000 }, // earlier outflow at the then average
    ]);
    expect(basis).toEqual({ eurCents: 92_667, fxMinor: 100_000, complete: true });
    expect(outflowCost(basis, 33_333)).toEqual({ ok: true, value: 30_889 }); // 33.333 × 0,92667 = 30.888,69 → half-up
  });

  test("E-ACC-26 the outflow that empties the pocket takes the whole remaining basis (rounding stays in FX result)", () => {
    // 3 × 1/3: 100,00 € for 300 units → the last unit takes the residue.
    const basis = pocketBasis([{ eurCents: 10_000, fxMinor: 300 }]);
    const first = outflowCost(basis, 100);
    expect(first).toEqual({ ok: true, value: 3_333 });
    const rest = pocketBasis([
      { eurCents: 10_000, fxMinor: 300 },
      { eurCents: -3_333, fxMinor: -100 },
      { eurCents: -3_333, fxMinor: -100 },
    ]);
    expect(outflowCost(rest, 100)).toEqual({ ok: true, value: 3_334 });
  });

  test("EC-BNK-69 BNK-028 without a complete EUR basis nothing is valued (no guessed rate)", () => {
    const basis = pocketBasis([{ eurCents: 50_000 }, { eurCents: 92_000, fxMinor: 100_000 }]);
    expect(basis.complete).toBe(false);
    expect(outflowCost(basis, 10_000)).toMatchObject({ ok: false, error: { message: FX_MESSAGES.incomplete } });
    expect(outflowCost(pocketBasis([{ eurCents: 92_000, fxMinor: 100_000 }]), 100_001)).toMatchObject({
      ok: false,
      error: { message: FX_MESSAGES.exceeds },
    });
  });
});
