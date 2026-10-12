import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { allocate, allocateExact } from "./allocate";
import { fcToEurCents, grossToNetMicros, netToGrossMicros, parseFxRate } from "./convert";
import { lineAmountCents, lineAmountExact } from "./line";
import { roundHalfAway } from "./rounding";
import { largestNetThatFits, vatCents, vatExact } from "./vat";

const rateArb = fc.constantFrom(0, 500, 700, 1600, 1900, 1000, 2500, 10_000);

describe("line amounts (F04 App. E.1/E.2)", () => {
  test("DOC-09 line net = round_half_away(qtyMilli × unitMicros / 10^5) — golden 1 × 10,005 → 10,01", () => {
    expect(lineAmountCents(1000, 100_050)).toBe(1001);
    expect(lineAmountCents(10_000, 1_000_000)).toBe(100_000); // 10 h × 100,00
    expect(lineAmountCents(3000, 199_900)).toBe(5997); // 3 × 19,99
    expect(lineAmountCents(1, 1)).toBe(0); // 0.001 × 0.0001
    expect(lineAmountCents(-1000, 100_050)).toBe(-1001);
    expect(lineAmountCents(0, 100_050)).toBe(0);
  });

  test("DOC-07 line discounts: percent of the exact base, or an amount in cents", () => {
    // 3 × 33,3333 = 99,9999 − 10 % = 89,99991 → 90,00
    expect(lineAmountCents(3000, 333_333, { kind: "percent", bp: 1000 })).toBe(9000);
    // 1 × 100,00 − 2,5 % = 97,50
    expect(lineAmountCents(1000, 1_000_000, { kind: "percent", bp: 250 })).toBe(9750);
    // 100 % discount → 0
    expect(lineAmountCents(1000, 1_000_000, { kind: "percent", bp: 10_000 })).toBe(0);
    // amount discount: 2 × 10,005 = 20,01 − 1,00 = 19,01
    expect(lineAmountCents(2000, 100_050, { kind: "amount", cents: 100 })).toBe(1901);
  });

  test("EC-050 a 0-€ line computes to 0 cents", () => {
    expect(lineAmountCents(5000, 0)).toBe(0);
  });

  test("GOBD-03 a line beyond 99.999.999.999,99 is refused, BigInt keeps the exact value", () => {
    expect(lineAmountExact(999_999_999_999, 999_999_999_999)).toBe(roundHalfAway(999_999_999_999n ** 2n, 100_000n));
    expect(() => lineAmountCents(999_999_999_999, 999_999_999_999)).toThrow(/amount_too_large/);
  });
});

describe("VAT per group (BR-CO-17, RI-05)", () => {
  test("UST-10 VAT = round_half_away(base × rate) — golden 30,03 @ 19 % → 5,71", () => {
    expect(vatCents(3003, 1900)).toBe(571);
    expect(vatCents(100_000, 1900)).toBe(19_000);
    expect(vatCents(50_000, 700)).toBe(3500);
    expect(vatCents(93_333, 1900)).toBe(17_733);
    expect(vatCents(46_667, 700)).toBe(3267);
    expect(vatCents(-3003, 1900)).toBe(-571);
    expect(vatCents(12_345, 0)).toBe(0);
  });

  test("RI-05 VAT equals round(net × rate) for every base and rate", () => {
    fc.assert(
      fc.property(fc.integer({ min: -9_999_999_999_999, max: 9_999_999_999_999 }), rateArb, (base, rate) => {
        const v = vatExact(BigInt(base), rate);
        expect(v).toBe(roundHalfAway(BigInt(base) * BigInt(rate), 10_000n));
      }),
    );
  });
});

describe("gross mode: largest net that fits (F04 App. E.3, EC-053)", () => {
  test("EC-053 6,29 € @ 19 % is unreachable → net 5,28 + VAT 1,00 = 6,28 € with a 1-cent deviation", () => {
    expect(largestNetThatFits(629n, 1900)).toEqual({ net: 528n, vat: 100n, deviation: 1n });
  });

  test("DOC-10 reachable gross values convert exactly (108,97 @ 19 % → 91,57 / 17,40; 21,40 @ 7 % → 20,00 / 1,40)", () => {
    expect(largestNetThatFits(10_897n, 1900)).toEqual({ net: 9157n, vat: 1740n, deviation: 0n });
    expect(largestNetThatFits(2140n, 700)).toEqual({ net: 2000n, vat: 140n, deviation: 0n });
    expect(largestNetThatFits(4711n, 1900)).toEqual({ net: 3959n, vat: 752n, deviation: 0n }); // T-DOC-038 47,11 €
    expect(largestNetThatFits(0n, 1900)).toEqual({ net: 0n, vat: 0n, deviation: 0n });
    expect(largestNetThatFits(500n, 0)).toEqual({ net: 500n, vat: 0n, deviation: 0n });
    expect(largestNetThatFits(-629n, 1900)).toEqual({ net: -528n, vat: -100n, deviation: -1n });
  });

  test("EC-053 N is the largest net with N + round(N × r) ≤ G; VAT is never adjusted; deviation is 0 or 1 cent", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 9_999_999_999_999n }), rateArb, (g, rate) => {
        const { net, vat, deviation } = largestNetThatFits(g, rate);
        expect(vat).toBe(vatExact(net, rate));
        expect(net + vat).toBeLessThanOrEqual(g);
        expect(net + 1n + vatExact(net + 1n, rate)).toBeGreaterThan(g);
        expect(deviation).toBe(g - net - vat);
        expect(deviation === 0n || deviation === 1n).toBe(true);
        const mirrored = largestNetThatFits(-g, rate);
        expect(mirrored).toEqual({ net: -net, vat: -vat, deviation: -deviation });
      }),
    );
  });
});

describe("allocation without losing cents (F04 App. E.1)", () => {
  test("EC-055 document discount 100,00 over groups 1.000,00 / 500,00 → 66,67 / 33,33 (residual to the largest weight)", () => {
    expect(allocate(10_000, [100_000, 50_000])).toEqual([6667, 3333]);
    expect(allocate(9157, [5997, 4900])).toEqual([5040, 4117]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]); // tie → lowest position
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(5, [])).toEqual([]);
  });

  test("EC-055 zero-sum weights never lose the total (all to the largest absolute weight)", () => {
    expect(allocate(7, [0, 0])).toEqual([7, 0]);
    expect(allocate(7, [10, -10])).toEqual([7, 0]);
    expect(allocate(7, [-10, 20, -10])).toEqual([0, 7, 0]);
  });

  test("GOBD-03 allocation sums exactly to the total, stays within one residual of the exact share and mirrors", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 13n), max: 10n ** 13n }),
        fc.array(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const parts = allocateExact(total, weights);
          expect(parts.length).toBe(weights.length);
          expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
          expect(
            allocateExact(
              -total,
              weights.map((w) => -w),
            ),
          ).toEqual(parts.map((p) => -p));
          const sum = weights.reduce((a, b) => a + b, 0n);
          if (sum !== 0n && weights.every((w) => w >= 0n) && total >= 0n) {
            // every share is floor(total·w/Σw) except the largest weight, which also takes the residual (< n)
            weights.forEach((w, i) => {
              const exactFloor = (total * w) / sum;
              const part = parts[i] ?? 0n;
              expect(part >= exactFloor).toBe(true);
              expect(part - exactFloor < BigInt(weights.length)).toBe(true);
            });
          }
        },
      ),
    );
  });
});

describe("price-mode conversion and foreign currency", () => {
  test("PRD-011 net ⇄ gross unit prices convert at 4 decimals with half-away rounding (App. E.3 step 6)", () => {
    expect(grossToNetMicros(119_000, 1900)).toBe(100_000); // 11,90 → 10,00
    expect(grossToNetMicros(199_900, 1900)).toBe(167_983); // 19,99 / 1,19 = 16,79831…
    expect(netToGrossMicros(100_000, 1900)).toBe(119_000);
    expect(netToGrossMicros(167_983, 1900)).toBe(199_900); // 19,98998 → 19,9900
    expect(grossToNetMicros(-119_000, 1900)).toBe(-100_000);
    expect(grossToNetMicros(119_000, 0)).toBe(119_000);
  });

  test("MISC-08 VAT in EUR = round(VAT in foreign currency ÷ rate) — golden 190,00 USD @ 1.0831 → 175,42 EUR", () => {
    const rate = parseFxRate("1.0831");
    expect(rate.ok).toBe(true);
    if (!rate.ok) return;
    expect(fcToEurCents(19_000, rate.value)).toBe(17_542);
    expect(fcToEurCents(-19_000, rate.value)).toBe(-17_542);
    expect(fcToEurCents(100, rate.value)).toBe(92);
  });

  test("EC-DOC-52 FX rates are decimal strings with ≤ 6 decimals and > 0, never floats", () => {
    const code = (s: string) => {
      const r = parseFxRate(s);
      return r.ok ? null : r.error.code;
    };
    expect(code("1.083100")).toBeNull();
    expect(code("162")).toBeNull();
    expect(code("1.0831234")).toBe("fx_rate_invalid");
    expect(code("0")).toBe("fx_rate_invalid");
    expect(code("-1.2")).toBe("fx_rate_invalid");
    expect(code("1,0831")).toBe("fx_rate_invalid");
    expect(code("abc")).toBe("fx_rate_invalid");
    const r = parseFxRate("1.5");
    expect(r.ok && r.value).toEqual({ scaled: 1_500_000n, text: "1.5" });
  });
});
