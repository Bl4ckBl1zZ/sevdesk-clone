import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { largestRemainder, splitDifferenceByVat, vatInGross } from "./split";

const S = (rateBp: number, grossCents: number) => ({ category: "S" as const, rateBp, grossCents });

describe("difference VAT split (PAY-021, UST-32)", () => {
  test("T05-030 PAY-021 golden S1: 4,52 € Skonto on 119,00 @19 % + 107,00 @7 % → 2,38 (2,00 + 0,38) / 2,14 (2,00 + 0,14)", () => {
    expect(splitDifferenceByVat(452, [S(1900, 11900), S(700, 10700)])).toEqual([
      { rateBp: 1900, netCents: 200, vatCents: 38 },
      { rateBp: 700, netCents: 200, vatCents: 14 },
    ]);
  });

  test("T05-031 PAY-021 golden S2: 2,00 € Skonto on a 19 % invoice → VAT 0,32, net 1,68", () => {
    expect(splitDifferenceByVat(200, [S(1900, 10000)])).toEqual([{ rateBp: 1900, netCents: 168, vatCents: 32 }]);
    expect(vatInGross(200, 1900)).toBe(32);
  });

  test("T05-032 EC-PAY-13 golden S6: 5,48 € over 119,00 / 53,50 / 10,00 → 3,57 / 1,61 / 0,30 (largest fractional part gets the cent)", () => {
    const r = splitDifferenceByVat(548, [S(1900, 11900), S(700, 5350), { category: "E", rateBp: 0, grossCents: 1000 }]);
    expect(r.map((x) => x.netCents + x.vatCents)).toEqual([357, 161, 30]);
    expect(r[2]).toEqual({ rateBp: 0, netCents: 30, vatCents: 0 });
  });

  test("T05-036 EC-PAY-12 price reduction on a KU or reverse-charge document → no VAT correction", () => {
    expect(splitDifferenceByVat(1000, [{ category: "KU", rateBp: 0, grossCents: 50000 }])).toEqual([
      { rateBp: 0, netCents: 1000, vatCents: 0 },
    ]);
    expect(splitDifferenceByVat(1000, [{ category: "AE", rateBp: 0, grossCents: 50000 }])).toEqual([
      { rateBp: 0, netCents: 1000, vatCents: 0 },
    ]);
  });

  test("EC-PAY-13 groups with the same rate are merged; zero groups are dropped", () => {
    expect(splitDifferenceByVat(100, [S(1900, 5000), S(1900, 5000), S(700, 0)])).toEqual([
      { rateBp: 1900, netCents: 84, vatCents: 16 },
    ]);
    expect(splitDifferenceByVat(0, [S(1900, 5000)])).toEqual([]);
  });

  test("T05-032 RI-09 property: Σ group gross == difference and net + vat == gross per group", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(1900, 700, 0), fc.integer({ min: 1, max: 5_000_000 })), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (groups, diff) => {
          const input = groups.map(([rate, gross]) => ({
            category: rate === 0 ? ("E" as const) : ("S" as const),
            rateBp: rate,
            grossCents: gross,
          }));
          const r = splitDifferenceByVat(diff, input);
          expect(r.reduce((s, x) => s + x.netCents + x.vatCents, 0)).toBe(diff);
          for (const x of r) {
            expect(x.vatCents).toBe(vatInGross(x.netCents + x.vatCents, x.rateBp));
            if (x.rateBp === 0) expect(x.vatCents).toBe(0);
          }
        },
      ),
    );
  });

  test("largest remainder: exact sum, ties to the larger weight, negative totals mirror, zero weights", () => {
    expect(largestRemainder(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(largestRemainder(-548, [11900, 5350, 1000])).toEqual([-357, -161, -30]);
    expect(largestRemainder(5, [0, 0])).toEqual([5, 0]);
    expect(largestRemainder(7, [])).toEqual([]);
    expect(largestRemainder(2, [1, 3])).toEqual([0, 2]);
  });
});
