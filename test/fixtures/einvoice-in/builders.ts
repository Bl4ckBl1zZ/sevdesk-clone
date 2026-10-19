/**
 * Fixtures for received E-Rechnungen (F06 INB-021…047). No downloads: UBL/CII are produced by the app's own
 * serializers (src/domain/einvoice), the special cases (golden V6 allowance, credit note 381, BASIC-WL hybrid) are
 * hand-written; hybrid PDFs are built with @cantoo/pdf-lib.
 */
import { AFRelationship, PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { makeSnapshot } from "@test/factories/snapshot";
import { serializeCii } from "@/domain/einvoice/cii";
import { mapToEn16931 } from "@/domain/einvoice/map";
import { CUSTOMIZATION_ID, type En16931Invoice } from "@/domain/einvoice/model";
import { serializeUbl } from "@/domain/einvoice/ubl";

/** A real F04 invoice (Muster Design GmbH → Beispiel Kunde GmbH, 1.000,00 € + 19 %) as EN 16931 model. */
export function outboundModel(
  profile: "en16931" | "xrechnung" = "xrechnung",
  attachments: En16931Invoice["attachments"] = [],
): En16931Invoice {
  return mapToEn16931(makeSnapshot(), { profile, attachments });
}

export const ublXml = (model = outboundModel("xrechnung")) => serializeUbl(model);
export const ciiXml = (model = outboundModel("xrechnung")) => serializeCii(model);

/** Golden V6: CII with two VAT groups (19 % / 7 %) and a document-level allowance of 10,00 € on the 19 % group. */
export const CII_V6 = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${CUSTOMIZATION_ID.xrechnung}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>LF-2026-0815</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20261005</udt:DateTimeString></ram:IssueDateTime>
    <ram:IncludedNote><ram:Content>Vielen Dank für Ihren Auftrag &amp; Ihre Treue.</ram:Content></ram:IncludedNote>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Druckerpapier A4</ram:Name><ram:Description>80 g/m², 5 Kartons</ram:Description></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>20.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">5</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>100.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>2</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Fachbuch Buchhaltung</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>50.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>7.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>50.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>04011000-12345-34</ram:BuyerReference>
      <ram:SellerTradeParty>
        <ram:Name>Bürobedarf Schmidt &amp; Söhne GmbH</ram:Name>
        <ram:DefinedTradeContact><ram:EmailURIUniversalCommunication><ram:URIID>rechnung@schmidt-buero.de</ram:URIID></ram:EmailURIUniversalCommunication></ram:DefinedTradeContact>
        <ram:PostalTradeAddress><ram:PostcodeCode>50667</ram:PostcodeCode><ram:LineOne>Domstraße 1</ram:LineOne><ram:CityName>Köln</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">rechnung@schmidt-buero.de</ram:URIID></ram:URIUniversalCommunication>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE811569869</ram:ID></ram:SpecifiedTaxRegistration>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">215/5432/1098</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>Muster Design GmbH</ram:Name>
        <ram:PostalTradeAddress><ram:PostcodeCode>10115</ram:PostcodeCode><ram:LineOne>Musterstraße 1</ram:LineOne><ram:CityName>Berlin</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456788</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:BuyerTradeParty>
      <ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>BEST-77</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>
      <ram:ContractReferencedDocument><ram:IssuerAssignedID>RV-2026-3</ram:IssuerAssignedID></ram:ContractReferencedDocument>
      <ram:AdditionalReferencedDocument>
        <ram:IssuerAssignedID>LS-1</ram:IssuerAssignedID>
        <ram:TypeCode>916</ram:TypeCode>
        <ram:Name>Lieferschein</ram:Name>
        <ram:AttachmentBinaryObject mimeCode="text/plain" filename="lieferschein.txt">TGllZmVyc2NoZWluIDQy</ram:AttachmentBinaryObject>
      </ram:AdditionalReferencedDocument>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">20261001</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02 1203 0000 0000 2020 51</ram:IBANID><ram:AccountName>Schmidt GmbH</ram:AccountName></ram:PayeePartyCreditorFinancialAccount>
        <ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>BYLADEM1001</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>17.10</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>90.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>3.50</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>50.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>
        <ram:ActualAmount>10.00</ram:ActualAmount>
        <ram:Reason>Treuerabatt</ram:Reason>
        <ram:CategoryTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>#SKONTO#TAGE=14#PROZENT=2.00#
Zahlbar innerhalb 30 Tagen netto.</ram:Description>
        <ram:DueDateDateTime><udt:DateTimeString format="102">20261104</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>150.00</ram:LineTotalAmount>
        <ram:AllowanceTotalAmount>10.00</ram:AllowanceTotalAmount>
        <ram:TaxBasisTotalAmount>140.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">20.60</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>160.60</ram:GrandTotalAmount>
        <ram:DuePayableAmount>160.60</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;

/** UBL CreditNote (381) of 119,00 € referencing invoice R-100 (BT-25). */
export const UBL_CREDIT_NOTE = `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${CUSTOMIZATION_ID.xrechnung}</cbc:CustomizationID>
  <cbc:ID>GS-7</cbc:ID>
  <cbc:IssueDate>2026-10-08</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  <cbc:Note>#AAI#Gutschrift wegen Reklamation</cbc:Note>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>n/a</cbc:BuyerReference>
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>R-100</cbc:ID><cbc:IssueDate>2026-09-01</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cbc:EndpointID schemeID="EM">gs@lieferant.de</cbc:EndpointID>
    <cac:PostalAddress><cbc:StreetName>Weg 2</cbc:StreetName><cbc:CityName>Hamburg</cbc:CityName><cbc:PostalZone>20095</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DE136695976</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>Lieferant AG</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cbc:EndpointID schemeID="EM">buchhaltung@muster.de</cbc:EndpointID>
    <cac:PostalAddress><cbc:CityName>Berlin</cbc:CityName><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
    <cac:PartyLegalEntity><cbc:RegistrationName>Muster Design GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">119.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">119.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:CreditNoteLine>
    <cbc:ID>1</cbc:ID>
    <cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Rücknahme Monitor</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price>
  </cac:CreditNoteLine>
</CreditNote>
`;

/** ZUGFeRD/Factur-X BASIC-WL (no lines): golden V7. */
export const CII_BASIC_WL = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:factur-x.eu:1p0:basicwl</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>WL-42</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20261010</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Tankstelle Nord GmbH</ram:Name>
        <ram:PostalTradeAddress><ram:PostcodeCode>24103</ram:PostcodeCode><ram:CityName>Kiel</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE129273398</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>Muster Design GmbH</ram:Name></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>9.50</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>50.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>50.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>50.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">9.50</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>59.50</ram:GrandTotalAmount>
        <ram:DuePayableAmount>59.50</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A hybrid PDF: one page with the visible text, the given XML files embedded (Factur-X uses AFRelationship
 * Alternative). `pageText` lets tests make the visible PDF disagree with the XML (EC-INB-15).
 */
export async function hybridPdf(
  files: readonly { name: string; xml: string }[],
  pageText: readonly string[] = ["Rechnung"],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  pageText.forEach((line, i) => {
    page.drawText(line, { x: 50, y: 780 - i * 18, size: 11, font });
  });
  for (const f of files) {
    await doc.attach(enc(f.xml), f.name, {
      mimeType: "text/xml",
      description: "Factur-X invoice",
      afRelationship: AFRelationship.Alternative,
    });
  }
  return doc.save({ useObjectStreams: false });
}

/** A plain PDF without attachments. */
export const plainPdf = (pageText: readonly string[] = ["Quittung"]) => hybridPdf([], pageText);
