import {
  CII_BASIC_WL,
  CII_V6,
  ciiXml,
  outboundModel,
  UBL_CREDIT_NOTE,
  ublXml,
} from "@test/fixtures/einvoice-in/builders";
import { describe, expect, test } from "vitest";
import { invoiceSyntaxOf, parseReceivedXml } from "./parse";
import { detectProfile, notEInvoiceMessage } from "./profile";
import { parseSkontoTerms } from "./skonto";

const parsed = (xml: string) => {
  const r = parseReceivedXml(xml);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe("parseReceivedXml — UBL and CII (INB-021, ER-02)", () => {
  test("INB-021 ER-02 T06-021 an XRechnung UBL written by our own serializer parses into the EN 16931 model", () => {
    const { invoice } = parsed(ublXml());
    expect(invoice).toMatchObject({
      syntax: "ubl",
      profile: "XRECHNUNG",
      notEInvoice: false,
      typeCode: "380",
      number: "RE-2026-0042",
      issueDate: "2026-10-12",
      dueDate: "2026-11-11",
      currency: "EUR",
      seller: { name: "Muster Design GmbH", vatId: "DE123456788", taxNumber: "1121081508150" },
      buyer: { name: "Beispiel Kunde GmbH", vatId: "DE811907980" },
      totals: { lineTotalCents: 100_000, taxCents: 19_000, taxInclusiveCents: 119_000, payableCents: 119_000 },
      vatBreakdown: [{ category: "S", rateBp: 1900, taxableCents: 100_000, taxCents: 19_000 }],
    });
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]).toMatchObject({ netCents: 100_000, category: "S", rateBp: 1900, quantityMilli: 10_000 });
    expect(invoice.payment.iban).toMatch(/^DE\d{20}$/);
    // plain JSON: no undefined values anywhere
    expect(JSON.parse(JSON.stringify(invoice))).toEqual(invoice);
  });

  test("INB-021 ER-02 T06-021 the same invoice as CII parses to the same values", () => {
    const ubl = parsed(ublXml()).invoice;
    const cii = parsed(ciiXml()).invoice;
    expect(cii.syntax).toBe("cii");
    expect(cii.profile).toBe("XRECHNUNG");
    for (const k of ["number", "issueDate", "dueDate", "currency", "totals", "vatBreakdown"] as const) {
      expect(cii[k]).toEqual(ubl[k]);
    }
    expect(cii.seller.vatId).toBe(ubl.seller.vatId);
    expect(cii.lines.map((l) => l.netCents)).toEqual(ubl.lines.map((l) => l.netCents));
    expect(cii.payment.iban).toBe(ubl.payment.iban);
  });

  test("INB-021 EN 16931 profile (factur-x.xml) is detected from BT-24", () => {
    const { invoice } = parsed(ciiXml(outboundModel("en16931")));
    expect(invoice.profile).toBe("EN16931");
    expect(invoice.notEInvoice).toBe(false);
  });

  test("INB-021 INB-043 golden V6: two VAT groups, a document-level allowance, references, Skonto, entities decoded", () => {
    const { invoice } = parsed(CII_V6);
    expect(invoice.seller.name).toBe("Bürobedarf Schmidt & Söhne GmbH");
    expect(invoice.notes).toEqual(["Vielen Dank für Ihren Auftrag & Ihre Treue."]);
    expect(invoice).toMatchObject({
      number: "LF-2026-0815",
      issueDate: "2026-10-05",
      dueDate: "2026-11-04",
      supplyDate: "2026-10-01",
      buyerReference: "04011000-12345-34",
      orderRef: "BEST-77",
      contractRef: "RV-2026-3",
      seller: {
        vatId: "DE811569869",
        taxNumber: "215/5432/1098",
        email: "rechnung@schmidt-buero.de",
        electronicAddress: { scheme: "EM", value: "rechnung@schmidt-buero.de" },
        address: { line1: "Domstraße 1", postalCode: "50667", city: "Köln", countryCode: "DE" },
      },
      payment: {
        meansCode: "58",
        iban: "DE02120300000000202051",
        bic: "BYLADEM1001",
        skonto: [{ percentBp: 200, days: 14 }],
      },
      allowancesCharges: [{ charge: false, amountCents: 1000, reason: "Treuerabatt", category: "S", rateBp: 1900 }],
      vatBreakdown: [
        { category: "S", rateBp: 1900, taxableCents: 9000, taxCents: 1710 },
        { category: "S", rateBp: 700, taxableCents: 5000, taxCents: 350 },
      ],
      totals: {
        lineTotalCents: 15_000,
        allowanceTotalCents: 1000,
        taxExclusiveCents: 14_000,
        taxInclusiveCents: 16_060,
      },
    });
    expect(invoice.lines[0]).toMatchObject({
      name: "Druckerpapier A4",
      description: "80 g/m², 5 Kartons",
      quantityMilli: 5000,
      unitCode: "H87",
      unitPriceMicros: 200_000,
    });
  });

  test("INB-041 ER-13 T06-026 BG-24 attachments are decoded and listed; the XML string is not modified", () => {
    const xml = CII_V6;
    const before = xml.slice();
    const { invoice, attachments } = parsed(xml);
    expect(invoice.attachments).toEqual([
      { id: "LS-1", description: "Lieferschein", filename: "lieferschein.txt", mime: "text/plain" },
    ]);
    expect(new TextDecoder().decode(attachments[0]?.bytes)).toBe("Lieferschein 42");
    expect(xml).toBe(before);
  });

  test("INB-041 UBL embedded documents (EmbeddedDocumentBinaryObject) are extracted", () => {
    const pdf = btoa("%PDF-1.7 Stundenzettel");
    const xml = ublXml(
      outboundModel("xrechnung", [
        { id: "A1", description: "Stundenzettel", base64: pdf, mime: "application/pdf", filename: "stunden.pdf" },
      ]),
    );
    const { invoice, attachments } = parsed(xml);
    expect(invoice.attachments[0]).toMatchObject({ filename: "stunden.pdf", mime: "application/pdf" });
    expect(new TextDecoder().decode(attachments[0]?.bytes)).toBe("%PDF-1.7 Stundenzettel");
  });

  test("INB-043 T06-043 a UBL CreditNote 381 parses with its preceding invoice (BT-25) and subject-coded note", () => {
    const { invoice } = parsed(UBL_CREDIT_NOTE);
    expect(invoice).toMatchObject({
      syntax: "ubl",
      typeCode: "381",
      number: "GS-7",
      precedingInvoices: [{ number: "R-100", date: "2026-09-01" }],
      notes: ["Gutschrift wegen Reklamation"],
      seller: {
        name: "Lieferant AG",
        vatId: "DE136695976",
        electronicAddress: { scheme: "EM", value: "gs@lieferant.de" },
      },
      totals: { taxInclusiveCents: 11_900 },
    });
    expect(invoice.lines[0]).toMatchObject({ name: "Rücknahme Monitor", netCents: 10_000, rateBp: 1900 });
  });

  test("INB-023 EC-INB-09 T06-023 golden V7: BASIC-WL is flagged „keine E-Rechnung“ and still prefills the header", () => {
    const { invoice } = parsed(CII_BASIC_WL);
    expect(invoice.profile).toBe("BASIC-WL");
    expect(invoice.notEInvoice).toBe(true);
    expect(invoice.lines).toEqual([]);
    expect(invoice).toMatchObject({ number: "WL-42", issueDate: "2026-10-10", totals: { taxInclusiveCents: 5950 } });
  });

  test("ER-02 BT-6/BT-111: a USD invoice with EUR VAT currency carries both tax totals", () => {
    const xml = CII_V6.replace(
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      "<ram:TaxCurrencyCode>EUR</ram:TaxCurrencyCode><ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
    ).replace(
      '<ram:TaxTotalAmount currencyID="EUR">20.60</ram:TaxTotalAmount>',
      '<ram:TaxTotalAmount currencyID="USD">20.60</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="EUR">18.99</ram:TaxTotalAmount>',
    );
    const { invoice } = parsed(xml);
    expect(invoice).toMatchObject({ currency: "USD", vatCurrency: "EUR", taxTotalVatCurrencyCents: 1899 });
    expect(invoice.totals.taxCents).toBe(2060);
  });

  test("ER-02 amounts with more than two decimals are rounded half-up, never via floats", () => {
    const xml = CII_V6.replace(
      "<ram:LineTotalAmount>100.00</ram:LineTotalAmount>",
      "<ram:LineTotalAmount>100.005</ram:LineTotalAmount>",
    );
    expect(parsed(xml).invoice.lines[0]?.netCents).toBe(10_001);
  });
});

describe("format errors (EC-INB-04, SEC-06)", () => {
  test("EC-INB-04 T06-027 a DOCTYPE with an external entity is refused as Formatfehler before parsing", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE Invoice [<!ENTITY xxe SYSTEM "http://169.254.169.254/latest">]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>&xxe;</ID></Invoice>`;
    const r = parseReceivedXml(evil);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({
      code: "xml_doctype",
      category: "format",
      message: "Die XML-Datei enthält unzulässige DTD-Angaben und wurde nicht verarbeitet.",
    });
  });

  test("EC-INB-04 malformed XML, foreign roots and incomplete invoices are Formatfehler", () => {
    const codeOf = (xml: string) => {
      const r = parseReceivedXml(xml);
      return r.ok ? "ok" : r.error.code;
    };
    expect(codeOf("<Invoice><ID>1</Invoice>")).toBe("xml_malformed");
    expect(codeOf("<Order><ID>1</ID></Order>")).toBe("xml_unknown_root");
    expect(codeOf(CII_V6.replace("<ram:ID>LF-2026-0815</ram:ID>", ""))).toBe("xml_incomplete");
    expect(codeOf(CII_V6.replace(/<ram:GrandTotalAmount>[^<]+<\/ram:GrandTotalAmount>/, ""))).toBe("xml_incomplete");
  });

  test("INB-021 invoiceSyntaxOf sniffs the root element", () => {
    expect(invoiceSyntaxOf(ublXml())).toBe("ubl");
    expect(invoiceSyntaxOf(UBL_CREDIT_NOTE)).toBe("ubl");
    expect(invoiceSyntaxOf(`﻿<?xml version="1.0"?>\n<!-- x -->\n${CII_V6.split("\n").slice(1).join("\n")}`)).toBe("cii");
    expect(invoiceSyntaxOf("<Order/>")).toBeNull();
  });
});

describe("profiles (INB-023) and Skonto (INB-043)", () => {
  test.each([
    ["urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0", "XRECHNUNG", false],
    ["urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3", "XRECHNUNG", false],
    ["urn:cen.eu:en16931:2017", "EN16931", false],
    ["urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0", "EN16931", false],
    ["urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic", "BASIC", false],
    ["urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p0:basic", "BASIC", false],
    ["urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended", "EXTENDED", false],
    ["urn:factur-x.eu:1p0:basicwl", "BASIC-WL", true],
    ["urn:zugferd.de:2p0:basicwl", "BASIC-WL", true],
    ["urn:factur-x.eu:1p0:minimum", "MINIMUM", true],
    ["urn:zugferd.de:2p0:minimum", "MINIMUM", true],
    ["something-else", "UNKNOWN", false],
  ] as const)("INB-023 T06-022 %s → %s", (id, profile, notE) => {
    expect(detectProfile(id)).toEqual({ profile, notEInvoice: notE });
  });

  test("INB-023 EC-INB-09 message", () => {
    expect(detectProfile(undefined).profile).toBe("UNKNOWN");
    expect(notEInvoiceMessage("MINIMUM")).toBe(
      "Keine E-Rechnung i.S.d. § 14 UStG (Profil MINIMUM). Maßgeblich ist die PDF-Darstellung.",
    );
  });

  test("INB-043 T06-042 BT-20 #SKONTO# terms are parsed (with optional base, several lines)", () => {
    expect(parseSkontoTerms("#SKONTO#TAGE=14#PROZENT=2.00#")).toEqual([{ percentBp: 200, days: 14 }]);
    expect(
      parseSkontoTerms("#SKONTO#TAGE=7#PROZENT=3.00#BASISBETRAG=1190.00#\n#SKONTO#TAGE=14#PROZENT=1.5#\nnetto 30 Tage"),
    ).toEqual([
      { percentBp: 300, days: 7, baseCents: 119_000 },
      { percentBp: 150, days: 14 },
    ]);
    expect(parseSkontoTerms("Zahlbar sofort")).toEqual([]);
    expect(parseSkontoTerms(undefined)).toEqual([]);
  });
});
