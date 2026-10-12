import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { largestNetThatFits, vatExact } from "../money/vat";
import { computeTotals, type DocumentTotals, type TotalsInput, type TotalsLineInput } from "./totals";

function totalsOf(input: TotalsInput): DocumentTotals {
  const r = computeTotals(input);
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  return r.value;
}

const item = (quantityMilli: number, unitPriceMicros: number, rateBp = 1900, extra: Partial<TotalsLineInput> = {}) =>
  ({ quantityMilli, unitPriceMicros, vatCategory: "S", rateBp, ...extra }) satisfies TotalsLineInput;

describe("document totals, net mode (F04 App. E.2)", () => {
  test("DOC-09 golden de-rounding-10005: 3 × 10,005 → 10,01 each, base 30,03, VAT 5,71, gross 35,74", () => {
    const t = totalsOf({ priceMode: "net", lines: [item(1000, 100_050), item(1000, 100_050), item(1000, 100_050)] });
    expect(t.lines.map((l) => l.netCents)).toEqual([1001, 1001, 1001]);
    expect(t.groups).toEqual([
      {
        vatCategory: "S",
        rateBp: 1900,
        lineNetSumCents: 3003,
        allowanceCents: 0,
        chargeCents: 0,
        baseCents: 3003,
        vatCents: 571,
      },
    ]);
    expect(t.lineNetSumCents).toBe(3003); // BT-106
    expect(t.taxExclusiveCents).toBe(3003); // BT-109
    expect(t.vatTotalCents).toBe(571); // BT-110
    expect(t.grossCents).toBe(3574); // BT-112
    expect(t.payableCents).toBe(3574); // BT-115
    expect(t.roundingCents).toBe(0); // BT-114 never used (F04 9.12)
    expect(t.warnings).toEqual([]);
  });

  test("UST-09 net amounts are broken down per rate — 1.000,00 @ 19 + 500,00 @ 7 → VAT 190,00 + 35,00", () => {
    const t = totalsOf({ priceMode: "net", lines: [item(1000, 10_000_000, 700), item(10_000, 1_000_000, 1900)] });
    expect(t.groups.map((g) => [g.vatCategory, g.rateBp, g.baseCents, g.vatCents])).toEqual([
      ["S", 1900, 100_000, 19_000],
      ["S", 700, 100_000, 7000],
    ]);
    expect(t.grossCents).toBe(226_000);
  });

  test("DOC-14 one VAT group per (category, rate), in a canonical order", () => {
    const t = totalsOf({
      priceMode: "net",
      lines: [
        item(1000, 1_000_000, 0, { vatCategory: "E" }),
        item(1000, 1_000_000, 700),
        item(1000, 1_000_000, 0, { vatCategory: "Z" }),
        item(1000, 1_000_000, 1900),
        item(1000, 1_000_000, 0, { vatCategory: "AE" }),
        item(1000, 2_000_000, 1900),
      ],
    });
    expect(t.groups.map((g) => `${g.vatCategory}/${g.rateBp}`)).toEqual(["S/1900", "S/700", "Z/0", "E/0", "AE/0"]);
    expect(t.groups[0]?.baseCents).toBe(30_000);
  });

  test("EC-055 golden de-document-discount: 100,00 over 1.000,00 @ 19 / 500,00 @ 7 → bases 933,33 / 466,67, gross 1.610,00", () => {
    const lines = [item(1000, 10_000_000, 1900), item(1000, 5_000_000, 700)];
    const t = totalsOf({ priceMode: "net", lines, adjustment: { type: "allowance", amountCents: 10_000 } });
    expect(t.groups.map((g) => [g.allowanceCents, g.baseCents, g.vatCents])).toEqual([
      [6667, 93_333, 17_733],
      [3333, 46_667, 3267],
    ]);
    expect(t.allowanceTotalCents).toBe(10_000); // BT-107
    expect(t.taxExclusiveCents).toBe(140_000);
    expect(t.grossCents).toBe(161_000);
  });

  test("DOC-07 document discount 5 % per group: 50,00 / 25,00 → bases 950,00 / 475,00, gross 1.638,75", () => {
    const lines = [item(1000, 10_000_000, 1900), item(1000, 5_000_000, 700)];
    const t = totalsOf({ priceMode: "net", lines, adjustment: { type: "allowance", percentBp: 500 } });
    expect(t.groups.map((g) => [g.allowanceCents, g.baseCents, g.vatCents])).toEqual([
      [5000, 95_000, 18_050],
      [2500, 47_500, 3325],
    ]);
    expect(t.grossCents).toBe(163_875);
  });

  test("DOC-07 document surcharge (charge) increases the group bases (BT-108)", () => {
    const lines = [item(1000, 10_000_000, 1900), item(1000, 5_000_000, 700)];
    const t = totalsOf({ priceMode: "net", lines, adjustment: { type: "charge", amountCents: 3000 } });
    expect(t.groups.map((g) => [g.chargeCents, g.baseCents])).toEqual([
      [2000, 102_000],
      [1000, 51_000],
    ]);
    expect(t.chargeTotalCents).toBe(3000);
    expect(t.allowanceTotalCents).toBe(0);
    expect(t.taxExclusiveCents).toBe(153_000);
  });

  test("EC-054 order: line discount → line net → document allowance per group → VAT", () => {
    // 1 × 1.000,00 −10 % = 900,00; document allowance 10 % = 90,00 → base 810,00 → VAT 153,90
    const t = totalsOf({
      priceMode: "net",
      lines: [item(1000, 10_000_000, 1900, { discount: { kind: "percent", bp: 1000 } })],
      adjustment: { type: "allowance", percentBp: 1000 },
    });
    expect(t.lines[0]?.netCents).toBe(90_000);
    expect(t.groups[0]).toMatchObject({
      lineNetSumCents: 90_000,
      allowanceCents: 9000,
      baseCents: 81_000,
      vatCents: 15_390,
    });
    expect(t.grossCents).toBe(96_390);
  });

  test("QUO-02 optional lines are excluded from all totals and VAT", () => {
    const t = totalsOf({
      priceMode: "net",
      lines: [item(1000, 1_000_000), item(1000, 5_000_000, 1900, { optional: true })],
    });
    expect(t.lines.map((l) => [l.included, l.netCents])).toEqual([
      [true, 10_000],
      [false, 50_000],
    ]);
    expect(t.taxExclusiveCents).toBe(10_000);
    expect(t.vatTotalCents).toBe(1900);
  });

  test("DOC-09 prepaid amounts (BT-113) reduce the payable amount (BT-115), which may become negative", () => {
    const t = totalsOf({ priceMode: "net", lines: [item(1000, 10_000_000)], prepaidCents: 119_000 });
    expect(t.prepaidCents).toBe(119_000);
    expect(t.payableCents).toBe(0);
    const refund = totalsOf({ priceMode: "net", lines: [item(1000, 1_000_000)], prepaidCents: 20_000 });
    expect(refund.payableCents).toBe(11_900 - 20_000);
  });

  test("EC-050 a document of only 0-€ lines totals 0 and still has its VAT group", () => {
    const t = totalsOf({ priceMode: "net", lines: [item(1000, 0)] });
    expect(t.grossCents).toBe(0);
    expect(t.groups).toHaveLength(1);
  });
});

describe("document totals, gross mode (F04 App. E.3)", () => {
  test("DOC-10 golden de-gross-mode-b2c: net 111,57, VAT 18,80, gross 130,37 = entered, line nets 50,40 / 41,17 / 21,40", () => {
    const t = totalsOf({
      priceMode: "gross",
      lines: [item(3000, 199_900, 1900), item(1000, 490_000, 1900), item(2000, 107_000, 700)],
    });
    expect(t.lines.map((l) => [l.grossCents, l.netCents])).toEqual([
      [5997, 5040],
      [4900, 4117],
      [2140, 2000],
    ]);
    expect(t.groups.map((g) => [g.rateBp, g.enteredGrossCents, g.baseCents, g.vatCents])).toEqual([
      [1900, 10_897, 9157, 1740],
      [700, 2140, 2000, 140],
    ]);
    expect(t.taxExclusiveCents).toBe(11_157);
    expect(t.vatTotalCents).toBe(1880);
    expect(t.grossCents).toBe(13_037);
    expect(t.warnings).toEqual([]);
  });

  test("EC-053 golden de-gross-unreachable: 6,29 € @ 19 % → 5,28 + 1,00 = 6,28 € and warning gross_rounding_deviation", () => {
    const t = totalsOf({ priceMode: "gross", lines: [item(1000, 62_900, 1900)] });
    expect(t.groups[0]).toMatchObject({ baseCents: 528, vatCents: 100, enteredGrossCents: 629 });
    expect(t.grossCents).toBe(628);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toMatchObject({
      code: "gross_rounding_deviation",
      params: { rateBp: 1900, vatCategory: "S", enteredCents: 629, computedCents: 628 },
    });
    expect(t.warnings[0]?.message).toBe(
      "Durch die Umrechnung in Nettobeträge (E-Rechnung) beträgt die Summe 19 % 6,28 € statt 6,29 €. Tipp: Bruttopreis um 0,01 € anpassen.",
    );
  });

  test("EC-DOC-49 VAT is never adjusted to hit the entered gross", () => {
    const t = totalsOf({ priceMode: "gross", lines: [item(1000, 62_900, 1900)] });
    const g = t.groups[0];
    expect(g?.vatCents).toBe(Number(vatExact(BigInt(g?.baseCents ?? 0), 1900)));
  });

  test("DOC-10 a 47,11 € gross B2C checkout is reachable: no warning, payable 47,11 (T-DOC-038)", () => {
    const t = totalsOf({ priceMode: "gross", lines: [item(1000, 471_100, 1900)] });
    expect(t.warnings).toEqual([]);
    expect(t.payableCents).toBe(4711);
  });

  test("DOC-07 gross-mode document allowance: percent per group on the gross; allowance net = N(G_lines) − N(G)", () => {
    // 119,00 gross @19 with 10 % allowance → G = 107,10 → N = 90,00, VAT 17,10; N(G_lines) = 100,00 → allowance net 10,00
    const t = totalsOf({
      priceMode: "gross",
      lines: [item(1000, 1_190_000, 1900)],
      adjustment: { type: "allowance", percentBp: 1000 },
    });
    expect(t.groups[0]).toMatchObject({
      enteredGrossCents: 10_710,
      lineNetSumCents: 10_000,
      allowanceCents: 1000,
      baseCents: 9000,
      vatCents: 1710,
    });
    expect(t.lines[0]?.netCents).toBe(10_000);
    expect(t.grossCents).toBe(10_710);
  });

  test("DOC-07 gross-mode document allowance/charge as an amount is allocated over the group grosses", () => {
    const lines = [item(1000, 1_190_000, 1900), item(1000, 1_070_000, 700)];
    const a = totalsOf({ priceMode: "gross", lines, adjustment: { type: "allowance", amountCents: 2260 } });
    // allocate(22,60, [119,00, 107,00]) → 11,90 / 10,70 → G = 107,10 / 96,30
    expect(a.groups.map((g) => [g.enteredGrossCents, g.baseCents, g.vatCents, g.allowanceCents])).toEqual([
      [10_710, 9000, 1710, 1000],
      [9630, 9000, 630, 1000],
    ]);
    const c = totalsOf({ priceMode: "gross", lines, adjustment: { type: "charge", amountCents: 2260 } });
    expect(c.groups.map((g) => [g.enteredGrossCents, g.baseCents, g.chargeCents])).toEqual([
      [13_090, 11_000, 1000],
      [11_770, 11_000, 1000],
    ]);
    expect(c.chargeTotalCents).toBe(2000);
  });

  test("DOC-10 lines that cancel out within a group still get their own nets (residual to the largest line)", () => {
    const t = totalsOf({ priceMode: "gross", lines: [item(1000, 1_190_000, 1900), item(-1000, 1_190_000, 1900)] });
    expect(t.lines.map((l) => l.netCents)).toEqual([10_000, -10_000]);
    expect(t.groups[0]).toMatchObject({ lineNetSumCents: 0, baseCents: 0, vatCents: 0 });
  });
});

describe("input validation", () => {
  const code = (input: TotalsInput) => {
    const r = computeTotals(input);
    return r.ok ? null : r.error.code;
  };

  test("GOBD-03 rejects non-integer or out-of-range inputs and totals above 99.999.999.999,99", () => {
    expect(code({ priceMode: "net", lines: [item(1.5, 100)] })).toBe("amount_invalid");
    expect(code({ priceMode: "net", lines: [item(1000, 100, 19.5)] })).toBe("amount_invalid");
    expect(code({ priceMode: "net", lines: [item(1000, 100, -1)] })).toBe("amount_invalid");
    expect(code({ priceMode: "net", lines: [item(1000, 100, 10_001)] })).toBe("amount_invalid");
    expect(code({ priceMode: "net", lines: [item(10 ** 13, 100)] })).toBe("amount_too_large");
    expect(code({ priceMode: "net", lines: [item(1000, 10 ** 13)] })).toBe("amount_too_large");
    expect(
      code({ priceMode: "net", lines: [item(1000, 100, 1900, { discount: { kind: "percent", bp: 10_001 } })] }),
    ).toBe("amount_invalid");
    expect(
      code({ priceMode: "net", lines: [item(1000, 100, 1900, { discount: { kind: "amount", cents: 0.5 } })] }),
    ).toBe("amount_invalid");
    expect(code({ priceMode: "net", lines: [item(1000, 100)], adjustment: { type: "allowance", percentBp: -1 } })).toBe(
      "amount_invalid",
    );
    expect(code({ priceMode: "net", lines: [item(1000, 100)], adjustment: { type: "charge", amountCents: 1.1 } })).toBe(
      "amount_invalid",
    );
    expect(code({ priceMode: "net", lines: [item(1000, 100)], prepaidCents: 0.1 })).toBe("amount_invalid");
    // each line fits, the line itself is too large
    expect(code({ priceMode: "net", lines: [item(999_999_999_999, 999_999_999_999)] })).toBe("amount_too_large");
    // each line fits, the sum does not
    const big = item(1_000_000, 600_000_000_000); // 1.000 × 60.000.000,00 € = 6·10^12 cents per line
    expect(code({ priceMode: "net", lines: [big, big] })).toBe("amount_too_large");
    expect(code({ priceMode: "gross", lines: [big, big] })).toBe("amount_too_large");
  });
});

// ── property tests (07 §5, T-DOC-005) ──────────────────────────────────────────
const lineArb: fc.Arbitrary<TotalsLineInput> = fc.record(
  {
    quantityMilli: fc.integer({ min: -100_000, max: 1_000_000 }),
    unitPriceMicros: fc.integer({ min: 0, max: 100_000_000 }),
    vatCategory: fc.constantFrom("S", "Z", "E", "AE"),
    rateBp: fc.constantFrom(1900, 700, 0),
    discount: fc.option(
      fc.oneof(
        fc.record({ kind: fc.constant("percent" as const), bp: fc.integer({ min: 0, max: 10_000 }) }),
        fc.record({ kind: fc.constant("amount" as const), cents: fc.integer({ min: 0, max: 10_000 }) }),
      ),
      { nil: undefined },
    ),
    optional: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ["quantityMilli", "unitPriceMicros", "vatCategory", "rateBp"] },
);
const adjustmentArb = fc.option(
  fc.oneof(
    fc.record({
      type: fc.constantFrom("allowance" as const, "charge" as const),
      percentBp: fc.integer({ min: 0, max: 5000 }),
    }),
    fc.record({
      type: fc.constantFrom("allowance" as const, "charge" as const),
      amountCents: fc.integer({ min: 0, max: 50_000 }),
    }),
  ),
  { nil: undefined },
);
const inputArb: fc.Arbitrary<TotalsInput> = fc.record({
  priceMode: fc.constantFrom("net" as const, "gross" as const),
  lines: fc.array(lineArb, { minLength: 1, maxLength: 12 }),
  adjustment: adjustmentArb,
  prepaidCents: fc.integer({ min: 0, max: 1_000_000 }),
});

const mirror = (input: TotalsInput): TotalsInput => ({
  ...input,
  lines: input.lines.map((l) => ({
    ...l,
    quantityMilli: -l.quantityMilli,
    discount: l.discount?.kind === "amount" ? { kind: "amount", cents: 0 - l.discount.cents } : l.discount,
  })),
  adjustment:
    input.adjustment && "amountCents" in input.adjustment
      ? { ...input.adjustment, amountCents: -input.adjustment.amountCents }
      : input.adjustment,
  prepaidCents: -(input.prepaidCents ?? 0),
});

describe("totals invariants (property-based)", () => {
  test("RI-05 Σ line nets = BT-106; base = lines − allowance + charge; VAT per group = round(base × rate); gross = net + VAT; payable = gross − prepaid", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const t = totalsOf(input);
        let lineSum = 0;
        for (const g of t.groups) {
          const nets = t.lines.filter((l) => l.included && l.groupIndex === t.groups.indexOf(g)).map((l) => l.netCents);
          expect(nets.reduce((a, b) => a + b, 0)).toBe(g.lineNetSumCents);
          expect(g.baseCents).toBe(g.lineNetSumCents - g.allowanceCents + g.chargeCents);
          expect(g.vatCents).toBe(Number(vatExact(BigInt(g.baseCents), g.rateBp)));
          lineSum += g.lineNetSumCents;
        }
        expect(t.lineNetSumCents).toBe(lineSum);
        expect(t.taxExclusiveCents).toBe(t.lineNetSumCents - t.allowanceTotalCents + t.chargeTotalCents);
        expect(t.taxExclusiveCents).toBe(t.groups.reduce((a, g) => a + g.baseCents, 0));
        expect(t.vatTotalCents).toBe(t.groups.reduce((a, g) => a + g.vatCents, 0));
        expect(t.grossCents).toBe(t.taxExclusiveCents + t.vatTotalCents);
        expect(t.payableCents).toBe(t.grossCents - t.prepaidCents);
        expect(t.lines.filter((l) => !l.included).every((l) => l.groupIndex === null)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test("EC-053 gross mode never exceeds the entered group gross, deviates by at most 1 cent and warns exactly then", () => {
    fc.assert(
      fc.property(inputArb, (raw) => {
        const input = { ...raw, priceMode: "gross" as const };
        const t = totalsOf(input);
        for (const g of t.groups) {
          const entered = g.enteredGrossCents ?? Number.NaN;
          const computed = g.baseCents + g.vatCents;
          const expected = largestNetThatFits(BigInt(entered), g.rateBp);
          expect(BigInt(g.baseCents)).toBe(expected.net);
          expect(Math.abs(entered - computed)).toBeLessThanOrEqual(1);
          if (entered >= 0) expect(computed).toBeLessThanOrEqual(entered);
          const warned = t.warnings.some(
            (w) => w.params?.rateBp === g.rateBp && w.params?.vatCategory === g.vatCategory,
          );
          expect(warned).toBe(computed !== entered);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("RI-06 mirror(doc) totals = −totals(doc) in both price modes (Storno sums to 0 per VAT group)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const t = totalsOf(input);
        const m = totalsOf(mirror(input));
        const neg = (x: number) => (x === 0 ? 0 : -x);
        expect(m.groups.map((g) => [g.vatCategory, g.rateBp, neg(g.baseCents), neg(g.vatCents)])).toEqual(
          t.groups.map((g) => [g.vatCategory, g.rateBp, g.baseCents, g.vatCents]),
        );
        expect(m.lines.map((l) => neg(l.netCents))).toEqual(t.lines.map((l) => l.netCents));
        expect(neg(m.grossCents)).toBe(t.grossCents);
        expect(neg(m.payableCents)).toBe(t.payableCents);
      }),
      { numRuns: 300 },
    );
  });
});
