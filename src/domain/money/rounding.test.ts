import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { floorDiv, roundHalfAway } from "./rounding";

describe("EN 16931 rounding (F04 App. E.1)", () => {
  test("UST-10 roundHalfAway rounds .5 away from zero (kaufmännisch) and is symmetric", () => {
    expect(roundHalfAway(5n, 10n)).toBe(1n); // 0.5 → 1
    expect(roundHalfAway(-5n, 10n)).toBe(-1n); // −0.5 → −1
    expect(roundHalfAway(4n, 10n)).toBe(0n);
    expect(roundHalfAway(-4n, 10n)).toBe(0n);
    expect(roundHalfAway(15n, 10n)).toBe(2n);
    expect(roundHalfAway(25n, 10n)).toBe(3n); // not banker's rounding
    expect(roundHalfAway(57057n, 10000n)).toBe(6n);
    expect(roundHalfAway(5n, -10n)).toBe(-1n); // negative denominator
    expect(() => roundHalfAway(1n, 0n)).toThrow(/division_by_zero/);
  });

  test("UST-10 roundHalfAway agrees with an exact rational oracle and mirrors exactly", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (n, d) => {
          const r = roundHalfAway(n, d);
          // |n/d − r| ≤ 1/2, and exactly 1/2 only when r is further from zero
          const diff2 = 2n * (n - r * d); // 2·(n − r·d), compare with d
          expect(diff2 <= d && diff2 >= -d).toBe(true);
          if (diff2 === d || diff2 === -d) expect(r * n >= 0n).toBe(true);
          expect(roundHalfAway(-n, d)).toBe(-r);
        },
      ),
    );
  });

  test("DOC-09 floorDiv floors towards negative infinity", () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, -2n)).toBe(-4n);
    expect(floorDiv(-6n, 2n)).toBe(-3n);
    expect(() => floorDiv(1n, 0n)).toThrow(/division_by_zero/);
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt({ min: 1n, max: 10n ** 9n }), (n, d) => {
        const q = floorDiv(n, d);
        expect(q * d <= n && n < (q + 1n) * d).toBe(true);
      }),
    );
  });
});
