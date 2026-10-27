import { BUYERS, makeSnapshot, SELLERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { paymentMeansFor, paymentTermsText } from "../einvoice/payment";
import { girocodeFor } from "../epc/girocode";
import type { SnapshotInputItem } from "./build-snapshot";
import { buildRenderModel, DEFAULT_LAYOUT, type RenderLayout } from "./render-model";
import { PREVIEW_NUMBER } from "./snapshot";

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
const layout = (print: Partial<RenderLayout["printOptions"]>): RenderLayout => ({
  ...DEFAULT_LAYOUT,
  printOptions: { ...DEFAULT_LAYOUT.printOptions, ...print },
});

describe("buildRenderModel (App. F)", () => {
  test("DOC-30 invoice: title, info block, VAT lines per group, payment block with bank and EPC payload", () => {
    const m = buildRenderModel(makeSnapshot());
    expect(m.title).toBe("Rechnung");
    expect(m.info.map((i) => i.label)).toEqual([
      "Nummer",
      "Rechnungsdatum",
      "Leistungsdatum",
      "Kundennummer",
      "Ansprechpartner",
      "Telefon",
      "E-Mail",
    ]);
    expect(m.recipient).toEqual(["Beispiel Kunde GmbH", "z. Hd. Max Beispiel", "Musterweg 5", "50667 Köln"]);
    expect(m.totals).toEqual([
      { label: "Summe netto", value: "1.000,00 €" },
      { label: "zzgl. 19 % USt auf 1.000,00 €", value: "190,00 €" },
      { label: "Gesamtbetrag", value: "1.190,00 €", emphasis: "strong" },
    ]);
    expect(m.payment.bank?.[1]).toEqual({ label: "IBAN", value: "DE89 3704 0044 0532 0130 00" });
    expect(m.payment.epcPayload).toContain("EUR1190.00");
    expect(m.einvoiceHint).toBe("Diese Rechnung enthält eine E-Rechnung nach EN 16931 (ZUGFeRD 2.5).");
    expect(m.columns.map((c) => c.key)).toEqual(["pos", "name", "quantity", "unit", "unitPrice", "amount"]);
  });

  test("DOC-30 the VAT column appears for mixed rates or the print option; KU never shows VAT", () => {
    const mixed = buildRenderModel(makeSnapshot({ lines: [item(), item({ vatRateBp: 700 })] }));
    expect(mixed.columns.map((c) => c.key)).toContain("vat");
    expect(buildRenderModel(makeSnapshot(), layout({ vatPerLine: true })).columns.map((c) => c.key)).toContain("vat");
    const ku = buildRenderModel(
      makeSnapshot({
        seller: SELLERS.ku,
        taxCase: "kleinunternehmer",
        lines: [item({ vatCategory: "KU", vatRateBp: 0 })],
        einvoice: { format: "none" },
      }),
      layout({ vatPerLine: true }),
    );
    expect(ku.columns.map((c) => c.key)).not.toContain("vat");
    expect(ku.totals).toEqual([{ label: "Gesamtbetrag", value: "100,00 €", emphasis: "strong" }]);
    expect(ku.legalNotes[0]).toContain("§ 19");
  });

  test("DOC-31 the Geschäftsbrief footer on every type; hidden only when the letterhead confirms all items", () => {
    const m = buildRenderModel(makeSnapshot({ type: "quote", einvoice: { format: "none" } }));
    expect(m.footer?.flat()).toEqual(expect.arrayContaining(["Sitz: Berlin", "HRB 123456 B"]));
    const letterhead = layout({
      footerInLetterhead: { confirmedAt: 1, items: ["Firma", "Sitz", "Registergericht", "HRB", "Geschäftsführer"] },
    });
    expect(buildRenderModel(makeSnapshot(), letterhead).footer).toBeNull();
    expect(
      buildRenderModel(makeSnapshot(), layout({ footerInLetterhead: { confirmedAt: 1, items: ["Firma"] } })).footer,
    ).not.toBeNull();
  });

  test("DOC-32 Kopie stamp + watermark, Lesefassung stamp and draft watermark", () => {
    expect(buildRenderModel(makeSnapshot(), DEFAULT_LAYOUT, "copy")).toMatchObject({
      stamp: "Kopie",
      watermark: "Kopie",
    });
    expect(buildRenderModel(makeSnapshot({ language: "en" }), DEFAULT_LAYOUT, "copy").stamp).toBe("Copy / Kopie");
    expect(buildRenderModel(makeSnapshot(), DEFAULT_LAYOUT, "reading").stamp).toBe(
      "Lesefassung – maßgeblich ist die XRechnung",
    );
    expect(buildRenderModel(makeSnapshot(), DEFAULT_LAYOUT, "draft")).toMatchObject({
      stamp: "ENTWURF – keine gültige Rechnung",
      watermark: "ENTWURF",
    });
    const original = buildRenderModel(makeSnapshot());
    expect(original.stamp).toBeUndefined();
    expect(original.watermark).toBeUndefined();
  });

  test("DOC-42 a draft preview shows „Entwurf“ instead of the placeholder number", () => {
    const m = buildRenderModel(makeSnapshot({ number: PREVIEW_NUMBER }), DEFAULT_LAYOUT, "draft");
    expect(m.number).toBe("Entwurf");
    expect(m.info[0]).toEqual({ label: "Nummer", value: "Entwurf" });
    expect(m.meta.title).not.toContain(PREVIEW_NUMBER);
    expect(
      buildRenderModel(makeSnapshot({ number: PREVIEW_NUMBER, language: "en" }), DEFAULT_LAYOUT, "draft").number,
    ).toBe("Draft");
    // the payment reference names the future number, and no GiroCode carries the placeholder
    expect(m.payment.lines.join("\n")).not.toContain(PREVIEW_NUMBER);
    expect(m.payment.lines.join("\n")).toContain("Rechnungsnummer (wird bei Fertigstellung vergeben)");
    expect(m.payment.epcPayload).toBeNull();
    // a real number (e.g. a finalised document rendered as draft in tests) stays as it is
    expect(buildRenderModel(makeSnapshot(), DEFAULT_LAYOUT, "draft").number).toBe("RE-2026-0042");
  });

  test("DOC-16 English documents: labels, formats, country line and bilingual legal notes", () => {
    const m = buildRenderModel(
      makeSnapshot({
        language: "en",
        taxCase: "eu_b2b_service",
        buyer: BUYERS.at,
        lines: [item({ vatCategory: "AE", vatRateBp: 0 })],
      }),
    );
    expect(m.title).toBe("Invoice");
    expect(m.info[1]).toEqual({ label: "Invoice date", value: "12 Oct 2026" });
    expect(m.recipient.at(-1)).toBe("AUSTRIA");
    expect(m.info).toEqual(expect.arrayContaining([{ label: "Your VAT ID", value: "ATU12345675" }]));
    expect(m.legalNotes[1]?.startsWith("/ Steuerschuldnerschaft")).toBe(true);
    expect(m.pageLabel).toEqual({ page: "Page", of: "of" });
  });

  test("UST-41 final invoice: one deduction row per advance and rate with net and VAT, then the payable", () => {
    const m = buildRenderModel(
      makeSnapshot({
        type: "final_invoice",
        chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2026-08-03" },
        flags: { chainIndex: 2 },
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
      }),
    );
    expect(m.title).toBe("Schlussrechnung");
    expect(m.totals.slice(-2)).toEqual([
      {
        label: "abzgl. Abschlagsrechnung RE-2026-0031 vom 10.08.2026: netto 3.000,00 € zzgl. 19 % USt 570,00 €",
        value: "-3.570,00 €",
      },
      { label: "Zahlbetrag", value: "8.330,00 €", emphasis: "strong" },
    ]);
  });

  test("DOC-30 delivery notes without prices; quotes with optional lines in parentheses and validity", () => {
    const dn = buildRenderModel(makeSnapshot({ type: "delivery_note", einvoice: { format: "none" } }));
    expect(dn.columns.map((c) => c.key)).toEqual(["pos", "name", "quantity", "unit"]);
    expect(dn.totals).toEqual([]);
    expect(dn.info.find((i) => i.label === "Lieferdatum")?.value).toBe("09.10.2026");
    const quote = buildRenderModel(
      makeSnapshot({
        type: "quote",
        validUntil: "2026-11-11",
        einvoice: { format: "none" },
        lines: [item(), item({ optional: true, name: "SEO" })],
      }),
    );
    const optional = quote.rows[1];
    expect(optional?.kind === "item" && [optional.name, optional.amount]).toEqual(["Optional: SEO", "(100,00 €)"]);
    expect(quote.info).toEqual(expect.arrayContaining([{ label: "Gültig bis", value: "11.11.2026" }]));
    expect(quote.payment.epcPayload).toBeNull();
  });

  test("DOC-30 refunds and zero amounts print the matching payment line instead of bank details", () => {
    const refund = buildRenderModel(
      makeSnapshot({
        type: "final_invoice",
        chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2026-08-03" },
        lines: [item()],
        deductions: [
          {
            advanceNumber: "RE-1",
            advanceDate: "2026-08-10",
            byGroup: [{ category: "S", rateBp: 1900, netCents: 20_000, vatCents: 3_800, grossCents: 23_800 }],
            deductedGrossCents: 23_800,
            partiallyPaid: false,
          },
        ],
      }),
    );
    expect(refund.payment.lines).toContain("Der Betrag wird erstattet.");
    expect(refund.payment.bank).toBeUndefined();
    expect(refund.totals.at(-1)).toMatchObject({ label: "Erstattungsbetrag", value: "-119,00 €" });
  });

  test("DOC-30 print options: product numbers, line descriptions, sender line, EPC-QR", () => {
    const s = makeSnapshot({ lines: [item({ itemNumber: "A-1", description: "Details" })] });
    const off = buildRenderModel(
      s,
      layout({ productNumbers: false, lineDescriptions: false, senderLine: false, epcQr: false }),
    );
    const row = off.rows[0];
    expect(row?.kind === "item" && [row.itemNumber, row.description]).toEqual([undefined, undefined]);
    expect(off.senderLine).toBeUndefined();
    expect(off.payment.epcPayload).toBeNull();
    const on = buildRenderModel(s, layout({ productNumbers: true }));
    const r2 = on.rows[0];
    expect(r2?.kind === "item" && [r2.itemNumber, r2.description]).toEqual(["Art.-Nr. A-1", "Details"]);
    expect(on.senderLine).toBe("Muster Design GmbH · Hauptstraße 1 · 10115 Berlin");
  });
});

describe("consumer gross prices (DOC-48, MISC-03, PAngV)", () => {
  test("DOC-48 MISC-03 a consumer document entered net still prints gross unit prices and gross line amounts", () => {
    const s = makeSnapshot({ buyer: BUYERS.consumer, priceMode: "net", lines: [item({ unitPriceMicros: 2_100_800 })] });
    const m = buildRenderModel(s);
    expect(m.columns.map((c) => c.label)).toEqual(expect.arrayContaining(["Einzelpreis brutto", "Gesamt brutto"]));
    const row = m.rows[0];
    expect(row?.kind === "item" && [row.unitPrice, row.amount]).toEqual(["250,00 €", "250,00 €"]);
    expect(m.totals.at(-1)).toMatchObject({ label: "Gesamtbetrag", value: "250,00 €" });
    // businesses keep net columns; delivery notes have no prices at all
    const b2b = buildRenderModel(makeSnapshot({ priceMode: "net", lines: [item()] }));
    expect(b2b.columns.map((c) => c.label)).toEqual(expect.arrayContaining(["Einzelpreis netto", "Gesamt netto"]));
    const quote = buildRenderModel(
      makeSnapshot({
        type: "quote",
        buyer: BUYERS.consumer,
        priceMode: "net",
        einvoice: { format: "none" },
        lines: [item()],
      }),
    );
    expect(quote.columns.map((c) => c.label)).toContain("Einzelpreis brutto");
  });
});

describe("payable ≤ 0 (INV-33, MISC-01)", () => {
  const consumerFinal = (deductedNet: number) => {
    const vat = Math.round(deductedNet * 0.19);
    return makeSnapshot({
      type: "final_invoice",
      buyer: BUYERS.consumer,
      priceMode: "gross",
      chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2026-08-03" },
      lines: [item({ unitPriceMicros: 11_900_000 })],
      deductions: [
        {
          advanceNumber: "RE-1",
          advanceDate: "2026-08-10",
          byGroup: [
            { category: "S", rateBp: 1900, netCents: deductedNet, vatCents: vat, grossCents: deductedNet + vat },
          ],
          deductedGrossCents: deductedNet + vat,
          partiallyPaid: false,
        },
      ],
    });
  };

  test("INV-33 a consumer refund: no EPC QR, no § 286 note, „Der Betrag wird erstattet“, BT-81 97 or 58", () => {
    const s = consumerFinal(200_000);
    expect(s.totals.payableCents).toBeLessThan(0);
    expect(girocodeFor(s)).toBeNull();
    expect(s.notes.map((n) => n.id)).not.toContain("b2c_286");
    const m = buildRenderModel(s);
    expect(m.payment.epcPayload).toBeNull();
    expect(m.payment.lines).toContain("Der Betrag wird erstattet.");
    expect(m.payment.bank).toBeUndefined();
    expect(paymentMeansFor(s).code).toBe("97");
    expect(paymentMeansFor({ ...s, payment: { ...s.payment, refundIban: "DE89370400440532013000" } }).code).toBe("58");
    expect(paymentTermsText(s)).toBe("Der Betrag wird erstattet oder verrechnet.");
  });

  test("INV-33 payable exactly 0: „Kein Zahlbetrag“, no QR, no § 286 note, BT-81 97", () => {
    const s = consumerFinal(100_000);
    expect(s.totals.payableCents).toBe(0);
    expect(girocodeFor(s)).toBeNull();
    expect(s.notes.map((n) => n.id)).not.toContain("b2c_286");
    expect(buildRenderModel(s).payment.lines).toContain("Kein Zahlbetrag.");
    expect(paymentMeansFor(s).code).toBe("97");
    // the same consumer invoice with an amount due keeps the QR and the § 286 note
    const due = makeSnapshot({ buyer: BUYERS.consumer, priceMode: "gross" });
    expect(girocodeFor(due)).not.toBeNull();
    expect(due.notes.map((n) => n.id)).toContain("b2c_286");
  });
});
