import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { vatCents } from "../money/vat";
import {
  advanceGroups,
  type ChainAdvance,
  deductionOf,
  finalChainFindings,
  finalDeductions,
  finalTaxEffect,
  type GroupAmount,
  partialExceedsOrder,
  remainderCorrectionGroups,
} from "./advances";

const g = (rateBp: number, netCents: number, vatCents: number, category: GroupAmount["category"] = "S") => ({
  category,
  rateBp,
  netCents,
  vatCents,
});

/** Order 5.000,00 @19 / 1.000,00 @7 (F04 App. E.5 golden). */
const ORDER = [g(1900, 500_000, 95_000), g(700, 100_000, 7000)];

const advance = (over: Partial<ChainAdvance> = {}): ChainAdvance => ({
  id: "a1",
  type: "advance_invoice",
  number: "RE-2026-0010",
  date: "2026-03-02",
  status: "finalized",
  currency: "EUR",
  taxCase: "domestic",
  openCents: 0,
  groups: [g(1900, 300_000, 57_000)],
  corrections: [],
  differences: [],
  paidOn: "2026-03-10",
  ...over,
});

const FINAL = { documentDate: "2026-06-30", currency: "EUR", taxCase: "domestic" as const };

describe("advance amounts from an order (F04 App. E.5)", () => {
  test("INV-03 T-INV-003 30 % of the order → 1.500,00 @19 and 300,00 @7 per VAT group", () => {
    expect(advanceGroups(ORDER, { kind: "percent", bp: 3000 })).toEqual([
      g(1900, 150_000, 28_500),
      g(700, 30_000, 2100),
    ]);
  });

  test("INV-04 T-INV-004 2.000,00 € gross → group gross 1.695,16 / 304,84, nets 1.424,50 / 284,90", () => {
    const r = advanceGroups(ORDER, { kind: "gross", cents: 200_000 });
    expect(r).toEqual([g(1900, 142_450, 27_066), g(700, 28_490, 1994)]);
    expect(r.reduce((a, x) => a + x.netCents + x.vatCents, 0)).toBe(200_000);
  });

  test("INV-04 a fixed net amount is allocated pro rata to the order nets (residue to the largest group)", () => {
    expect(advanceGroups(ORDER, { kind: "net", cents: 100_001 })).toEqual([
      g(1900, 83_335, 15_834),
      g(700, 16_666, 1167),
    ]);
  });

  test("UST-40 EC-078 EC-DOC-61 T-EC-061 advances of 60 % and 50 % → partial_exceeds_order on the second", () => {
    const first = advanceGroups(ORDER, { kind: "percent", bp: 6000 });
    expect(partialExceedsOrder(ORDER, [], first)).toEqual([]);
    const second = advanceGroups(ORDER, { kind: "percent", bp: 5000 });
    const f = partialExceedsOrder(ORDER, [first], second);
    // one finding per VAT group that is exceeded (19 % and 7 %)
    expect(f.map((x) => x.code)).toEqual(["partial_exceeds_order", "partial_exceeds_order"]);
    expect(f[0]?.severity).toBe("E");
    expect(f[0]?.message).toContain("übersteigen den Auftragswert");
    expect(partialExceedsOrder(ORDER, [first], advanceGroups(ORDER, { kind: "percent", bp: 4000 }))).toEqual([]);
  });
});

describe("final invoice deductions (F04 App. E.4, UST-41, RI-08)", () => {
  test("INV-06 case A: a paid advance is deducted with its invoiced amounts", () => {
    const d = deductionOf(advance({ groups: [g(1900, 300_000, 57_000)] }));
    expect(d).toEqual({
      advanceNumber: "RE-2026-0010",
      advanceDate: "2026-03-02",
      paidOn: "2026-03-10",
      byGroup: [{ category: "S", rateBp: 1900, netCents: 300_000, vatCents: 57_000, grossCents: 357_000 }],
      deductedGrossCents: 357_000,
      partiallyPaid: false,
    });
  });

  test("UST-32 EC-DOC-59 T-EC-059 case D: a Skonto difference on the advance reduces the deduction per rate", () => {
    const d = deductionOf(advance({ groups: [g(1900, 300_000, 57_000)], differences: [g(1900, 6000, 1140)] }));
    expect(d.byGroup).toEqual([
      { category: "S", rateBp: 1900, netCents: 294_000, vatCents: 55_860, grossCents: 349_860 },
    ]);
    expect(d.deductedGrossCents).toBe(349_860);
  });

  test("EC-071 EC-DOC-56 T-EC-056 case E: an advance reduced by its Rechnungskorrektur is deducted with the received amount", () => {
    const corr = remainderCorrectionGroups([g(1900, 300_000, 57_000)], 178_500);
    expect(corr).toEqual([g(1900, -150_000, -28_500)]);
    const d = deductionOf(advance({ groups: [g(1900, 300_000, 57_000)], corrections: corr }));
    expect(d.byGroup).toEqual([
      { category: "S", rateBp: 1900, netCents: 150_000, vatCents: 28_500, grossCents: 178_500 },
    ]);
    expect(d.partiallyPaid).toBe(true);
  });

  test("EC-071 the remainder correction is split over the advance's VAT groups in proportion to their gross", () => {
    const groups = [g(1900, 150_000, 28_500), g(700, 30_000, 2100)];
    const corr = remainderCorrectionGroups(groups, 100_000);
    expect(corr.reduce((a, x) => a + x.netCents + x.vatCents, 0)).toBe(-100_000);
    expect(corr.map((x) => x.rateBp)).toEqual([1900, 700]);
  });

  test("RI-08 property: deduction gross = invoiced gross − remainder correction gross whenever the gross is reachable", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 5_000_000 }), fc.integer({ min: 1, max: 99 }), (net, pct) => {
        const vat = vatCents(net, 1900);
        const groups = [g(1900, net, vat)];
        const gross = net + vat;
        const open = Math.floor((gross * pct) / 100);
        const corr = remainderCorrectionGroups(groups, open);
        const d = deductionOf(advance({ groups, corrections: corr }));
        const corrGross = corr.reduce((a, x) => a + x.netCents + x.vatCents, 0);
        expect(d.deductedGrossCents).toBe(gross + corrGross);
        expect(Math.abs(corrGross + open)).toBeLessThanOrEqual(1);
      }),
    );
  });

  test("INV-08 EC-073 EC-DOC-20 T-EC-020 case B: final at 7 % deducts the 19 % advance; tax effect 7 %: +1.000/+70, 19 %: −1.000/−190", () => {
    const deductions = finalDeductions({
      advances: [advance({ groups: [g(1900, 100_000, 19_000)], date: "2025-11-20", paidOn: "2025-11-28" })],
    });
    expect(deductions.map((d) => d.deductedGrossCents)).toEqual([119_000]);
    const effect = finalTaxEffect([g(700, 100_000, 7000)], deductions);
    expect(effect).toEqual([g(1900, -100_000, -19_000), g(700, 100_000, 7000)]);
    // golden G-14: VAT remainder of the final invoice −120,00 €
    expect(effect.reduce((a, x) => a + x.vatCents, 0)).toBe(-12_000);
  });

  test("UST-41 T-EC-057 a cancelled advance is not deducted; INV-06 case C two advances", () => {
    const deductions = finalDeductions({
      advances: [
        advance({ id: "a1", groups: [g(1900, 600_000, 114_000)] }),
        advance({ id: "a2", number: "RE-2026-0011", groups: [g(1900, 600_000, 114_000)] }),
        advance({ id: "a3", number: "RE-2026-0012", status: "cancelled" }),
      ],
    });
    expect(deductions.map((d) => d.advanceNumber)).toEqual(["RE-2026-0010", "RE-2026-0011"]);
    expect(deductions.reduce((a, d) => a + d.deductedGrossCents, 0)).toBe(1_428_000);
  });
});

describe("final-invoice preconditions (F04 INV-07, §5.1.6)", () => {
  const codes = (advances: ChainAdvance[], extra: { otherFinal?: { number: string } } = {}, final = FINAL) =>
    finalChainFindings(final, { advances, ...extra }).map((f) => f.code);

  test("INV-07 a fully paid chain has no findings", () => {
    expect(codes([advance()])).toEqual([]);
  });

  test("UST-41 EC-070 EC-DOC-55 T-EC-055 an unpaid advance blocks the final with advance_not_settled (no 'nicht abziehen')", () => {
    const f = finalChainFindings(FINAL, { advances: [advance({ openCents: 357_000 })] });
    expect(f.map((x) => x.code)).toEqual(["advance_not_settled"]);
    expect(f[0]?.severity).toBe("E");
    expect(f[0]?.message).toBe(
      "Abschlagsrechnung RE-2026-0010 ist nicht vollständig bezahlt (offen: 3.570,00 €). Vor der Schlussrechnung muss sie storniert (keine Zahlung) oder per Rechnungskorrektur auf den erhaltenen Betrag (0,00 €) reduziert werden. Abgezogen werden nur tatsächlich erhaltene Zahlungen.",
    );
  });

  test("UST-41 EC-071 EC-DOC-56 a partially paid advance blocks the final and names the received amount", () => {
    const f = finalChainFindings(FINAL, { advances: [advance({ openCents: 178_500 })] });
    expect(f[0]?.params).toMatchObject({ number: "RE-2026-0010", open: 178_500, received: 178_500 });
  });

  test("UST-41 final_without_advances, final_exists, advance_already_deducted, mismatches and dates", () => {
    expect(codes([])).toEqual(["final_without_advances"]);
    expect(codes([advance({ status: "cancelled" })])).toEqual(["final_without_advances"]);
    expect(codes([advance()], { otherFinal: { number: "RE-2026-0050" } })).toEqual(["final_exists"]);
    expect(codes([advance({ deductedIn: { id: "f9", number: "RE-2026-0049" } })])).toEqual([
      "advance_already_deducted",
    ]);
    expect(codes([advance({ currency: "USD" })])).toEqual(["chain_currency_mismatch"]);
    expect(codes([advance({ taxCase: "kleinunternehmer" })])).toEqual(["chain_tax_case_mismatch"]);
  });

  test("UST-41 T-INV-008 a final dated before an advance → final_date_before_advance", () => {
    expect(codes([advance({ date: "2026-07-01" })])).toEqual(["final_date_before_advance"]);
  });
});
