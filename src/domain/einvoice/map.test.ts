import { BUYERS, makeSnapshot, SELLERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import type { SnapshotInputItem } from "../documents/build-snapshot";
import { EinvoiceMappingError, mapToEn16931 } from "./map";
import { serializeEinvoice } from "./serialize";

const item = (over: Partial<SnapshotInputItem> = {}): SnapshotInputItem => ({
  kind: "item",
  name: "Leistung",
  quantityMilli: 1_000,
  unitCode: "LS",
  unitPriceMicros: 1_000_000,
  vatCategory: "S",
  vatRateBp: 1900,
  ...over,
});
const ORIGINAL = { number: "RE-2026-0042", date: "2026-10-12" };

describe("mapToEn16931 (App. A)", () => {
  test("INV-19 standard invoice: BT-1/2/3/5/9, seller/buyer identifiers, BG-22 totals, BG-23 breakdown", () => {
    const inv = mapToEn16931(makeSnapshot(), { profile: "en16931" });
    expect(inv).toMatchObject({
      customizationId: "urn:cen.eu:en16931:2017",
      number: "RE-2026-0042",
      issueDate: "2026-10-12",
      typeCode: "380",
      currency: "EUR",
      dueDate: "2026-11-11",
      seller: {
        name: "Muster Design GmbH",
        vatId: "DE123456788",
        taxNumber: "1121081508150",
        registerNumber: "HRB 123456 B",
      },
      buyer: { name: "Beispiel Kunde GmbH", identifier: "K-10023", vatId: "DE811907980" },
      totals: {
        lineNetCents: 100_000,
        taxExclusiveCents: 100_000,
        vatCents: 19_000,
        taxInclusiveCents: 119_000,
        payableCents: 119_000,
      },
      vatBreakdown: [{ baseCents: 100_000, vatCents: 19_000, category: "S", rateBp: 1900 }],
    });
    expect(inv.buyerReference).toBeUndefined();
    expect(inv.seller.identifier).toBeUndefined();
    expect(inv.seller.legalInfo).toContain("Amtsgericht Charlottenburg");
  });

  test("INV-19 BR-DE-15: the XRechnung profile always has BT-10 (fallback chain), EN 16931 only a real one", () => {
    expect(mapToEn16931(makeSnapshot(), { profile: "xrechnung" }).buyerReference).toBe("K-10023");
    expect(mapToEn16931(makeSnapshot(), { profile: "xrechnung" }).customizationId).toBe(
      "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0",
    );
    expect(
      mapToEn16931(makeSnapshot({ references: { orderReference: "PO-9" } }), { profile: "xrechnung" }).buyerReference,
    ).toBe("PO-9");
  });

  test("INV-10 Storno 381: positive quantities and amounts (credit-note semantics), BG-3 original, BT-81 97", () => {
    const s = makeSnapshot({
      type: "cancellation",
      original: ORIGINAL,
      lines: [item({ quantityMilli: -10_000, unitPriceMicros: 1_000_000 })],
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.typeCode).toBe("381");
    expect(inv.lines[0]).toMatchObject({ quantityMilli: 10_000, netCents: 100_000, priceMicros: 1_000_000 });
    expect(inv.totals).toMatchObject({ taxInclusiveCents: 119_000, payableCents: 119_000 });
    expect(inv.precedingInvoices).toEqual([ORIGINAL]);
    expect(inv.paymentMeans[0]?.code).toBe("97");
    const ubl = serializeEinvoice(s, "xrechnung_ubl").xml;
    expect(ubl).toContain("<CreditNote xmlns=");
    expect(ubl).toContain('<cbc:CreditedQuantity unitCode="LS">10</cbc:CreditedQuantity>');
  });

  test("INV-13 rectification 384 keeps the original amounts and references the original", () => {
    const s = makeSnapshot({
      type: "correction",
      correctionKind: "rectification",
      original: ORIGINAL,
      rectifiedFields: ["buyer.vatId"],
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.typeCode).toBe("384");
    expect(inv.totals.payableCents).toBe(119_000);
    expect(inv.precedingInvoices).toEqual([ORIGINAL]);
  });

  test("INV-09 final invoice: BT-113 prepaid and BT-115 incl. a negative payable (refund) with BT-81 58 to the refund IBAN", () => {
    const s = makeSnapshot({
      type: "final_invoice",
      chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2025-11-03" },
      documentDate: "2026-01-20",
      supplyDate: { kind: "date", date: "2026-01-15" },
      lines: [item({ unitPriceMicros: 10_000_000, vatRateBp: 700 })],
      deductions: [
        {
          advanceNumber: "RE-2025-0210",
          advanceDate: "2025-11-20",
          byGroup: [{ category: "S", rateBp: 1900, netCents: 100_000, vatCents: 19_000, grossCents: 119_000 }],
          deductedGrossCents: 119_000,
          partiallyPaid: false,
        },
      ],
      payment: { method: "transfer", dueDays: 30, refundIban: "DE89370400440532013000", showEpcQr: true },
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.totals).toMatchObject({ taxInclusiveCents: 107_000, prepaidCents: 119_000, payableCents: -12_000 });
    expect(inv.precedingInvoices).toEqual([{ number: "RE-2025-0210", date: "2025-11-20" }]);
    expect(
      inv.notes.some((n) => n.subjectCode === "AAI" && n.text.startsWith("Abzüglich Abschlagsrechnung RE-2025-0210")),
    ).toBe(true);
    expect(inv.paymentMeans[0]).toMatchObject({ code: "58", account: { iban: "DE89370400440532013000" } });
    expect(serializeEinvoice(s, "zugferd_en16931").xml).toContain(
      "<ram:DuePayableAmount>-120.00</ram:DuePayableAmount>",
    );
  });

  test("INV-24 KU: category E rate 0 with the KU note as BT-120 and no VATEX code; BT-29 = Steuernummer (BR-CO-26)", () => {
    const s = makeSnapshot({
      seller: SELLERS.ku,
      buyer: BUYERS.consumer,
      taxCase: "kleinunternehmer",
      lines: [item({ vatCategory: "KU", vatRateBp: 0 })],
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.vatBreakdown).toEqual([
      {
        baseCents: 10_000,
        vatCents: 0,
        category: "E",
        rateBp: 0,
        exemptionReason: "Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung).",
      },
    ]);
    expect(inv.lines[0]).toMatchObject({ category: "E", rateBp: 0 });
    expect(inv.seller.identifier).toBe(SELLERS.ku.taxNumber);
    expect(inv.seller.vatId).toBeUndefined();
  });

  test("UST-23 category O: no BT-31/BT-48, no line rate; BT-119 0.00 only in the XRechnung profile (BR-DE-14)", () => {
    const s = makeSnapshot({
      taxCase: "not_taxable_domestic",
      buyer: BUYERS.us,
      lines: [item({ vatCategory: "O", vatRateBp: 0 })],
    });
    const en = mapToEn16931(s, { profile: "en16931" });
    expect(en.seller.vatId).toBeUndefined();
    expect(en.buyer.vatId).toBeUndefined();
    expect(en.seller.taxNumber).toBe("1121081508150");
    expect(en.lines[0]?.rateBp).toBeNull();
    expect(en.vatBreakdown[0]).toMatchObject({ category: "O", rateBp: null, exemptionReasonCode: "VATEX-EU-O" });
    expect(mapToEn16931(s, { profile: "xrechnung" }).vatBreakdown[0]?.rateBp).toBe(0);
  });

  test("UST-20 EU service AE: VATEX-EU-AE and both VAT IDs; EN documents carry bilingual notes", () => {
    const s = makeSnapshot({
      taxCase: "eu_b2b_service",
      buyer: BUYERS.at,
      language: "en",
      lines: [item({ vatCategory: "AE", vatRateBp: 0 })],
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.vatBreakdown[0]).toMatchObject({ category: "AE", exemptionReasonCode: "VATEX-EU-AE" });
    expect(inv.buyer.vatId).toBe("ATU12345675");
    const reg = inv.notes.find((n) => n.subjectCode === "REG");
    expect(reg?.text).toMatch(/^Reverse charge.* \/ Steuerschuldnerschaft/);
  });

  test("DOC-07 document discount → BG-20 per VAT group; line discounts → BG-27 in net mode", () => {
    const s = makeSnapshot({
      lines: [
        item({ unitPriceMicros: 10_000_000, discount: { kind: "percent", bp: 1000 } }),
        item({ unitPriceMicros: 5_000_000, vatRateBp: 700 }),
      ],
      adjustment: { type: "allowance", amountCents: 10_000, reason: "Treuerabatt" },
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.lines[0]?.allowance).toMatchObject({
      amountCents: 10_000,
      baseCents: 100_000,
      percentBp: 1000,
      reasonCode: "95",
    });
    expect(inv.allowanceCharges.map((a) => [a.charge, a.amountCents, a.rateBp])).toEqual([
      [false, 6_429, 1900],
      [false, 3_571, 700],
    ]);
    expect(inv.totals.allowanceCents).toBe(10_000);
  });

  test("DOC-10 gross mode → net EN 16931 model with BT-146 derived from the line net (App. E.3 step 5)", () => {
    const s = makeSnapshot({
      priceMode: "gross",
      buyer: BUYERS.consumer,
      lines: [
        item({ quantityMilli: 3_000, unitPriceMicros: 199_900 }),
        item({ quantityMilli: 1_000, unitPriceMicros: 490_000 }),
        item({ quantityMilli: 2_000, unitPriceMicros: 107_000, vatRateBp: 700 }),
      ],
    });
    const inv = mapToEn16931(s, { profile: "en16931" });
    expect(inv.lines.map((l) => [l.netCents, l.priceMicros, l.baseQuantityMilli])).toEqual([
      [5_040, 168_000, undefined],
      [4_117, 411_700, undefined],
      [2_000, 100_000, undefined],
    ]);
    expect(inv.totals).toMatchObject({ taxExclusiveCents: 11_157, vatCents: 1_880, taxInclusiveCents: 13_037 });
  });

  test("DOC-15 foreign currency: BT-6 EUR and BT-111 VAT in EUR", () => {
    const inv = mapToEn16931(
      makeSnapshot({ currency: "USD", fx: { rate: "1.0831", source: "bmf_monthly", date: "2026-10-01" } }),
      {
        profile: "en16931",
      },
    );
    expect(inv.taxCurrency).toBe("EUR");
    expect(inv.totals.vatAccountingCurrencyCents).toBe(17_542);
  });

  test("INV-19 types without an e-invoice cannot be mapped", () => {
    expect(() =>
      mapToEn16931(makeSnapshot({ type: "quote", einvoice: { format: "none" } }), { profile: "en16931" }),
    ).toThrow(EinvoiceMappingError);
  });
});

describe("serializeEinvoice", () => {
  test("INV-19 the four profiles: syntax, guideline and embedded file name", () => {
    const s = makeSnapshot({ references: { buyerReference: "EK-1" } });
    const plan = (["zugferd_en16931", "zugferd_xrechnung", "xrechnung_cii", "xrechnung_ubl"] as const).map((f) => {
      const r = serializeEinvoice(s, f);
      return [r.format, r.syntax, r.profile, r.embeddedFileName];
    });
    expect(plan).toEqual([
      ["zugferd_en16931", "CII", "en16931", "factur-x.xml"],
      ["zugferd_xrechnung", "CII", "xrechnung", "xrechnung.xml"],
      ["xrechnung_cii", "CII", "xrechnung", null],
      ["xrechnung_ubl", "UBL", "xrechnung", null],
    ]);
    const cii = serializeEinvoice(s, "zugferd_en16931").xml;
    expect(cii).toContain("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
    expect(cii).toContain("<ram:BuyerReference>EK-1</ram:BuyerReference>");
    expect(serializeEinvoice(s, "xrechnung_cii").xml).toContain("urn:fdc:peppol.eu:2017:poacc:billing:01:1.0");
  });

  test("INV-19 BG-24 attachments are embedded base64 with MIME code and file name", () => {
    const att = { id: "Leistungsnachweis", base64: "JVBERi0=", mime: "application/pdf", filename: "nachweis.pdf" };
    const s = makeSnapshot({ references: { buyerReference: "EK-1" } });
    expect(serializeEinvoice(s, "xrechnung_ubl", { attachments: [att] }).xml).toContain(
      '<cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="nachweis.pdf">JVBERi0=</cbc:EmbeddedDocumentBinaryObject>',
    );
    expect(serializeEinvoice(s, "xrechnung_cii", { attachments: [att] }).xml).toContain(
      '<ram:AttachmentBinaryObject mimeCode="application/pdf" filename="nachweis.pdf">JVBERi0=</ram:AttachmentBinaryObject>',
    );
  });
});
