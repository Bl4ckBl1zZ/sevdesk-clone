import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { canonicalize } from "./canonical";

describe("JCS canonical JSON (RFC 8785)", () => {
  test("AUD-004 RFC 8785 §3.2.3 sample input serialises to the published output", () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        ' "literals": [null, true, false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test("AUD-004 RFC 8785 §3.2.3 property sorting by UTF-16 code units", () => {
    const input = JSON.parse(
      '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh",' +
        ' "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control",' +
        ' "\\u00f6": "Latin Small Letter O With Diaeresis"}',
    );
    // Read the values from the string: JSON.parse would move the integer-like key "1" to the front.
    const values = [...canonicalize(input).matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });

  test.each([
    [0, "0"],
    [-0, "0"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [123456789012345680000, "123456789012345680000"],
    [-1.5, "-1.5"],
  ])("AUD-004 number %d serialises as %s", (n, s) => {
    expect(canonicalize(n)).toBe(s);
  });

  test("AUD-004 omits undefined members and rejects values without a JSON form", () => {
    expect(canonicalize({ b: 1, a: undefined, c: { z: [1, "x"], y: null } })).toBe(
      '{"b":1,"c":{"y":null,"z":[1,"x"]}}',
    );
    expect(() => canonicalize(Number.NaN)).toThrow("non-finite");
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow("$.a");
    expect(() => canonicalize([undefined])).toThrow("undefined");
    expect(() => canonicalize(undefined)).toThrow("unsupported");
    expect(() => canonicalize(10n)).toThrow("unsupported");
    expect(() => canonicalize(new Uint8Array(2))).toThrow("binary");
  });

  test("AUD-004 key order of the input never changes the output and parse ∘ canonicalize is stable", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const once = canonicalize(v);
        expect(canonicalize(JSON.parse(once))).toBe(once);
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const reversed = Object.fromEntries(Object.entries(v).reverse());
          expect(canonicalize(reversed)).toBe(once);
        }
      }),
    );
  });
});
