import { CII_BASIC_WL, CII_V6, UBL_CREDIT_NOTE, ublXml } from "@test/fixtures/einvoice-in/builders";
import { describe, expect, test } from "vitest";
import { checkLineVat, checkStatedTotals, computeLine, voucherTotals } from "../vouchers/lines";
import { checkAddressee } from "./addressee";
import { compareWithPdfText, pdfMismatchMessage } from "./compare-pdf";
import { parseReceivedXml } from "./parse";
import type { ReceivedInvoice } from "./received";
import { supplierEinvoiceObligation } from "./supplier-obligation";
import { germanRateFromRules, receivedToVoucherDraft } from "./to-voucher";

const inv = (xml: string): ReceivedInvoice => {
  const r = parseReceivedXml(xml);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.invoice;
};
const opts = { germanRateBp: germanRateFromRules };

/** Runs the voucher domain over the prefill (net mode) and checks EC-VOU-03 against the stated totals. */
function booked(draft: ReturnType<typeof receivedToVoucherDraft>) {
  const lines = draft.input.lines.map((l) => ({
    ...computeLine(
      {
        amountCents: l.amountCents,
        vatRateBp: l.vatRateBp,
        ...(l.vatCents !== undefined ? { vatCents: l.vatCents } : {}),
      },
      "net",
      draft.input.taxRule,
    ),
    vatRateBp: l.vatRateBp,
  }));
  const totals = voucherTotals(lines);
  return { totals, mismatch: checkStatedTotals(totals, draft.input.statedTotals), lines };
}

describe("receivedToVoucherDraft (INB-043)", () => {
  test("INB-043 T06-041 golden V6: lines grouped by (category, rate) net of the document allowance; Σ equals BG-23", () => {
    const d = receivedToVoucherDraft(inv(CII_V6), opts);
    expect(d.input).toMatchObject({
      direction: "expense",
      supplierName: "Bürobedarf Schmidt & Söhne GmbH",
      supplierVatId: "DE811569869",
      supplierTaxNumber: "215/5432/1098",
      supplierAddress: "Domstraße 1, 50667 Köln",
      supplierIban: "DE02120300000000202051",
      documentNumber: "LF-2026-0815",
      documentDate: "2026-10-05",
      supplyDate: { kind: "date", date: "2026-10-01" },
      dueDate: "2026-11-04",
      currency: "EUR",
      priceMode: "net",
      taxRule: "input_vat_deductible",
      skontoTerms: { percentBp: 200, days: 14 },
      statedTotals: {
        grossCents: 16_060,
        byRate: [
          { rateBp: 1900, netCents: 9000, vatCents: 1710 },
          { rateBp: 700, netCents: 5000, vatCents: 350 },
        ],
      },
    });
    expect(d.input.lines).toEqual([
      { account: "", description: "Druckerpapier A4", amountCents: 9000, vatRateBp: 1900, vatCents: 1710 },
      { account: "", description: "Fachbuch Buchhaltung", amountCents: 5000, vatRateBp: 700, vatCents: 350 },
    ]);
    expect(d.payee).toEqual({ name: "Schmidt GmbH", iban: "DE02120300000000202051", bic: "BYLADEM1001" });
    expect(d.creditNote).toBe(false);
    const b = booked(d);
    expect(b.totals.grossCents).toBe(16_060);
    expect(b.mismatch).toBeNull();
    for (const l of b.lines) expect(checkLineVat(l, l.vatRateBp)).toBeNull();
  });

  test("INB-043 „Positionen einzeln übernehmen“: one line per BG-25 plus the allowance line", () => {
    const d = receivedToVoucherDraft(inv(CII_V6), { ...opts, perLine: true });
    expect(d.input.lines.map((l) => [l.description, l.amountCents, l.vatRateBp, l.quantityMilli])).toEqual([
      ["Druckerpapier A4 – 80 g/m², 5 Kartons", 10_000, 1900, 5000],
      ["Fachbuch Buchhaltung", 5000, 700, 1000],
      ["Treuerabatt", -1000, 1900, undefined],
    ]);
    expect(booked(d).mismatch).toBeNull();
  });

  test("INB-043 VOU-012 T06-043 a 381 credit note becomes a negative voucher linked via BT-25", () => {
    const d = receivedToVoucherDraft(inv(UBL_CREDIT_NOTE), opts);
    expect(d.creditNote).toBe(true);
    expect(d.precedingInvoiceNumber).toBe("R-100");
    expect(d.input.lines).toEqual([
      { account: "", description: "Rücknahme Monitor", amountCents: -10_000, vatRateBp: 1900, vatCents: -1900 },
    ]);
    expect(d.input.statedTotals.grossCents).toBe(-11_900);
    expect(booked(d).mismatch).toBeNull();
  });

  test("INB-043 VOU-022 reverse charge (AE): German rate on the supply date, no VAT shown, rule by seller country", () => {
    const base = inv(CII_V6);
    const rc: ReceivedInvoice = {
      ...base,
      seller: { ...base.seller, vatId: "IE6388047V", address: { countryCode: "IE", city: "Dublin" } },
      lines: [{ ...(base.lines[0] as ReceivedInvoice["lines"][number]), category: "AE", rateBp: 0, netCents: 100_000 }],
      allowancesCharges: [],
      vatBreakdown: [
        { category: "AE", rateBp: 0, taxableCents: 100_000, taxCents: 0, exemptionReason: "Reverse charge" },
      ],
      totals: {
        ...base.totals,
        taxCents: 0,
        taxExclusiveCents: 100_000,
        taxInclusiveCents: 100_000,
        payableCents: 100_000,
      },
    };
    const d = receivedToVoucherDraft(rc, opts);
    expect(d.input.taxRule).toBe("reverse_charge_eu");
    expect(d.input.lines).toEqual([
      { account: "", description: "Druckerpapier A4", amountCents: 100_000, vatRateBp: 1900 },
    ]);
    expect(d.warnings.map((w) => w.code)).toContain("einvoice_self_assessment_rate");
    const b = booked(d);
    expect(b.totals.selfAssessedVatCents).toBe(19_000);
    expect(b.mismatch).toBeNull();
    const de = receivedToVoucherDraft({ ...rc, seller: { ...rc.seller, address: { countryCode: "DE" } } }, opts);
    expect(de.input.taxRule).toBe("reverse_charge_13b_de");
    const us = receivedToVoucherDraft(
      { ...rc, seller: { ...rc.seller, vatId: undefined as never, address: { countryCode: "US" } } },
      opts,
    );
    expect(us.input.taxRule).toBe("reverse_charge_non_eu");
    const k = receivedToVoucherDraft(
      {
        ...rc,
        vatBreakdown: [{ ...(rc.vatBreakdown[0] as ReceivedInvoice["vatBreakdown"][number]), category: "K" }],
        lines: [],
      },
      opts,
    );
    expect(k.input.taxRule).toBe("intra_community_acquisition");
  });

  test("INB-043 KU supplier (E with § 19 hint) → kleinunternehmer_supplier; other exemptions → no_input_vat", () => {
    const base = inv(CII_V6);
    const ku: ReceivedInvoice = {
      ...base,
      lines: [],
      allowancesCharges: [],
      vatBreakdown: [
        {
          category: "E",
          rateBp: 0,
          taxableCents: 5000,
          taxCents: 0,
          exemptionReason: "Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG",
        },
      ],
    };
    expect(receivedToVoucherDraft(ku, opts).input.taxRule).toBe("kleinunternehmer_supplier");
    const exempt = {
      ...ku,
      vatBreakdown: [
        { ...(ku.vatBreakdown[0] as ReceivedInvoice["vatBreakdown"][number]), exemptionReason: "§ 4 Nr. 8 UStG" },
      ],
    };
    expect(receivedToVoucherDraft(exempt as ReceivedInvoice, opts).input.taxRule).toBe("no_input_vat");
  });

  test("INB-043 BASIC-WL (no lines) prefills from BG-23; foreign currency and prepaid amounts are warned", () => {
    const d = receivedToVoucherDraft(inv(CII_BASIC_WL), opts);
    expect(d.input.lines).toEqual([
      { account: "", description: "Rechnungsbetrag 19 %", amountCents: 5000, vatRateBp: 1900, vatCents: 950 },
    ]);
    const base = inv(CII_V6);
    const usd: ReceivedInvoice = {
      ...base,
      currency: "USD",
      vatCurrency: "EUR",
      taxTotalVatCurrencyCents: 1899,
      totals: { ...base.totals, prepaidCents: 5000 },
    };
    const w = receivedToVoucherDraft(usd, opts);
    expect(w.input.currency).toBe("USD");
    expect(w.warnings.map((x) => x.code)).toEqual(["einvoice_vat_currency", "einvoice_prepaid"]);
    expect(w.warnings[0]?.message).toContain("18,99 €");
    expect(w.prepaidCents).toBe(5000);
  });

  test("INB-043 MINIMUM without breakdown: one line only when the VAT matches a German rate", () => {
    const base = inv(CII_BASIC_WL);
    const minimum: ReceivedInvoice = { ...base, profile: "MINIMUM", vatBreakdown: [] };
    expect(receivedToVoucherDraft(minimum, opts).input.lines).toHaveLength(1);
    const odd = { ...minimum, totals: { ...minimum.totals, taxCents: 777 } };
    expect(receivedToVoucherDraft(odd, opts).input.lines).toEqual([]);
  });

  test("INB-043 the period (BG-14) becomes the supply period", () => {
    const base = inv(ublXml());
    const d = receivedToVoucherDraft(
      { ...base, supplyDate: undefined as never, period: { from: "2026-09-01", to: "2026-09-30" } },
      opts,
    );
    expect(d.input.supplyDate).toEqual({ kind: "period", from: "2026-09-01", to: "2026-09-30" });
  });
});

describe("addressee check (INB-044, EC-INB-08)", () => {
  const company = { name: "Muster Design GmbH", tradeName: "Muster Design", vatId: "DE123456788" };

  test("INB-044 T06-044 matching name (legal form, case, punctuation) and VAT ID → no warning", () => {
    expect(checkAddressee({ name: "MUSTER DESIGN GmbH", vatId: "DE 123 456 788" }, company)).toBeNull();
    expect(checkAddressee({ name: "Muster Design GmbH – Buchhaltung" }, company)).toBeNull();
    expect(checkAddressee({}, company)).toBeNull();
  });

  test("INB-044 T06-044 EC-INB-08 a different buyer → warning with the buyer named", () => {
    expect(checkAddressee({ name: "Andere Firma KG", vatId: "DE811907980" }, company)).toEqual({
      code: "einvoice_wrong_addressee",
      message:
        "Die Rechnung ist nicht an Ihr Unternehmen adressiert (Empfänger: Andere Firma KG, DE811907980). Vorsteuerabzug gefährdet.",
    });
    expect(checkAddressee({ name: "Muster Design GmbH", vatId: "DE999999999" }, company)?.code).toBe(
      "einvoice_wrong_addressee",
    );
  });
});

describe("supplier E-Rechnung obligation (INB-047, ER-03 inverse, EC-INB-10)", () => {
  const base = { isEInvoice: false, supplierCountryCode: "DE", supplierIsKu: false, b2b: true, grossEurCents: 50_000 };

  test("INB-047 T06-047 EC-102 PDF from a domestic supplier, supply 2028-02-01, 500 € → warning", () => {
    expect(supplierEinvoiceObligation({ ...base, supplyEnd: "2028-02-01" })).toEqual({
      severity: "warning",
      code: "einvoice_required_from_supplier",
      message:
        "Für Leistungen ab 01.01.2028 muss ein inländischer Lieferant eine E-Rechnung ausstellen. Eine PDF-Rechnung berechtigt nicht zum Vorsteuerabzug. Bitte E-Rechnung anfordern.",
    });
  });

  test("INB-047 T06-047 supply in 2027 → info (turnover unknown); 2026 → nothing", () => {
    expect(supplierEinvoiceObligation({ ...base, supplyEnd: "2027-06-30" })?.severity).toBe("info");
    expect(supplierEinvoiceObligation({ ...base, supplyEnd: "2026-10-01" })).toBeNull();
  });

  test("INB-047 T06-047 the supply date counts, not the invoice date; exemptions: ≤ 250 €, KU, abroad, E-Rechnung, Fahrausweis, private", () => {
    expect(supplierEinvoiceObligation({ ...base, supplyEnd: "2027-12-31" })?.severity).toBe("info");
    const y28 = { ...base, supplyEnd: "2028-03-01" };
    expect(supplierEinvoiceObligation({ ...y28, grossEurCents: 25_000 })).toBeNull();
    expect(supplierEinvoiceObligation({ ...y28, grossEurCents: 25_001 })?.severity).toBe("warning");
    expect(supplierEinvoiceObligation({ ...y28, supplierIsKu: true })).toBeNull();
    expect(supplierEinvoiceObligation({ ...y28, supplierCountryCode: "AT" })).toBeNull();
    expect(supplierEinvoiceObligation({ ...y28, isEInvoice: true })).toBeNull();
    expect(supplierEinvoiceObligation({ ...y28, isFahrausweis: true })).toBeNull();
    expect(supplierEinvoiceObligation({ ...y28, b2b: false })).toBeNull();
  });
});

describe("XML vs. PDF text (EC-INB-15, EC-101)", () => {
  const v6 = () => inv(CII_V6);

  test("EC-INB-15 EC-101 T06-030a PDF shows gross 1.190,00 but the XML 160,60 → „Bruttobetrag“ listed", () => {
    const text =
      "Rechnung\nRechnungsnummer: LF-2026-0815\nRechnungsdatum: 05.10.2026\nGesamtbetrag 1.190,00 €\nIBAN DE02 1203 0000 0000 2020 51";
    expect(compareWithPdfText(v6(), text)).toEqual(["Bruttobetrag"]);
    expect(pdfMismatchMessage(["Bruttobetrag"])).toBe(
      "PDF-Darstellung und XML weichen ab (Bruttobetrag). Maßgeblich ist die XML; bitte ggf. Korrektur beim Lieferanten anfordern.",
    );
  });

  test("EC-INB-15 matching texts and texts without recognisable values → no differences", () => {
    expect(
      compareWithPdfText(
        v6(),
        "Rechnungsnummer LF-2026-0815 Datum 2026-10-05 Rechnungsbetrag: EUR 160,60 IBAN DE02120300000000202051",
      ),
    ).toEqual([]);
    expect(compareWithPdfText(v6(), "Total 160.60")).toEqual([]);
    expect(compareWithPdfText(v6(), "Vielen Dank für Ihren Einkauf")).toEqual([]);
    expect(compareWithPdfText(v6(), "")).toEqual([]);
  });

  test("EC-INB-15 number, date and IBAN differences are listed", () => {
    const text =
      "Rechnungs-Nr.: LF-2026-0999\nRechnungsdatum 06.10.2026\nGesamtbetrag 160,60\nIBAN DE89 3704 0044 0532 0130 00";
    expect(compareWithPdfText(v6(), text)).toEqual(["Rechnungsnummer", "Rechnungsdatum", "IBAN"]);
  });
});
