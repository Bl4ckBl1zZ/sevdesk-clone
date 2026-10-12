/**
 * UN/CEFACT CII D16B serializer for the EN 16931 model (F04 INV-19, App. A.7):
 * - profile `en16931`  → ZUGFeRD 2.x / Factur-X EN 16931 (`factur-x.xml`, BT-24 `urn:cen.eu:en16931:2017`)
 * - profile `xrechnung` → XRechnung 3.0.2 CII and the ZUGFeRD XRECHNUNG profile (`xrechnung.xml`)
 *
 * Element order follows the D16B / Factur-X schema sequences (XSD-validated by KoSIT and Mustang, golden suite).
 */
import type { En16931Invoice, XmlAddress, XmlAllowanceCharge, XmlLine } from "./model";
import { amount, date102, el, leaf, percent, price, quantity, renderXml, type XmlElement } from "./xml";

const NS = {
  "xmlns:rsm": "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  "xmlns:ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  "xmlns:qdt": "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
  "xmlns:udt": "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
};

const dateTime = (name: string, d: string | undefined) =>
  d ? el(name, null, leaf("udt:DateTimeString", date102(d), { format: "102" })) : null;

const indicator = (charge: boolean) =>
  el("ram:ChargeIndicator", null, leaf("udt:Indicator", charge ? "true" : "false"));

function postalAddress(a: XmlAddress): XmlElement | null {
  return el(
    "ram:PostalTradeAddress",
    null,
    leaf("ram:PostcodeCode", a.postalCode),
    leaf("ram:LineOne", a.line1),
    leaf("ram:LineTwo", a.line2),
    leaf("ram:LineThree", a.line3),
    leaf("ram:CityName", a.city),
    leaf("ram:CountryID", a.countryCode),
  );
}

function contact(c: { name?: string; phone?: string; email?: string } | undefined): XmlElement | null {
  if (!c) return null;
  return el(
    "ram:DefinedTradeContact",
    null,
    leaf("ram:PersonName", c.name),
    el("ram:TelephoneUniversalCommunication", null, leaf("ram:CompleteNumber", c.phone)),
    el("ram:EmailURIUniversalCommunication", null, leaf("ram:URIID", c.email)),
  );
}

const tax = (category: string, rateBp: number | null) => [
  leaf("ram:TypeCode", "VAT"),
  leaf("ram:CategoryCode", category),
  leaf("ram:RateApplicablePercent", rateBp === null ? undefined : percent(rateBp)),
];

function lineItem(l: XmlLine): XmlElement | null {
  return el(
    "ram:IncludedSupplyChainTradeLineItem",
    null,
    el(
      "ram:AssociatedDocumentLineDocument",
      null,
      leaf("ram:LineID", l.id),
      el("ram:IncludedNote", null, leaf("ram:Content", l.note)),
    ),
    el(
      "ram:SpecifiedTradeProduct",
      null,
      leaf("ram:SellerAssignedID", l.sellerItemId),
      leaf("ram:BuyerAssignedID", l.buyerItemId),
      leaf("ram:Name", l.name),
      leaf("ram:Description", l.description),
    ),
    el(
      "ram:SpecifiedLineTradeAgreement",
      null,
      el(
        "ram:NetPriceProductTradePrice",
        null,
        leaf("ram:ChargeAmount", price(l.priceMicros)),
        leaf("ram:BasisQuantity", l.baseQuantityMilli === undefined ? undefined : quantity(l.baseQuantityMilli), {
          unitCode: l.unitCode,
        }),
      ),
    ),
    el(
      "ram:SpecifiedLineTradeDelivery",
      null,
      leaf("ram:BilledQuantity", quantity(l.quantityMilli), { unitCode: l.unitCode }),
    ),
    el(
      "ram:SpecifiedLineTradeSettlement",
      null,
      el("ram:ApplicableTradeTax", null, ...tax(l.category, l.rateBp)),
      l.period
        ? el(
            "ram:BillingSpecifiedPeriod",
            null,
            dateTime("ram:StartDateTime", l.period.from),
            dateTime("ram:EndDateTime", l.period.to),
          )
        : null,
      l.allowance
        ? el(
            "ram:SpecifiedTradeAllowanceCharge",
            null,
            indicator(false),
            leaf(
              "ram:CalculationPercent",
              l.allowance.percentBp === undefined ? undefined : percent(l.allowance.percentBp),
            ),
            leaf("ram:BasisAmount", amount(l.allowance.baseCents)),
            leaf("ram:ActualAmount", amount(l.allowance.amountCents)),
            leaf("ram:ReasonCode", l.allowance.reasonCode),
            leaf("ram:Reason", l.allowance.reason),
          )
        : null,
      el("ram:SpecifiedTradeSettlementLineMonetarySummation", null, leaf("ram:LineTotalAmount", amount(l.netCents))),
    ),
  );
}

function allowanceCharge(a: XmlAllowanceCharge): XmlElement | null {
  return el(
    "ram:SpecifiedTradeAllowanceCharge",
    null,
    indicator(a.charge),
    leaf("ram:CalculationPercent", a.percentBp === undefined ? undefined : percent(a.percentBp)),
    leaf("ram:BasisAmount", a.baseCents === undefined ? undefined : amount(a.baseCents)),
    leaf("ram:ActualAmount", amount(a.amountCents)),
    leaf("ram:ReasonCode", a.reasonCode),
    leaf("ram:Reason", a.reason),
    el("ram:CategoryTradeTax", null, ...tax(a.category, a.rateBp)),
  );
}

export function serializeCii(inv: En16931Invoice): string {
  const t = inv.totals;
  const root = el(
    "rsm:CrossIndustryInvoice",
    NS,
    el(
      "rsm:ExchangedDocumentContext",
      null,
      el("ram:BusinessProcessSpecifiedDocumentContextParameter", null, leaf("ram:ID", inv.businessProcessId)),
      el("ram:GuidelineSpecifiedDocumentContextParameter", null, leaf("ram:ID", inv.customizationId)),
    ),
    el(
      "rsm:ExchangedDocument",
      null,
      leaf("ram:ID", inv.number),
      leaf("ram:TypeCode", inv.typeCode),
      dateTime("ram:IssueDateTime", inv.issueDate),
      ...inv.notes.map((n) =>
        el("ram:IncludedNote", null, leaf("ram:Content", n.text), leaf("ram:SubjectCode", n.subjectCode)),
      ),
    ),
    el(
      "rsm:SupplyChainTradeTransaction",
      null,
      ...inv.lines.map(lineItem),
      el(
        "ram:ApplicableHeaderTradeAgreement",
        null,
        leaf("ram:BuyerReference", inv.buyerReference),
        el(
          "ram:SellerTradeParty",
          null,
          leaf("ram:ID", inv.seller.identifier),
          leaf("ram:Name", inv.seller.name),
          leaf("ram:Description", inv.seller.legalInfo),
          el(
            "ram:SpecifiedLegalOrganization",
            null,
            leaf("ram:ID", inv.seller.registerNumber),
            leaf("ram:TradingBusinessName", inv.seller.tradeName),
          ),
          contact(inv.seller.contact),
          postalAddress(inv.seller.address),
          inv.seller.electronicAddress
            ? el(
                "ram:URIUniversalCommunication",
                null,
                leaf("ram:URIID", inv.seller.electronicAddress.value, {
                  schemeID: inv.seller.electronicAddress.scheme,
                }),
              )
            : null,
          el("ram:SpecifiedTaxRegistration", null, leaf("ram:ID", inv.seller.vatId, { schemeID: "VA" })),
          el("ram:SpecifiedTaxRegistration", null, leaf("ram:ID", inv.seller.taxNumber, { schemeID: "FC" })),
        ),
        el(
          "ram:BuyerTradeParty",
          null,
          leaf("ram:ID", inv.buyer.identifier),
          leaf("ram:Name", inv.buyer.name),
          el(
            "ram:SpecifiedLegalOrganization",
            null,
            leaf("ram:ID", inv.buyer.registerNumber),
            leaf("ram:TradingBusinessName", inv.buyer.tradeName),
          ),
          contact(inv.buyer.contact),
          postalAddress(inv.buyer.address),
          inv.buyer.electronicAddress
            ? el(
                "ram:URIUniversalCommunication",
                null,
                leaf("ram:URIID", inv.buyer.electronicAddress.value, { schemeID: inv.buyer.electronicAddress.scheme }),
              )
            : null,
          el("ram:SpecifiedTaxRegistration", null, leaf("ram:ID", inv.buyer.vatId, { schemeID: "VA" })),
        ),
        el("ram:SellerOrderReferencedDocument", null, leaf("ram:IssuerAssignedID", inv.salesOrderReference)),
        el("ram:BuyerOrderReferencedDocument", null, leaf("ram:IssuerAssignedID", inv.orderReference)),
        el("ram:ContractReferencedDocument", null, leaf("ram:IssuerAssignedID", inv.contractReference)),
        ...inv.attachments.map((a) =>
          el(
            "ram:AdditionalReferencedDocument",
            null,
            leaf("ram:IssuerAssignedID", a.id),
            leaf("ram:TypeCode", "916"),
            leaf("ram:Name", a.description),
            leaf("ram:AttachmentBinaryObject", a.base64, { mimeCode: a.mime, filename: a.filename }),
          ),
        ),
        inv.projectReference
          ? el("ram:SpecifiedProcuringProject", null, leaf("ram:ID", inv.projectReference), leaf("ram:Name", "Projekt"))
          : null,
      ),
      el(
        "ram:ApplicableHeaderTradeDelivery",
        null,
        inv.delivery?.address || inv.delivery?.partyName
          ? el(
              "ram:ShipToTradeParty",
              null,
              leaf("ram:Name", inv.delivery.partyName),
              inv.delivery.address ? postalAddress(inv.delivery.address) : null,
            )
          : null,
        inv.delivery?.date
          ? el("ram:ActualDeliverySupplyChainEvent", null, dateTime("ram:OccurrenceDateTime", inv.delivery.date))
          : null,
        el("ram:DespatchAdviceReferencedDocument", null, leaf("ram:IssuerAssignedID", inv.despatchAdviceReference)),
      ) ?? { name: "ram:ApplicableHeaderTradeDelivery", attrs: {}, children: [] },
      el(
        "ram:ApplicableHeaderTradeSettlement",
        null,
        leaf("ram:PaymentReference", inv.paymentMeans[0]?.remittance),
        leaf("ram:TaxCurrencyCode", inv.taxCurrency),
        leaf("ram:InvoiceCurrencyCode", inv.currency),
        ...inv.paymentMeans.map((pm) =>
          el(
            "ram:SpecifiedTradeSettlementPaymentMeans",
            null,
            leaf("ram:TypeCode", pm.code),
            leaf("ram:Information", pm.text),
            pm.account
              ? el(
                  "ram:PayeePartyCreditorFinancialAccount",
                  null,
                  leaf("ram:IBANID", pm.account.iban),
                  leaf("ram:AccountName", pm.account.name),
                )
              : null,
            pm.account?.bic
              ? el("ram:PayeeSpecifiedCreditorFinancialInstitution", null, leaf("ram:BICID", pm.account.bic))
              : null,
          ),
        ),
        ...inv.vatBreakdown.map((v) =>
          el(
            "ram:ApplicableTradeTax",
            null,
            leaf("ram:CalculatedAmount", amount(v.vatCents)),
            leaf("ram:TypeCode", "VAT"),
            leaf("ram:ExemptionReason", v.exemptionReason),
            leaf("ram:BasisAmount", amount(v.baseCents)),
            leaf("ram:CategoryCode", v.category),
            leaf("ram:ExemptionReasonCode", v.exemptionReasonCode),
            leaf("ram:RateApplicablePercent", v.rateBp === null ? undefined : percent(v.rateBp)),
          ),
        ),
        inv.invoicePeriod
          ? el(
              "ram:BillingSpecifiedPeriod",
              null,
              dateTime("ram:StartDateTime", inv.invoicePeriod.from),
              dateTime("ram:EndDateTime", inv.invoicePeriod.to),
            )
          : null,
        ...inv.allowanceCharges.map(allowanceCharge),
        inv.paymentTerms || inv.dueDate
          ? el(
              "ram:SpecifiedTradePaymentTerms",
              null,
              leaf("ram:Description", inv.paymentTerms),
              dateTime("ram:DueDateDateTime", inv.dueDate),
            )
          : null,
        el(
          "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
          null,
          leaf("ram:LineTotalAmount", amount(t.lineNetCents)),
          leaf("ram:ChargeTotalAmount", t.chargeCents !== 0 ? amount(t.chargeCents) : undefined),
          leaf("ram:AllowanceTotalAmount", t.allowanceCents !== 0 ? amount(t.allowanceCents) : undefined),
          leaf("ram:TaxBasisTotalAmount", amount(t.taxExclusiveCents)),
          leaf("ram:TaxTotalAmount", amount(t.vatCents), { currencyID: inv.currency }),
          leaf(
            "ram:TaxTotalAmount",
            t.vatAccountingCurrencyCents === undefined ? undefined : amount(t.vatAccountingCurrencyCents),
            { currencyID: "EUR" },
          ),
          leaf("ram:RoundingAmount", t.roundingCents !== 0 ? amount(t.roundingCents) : undefined),
          leaf("ram:GrandTotalAmount", amount(t.taxInclusiveCents)),
          leaf("ram:TotalPrepaidAmount", t.prepaidCents !== 0 ? amount(t.prepaidCents) : undefined),
          leaf("ram:DuePayableAmount", amount(t.payableCents)),
        ),
        ...inv.precedingInvoices.map((p) =>
          el(
            "ram:InvoiceReferencedDocument",
            null,
            leaf("ram:IssuerAssignedID", p.number),
            el("ram:FormattedIssueDateTime", null, leaf("qdt:DateTimeString", date102(p.date), { format: "102" })),
          ),
        ),
      ),
    ),
  );
  if (!root) throw new Error("empty CII document");
  return renderXml(root);
}
