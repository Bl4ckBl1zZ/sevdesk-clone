import { BUYERS, makeSnapshot, SELLERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import type { SnapshotInputItem } from "./build-snapshot";
import { buildRenderModel, DEFAULT_LAYOUT, layoutFromConfig, type RenderLayout } from "./render-model";

const SEVDESK: RenderLayout = { ...DEFAULT_LAYOUT, template: "sevdesk" };

const kuItem = (over: Partial<SnapshotInputItem> = {}): SnapshotInputItem => ({
  kind: "item",
  name: "Dose",
  quantityMilli: 6_000,
  unitCode: "C62",
  unitLabel: "Stk",
  unitPriceMicros: 120_000,
  vatCategory: "KU",
  vatRateBp: 0,
  ...over,
});

const ku = (lines: SnapshotInputItem[] = [kuItem()]) =>
  makeSnapshot({
    seller: SELLERS.ku,
    buyer: { ...BUYERS.b2b, contactPerson: { name: "Max Beispiel" } },
    taxCase: "kleinunternehmer",
    einvoice: { format: "none", decision: "NOT_REQUIRED" },
    lines,
  });

describe("template sevdesk (SET-071, DOC-30)", () => {
  test("SET-071 the stored template survives layoutFromConfig", () => {
    expect(layoutFromConfig(SEVDESK).template).toBe("sevdesk");
  });

  test("DOC-30 the other templates keep their wording (a Kopie of an issued document does not change, SET-E20)", () => {
    const m = buildRenderModel(ku(), DEFAULT_LAYOUT);
    expect(m.documentDate).toBeUndefined();
    expect(m.columns.map((c) => c.label)).toContain("Einheit");
    expect(m.senderLine).toContain(" · ");
    expect(m.labelledFooter).toBeUndefined();
  });

  test("DOC-30 the position table has one Menge cell, EUR amounts and no Einheit column", () => {
    const m = buildRenderModel(ku(), SEVDESK);
    expect(m.columns.map((c) => [c.key, c.label])).toEqual([
      ["pos", ""],
      ["name", "Beschreibung"],
      ["quantity", "Menge"],
      ["unitPrice", "Einzelpreis"],
      ["amount", "Gesamtpreis"],
    ]);
    expect(m.rows[0]).toMatchObject({ pos: "1.", quantity: "6,00 Stk", unitPrice: "12,00 EUR", amount: "72,00 EUR" });
  });

  test("DOC-30 a line discount prints under the amount, the percentage and the amount both visible", () => {
    const m = buildRenderModel(
      ku([kuItem({ quantityMilli: 10_000, unitPriceMicros: 80_000, discount: { kind: "percent", bp: 1000 } })]),
      SEVDESK,
    );
    expect(m.columns.map((c) => c.key)).not.toContain("discount");
    expect(m.rows[0]).toMatchObject({ amount: "72,00 EUR", discountNote: "(Rabatt 10%\n8,00 EUR)" });
  });

  test("DOC-30 an amount discount names only the amount", () => {
    const m = buildRenderModel(
      ku([kuItem({ quantityMilli: 2_000, unitPriceMicros: 100_000, discount: { kind: "amount", cents: 500 } })]),
      SEVDESK,
    );
    expect(m.rows[0]).toMatchObject({ amount: "15,00 EUR", discountNote: "(Rabatt 5,00 EUR)" });
  });

  test("KU-02 Kleinunternehmer: the §19 note stands between the bands, no VAT amount is printed", () => {
    const m = buildRenderModel(ku(), SEVDESK);
    expect(m.totals.map((t) => [t.emphasis, t.label, t.value])).toEqual([
      ["band", "Gesamtbetrag netto", "72,00 EUR"],
      ["note", expect.stringContaining("§ 19"), ""],
      ["strong", "Gesamtbetrag brutto", "72,00 EUR"],
    ]);
    expect(m.legalNotes).toEqual([]);
    expect(m.totals.map((t) => t.label).join(" ")).not.toMatch(/zzgl|USt auf/);
  });

  test("UST-10 regular taxation keeps the VAT line per rate between the bands", () => {
    const m = buildRenderModel(makeSnapshot(), SEVDESK);
    expect(m.totals[0]).toMatchObject({ emphasis: "band", label: "Gesamtbetrag netto" });
    expect(m.totals.some((t) => t.label.startsWith("zzgl. 19 % USt auf"))).toBe(true);
    expect(m.totals.at(-1)).toMatchObject({ emphasis: "strong", label: "Gesamtbetrag brutto" });
  });

  test("UST-07 regular taxation still says whether the line prices are net or gross", () => {
    const labels = buildRenderModel(makeSnapshot(), SEVDESK).columns.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["Einzelpreis netto", "Gesamtpreis netto"]));
  });

  test("DOC-30 the info block has sevdesk's labels; number, dates, customer number and the buyer's VAT ID stay", () => {
    const m = buildRenderModel(ku(), SEVDESK);
    const label = (l: string) => m.info.find((i) => i.label === l)?.value;
    expect(m.info.map((i) => i.label)).toEqual([
      "Rechnungs-Nr.",
      "Rechnungsdatum",
      "Lieferdatum",
      "Ihre Kundennummer",
      "Ihre USt-ID.",
      "Ihr Ansprechpartner",
    ]);
    expect(label("Rechnungs-Nr.")).toBe(m.number);
    expect(label("Ihre USt-ID.")).toBe(BUYERS.b2b.vatId);
    expect(label("Ihr Ansprechpartner")).toBe("Lena Kleinert\nhallo@kleinert-foto.de");
  });

  test("DOC-30 title row carries the date; the sender line uses arrows and the seller's Germany is spelled out", () => {
    const m = buildRenderModel(ku(), SEVDESK);
    expect(m.title).toBe("Rechnung Nr.");
    expect(m.documentDate).toBe(m.info[1]?.value);
    expect(m.senderLine).toBe("Lena Kleinert Fotografie → Gartenweg 3 → 04109 Leipzig");
    expect(m.recipient).toEqual(["Beispiel Kunde GmbH", "Max Beispiel", "Musterweg 5", "50667 Köln", "Deutschland"]);
  });

  test("MISC-01 the bank details move to the footer; without a footer they stay in the document", () => {
    const m = buildRenderModel(ku(), SEVDESK);
    expect(m.payment.bank).toBeUndefined();
    expect(m.labelledFooter?.flat().map((f) => f.label)).toContain("IBAN");

    const letterhead: RenderLayout = {
      ...SEVDESK,
      printOptions: {
        ...SEVDESK.printOptions,
        footerInLetterhead: { confirmedAt: 1, items: ["Firma", "Name", "Anschrift"] },
      },
    };
    const hidden = buildRenderModel(ku(), letterhead);
    expect(hidden.footer).toBeNull();
    expect(hidden.labelledFooter).toBeUndefined();
    expect(hidden.payment.bank?.map((b) => b.label)).toContain("IBAN");
  });

  test("ER-10 a Bestellnummer and a Käuferreferenz stay two distinguishable rows", () => {
    const base = ku();
    const m = buildRenderModel(
      { ...base, references: { ...base.references, orderReference: "PO-1", buyerReference: "BR-2" } },
      SEVDESK,
    );
    const labels = m.info.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(m.info.find((i) => i.label === "Referenz")?.value).toBe("PO-1");
    expect(m.info.map((i) => i.value)).toContain("BR-2");
  });

  test("DOC-16 English documents get the same design in English", () => {
    const m = buildRenderModel(makeSnapshot({ language: "en" }), SEVDESK);
    expect(m.title).toBe("Invoice no.");
    expect(m.info[0]?.label).toBe("Invoice no.");
    expect(m.columns.map((c) => c.label)).toEqual(["", "Description", "Qty", "Unit price (net)", "Amount (net)"]);
  });

  test("DOC-32 stamp and watermark of a Kopie are independent of the template", () => {
    const m = buildRenderModel(ku(), SEVDESK, "copy");
    expect(m.stamp).toBe("Kopie");
    expect(m.watermark).toBe("Kopie");
  });
});
