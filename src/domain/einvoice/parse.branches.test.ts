/**
 * Branch-level cases for the received e-invoice parser (INB-021, ER-02, INB-041, EC-INB-04): minimal hand-written
 * UBL/CII documents from other senders that leave out optional elements or use the alternative element the standard
 * allows (PartyName instead of PartyLegalEntity, due date in PaymentMeans, missing totals, …).
 */
import { describe, expect, test } from "vitest";
import { invoiceSyntaxOf, parseReceivedXml } from "./parse";

const parsed = (xml: string) => {
  const r = parseReceivedXml(xml);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const codeOf = (xml: string) => {
  const r = parseReceivedXml(xml);
  return r.ok ? "ok" : r.error.code;
};

const UBL_NS =
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';
const CN_NS =
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"';
const CII_NS =
  'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"';

/** A lean UBL invoice: seller only with PartyName, no legal entity, only the mandatory monetary total. */
const minimalUbl = (body: string, totals = "<cbc:TaxInclusiveAmount>119.00</cbc:TaxInclusiveAmount>") =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Invoice ${UBL_NS}>
  <cbc:ID>2026-77</cbc:ID>
  <cbc:IssueDate>2026-10-01</cbc:IssueDate>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Kleiner Laden</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>
  ${body}
  <cac:LegalMonetaryTotal>${totals}</cac:LegalMonetaryTotal>
</Invoice>`;

const minimalCii = (body: string, sum = "<ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>", extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice ${CII_NS}>
  <rsm:ExchangedDocument><ram:ID>C-1</ram:ID><ram:IssueDateTime><udt:DateTimeString format="102">20261001</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    ${extra}
    <ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Werkstatt Meier</ram:Name></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      ${body}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>${sum}</ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

describe("UBL variants (INB-021, ER-02)", () => {
  test("INB-021 a lean UBL invoice: seller name from PartyName, defaults for missing currency/type/totals", () => {
    const { invoice, attachments } = parsed(minimalUbl(""));
    expect(invoice).toMatchObject({
      syntax: "ubl",
      profile: "UNKNOWN",
      typeCode: "380",
      currency: "EUR",
      number: "2026-77",
      issueDate: "2026-10-01",
      seller: { name: "Kleiner Laden", tradeName: "Kleiner Laden", address: {} },
      buyer: {},
      precedingInvoices: [],
      notes: [],
      lines: [],
      vatBreakdown: [],
      payment: { skonto: [] },
    });
    // BG-22 defaults: no tax total → tax 0, exclusive = inclusive − tax, payable = inclusive
    expect(invoice.totals).toEqual({
      lineTotalCents: 0,
      allowanceTotalCents: 0,
      chargeTotalCents: 0,
      taxExclusiveCents: 11_900,
      taxCents: 0,
      taxInclusiveCents: 11_900,
      prepaidCents: 0,
      roundingCents: 0,
      payableCents: 11_900,
    });
    expect(invoice.dueDate).toBeUndefined();
    expect(invoice.period).toBeUndefined();
    expect(invoice.payee).toBeUndefined();
    expect(attachments).toEqual([]);
  });

  test("INB-021 UBL: due date from PaymentMeans (BT-9), order reference „NA“ ignored, period, payee, buyer via PartyName", () => {
    const { invoice } = parsed(
      minimalUbl(`
  <cac:InvoicePeriod><cbc:StartDate>2026-09-01</cbc:StartDate><cbc:EndDate>2026-09-30</cbc:EndDate></cac:InvoicePeriod>
  <cac:OrderReference><cbc:ID>NA</cbc:ID></cac:OrderReference>
  <cac:AccountingCustomerParty><cac:Party>
    <cbc:EndpointID>kunde@example.de</cbc:EndpointID>
    <cac:PartyName><cbc:Name>Kunde KG</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:CityName>Bonn</cbc:CityName><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE811907980</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:PayeeParty><cac:PartyName><cbc:Name>Factoring Bank AG</cbc:Name></cac:PartyName></cac:PayeeParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-10-31</cbc:PaymentDueDate>
    <cac:PayeeFinancialAccount><cbc:ID>de02 1203 0000 0000 2020 51</cbc:ID><cbc:Name>Kleiner Laden</cbc:Name>
      <cac:FinancialInstitutionBranch><cbc:ID>BYLADEM1001</cbc:ID></cac:FinancialInstitutionBranch></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms><cbc:Note>#SKONTO#TAGE=10#PROZENT=2.00#</cbc:Note><cbc:Note>Netto 30 Tage</cbc:Note></cac:PaymentTerms>`),
    );
    expect(invoice.dueDate).toBe("2026-10-31");
    expect(invoice.orderRef).toBeUndefined();
    expect(invoice.period).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(invoice.payee).toEqual({ name: "Factoring Bank AG" });
    expect(invoice.buyer).toEqual({
      name: "Kunde KG",
      vatId: "DE811907980",
      electronicAddress: { scheme: "", value: "kunde@example.de" },
      address: { city: "Bonn", countryCode: "DE" },
    });
    expect(invoice.payment).toEqual({
      meansCode: "58",
      iban: "DE02120300000000202051",
      bic: "BYLADEM1001",
      accountName: "Kleiner Laden",
      termsText: "#SKONTO#TAGE=10#PROZENT=2.00#\nNetto 30 Tage",
      skonto: [{ percentBp: 200, days: 10 }],
    });
  });

  test("INB-021 UBL: first VAT scheme wins for BT-31, a non-VAT scheme is the tax number (BT-32), empty IDs are skipped", () => {
    const { invoice } = parsed(
      minimalUbl("").replace(
        "</cac:PartyName></cac:Party>",
        `</cac:PartyName>
          <cac:PartyTaxScheme><cbc:CompanyID></cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
          <cac:PartyTaxScheme><cbc:CompanyID>DE123456788</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
          <cac:PartyTaxScheme><cbc:CompanyID>DE999999999</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
          <cac:PartyTaxScheme><cbc:CompanyID>201/123/45678</cbc:CompanyID><cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
          <cac:PartyTaxScheme><cbc:CompanyID>other</cbc:CompanyID><cac:TaxScheme><cbc:ID>LOC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
        </cac:Party>`,
      ),
    );
    expect(invoice.seller.vatId).toBe("DE123456788");
    expect(invoice.seller.taxNumber).toBe("201/123/45678");
  });

  test("INB-021 UBL lines without quantity, ID or tax category default to 1 piece, position number and S 0 %", () => {
    const { invoice } = parsed(
      minimalUbl(`
  <cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Fracht</cbc:AllowanceChargeReason><cbc:Amount>5.00</cbc:Amount>
    <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent></cac:TaxCategory></cac:AllowanceCharge>
  <cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount>2.50</cbc:Amount></cac:AllowanceCharge>
  <cac:InvoiceLine><cbc:LineExtensionAmount>100.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Beratung</cbc:Name></cac:Item></cac:InvoiceLine>
  <cac:InvoiceLine><cbc:ID>B</cbc:ID><cbc:InvoicedQuantity>2.5</cbc:InvoicedQuantity><cac:Item/><cac:Price><cbc:PriceAmount>1.23456</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`),
    );
    expect(invoice.lines).toEqual([
      { id: "1", name: "Beratung", quantityMilli: 1000, netCents: 10_000, category: "S", rateBp: 0 },
      { id: "B", name: "", quantityMilli: 2500, netCents: 0, unitPriceMicros: 12_346, category: "S", rateBp: 0 },
    ]);
    expect(invoice.allowancesCharges).toEqual([
      { charge: true, amountCents: 500, reason: "Fracht", category: "S", rateBp: 1900 },
      { charge: false, amountCents: 250, category: "S", rateBp: 0 },
    ]);
    // BT-106 missing → sum of the line net amounts
    expect(invoice.totals.lineTotalCents).toBe(10_000);
  });

  test("INB-021 UBL VAT breakdown: tax total in the document currency is BG-23; exemption reason (BT-120) kept", () => {
    const { invoice } = parsed(
      minimalUbl(
        `<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:TaxTotal><cbc:TaxAmount>0.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount>100.00</cbc:TaxableAmount><cbc:TaxAmount>0.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>E</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Steuerfrei nach § 4 Nr. 14 UStG</cbc:TaxExemptionReason></cac:TaxCategory>
    </cac:TaxSubtotal>
    <cac:TaxSubtotal><cbc:TaxCategory/></cac:TaxSubtotal>
  </cac:TaxTotal>`,
        "<cbc:TaxInclusiveAmount>100.00</cbc:TaxInclusiveAmount><cbc:PrepaidAmount>40.00</cbc:PrepaidAmount><cbc:PayableRoundingAmount>0.01</cbc:PayableRoundingAmount><cbc:PayableAmount>60.01</cbc:PayableAmount>",
      ),
    );
    expect(invoice.vatBreakdown).toEqual([
      {
        category: "E",
        rateBp: 0,
        taxableCents: 10_000,
        taxCents: 0,
        exemptionReason: "Steuerfrei nach § 4 Nr. 14 UStG",
      },
      { category: "S", rateBp: 0, taxableCents: 0, taxCents: 0 },
    ]);
    expect(invoice.totals).toMatchObject({ prepaidCents: 4000, roundingCents: 1, payableCents: 6001 });
  });

  test("ER-02 BT-6/BT-111 UBL: a USD invoice with a second TaxTotal in EUR", () => {
    const { invoice } = parsed(
      minimalUbl(`<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>EUR</cbc:TaxCurrencyCode>
  <cac:TaxTotal><cbc:TaxAmount currencyID="USD">19.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">17.42</cbc:TaxAmount></cac:TaxTotal>`),
    );
    expect(invoice).toMatchObject({ currency: "USD", vatCurrency: "EUR", taxTotalVatCurrencyCents: 1742 });
    expect(invoice.totals.taxCents).toBe(1900);
  });

  test("ER-02 BT-6 equal to BT-5 carries no separate BT-111", () => {
    const { invoice } = parsed(
      minimalUbl(
        `<cbc:TaxCurrencyCode>EUR</cbc:TaxCurrencyCode><cac:TaxTotal><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount></cac:TaxTotal>`,
      ),
    );
    expect(invoice.vatCurrency).toBe("EUR");
    expect(invoice.taxTotalVatCurrencyCents).toBeUndefined();
  });

  test("INB-043 a UBL CreditNote without CreditNoteTypeCode defaults to 381; credited quantity is read", () => {
    const xml = `<CreditNote ${CN_NS}><cbc:ID>GS-1</cbc:ID><cbc:IssueDate>2026-10-02</cbc:IssueDate>
      <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>R-9</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>
      <cac:BillingReference><cac:InvoiceDocumentReference><cbc:IssueDate>2026-01-01</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>
      <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Lieferant AG</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
      <cac:CreditNoteLine><cbc:ID>1</cbc:ID><cbc:CreditedQuantity unitCode="H87">3</cbc:CreditedQuantity><cbc:LineExtensionAmount>30.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Retoure</cbc:Name></cac:Item></cac:CreditNoteLine>
      <cac:LegalMonetaryTotal><cbc:TaxInclusiveAmount>35.70</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></CreditNote>`;
    const { invoice } = parsed(xml);
    expect(invoice.typeCode).toBe("381");
    // BT-25 without a number is dropped; BT-26 is optional
    expect(invoice.precedingInvoices).toEqual([{ number: "R-9" }]);
    expect(invoice.seller).toEqual({ name: "Lieferant AG", address: {} });
    expect(invoice.lines[0]).toMatchObject({ quantityMilli: 3000, unitCode: "H87", netCents: 3000 });
  });

  test("INB-041 UBL attachments: undecodable base64 and empty objects are skipped; filename and MIME default", () => {
    const ok = btoa("Stundenliste");
    const { invoice, attachments } = parsed(
      minimalUbl(`
  <cac:AdditionalDocumentReference><cbc:ID>leer</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject></cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>kaputt</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject>@@nicht base64@@</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>Z-1</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject>${ok}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>nur-Verweis</cbc:ID></cac:AdditionalDocumentReference>`),
    );
    expect(invoice.attachments).toEqual([{ id: "Z-1", filename: "anlage-1", mime: "application/octet-stream" }]);
    expect(attachments).toHaveLength(1);
    expect(new TextDecoder().decode(attachments[0]?.bytes)).toBe("Stundenliste");
  });

  test("INB-021 entities in text and attributes are decoded by hand (numeric, hex, quot/apos/lt/gt); invalid code points vanish", () => {
    const { invoice } = parsed(
      minimalUbl(
        `<cbc:Note>#AAI#Preis &lt;netto&gt; &quot;inkl.&quot; Kunde&apos;s Lager &#8364; &#x20AC; &#0;Ende</cbc:Note>
  <cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="&#x30;204">04011000-1&amp;2</cbc:EndpointID></cac:Party></cac:AccountingCustomerParty>`,
      ),
    );
    expect(invoice.notes).toEqual([`Preis <netto> "inkl." Kunde's Lager € € Ende`]);
    expect(invoice.buyer.electronicAddress).toEqual({ scheme: "0204", value: "04011000-1&2" });
  });

  test("EC-INB-04 UBL without TaxInclusiveAmount (BT-112) or without seller name is incomplete", () => {
    expect(codeOf(minimalUbl("", "<cbc:PayableAmount>119.00</cbc:PayableAmount>"))).toBe("xml_incomplete");
    expect(codeOf(minimalUbl("").replace("<cbc:Name>Kleiner Laden</cbc:Name>", ""))).toBe("xml_incomplete");
    expect(
      codeOf(
        minimalUbl("").replace(
          "<cbc:IssueDate>2026-10-01</cbc:IssueDate>",
          "<cbc:IssueDate>01.10.2026</cbc:IssueDate>",
        ),
      ),
    ).toBe("xml_incomplete");
    // a non-numeric amount is not a number → BT-112 missing
    expect(codeOf(minimalUbl("", "<cbc:TaxInclusiveAmount>119,00 EUR</cbc:TaxInclusiveAmount>"))).toBe(
      "xml_incomplete",
    );
  });

  test("EC-INB-04 SEC-06 an internal ENTITY declaration without DOCTYPE keyword is refused, too", () => {
    expect(codeOf(`<!ENTITY x "y"><Invoice ${UBL_NS}/>`)).toBe("xml_doctype");
  });
});

describe("CII variants (INB-021, INB-022)", () => {
  test("INB-022 a lean CII: defaults for type code, currency, totals and payment; positive sign accepted", () => {
    const { invoice } = parsed(minimalCii("", "<ram:GrandTotalAmount>+119.00</ram:GrandTotalAmount>"));
    expect(invoice).toMatchObject({
      syntax: "cii",
      typeCode: "380",
      currency: "EUR",
      number: "C-1",
      issueDate: "2026-10-01",
      seller: { name: "Werkstatt Meier", address: {} },
      buyer: {},
      payment: { skonto: [] },
    });
    expect(invoice.totals).toEqual({
      lineTotalCents: 0,
      allowanceTotalCents: 0,
      chargeTotalCents: 0,
      taxExclusiveCents: 11_900,
      taxCents: 0,
      taxInclusiveCents: 11_900,
      prepaidCents: 0,
      roundingCents: 0,
      payableCents: 11_900,
    });
    expect(invoice.dueDate).toBeUndefined();
    expect(invoice.period).toBeUndefined();
    expect(invoice.supplyDate).toBeUndefined();
  });

  test("INB-022 CII: ISO dates, billing period, payee, due date from the second terms block, tax total without currencyID", () => {
    const { invoice } = parsed(
      minimalCii(
        `<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:PayeeTradeParty><ram:Name>Inkasso GmbH</ram:Name></ram:PayeeTradeParty>
      <ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>30</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02 1203 0000 0000 2020 51</ram:IBANID><ram:AccountName>Meier</ram:AccountName></ram:PayeePartyCreditorFinancialAccount>
        <ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>BYLADEM1001</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString>2026-09-01</udt:DateTimeString></ram:StartDateTime><ram:EndDateTime><udt:DateTimeString format="102">20260930</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>
      <ram:SpecifiedTradePaymentTerms><ram:Description>Zahlbar ohne Abzug</ram:Description></ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">20261031</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
      <ram:InvoiceReferencedDocument><ram:IssuerAssignedID>R-1</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>
      <ram:InvoiceReferencedDocument><ram:FormattedIssueDateTime><udt:DateTimeString>20260101</udt:DateTimeString></ram:FormattedIssueDateTime></ram:InvoiceReferencedDocument>`,
        "<ram:TaxTotalAmount>19.00</ram:TaxTotalAmount><ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>",
      ),
    );
    expect(invoice.period).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(invoice.dueDate).toBe("2026-10-31");
    expect(invoice.payee).toEqual({ name: "Inkasso GmbH" });
    expect(invoice.precedingInvoices).toEqual([{ number: "R-1" }]);
    expect(invoice.payment).toEqual({
      meansCode: "30",
      iban: "DE02120300000000202051",
      bic: "BYLADEM1001",
      accountName: "Meier",
      termsText: "Zahlbar ohne Abzug",
      skonto: [],
    });
    expect(invoice.totals).toMatchObject({ taxCents: 1900, taxExclusiveCents: 10_000, payableCents: 11_900 });
  });

  test("INB-022 CII: a period with only a start date is not a BG-14 period", () => {
    const { invoice } = parsed(
      minimalCii(
        `<ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString>20260901</udt:DateTimeString></ram:StartDateTime></ram:BillingSpecifiedPeriod>`,
      ),
    );
    expect(invoice.period).toBeUndefined();
  });

  test("INB-022 CII lines without LineID, quantity, product name or tax default sensibly; allowances without reason", () => {
    const { invoice } = parsed(
      minimalCii(
        `<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>3.00</ram:ActualAmount></ram:SpecifiedTradeAllowanceCharge>
      <ram:ApplicableTradeTax><ram:CategoryCode>AE</ram:CategoryCode><ram:ExemptionReason>Steuerschuldnerschaft des Leistungsempfängers</ram:ExemptionReason></ram:ApplicableTradeTax>`,
        undefined,
        `<ram:IncludedSupplyChainTradeLineItem><ram:SpecifiedLineTradeSettlement/></ram:IncludedSupplyChainTradeLineItem>
    <ram:IncludedSupplyChainTradeLineItem><ram:SpecifiedLineTradeSettlement><ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>40.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement></ram:IncludedSupplyChainTradeLineItem>`,
      ),
    );
    expect(invoice.lines).toEqual([
      { id: "1", name: "", quantityMilli: 1000, netCents: 0, category: "S", rateBp: 0 },
      { id: "2", name: "", quantityMilli: 1000, netCents: 4000, category: "S", rateBp: 0 },
    ]);
    expect(invoice.allowancesCharges).toEqual([{ charge: false, amountCents: 300, category: "S", rateBp: 0 }]);
    expect(invoice.vatBreakdown).toEqual([
      {
        category: "AE",
        rateBp: 0,
        taxableCents: 0,
        taxCents: 0,
        exemptionReason: "Steuerschuldnerschaft des Leistungsempfängers",
      },
    ]);
    expect(invoice.totals.lineTotalCents).toBe(4000);
  });

  test("INB-041 CII attachments: empty and undecodable objects skipped, missing filename/MIME defaulted", () => {
    const bytes = btoa("abc");
    const { invoice, attachments } = parsed(
      minimalCii("").replace(
        "</ram:SellerTradeParty>",
        `</ram:SellerTradeParty>
      <ram:AdditionalReferencedDocument><ram:IssuerAssignedID>A</ram:IssuerAssignedID><ram:AttachmentBinaryObject></ram:AttachmentBinaryObject></ram:AdditionalReferencedDocument>
      <ram:AdditionalReferencedDocument><ram:IssuerAssignedID>B</ram:IssuerAssignedID><ram:AttachmentBinaryObject>!!!</ram:AttachmentBinaryObject></ram:AdditionalReferencedDocument>
      <ram:AdditionalReferencedDocument><ram:IssuerAssignedID>C</ram:IssuerAssignedID><ram:AttachmentBinaryObject>${bytes}</ram:AttachmentBinaryObject></ram:AdditionalReferencedDocument>`,
      ),
    );
    expect(invoice.attachments).toEqual([{ id: "C", filename: "anlage-1", mime: "application/octet-stream" }]);
    expect(new TextDecoder().decode(attachments[0]?.bytes)).toBe("abc");
  });

  test("INB-022 CII seller/buyer: electronic address without scheme, tax registrations with other schemes ignored", () => {
    const { invoice } = parsed(
      minimalCii("").replace(
        "<ram:SellerTradeParty><ram:Name>Werkstatt Meier</ram:Name></ram:SellerTradeParty>",
        `<ram:SellerTradeParty><ram:Name>Werkstatt Meier</ram:Name>
          <ram:URIUniversalCommunication><ram:URIID>meier@example.de</ram:URIID></ram:URIUniversalCommunication>
          <ram:SpecifiedTaxRegistration><ram:ID>no-scheme</ram:ID></ram:SpecifiedTaxRegistration>
          <ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">201/123/45678</ram:ID></ram:SpecifiedTaxRegistration>
        </ram:SellerTradeParty>
        <ram:BuyerTradeParty><ram:Name>Kunde</ram:Name><ram:URIUniversalCommunication><ram:URIID schemeID="0204">991-1-2</ram:URIID></ram:URIUniversalCommunication></ram:BuyerTradeParty>`,
      ),
    );
    expect(invoice.seller).toEqual({
      name: "Werkstatt Meier",
      taxNumber: "201/123/45678",
      electronicAddress: { scheme: "", value: "meier@example.de" },
      address: {},
    });
    expect(invoice.buyer).toEqual({ name: "Kunde", electronicAddress: { scheme: "0204", value: "991-1-2" } });
  });

  test("EC-INB-04 CII with an unparsable date or no seller name is incomplete", () => {
    expect(codeOf(minimalCii("").replace("20261001", "1.10.26"))).toBe("xml_incomplete");
    expect(codeOf(minimalCii("").replace("<ram:Name>Werkstatt Meier</ram:Name>", ""))).toBe("xml_incomplete");
  });
});

describe("invoiceSyntaxOf (INB-021)", () => {
  test("INB-021 prefixed UBL roots and roots preceded by text are recognised or refused", () => {
    expect(invoiceSyntaxOf('<ubl:Invoice xmlns:ubl="urn:x">')).toBe("ubl");
    expect(invoiceSyntaxOf("<CreditNote/>")).toBe("ubl");
    expect(invoiceSyntaxOf("<rsm:CrossIndustryInvoice>")).toBe("cii");
    expect(invoiceSyntaxOf("<Wrapper><Invoice/></Wrapper>")).toBeNull();
    expect(invoiceSyntaxOf("")).toBeNull();
  });
});
