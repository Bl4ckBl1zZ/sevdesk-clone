import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { cumulativeShares, shareOfSettlement } from "./pro-rata";

describe("Ist VAT shares of partial payments (UVA-06)", () => {
  test("TST-ACC-13 E-TAX-02 1,190 € invoice paid 595 € + 595 €: 95 € VAT each", () => {
    expect(shareOfSettlement([19000], 119000, 0, 59500)).toEqual([9500]);
    expect(shareOfSettlement([19000], 119000, 59500, 59500)).toEqual([9500]);
  });

  test("TST-ACC-14 E-TAX-03 EC-172 19 % 1,000 € + 7 % 500 € paid in random instalments: Σ VAT per rate exact", () => {
    const totals = [19000, 3500];
    const payable = 100000 + 19000 + 50000 + 3500;
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: payable }), { minLength: 1, maxLength: 6 }), (cuts) => {
        const points = [...new Set([0, ...cuts.map((c) => Math.min(c, payable)), payable])].sort((a, b) => a - b);
        const sums = [0, 0];
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1] ?? 0;
          const share = shareOfSettlement(totals, payable, prev, (points[i] ?? 0) - prev);
          sums[0] = (sums[0] ?? 0) + (share[0] ?? 0);
          sums[1] = (sums[1] ?? 0) + (share[1] ?? 0);
        }
        expect(sums).toEqual(totals);
      }),
    );
  });

  test("UVA-06 shares are cumulative and clamp to the payable; zero payable yields zero", () => {
    expect(cumulativeShares([19000, 3500], 172500, 172500)).toEqual([19000, 3500]);
    expect(cumulativeShares([19000, 3500], 172500, 999999)).toEqual([19000, 3500]);
    expect(cumulativeShares([19000], 119000, -5)).toEqual([0]);
    expect(cumulativeShares([], 100, 50)).toEqual([]);
    expect(cumulativeShares([100], 0, 50)).toEqual([0]);
  });
});
