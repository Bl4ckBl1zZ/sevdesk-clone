import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { checkLineVat, checkStatedTotals, computeLine, convertLinesToEur, voucherTotals } from "./lines";

describe("voucher lines and totals", () => {
  test("VOU-002 net mode: VAT = round(net × rate), gross = net + VAT; VAT may deviate ±1 cent (EC-VOU-04)", () => {
    expect(computeLine({ amountCents: 10_000, vatRateBp: 1900 }, "net", "input_vat_deductible")).toEqual({
      netCents: 10_000,
      vatCents: 1900,
      grossCents: 11_900,
    });
    const supplier = computeLine({ amountCents: 1033, vatRateBp: 1900, vatCents: 197 }, "net", "input_vat_deductible");
    expect(supplier.vatCents).toBe(197);
    expect(checkLineVat({ ...supplier, vatRateBp: 1900 }, 1)).toBeNull(); // 1033 × 19 % = 196,27 → 196; 197 within ±1
    expect(checkLineVat({ netCents: 1033, vatCents: 199, vatRateBp: 1900 }, 2)?.message).toBe(
      "Der USt-Betrag in Position 2 passt nicht zum Steuersatz 19 %.",
    );
  });

  test("VOU-005 UST-14 golden V4: Kleinbetrag 23,80 € gross @19 % → VAT 3,80, net 20,00 (computed from gross)", () => {
    expect(computeLine({ amountCents: 2380, vatRateBp: 1900 }, "gross", "input_vat_deductible")).toEqual({
      netCents: 2000,
      vatCents: 380,
      grossCents: 2380,
    });
  });

  test("VOU-022 self-assessment: net only, selfAssessedVat = round(net × German rate), vatCents = 0, payable = net", () => {
    const l = computeLine({ amountCents: 100_000, vatRateBp: 1900 }, "net", "reverse_charge_eu");
    expect(l).toEqual({ netCents: 100_000, vatCents: 0, grossCents: 100_000, selfAssessedVatCents: 19_000 });
    const totals = voucherTotals([{ ...l, vatRateBp: 1900 }]);
    expect(totals).toMatchObject({ vatCents: 0, grossCents: 100_000, selfAssessedVatCents: 19_000 });
  });

  test("VOU-025 kleinunternehmer_supplier: gross = net, no VAT", () => {
    expect(computeLine({ amountCents: 5000, vatRateBp: 0 }, "gross", "kleinunternehmer_supplier")).toEqual({
      netCents: 5000,
      vatCents: 0,
      grossCents: 5000,
    });
  });

  test("VOU-003 EC-VOU-03 totals per rate must equal the stated Belegsumme / VAT breakdown", () => {
    const lines = [
      { ...computeLine({ amountCents: 10_000, vatRateBp: 700 }, "net", "input_vat_deductible"), vatRateBp: 700 },
      { ...computeLine({ amountCents: 5000, vatRateBp: 1900 }, "net", "input_vat_deductible"), vatRateBp: 1900 },
    ];
    const t = voucherTotals(lines);
    expect(t.byRate).toEqual([
      { rateBp: 700, netCents: 10_000, vatCents: 700 },
      { rateBp: 1900, netCents: 5000, vatCents: 950 },
    ]);
    expect(checkStatedTotals(t, { grossCents: 16_650 })).toBeNull();
    expect(checkStatedTotals(t, { grossCents: 16_700 })?.message).toBe(
      "Die Summe der Positionen (166,50 €) weicht von der Belegsumme (167,00 €) ab.",
    );
    expect(
      checkStatedTotals(t, {
        byRate: [
          { rateBp: 700, netCents: 10_000, vatCents: 700 },
          { rateBp: 1900, netCents: 5000, vatCents: 950 },
        ],
      }),
    ).toBeNull();
    expect(checkStatedTotals(t, { byRate: [{ rateBp: 700, netCents: 10_000, vatCents: 700 }] })?.code).toBe(
      "sum_mismatch",
    );
  });

  test("VOU-028 MISC-08 golden V3: USD 33,33 net reverse charge non-EU at 1 EUR = 1.096131 USD → netEur 30,41, self-assessed 5,78", () => {
    // 03 FxRate convention „1 EUR = x FC“; 1/1.096131 = 0.9123 USD→EUR as in F06 golden V3.
    const l = {
      ...computeLine({ amountCents: 3333, vatRateBp: 1900 }, "net", "reverse_charge_non_eu"),
      vatRateBp: 1900,
    };
    const r = convertLinesToEur([l], "USD", { rate: "1.096131" });
    expect(r.ok && r.value.lines[0]).toEqual({ netEurCents: 3041, vatEurCents: 0, selfAssessedVatEurCents: 578 });
    expect(r.ok && r.value.totals).toEqual({
      netCents: 3041,
      vatCents: 0,
      grossCents: 3041,
      selfAssessedVatCents: 578,
    });
  });

  test("VOU-028 EC-VOU-16 foreign currency without a rate is blocked", () => {
    const r = convertLinesToEur([{ netCents: 100, vatCents: 0, grossCents: 100, vatRateBp: 0 }], "USD", undefined);
    expect(!r.ok && r.error.message).toBe("Bitte Umrechnungskurs angeben oder Kursquelle wählen.");
  });

  test("VOU-028 EC-VOU-32 BT-111 VAT in EUR takes precedence, the difference is shown", () => {
    const lines = [{ netCents: 10_000, vatCents: 1900, grossCents: 11_900, vatRateBp: 1900 }];
    const r = convertLinesToEur(lines, "USD", { rate: "1.1" }, 1730);
    expect(r.ok && r.value.totals.vatCents).toBe(1730);
    expect(r.ok && r.value.warning?.message).toBe(
      "USt in EUR laut Rechnung (17,30 €) weicht von der Umrechnung (17,27 €) ab. Es gilt der Rechnungswert.",
    );
  });

  test("VOU-028 EC-VOU-31 property: EUR totals always equal the sum of the EUR lines (half-up per line)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ net: fc.integer({ min: -1_000_000, max: 1_000_000 }), rate: fc.constantFrom(0, 700, 1900) }),
          {
            minLength: 1,
            maxLength: 12,
          },
        ),
        fc.integer({ min: 100_000, max: 5_000_000 }),
        (rows, scaled) => {
          const lines = rows.map((r) => ({
            ...computeLine({ amountCents: r.net, vatRateBp: r.rate }, "net", "input_vat_deductible"),
            vatRateBp: r.rate,
          }));
          const rate = `${Math.floor(scaled / 1_000_000)}.${String(scaled % 1_000_000).padStart(6, "0")}`;
          const res = convertLinesToEur(lines, "USD", { rate });
          if (!res.ok) return false;
          const net = res.value.lines.reduce((s, l) => s + l.netEurCents, 0);
          const vat = res.value.lines.reduce((s, l) => s + l.vatEurCents, 0);
          return (
            res.value.totals.netCents === net &&
            res.value.totals.vatCents === vat &&
            res.value.totals.grossCents === net + vat
          );
        },
      ),
    );
  });
});
