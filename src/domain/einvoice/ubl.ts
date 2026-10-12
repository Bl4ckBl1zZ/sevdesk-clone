/**
 * OASIS UBL 2.1 serializer for the EN 16931 model — XRechnung 3.0.2 UBL (F04 INV-19, App. A.7; default for B2G).
 * TypeCode 381 is written as `CreditNote` (App. A.2), every other code as `Invoice`. Element order follows the UBL 2.1
 * XSD sequences (validated by KoSIT in the golden suite).
 */
import type { En16931Invoice, XmlAddress, XmlLine } from "./model";
import { isCreditNote } from "./type-code";
import { amount, el, leaf, percent, price, quantity, renderXml, type XmlElement } from "./xml";

const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";
const CAC = "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";

function postalAddress(name: string, a: XmlAddress): XmlElement | null {
  return el(
    name,
    null,
    leaf("cbc:StreetName", a.line1),
    leaf("cbc:AdditionalStreetName", a.line2),
    leaf("cbc:CityName", a.city),
    leaf("cbc:PostalZone", a.postalCode),
    el("cac:AddressLine", null, leaf("cbc:Line", a.line3)),
    el("cac:Country", null, leaf("cbc:IdentificationCode", a.countryCode)),
  );
}

const taxScheme = () => el("cac:TaxScheme", null, leaf("cbc:ID", "VAT"));

function contact(c: { name?: string; phone?: string; email?: string } | undefined): XmlElement | null {
  if (!c) return null;
  return el(
    "cac:Contact",
    null,
    leaf("cbc:Name", c.name),
    leaf("cbc:Telephone", c.phone),
    leaf("cbc:ElectronicMail", c.email),
  );
}

function category(name: string, id: string, rateBp: number | null, reason?: string, reasonCode?: string) {
  return el(
    name,
    null,
    leaf("cbc:ID", id),
    leaf("cbc:Percent", rateBp === null ? undefined : percent(rateBp)),
    leaf("cbc:TaxExemptionReasonCode", reasonCode),
    leaf("cbc:TaxExemptionReason", reason),
    taxScheme(),
  );
}

function line(l: XmlLine, inv: En16931Invoice, credit: boolean): XmlElement | null {
  const cur = { currencyID: inv.currency };
  return el(
    credit ? "cac:CreditNoteLine" : "cac:InvoiceLine",
    null,
    leaf("cbc:ID", l.id),
    leaf("cbc:Note", l.note),
    leaf(credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", quantity(l.quantityMilli), { unitCode: l.unitCode }),
    leaf("cbc:LineExtensionAmount", amount(l.netCents), cur),
    l.period
      ? el("cac:InvoicePeriod", null, leaf("cbc:StartDate", l.period.from), leaf("cbc:EndDate", l.period.to))
      : null,
    l.allowance
      ? el(
          "cac:AllowanceCharge",
          null,
          leaf("cbc:ChargeIndicator", "false"),
          leaf("cbc:AllowanceChargeReasonCode", l.allowance.reasonCode),
          leaf("cbc:AllowanceChargeReason", l.allowance.reason),
          leaf(
            "cbc:MultiplierFactorNumeric",
            l.allowance.percentBp === undefined ? undefined : percent(l.allowance.percentBp),
          ),
          leaf("cbc:Amount", amount(l.allowance.amountCents), cur),
          leaf("cbc:BaseAmount", amount(l.allowance.baseCents), cur),
        )
      : null,
    el(
      "cac:Item",
      null,
      leaf("cbc:Description", l.description),
      leaf("cbc:Name", l.name),
      el("cac:BuyersItemIdentification", null, leaf("cbc:ID", l.buyerItemId)),
      el("cac:SellersItemIdentification", null, leaf("cbc:ID", l.sellerItemId)),
      category("cac:ClassifiedTaxCategory", l.category, l.rateBp),
    ),
    el(
      "cac:Price",
      null,
      leaf("cbc:PriceAmount", price(l.priceMicros), cur),
      leaf("cbc:BaseQuantity", l.baseQuantityMilli === undefined ? undefined : quantity(l.baseQuantityMilli), {
        unitCode: l.unitCode,
      }),
    ),
  );
}

export function serializeUbl(inv: En16931Invoice): string {
  const credit = isCreditNote(inv.typeCode);
  const root = credit ? "CreditNote" : "Invoice";
  const cur = { currencyID: inv.currency };
  const t = inv.totals;
  const party = (
    name: string,
    p: {
      electronicAddress?: { scheme: string; value: string };
      identifier?: string;
      tradeName?: string;
      address: XmlAddress;
      vatId?: string;
      taxNumber?: string;
      name: string;
      registerNumber?: string;
      legalInfo?: string;
      contact?: { name?: string; phone?: string; email?: string };
    },
  ) =>
    el(
      name,
      null,
      el(
        "cac:Party",
        null,
        leaf("cbc:EndpointID", p.electronicAddress?.value, { schemeID: p.electronicAddress?.scheme }),
        el("cac:PartyIdentification", null, leaf("cbc:ID", p.identifier)),
        el("cac:PartyName", null, leaf("cbc:Name", p.tradeName)),
        postalAddress("cac:PostalAddress", p.address),
        el("cac:PartyTaxScheme", null, leaf("cbc:CompanyID", p.vatId), p.vatId ? taxScheme() : null),
        p.taxNumber
          ? el(
              "cac:PartyTaxScheme",
              null,
              leaf("cbc:CompanyID", p.taxNumber),
              el("cac:TaxScheme", null, leaf("cbc:ID", "FC")),
            )
          : null,
        el(
          "cac:PartyLegalEntity",
          null,
          leaf("cbc:RegistrationName", p.name),
          leaf("cbc:CompanyID", p.registerNumber),
          leaf("cbc:CompanyLegalForm", p.legalInfo),
        ),
        contact(p.contact),
      ),
    );

  const doc = el(
    root,
    {
      xmlns: `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`,
      "xmlns:cac": CAC,
      "xmlns:cbc": CBC,
    },
    leaf("cbc:CustomizationID", inv.customizationId),
    leaf("cbc:ProfileID", inv.businessProcessId),
    leaf("cbc:ID", inv.number),
    leaf("cbc:IssueDate", inv.issueDate),
    credit ? null : leaf("cbc:DueDate", inv.dueDate),
    leaf(credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", inv.typeCode),
    ...inv.notes.map((n) => leaf("cbc:Note", n.subjectCode ? `#${n.subjectCode}#${n.text}` : n.text)),
    leaf("cbc:DocumentCurrencyCode", inv.currency),
    leaf("cbc:TaxCurrencyCode", inv.taxCurrency),
    leaf("cbc:BuyerReference", inv.buyerReference),
    inv.invoicePeriod
      ? el(
          "cac:InvoicePeriod",
          null,
          leaf("cbc:StartDate", inv.invoicePeriod.from),
          leaf("cbc:EndDate", inv.invoicePeriod.to),
        )
      : null,
    inv.orderReference || inv.salesOrderReference
      ? el(
          "cac:OrderReference",
          null,
          leaf("cbc:ID", inv.orderReference ?? "NA"),
          leaf("cbc:SalesOrderID", inv.salesOrderReference),
        )
      : null,
    ...inv.precedingInvoices.map((p) =>
      el(
        "cac:BillingReference",
        null,
        el("cac:InvoiceDocumentReference", null, leaf("cbc:ID", p.number), leaf("cbc:IssueDate", p.date)),
      ),
    ),
    el("cac:DespatchDocumentReference", null, leaf("cbc:ID", inv.despatchAdviceReference)),
    el("cac:ContractDocumentReference", null, leaf("cbc:ID", inv.contractReference)),
    ...inv.attachments.map((a) =>
      el(
        "cac:AdditionalDocumentReference",
        null,
        leaf("cbc:ID", a.id),
        leaf("cbc:DocumentDescription", a.description),
        el(
          "cac:Attachment",
          null,
          leaf("cbc:EmbeddedDocumentBinaryObject", a.base64, { mimeCode: a.mime, filename: a.filename }),
        ),
      ),
    ),
    credit ? null : el("cac:ProjectReference", null, leaf("cbc:ID", inv.projectReference)),
    party("cac:AccountingSupplierParty", inv.seller),
    party("cac:AccountingCustomerParty", inv.buyer),
    inv.delivery
      ? el(
          "cac:Delivery",
          null,
          leaf("cbc:ActualDeliveryDate", inv.delivery.date),
          inv.delivery.address
            ? el("cac:DeliveryLocation", null, postalAddress("cac:Address", inv.delivery.address))
            : null,
          el("cac:DeliveryParty", null, el("cac:PartyName", null, leaf("cbc:Name", inv.delivery.partyName))),
        )
      : null,
    ...inv.paymentMeans.map((pm) =>
      el(
        "cac:PaymentMeans",
        null,
        leaf("cbc:PaymentMeansCode", pm.code, { name: pm.text }),
        credit ? leaf("cbc:PaymentDueDate", inv.dueDate) : null,
        leaf("cbc:PaymentID", pm.remittance),
        pm.account
          ? el(
              "cac:PayeeFinancialAccount",
              null,
              leaf("cbc:ID", pm.account.iban),
              leaf("cbc:Name", pm.account.name),
              el("cac:FinancialInstitutionBranch", null, leaf("cbc:ID", pm.account.bic)),
            )
          : null,
      ),
    ),
    el("cac:PaymentTerms", null, leaf("cbc:Note", inv.paymentTerms)),
    ...inv.allowanceCharges.map((a) =>
      el(
        "cac:AllowanceCharge",
        null,
        leaf("cbc:ChargeIndicator", a.charge ? "true" : "false"),
        leaf("cbc:AllowanceChargeReasonCode", a.reasonCode),
        leaf("cbc:AllowanceChargeReason", a.reason),
        leaf("cbc:MultiplierFactorNumeric", a.percentBp === undefined ? undefined : percent(a.percentBp)),
        leaf("cbc:Amount", amount(a.amountCents), cur),
        leaf("cbc:BaseAmount", a.baseCents === undefined ? undefined : amount(a.baseCents), cur),
        category("cac:TaxCategory", a.category, a.rateBp),
      ),
    ),
    el(
      "cac:TaxTotal",
      null,
      leaf("cbc:TaxAmount", amount(t.vatCents), cur),
      ...inv.vatBreakdown.map((v) =>
        el(
          "cac:TaxSubtotal",
          null,
          leaf("cbc:TaxableAmount", amount(v.baseCents), cur),
          leaf("cbc:TaxAmount", amount(v.vatCents), cur),
          category("cac:TaxCategory", v.category, v.rateBp, v.exemptionReason, v.exemptionReasonCode),
        ),
      ),
    ),
    t.vatAccountingCurrencyCents === undefined
      ? null
      : el("cac:TaxTotal", null, leaf("cbc:TaxAmount", amount(t.vatAccountingCurrencyCents), { currencyID: "EUR" })),
    el(
      "cac:LegalMonetaryTotal",
      null,
      leaf("cbc:LineExtensionAmount", amount(t.lineNetCents), cur),
      leaf("cbc:TaxExclusiveAmount", amount(t.taxExclusiveCents), cur),
      leaf("cbc:TaxInclusiveAmount", amount(t.taxInclusiveCents), cur),
      leaf("cbc:AllowanceTotalAmount", t.allowanceCents !== 0 ? amount(t.allowanceCents) : undefined, cur),
      leaf("cbc:ChargeTotalAmount", t.chargeCents !== 0 ? amount(t.chargeCents) : undefined, cur),
      leaf("cbc:PrepaidAmount", t.prepaidCents !== 0 ? amount(t.prepaidCents) : undefined, cur),
      leaf("cbc:PayableRoundingAmount", t.roundingCents !== 0 ? amount(t.roundingCents) : undefined, cur),
      leaf("cbc:PayableAmount", amount(t.payableCents), cur),
    ),
    ...inv.lines.map((l) => line(l, inv, credit)),
  );
  if (!doc) throw new Error("empty UBL document");
  return renderXml(doc);
}
