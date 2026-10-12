import { BANK_ACCOUNT, BUYERS, makeSnapshot, makeSnapshotInput, SELLERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { buildSnapshot, fillPlaceholders, type SnapshotInput, type SnapshotInputItem } from "./build-snapshot";
import { canonicalSnapshotJson, type SnapshotSeller, snapshotHash } from "./snapshot";

const item = (over: Partial<SnapshotInputItem> = {}): SnapshotInputItem => ({
  kind: "item",
  name: "Leistung",
  quantityMilli: 1_000,
  unitCode: "LS",
  unitPriceMicros: 1_000_000,
  vatCategory: "S",
  vatRateBp: 1900,
  vatRuleRowId: "standard@2021-01-01",
  ...over,
});
const build = (over: Partial<SnapshotInput>) => buildSnapshot(makeSnapshotInput(over));
const noteIds = (over: Partial<SnapshotInput>) => makeSnapshot(over).notes.map((n) => n.id);
const CHAIN = { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2026-08-03" };
const ORIGINAL = { number: "RE-2026-0042", date: "2026-10-12" };

describe("buildSnapshot – legal notes (App. B)", () => {
  test("T-INV-019 each tax case yields its App. B note with subject REG and no open placeholders", () => {
    const cases: [Partial<SnapshotInput>, string][] = [
      [
        {
          taxCase: "kleinunternehmer",
          seller: SELLERS.ku,
          lines: [item({ vatCategory: "KU", vatRateBp: 0, vatRuleRowId: undefined })],
        },
        "ku_note_19",
      ],
      [{ taxCase: "eu_b2b_service", buyer: BUYERS.at, lines: [item({ vatCategory: "AE", vatRateBp: 0 })] }, "rc_eu"],
      [
        { taxCase: "intra_community_supply", buyer: BUYERS.fr, lines: [item({ vatCategory: "K", vatRateBp: 0 })] },
        "igl",
      ],
      [{ taxCase: "export", buyer: BUYERS.ch, lines: [item({ vatCategory: "G", vatRateBp: 0 })] }, "export"],
      [
        { taxCase: "not_taxable_domestic", buyer: BUYERS.us, lines: [item({ vatCategory: "O", vatRateBp: 0 })] },
        "o_3a2",
      ],
      [
        {
          taxCase: "not_taxable_domestic",
          buyer: { ...BUYERS.us, isConsumer: true },
          lines: [item({ vatCategory: "O", vatRateBp: 0 })],
        },
        "o_3a4",
      ],
      [
        {
          taxCase: "reverse_charge_13b",
          buyer: BUYERS.construction,
          lines: [item({ vatCategory: "AE", vatRateBp: 0, reverseCharge13b: "construction" })],
        },
        "rc_13b",
      ],
      [
        { taxCase: "exempt_4", lines: [item({ vatCategory: "E", vatRateBp: 0, exemptionParagraph: "14" })] },
        "exempt_4",
      ],
      [{ lines: [item({ vatCategory: "Z", vatRateBp: 0, vatRuleRowId: "zero@2023-01-01" })] }, "zero_pv"],
    ];
    for (const [over, id] of cases) {
      const s = makeSnapshot(over);
      const note = s.notes.find((n) => n.id === id);
      expect(note, id).toMatchObject({ zone: "legal", xmlSubjectCode: "REG" });
      expect(note?.de, id).not.toMatch(/\{\w+\}/);
      expect(note?.en, id).not.toMatch(/\{\w+\}/);
      expect(s.ruleVersions[`note:${id}`], id).toBeDefined();
    }
  });

  test("T-INV-019 the § 13b note names the paragraph of the type and records the rc13b rule row", () => {
    const s = makeSnapshot({
      taxCase: "reverse_charge_13b",
      buyer: BUYERS.construction,
      lines: [item({ vatCategory: "AE", vatRateBp: 0, reverseCharge13b: "construction" })],
    });
    expect(s.notes.find((n) => n.id === "rc_13b")?.de).toContain("§ 13b");
    expect(s.ruleVersions["rc13b:construction"]).toBeDefined();
    const unknown = build({ lines: [item({ vatCategory: "AE", vatRateBp: 0, reverseCharge13b: "spaceships" })] });
    expect(unknown).toMatchObject({ ok: false, error: { code: "rc13b_type_unknown" } });
  });

  test("T-INV-019 the EU notes carry both VAT IDs", () => {
    const s = makeSnapshot({
      taxCase: "eu_b2b_service",
      buyer: BUYERS.at,
      lines: [item({ vatCategory: "AE", vatRateBp: 0 })],
    });
    const note = s.notes.find((n) => n.id === "rc_eu");
    expect(note?.de).toContain("DE123456788");
    expect(note?.de).toContain("ATU12345675");
  });

  test("T-DOC-030 the § 14b note only for consumers on property-related invoices", () => {
    expect(noteIds({ buyer: BUYERS.consumer, flags: { propertyRelated: true } })).toContain("p14b");
    expect(noteIds({ buyer: BUYERS.b2b, flags: { propertyRelated: true } })).not.toContain("p14b");
    expect(noteIds({ buyer: BUYERS.consumer })).not.toContain("p14b");
  });

  test("INV-25 the Ist note from 2028-01-01 for Ist-taxing companies only (not for KU)", () => {
    const at = (documentDate: string, seller: SnapshotSeller = SELLERS.ek) =>
      noteIds({ seller, documentDate, supplyDate: { kind: "date", date: "2027-12-28" } });
    expect(at("2028-01-02")).toContain("ist_2028");
    expect(at("2027-12-31")).not.toContain("ist_2028");
    expect(at("2028-01-02", SELLERS.gmbh)).not.toContain("ist_2028");
    expect(
      noteIds({
        seller: SELLERS.ku,
        taxCase: "kleinunternehmer",
        documentDate: "2028-01-02",
        lines: [item({ vatCategory: "KU", vatRateBp: 0, vatRuleRowId: undefined })],
      }),
    ).not.toContain("ist_2028");
  });

  test("INV-26 the § 286 note on B2C invoices with a payable amount only", () => {
    expect(noteIds({ buyer: BUYERS.consumer })).toContain("b2c_286");
    expect(noteIds({ buyer: BUYERS.b2b })).not.toContain("b2c_286");
    expect(noteIds({ buyer: BUYERS.consumer, type: "quote", einvoice: { format: "none" } })).not.toContain("b2c_286");
  });

  test("DOC-21 supply date = document date prints the supply_same note", () => {
    const ids = noteIds({ supplyDate: { kind: "date", date: "2026-10-12" }, supplyDateIsDocumentDate: true });
    expect(ids).toContain("supply_same");
  });

  test("INV-23 title notes: advance/final need the order chain, Storno/correction the original, proforma its note", () => {
    expect(build({ type: "advance_invoice" })).toMatchObject({ ok: false, error: { code: "chain_reference_missing" } });
    expect(build({ type: "cancellation" })).toMatchObject({ ok: false, error: { code: "original_reference_missing" } });
    expect(noteIds({ type: "advance_invoice", chain: CHAIN })).toContain("advance_info");
    expect(noteIds({ type: "final_invoice", chain: CHAIN })).toContain("final_info");
    expect(noteIds({ type: "correction", correctionKind: "credit", original: ORIGINAL })).toContain("credit_info");
    expect(noteIds({ type: "correction", correctionKind: "rectification", original: ORIGINAL })).toContain("rect_info");
    expect(noteIds({ type: "proforma", einvoice: { format: "none" } })).toContain("proforma_info");
  });

  test("INV-23 owner overrides of note texts must not leave placeholders unfilled", () => {
    const r = build({
      taxCase: "export",
      buyer: BUYERS.ch,
      lines: [item({ vatCategory: "G", vatRateBp: 0 })],
      noteOverrides: {
        export: [
          { id: "x", validFrom: "2020-01-01", value: { de: "Ausfuhr {unbekannt}", en: "Export" }, source: "owner" },
        ] as never,
      },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "note_placeholder_missing" } });
    expect(fillPlaceholders("{a} und {b}", { a: "1", b: "2" })).toEqual({ ok: true, value: "1 und 2" });
  });
});

describe("buildSnapshot – amounts and payment", () => {
  test("DOC-50 Skonto: date, amount on the payable and the payment note; immediate terms without Skonto", () => {
    const s = makeSnapshot({
      payment: {
        method: "transfer",
        dueDays: 30,
        skonto: { percentBp: 200, days: 14 },
        bankAccount: BANK_ACCOUNT,
        showEpcQr: true,
      },
    });
    expect(s.payment.skonto).toEqual({
      percentBp: 200,
      days: 14,
      date: "2026-10-26",
      amountCents: 2_380,
      payableCents: 116_620,
    });
    expect(s.dueDate).toBe("2026-11-11");
    expect(s.notes.find((n) => n.id === "skonto")?.de).toContain("23,80 €");
    expect(noteIds({ payment: { method: "transfer", dueDays: 0, showEpcQr: false } })).toContain("terms_immediate");
  });

  test("DOC-04 subtotals sum the items since the last heading/subtotal; optional items stay out", () => {
    const s = makeSnapshot({
      lines: [
        { kind: "heading", text: "Phase 1" },
        item({ unitPriceMicros: 1_000_000 }),
        item({ unitPriceMicros: 500_000, optional: true }),
        { kind: "subtotal" },
        { kind: "heading", text: "Phase 2" },
        item({ unitPriceMicros: 2_500_000 }),
        { kind: "subtotal", text: "Summe Phase 2" },
      ],
    });
    const subs = s.lines.filter((l) => l.kind === "subtotal");
    expect(subs).toEqual([
      { kind: "subtotal", text: "Zwischensumme", amountCents: 10_000 },
      { kind: "subtotal", text: "Summe Phase 2", amountCents: 25_000 },
    ]);
    expect(s.totals.netCents).toBe(35_000);
    const items = s.lines.filter((l) => l.kind === "item");
    expect(items.map((l) => (l.kind === "item" ? l.position : 0))).toEqual([1, 2, 3]);
    expect(items[0]?.kind === "item" && items[0].note).toBe("Phase 1");
  });

  test("DOC-44 Kleinbetrag only up to 250,00 € gross and never with K/AE lines", () => {
    const at = (priceMicros: number, over: Partial<SnapshotInputItem> = {}) =>
      build({ flags: { kleinbetrag: true }, lines: [item({ unitPriceMicros: priceMicros, ...over })] });
    expect(at(2_100_800).ok).toBe(true);
    expect(at(2_100_900)).toMatchObject({ ok: false, error: { code: "kleinbetrag_not_allowed" } });
    expect(at(1_000_000, { vatCategory: "AE", vatRateBp: 0 })).toMatchObject({
      ok: false,
      error: { code: "kleinbetrag_not_allowed" },
    });
  });

  test("DOC-15 foreign currency: VAT in EUR per group and the fx note; an invalid rate is rejected", () => {
    const s = makeSnapshot({ currency: "USD", fx: { rate: "1.0831", source: "bmf_monthly", date: "2026-10-01" } });
    expect(s.totals.vatEurCents).toBe(17_542);
    expect(s.totals.byGroup[0]?.vatEurCents).toBe(17_542);
    expect(s.notes.find((n) => n.id === "fx")?.de).toContain("175,42 €");
    expect(build({ currency: "USD", fx: { rate: "abc", source: "manual", date: "2026-10-01" } })).toMatchObject({
      ok: false,
    });
  });

  test("DOC-47 §35a labour subtotal on B2C invoices (App. E.7)", () => {
    const s = makeSnapshot({
      buyer: BUYERS.consumer,
      lines: [item({ unitPriceMicros: 8_000_000, isLaborCost: true }), item({ unitPriceMicros: 4_000_000 })],
    });
    expect(s.totals.labor).toEqual({ netCents: 80_000, vatCents: 15_200, grossCents: 95_200 });
    expect(s.notes.find((n) => n.id === "p35a")?.zone).toBe("totals");
    expect(makeSnapshot({ lines: [item({ isLaborCost: true })] }).totals.labor).toBeUndefined();
  });

  test("INV-06 deductions: BT-113 = Σ deducted gross, BG-3 per advance, payable = gross − deductions", () => {
    const s = makeSnapshot({
      type: "final_invoice",
      chain: CHAIN,
      lines: [item({ unitPriceMicros: 100_000_000 })],
      deductions: [
        {
          advanceNumber: "RE-2026-0031",
          advanceDate: "2026-08-10",
          byGroup: [{ category: "S", rateBp: 1900, netCents: 300_000, vatCents: 57_000, grossCents: 357_000 }],
          deductedGrossCents: 357_000,
          partiallyPaid: false,
        },
      ],
    });
    expect(s.totals).toMatchObject({
      grossCents: 1_190_000,
      advancesDeductedGrossCents: 357_000,
      payableCents: 833_000,
    });
    expect(s.references.precedingInvoices).toEqual([{ number: "RE-2026-0031", date: "2026-08-10", role: "advance" }]);
  });

  test("INV-15 corrections reference the original and earlier corrections (BG-3)", () => {
    const s = makeSnapshot({
      type: "correction",
      correctionKind: "credit",
      original: ORIGINAL,
      earlierCorrections: [{ number: "RE-2026-0048", date: "2026-10-21" }],
      lines: [item({ quantityMilli: -1_000 })],
    });
    expect(s.references.precedingInvoices.map((p) => p.role)).toEqual(["original", "earlier_correction"]);
    expect(s.totals.payableCents).toBe(-11_900);
  });

  test("INV-22 BT-10 in the snapshot: real reference or, for XRechnung formats, the fallback chain", () => {
    expect(makeSnapshot().references.buyerReference).toBeUndefined();
    expect(makeSnapshot({ einvoice: { format: "xrechnung_cii" } }).references.buyerReference).toBe("K-10023");
    expect(makeSnapshot({ references: { contactBuyerReference: "EK-7" } }).references.buyerReference).toBe("EK-7");
  });

  test("DOC-27 the snapshot is deterministic: same input → same canonical JSON and hash", async () => {
    const a = makeSnapshot();
    const b = makeSnapshot();
    expect(canonicalSnapshotJson(a)).toBe(canonicalSnapshotJson(b));
    expect(await snapshotHash(a)).toBe(await snapshotHash(b));
    expect(await snapshotHash(makeSnapshot({ number: "RE-2026-0043" }))).not.toBe(await snapshotHash(a));
  });

  test("DOC-10 gross mode: line gross kept, net derived; a discount is documented in the line note (BT-127)", () => {
    const s = makeSnapshot({
      priceMode: "gross",
      buyer: BUYERS.consumer,
      lines: [item({ quantityMilli: 2_000, unitPriceMicros: 119_000, discount: { kind: "percent", bp: 1000 } })],
    });
    const l = s.lines[0];
    expect(l?.kind === "item" && l.grossCents).toBe(2_142);
    expect(l?.kind === "item" && l.note).toBe("inkl. 10 % Rabatt");
    expect(s.totals.grossCents).toBe(2_142);
  });
});
