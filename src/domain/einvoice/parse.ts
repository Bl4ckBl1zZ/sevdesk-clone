/**
 * Parser for received E-Rechnungen (F06 INB-021, ER-02): XRechnung / EN 16931 in UBL 2.1 (`Invoice`, `CreditNote`)
 * or UN/CEFACT CII D16B (`CrossIndustryInvoice`, also the XML inside ZUGFeRD/Factur-X hybrids, INB-022) → the
 * syntax-neutral `ReceivedInvoice`.
 *
 * Security (SEC-06, EC-INB-04, T06-027): `fast-xml-parser` with `processEntities: false`; a document with a DOCTYPE
 * is refused before parsing (Formatfehler), so neither internal nor external entities are ever expanded and nothing
 * is fetched. The five predefined XML entities and numeric character references are decoded by hand.
 *
 * Money: machine decimals ("1190.00") → integer cents with EN 16931 half-up rounding (never floats); quantities
 * 1/1,000, prices 1/10,000, rates basis points. BG-24 attachments (base64) are decoded and returned separately
 * (INB-041); the XML itself is never modified (ER-13). Pure.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseDecimal } from "../money/parse";
import { err, ok, type Result } from "../result";
import { detectProfile } from "./profile";
import type {
  ReceivedAddress,
  ReceivedAllowanceCharge,
  ReceivedAttachment,
  ReceivedElectronicAddress,
  ReceivedInvoice,
  ReceivedLine,
  ReceivedTotals,
  ReceivedVatBreakdown,
} from "./received";
import { parseSkontoTerms } from "./skonto";

export type ReceiveIssueCode = "xml_doctype" | "xml_malformed" | "xml_unknown_root" | "xml_incomplete";

export interface ReceiveIssue {
  code: ReceiveIssueCode;
  category: "format";
  message: string;
}

export interface ParsedReceived {
  invoice: ReceivedInvoice;
  attachments: ReceivedAttachment[];
}

export const RECEIVE_MESSAGES: Record<ReceiveIssueCode, string> = {
  xml_doctype: "Die XML-Datei enthält unzulässige DTD-Angaben und wurde nicht verarbeitet.",
  xml_malformed: "Die XML-Datei ist nicht wohlgeformt und kann nicht gelesen werden.",
  xml_unknown_root: "Die XML-Datei ist keine Rechnung im Format XRechnung (UBL/CII) oder ZUGFeRD/Factur-X.",
  xml_incomplete:
    "Der E-Rechnung fehlen Pflichtangaben (Rechnungsnummer, Rechnungsdatum, Verkäufer oder Rechnungsbetrag).",
};

const fail = (code: ReceiveIssueCode): { ok: false; error: ReceiveIssue } =>
  err({ code, category: "format", message: RECEIVE_MESSAGES[code] });

// ── generic tree access ─────────────────────────────────────────────────────────────────────────────────────────

/** A parsed element: every child element is an array (alwaysArray), attributes carry the "@" prefix. */
type XNode = Record<string, unknown> | string;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (_name: string, _jpath: unknown, _isLeaf: boolean, isAttribute: boolean) => !isAttribute,
});

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

const kids = (node: XNode | undefined, name: string): XNode[] => {
  if (!node || typeof node === "string") return [];
  const v = node[name];
  return Array.isArray(v) ? (v as XNode[]) : [];
};

/** First element along a path of child names. */
function at(node: XNode | undefined, ...path: string[]): XNode | undefined {
  let cur: XNode | undefined = node;
  for (const p of path) {
    cur = kids(cur, p)[0];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function textOf(node: XNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  const raw = typeof node === "string" ? node : typeof node["#text"] === "string" ? (node["#text"] as string) : "";
  const s = decodeEntities(raw).trim();
  return s === "" ? undefined : s;
}

const text = (node: XNode | undefined, ...path: string[]) => textOf(at(node, ...path));

function attr(node: XNode | undefined, name: string): string | undefined {
  if (!node || typeof node === "string") return undefined;
  const v = node[`@${name}`];
  return typeof v === "string" && v.trim() !== "" ? decodeEntities(v).trim() : undefined;
}

// ── value conversion ────────────────────────────────────────────────────────────────────────────────────────────

/** Machine decimal → integer of `scale` decimals, half-up (away from zero) when the source has more decimals. */
function scaled(s: string | undefined, scale: number): number | undefined {
  if (s === undefined) return undefined;
  const r = parseDecimal(s.replace(/^\+/, ""), {
    scale: 8,
    decimalSeparator: ".",
    grouping: false,
    currencySymbol: false,
  });
  if (!r.ok) return undefined;
  const factor = 10n ** BigInt(8 - scale);
  const v = r.value;
  const abs = v < 0n ? -v : v;
  const q = (abs + factor / 2n) / factor;
  return Number(v < 0n ? -q : q);
}

const cents = (s: string | undefined) => scaled(s, 2);
const bp = (s: string | undefined) => scaled(s, 2) ?? 0;

/** CII format 102 (YYYYMMDD) or ISO dates → YYYY-MM-DD. */
function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : undefined;
}

const ciiDate = (node: XNode | undefined) => isoDate(text(node, "DateTimeString"));

const normIban = (s: string | undefined) => (s ? s.replace(/\s+/g, "").toUpperCase() : undefined);

/** Drops keys whose value is undefined (the model must stay plain JSON without undefined values). */
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function decodeBase64(b64: string): Uint8Array | null {
  const clean = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** UBL notes may carry the subject code as `#AAI#text` (XRechnung convention). */
const stripSubject = (note: string) => note.replace(/^#[A-Z]{3}#/, "");

// ── entry points ────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT_RE = /<(?:[A-Za-z_][\w.-]*:)?(Invoice|CreditNote|CrossIndustryInvoice)[\s>/]/;

/** Cheap root sniff (first element after declarations/comments). */
export function invoiceSyntaxOf(xml: string): "ubl" | "cii" | null {
  const head = xml
    .slice(0, 4096)
    .replace(/^﻿/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trimStart();
  const m = ROOT_RE.exec(head);
  if (m?.index !== 0) return null;
  return m[1] === "CrossIndustryInvoice" ? "cii" : "ubl";
}

export function parseReceivedXml(xml: string): Result<ParsedReceived, ReceiveIssue> {
  const source = xml.replace(/^﻿/, "");
  if (/<!DOCTYPE/i.test(source) || /<!ENTITY/i.test(source)) return fail("xml_doctype");
  if (XMLValidator.validate(source) !== true) return fail("xml_malformed");
  let tree: Record<string, unknown>;
  try {
    tree = parser.parse(source) as Record<string, unknown>;
  } catch {
    return fail("xml_malformed");
  }
  const cii = kids(tree, "CrossIndustryInvoice")[0];
  if (cii) return finish(parseCii(cii));
  const ubl = kids(tree, "Invoice")[0] ?? kids(tree, "CreditNote")[0];
  if (ubl) return finish(parseUbl(ubl, kids(tree, "CreditNote").length > 0));
  return fail("xml_unknown_root");
}

function finish(parsed: ParsedReceived | null): Result<ParsedReceived, ReceiveIssue> {
  if (!parsed) return fail("xml_incomplete");
  const inv = parsed.invoice;
  if (!inv.number || !inv.issueDate || !inv.seller.name) return fail("xml_incomplete");
  return ok(parsed);
}

// ── CII ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function ciiAddress(party: XNode | undefined): ReceivedAddress | undefined {
  const a = at(party, "PostalTradeAddress");
  if (!a) return undefined;
  return compact({
    line1: text(a, "LineOne"),
    line2: text(a, "LineTwo"),
    city: text(a, "CityName"),
    postalCode: text(a, "PostcodeCode"),
    countryCode: text(a, "CountryID"),
  });
}

function ciiElectronic(party: XNode | undefined): ReceivedElectronicAddress | undefined {
  const n = at(party, "URIUniversalCommunication", "URIID");
  const value = textOf(n);
  return value ? { scheme: attr(n, "schemeID") ?? "", value } : undefined;
}

function ciiTaxReg(party: XNode | undefined, scheme: "VA" | "FC"): string | undefined {
  for (const reg of kids(party, "SpecifiedTaxRegistration")) {
    const id = at(reg, "ID");
    if (attr(id, "schemeID") === scheme) return textOf(id);
  }
  return undefined;
}

function ciiTax(node: XNode | undefined) {
  return { category: text(node, "CategoryCode") ?? "S", rateBp: bp(text(node, "RateApplicablePercent")) };
}

function parseCii(root: XNode): ParsedReceived | null {
  const doc = at(root, "ExchangedDocument");
  const tx = at(root, "SupplyChainTradeTransaction");
  const agreement = at(tx, "ApplicableHeaderTradeAgreement");
  const delivery = at(tx, "ApplicableHeaderTradeDelivery");
  const settlement = at(tx, "ApplicableHeaderTradeSettlement");
  const sellerNode = at(agreement, "SellerTradeParty");
  const buyerNode = at(agreement, "BuyerTradeParty");
  const guidelineId = text(root, "ExchangedDocumentContext", "GuidelineSpecifiedDocumentContextParameter", "ID");
  const { profile, notEInvoice } = detectProfile(guidelineId);
  const currency = text(settlement, "InvoiceCurrencyCode") ?? "EUR";
  const vatCurrency = text(settlement, "TaxCurrencyCode");

  const lines: ReceivedLine[] = kids(tx, "IncludedSupplyChainTradeLineItem").map((item, i) => {
    const product = at(item, "SpecifiedTradeProduct");
    const qty = at(item, "SpecifiedLineTradeDelivery", "BilledQuantity");
    const lineSettlement = at(item, "SpecifiedLineTradeSettlement");
    return compact({
      id: text(item, "AssociatedDocumentLineDocument", "LineID") ?? String(i + 1),
      name: text(product, "Name") ?? "",
      description: text(product, "Description"),
      quantityMilli: scaled(textOf(qty), 3) ?? 1000,
      unitCode: attr(qty, "unitCode"),
      netCents: cents(text(lineSettlement, "SpecifiedTradeSettlementLineMonetarySummation", "LineTotalAmount")) ?? 0,
      unitPriceMicros: scaled(
        text(item, "SpecifiedLineTradeAgreement", "NetPriceProductTradePrice", "ChargeAmount"),
        4,
      ),
      ...ciiTax(at(lineSettlement, "ApplicableTradeTax")),
    });
  });

  const allowancesCharges: ReceivedAllowanceCharge[] = kids(settlement, "SpecifiedTradeAllowanceCharge").map((ac) =>
    compact({
      charge: text(ac, "ChargeIndicator", "Indicator") === "true",
      amountCents: cents(text(ac, "ActualAmount")) ?? 0,
      reason: text(ac, "Reason"),
      ...ciiTax(at(ac, "CategoryTradeTax")),
    }),
  );

  const vatBreakdown: ReceivedVatBreakdown[] = kids(settlement, "ApplicableTradeTax").map((t) =>
    compact({
      ...ciiTax(t),
      taxableCents: cents(text(t, "BasisAmount")) ?? 0,
      taxCents: cents(text(t, "CalculatedAmount")) ?? 0,
      exemptionReason: text(t, "ExemptionReason"),
    }),
  );

  const sum = at(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const taxTotals = kids(sum, "TaxTotalAmount");
  const taxIn = (cur: string | undefined) => taxTotals.find((n) => (attr(n, "currencyID") ?? currency) === cur);
  const taxCents = cents(textOf(taxIn(currency) ?? taxTotals[0])) ?? 0;
  const bt111 =
    vatCurrency && vatCurrency !== currency
      ? cents(textOf(taxTotals.find((n) => attr(n, "currencyID") === vatCurrency)))
      : undefined;
  const grand = cents(text(sum, "GrandTotalAmount"));
  if (grand === undefined) return null;
  const totals: ReceivedTotals = {
    lineTotalCents: cents(text(sum, "LineTotalAmount")) ?? lines.reduce((s, l) => s + l.netCents, 0),
    allowanceTotalCents: cents(text(sum, "AllowanceTotalAmount")) ?? 0,
    chargeTotalCents: cents(text(sum, "ChargeTotalAmount")) ?? 0,
    taxExclusiveCents: cents(text(sum, "TaxBasisTotalAmount")) ?? grand - taxCents,
    taxCents,
    taxInclusiveCents: grand,
    prepaidCents: cents(text(sum, "TotalPrepaidAmount")) ?? 0,
    roundingCents: cents(text(sum, "RoundingAmount")) ?? 0,
    payableCents: cents(text(sum, "DuePayableAmount")) ?? grand,
  };

  const attachments: ReceivedAttachment[] = [];
  const attachmentMeta: ReceivedInvoice["attachments"] = [];
  for (const ref of kids(agreement, "AdditionalReferencedDocument")) {
    const bin = at(ref, "AttachmentBinaryObject");
    const b64 = textOf(bin);
    if (!b64) continue;
    const bytes = decodeBase64(b64);
    if (!bytes) continue;
    const meta = compact({
      id: text(ref, "IssuerAssignedID"),
      description: text(ref, "Name"),
      filename: attr(bin, "filename") ?? `anlage-${attachments.length + 1}`,
      mime: attr(bin, "mimeCode") ?? "application/octet-stream",
    });
    attachmentMeta.push(meta);
    attachments.push(
      compact({ filename: meta.filename, mime: meta.mime, description: meta.description, bytes }) as ReceivedAttachment,
    );
  }

  const means = at(settlement, "SpecifiedTradeSettlementPaymentMeans");
  const terms = kids(settlement, "SpecifiedTradePaymentTerms");
  const termsText = terms
    .map((t) => text(t, "Description"))
    .filter((s): s is string => !!s)
    .join("\n");
  const dueDate = terms.map((t) => ciiDate(at(t, "DueDateDateTime"))).find((d) => !!d);
  const periodNode = at(settlement, "BillingSpecifiedPeriod");
  const from = ciiDate(at(periodNode, "StartDateTime"));
  const to = ciiDate(at(periodNode, "EndDateTime"));
  const payeeName = text(settlement, "PayeeTradeParty", "Name");

  const invoice: ReceivedInvoice = compact({
    syntax: "cii" as const,
    guidelineId,
    profile,
    notEInvoice,
    typeCode: text(doc, "TypeCode") ?? "380",
    number: text(doc, "ID") ?? "",
    issueDate: ciiDate(at(doc, "IssueDateTime")) ?? "",
    dueDate,
    currency,
    vatCurrency,
    taxTotalVatCurrencyCents: bt111,
    buyerReference: text(agreement, "BuyerReference"),
    contractRef: text(agreement, "ContractReferencedDocument", "IssuerAssignedID"),
    orderRef: text(agreement, "BuyerOrderReferencedDocument", "IssuerAssignedID"),
    precedingInvoices: kids(settlement, "InvoiceReferencedDocument")
      .map((r) =>
        compact({ number: text(r, "IssuerAssignedID") ?? "", date: ciiDate(at(r, "FormattedIssueDateTime")) }),
      )
      .filter((p) => p.number !== ""),
    supplyDate: ciiDate(at(delivery, "ActualDeliverySupplyChainEvent", "OccurrenceDateTime")),
    period: from && to ? { from, to } : undefined,
    notes: kids(doc, "IncludedNote")
      .map((n) => text(n, "Content"))
      .filter((s): s is string => !!s),
    seller: compact({
      name: text(sellerNode, "Name") ?? "",
      tradeName: text(sellerNode, "SpecifiedLegalOrganization", "TradingBusinessName"),
      vatId: ciiTaxReg(sellerNode, "VA"),
      taxNumber: ciiTaxReg(sellerNode, "FC"),
      electronicAddress: ciiElectronic(sellerNode),
      email: text(sellerNode, "DefinedTradeContact", "EmailURIUniversalCommunication", "URIID"),
      address: ciiAddress(sellerNode) ?? {},
    }),
    buyer: compact({
      name: text(buyerNode, "Name"),
      vatId: ciiTaxReg(buyerNode, "VA"),
      electronicAddress: ciiElectronic(buyerNode),
      address: ciiAddress(buyerNode),
    }),
    payee: payeeName ? { name: payeeName } : undefined,
    payment: compact({
      meansCode: text(means, "TypeCode"),
      iban: normIban(text(means, "PayeePartyCreditorFinancialAccount", "IBANID")),
      bic: text(means, "PayeeSpecifiedCreditorFinancialInstitution", "BICID"),
      accountName: text(means, "PayeePartyCreditorFinancialAccount", "AccountName"),
      termsText: termsText || undefined,
      skonto: parseSkontoTerms(termsText),
    }),
    lines,
    allowancesCharges,
    vatBreakdown,
    totals,
    attachments: attachmentMeta,
  });
  return { invoice, attachments };
}

// ── UBL ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function ublAddress(node: XNode | undefined): ReceivedAddress | undefined {
  if (!node) return undefined;
  return compact({
    line1: text(node, "StreetName"),
    line2: text(node, "AdditionalStreetName"),
    city: text(node, "CityName"),
    postalCode: text(node, "PostalZone"),
    countryCode: text(node, "Country", "IdentificationCode"),
  });
}

function ublTaxIds(party: XNode | undefined): { vatId?: string; taxNumber?: string } {
  let vatId: string | undefined;
  let taxNumber: string | undefined;
  for (const s of kids(party, "PartyTaxScheme")) {
    const id = text(s, "CompanyID");
    const scheme = text(s, "TaxScheme", "ID");
    if (!id) continue;
    if (scheme === "VAT" && !vatId) vatId = id;
    else if (scheme !== "VAT" && !taxNumber) taxNumber = id;
  }
  return compact({ vatId, taxNumber });
}

function ublElectronic(party: XNode | undefined): ReceivedElectronicAddress | undefined {
  const n = at(party, "EndpointID");
  const value = textOf(n);
  return value ? { scheme: attr(n, "schemeID") ?? "", value } : undefined;
}

function ublCategory(node: XNode | undefined) {
  return { category: text(node, "ID") ?? "S", rateBp: bp(text(node, "Percent")) };
}

function parseUbl(root: XNode, credit: boolean): ParsedReceived | null {
  const guidelineId = text(root, "CustomizationID");
  const { profile, notEInvoice } = detectProfile(guidelineId);
  const currency = text(root, "DocumentCurrencyCode") ?? "EUR";
  const vatCurrency = text(root, "TaxCurrencyCode");
  const supplier = at(root, "AccountingSupplierParty", "Party");
  const customer = at(root, "AccountingCustomerParty", "Party");

  const lines: ReceivedLine[] = kids(root, credit ? "CreditNoteLine" : "InvoiceLine").map((l, i) => {
    const qty = at(l, credit ? "CreditedQuantity" : "InvoicedQuantity");
    const item = at(l, "Item");
    return compact({
      id: text(l, "ID") ?? String(i + 1),
      name: text(item, "Name") ?? "",
      description: text(item, "Description"),
      quantityMilli: scaled(textOf(qty), 3) ?? 1000,
      unitCode: attr(qty, "unitCode"),
      netCents: cents(text(l, "LineExtensionAmount")) ?? 0,
      unitPriceMicros: scaled(text(l, "Price", "PriceAmount"), 4),
      ...ublCategory(at(item, "ClassifiedTaxCategory")),
    });
  });

  const allowancesCharges: ReceivedAllowanceCharge[] = kids(root, "AllowanceCharge").map((ac) =>
    compact({
      charge: text(ac, "ChargeIndicator") === "true",
      amountCents: cents(text(ac, "Amount")) ?? 0,
      reason: text(ac, "AllowanceChargeReason"),
      ...ublCategory(at(ac, "TaxCategory")),
    }),
  );

  const taxTotals = kids(root, "TaxTotal");
  const mainTax = taxTotals.find((t) => (attr(at(t, "TaxAmount"), "currencyID") ?? currency) === currency);
  const vatBreakdown: ReceivedVatBreakdown[] = kids(mainTax, "TaxSubtotal").map((st) =>
    compact({
      ...ublCategory(at(st, "TaxCategory")),
      taxableCents: cents(text(st, "TaxableAmount")) ?? 0,
      taxCents: cents(text(st, "TaxAmount")) ?? 0,
      exemptionReason: text(st, "TaxCategory", "TaxExemptionReason"),
    }),
  );
  const taxCents = cents(text(mainTax, "TaxAmount")) ?? 0;
  const bt111 =
    vatCurrency && vatCurrency !== currency
      ? cents(
          text(
            taxTotals.find((t) => attr(at(t, "TaxAmount"), "currencyID") === vatCurrency),
            "TaxAmount",
          ),
        )
      : undefined;

  const lmt = at(root, "LegalMonetaryTotal");
  const grand = cents(text(lmt, "TaxInclusiveAmount"));
  if (grand === undefined) return null;
  const totals: ReceivedTotals = {
    lineTotalCents: cents(text(lmt, "LineExtensionAmount")) ?? lines.reduce((s, l) => s + l.netCents, 0),
    allowanceTotalCents: cents(text(lmt, "AllowanceTotalAmount")) ?? 0,
    chargeTotalCents: cents(text(lmt, "ChargeTotalAmount")) ?? 0,
    taxExclusiveCents: cents(text(lmt, "TaxExclusiveAmount")) ?? grand - taxCents,
    taxCents,
    taxInclusiveCents: grand,
    prepaidCents: cents(text(lmt, "PrepaidAmount")) ?? 0,
    roundingCents: cents(text(lmt, "PayableRoundingAmount")) ?? 0,
    payableCents: cents(text(lmt, "PayableAmount")) ?? grand,
  };

  const attachments: ReceivedAttachment[] = [];
  const attachmentMeta: ReceivedInvoice["attachments"] = [];
  for (const ref of kids(root, "AdditionalDocumentReference")) {
    const bin = at(ref, "Attachment", "EmbeddedDocumentBinaryObject");
    const b64 = textOf(bin);
    if (!b64) continue;
    const bytes = decodeBase64(b64);
    if (!bytes) continue;
    const meta = compact({
      id: text(ref, "ID"),
      description: text(ref, "DocumentDescription"),
      filename: attr(bin, "filename") ?? `anlage-${attachments.length + 1}`,
      mime: attr(bin, "mimeCode") ?? "application/octet-stream",
    });
    attachmentMeta.push(meta);
    attachments.push(
      compact({ filename: meta.filename, mime: meta.mime, description: meta.description, bytes }) as ReceivedAttachment,
    );
  }

  const means = at(root, "PaymentMeans");
  const termsText = kids(root, "PaymentTerms")
    .flatMap((t) => kids(t, "Note").map(textOf))
    .filter((s): s is string => !!s)
    .join("\n");
  const from = text(root, "InvoicePeriod", "StartDate");
  const to = text(root, "InvoicePeriod", "EndDate");
  const payeeName = text(root, "PayeeParty", "PartyName", "Name");
  const orderRef = text(root, "OrderReference", "ID");

  const invoice: ReceivedInvoice = compact({
    syntax: "ubl" as const,
    guidelineId,
    profile,
    notEInvoice,
    typeCode: text(root, credit ? "CreditNoteTypeCode" : "InvoiceTypeCode") ?? (credit ? "381" : "380"),
    number: text(root, "ID") ?? "",
    issueDate: isoDate(text(root, "IssueDate")) ?? "",
    dueDate: isoDate(text(root, "DueDate") ?? text(means, "PaymentDueDate")),
    currency,
    vatCurrency,
    taxTotalVatCurrencyCents: bt111,
    buyerReference: text(root, "BuyerReference"),
    contractRef: text(root, "ContractDocumentReference", "ID"),
    orderRef: orderRef && orderRef !== "NA" ? orderRef : undefined,
    precedingInvoices: kids(root, "BillingReference")
      .map((b) => at(b, "InvoiceDocumentReference"))
      .map((r) => compact({ number: text(r, "ID") ?? "", date: isoDate(text(r, "IssueDate")) }))
      .filter((p) => p.number !== ""),
    supplyDate: isoDate(text(root, "Delivery", "ActualDeliveryDate")),
    period: from && to ? { from: isoDate(from) ?? from, to: isoDate(to) ?? to } : undefined,
    notes: kids(root, "Note")
      .map(textOf)
      .filter((s): s is string => !!s)
      .map(stripSubject),
    seller: compact({
      name: text(supplier, "PartyLegalEntity", "RegistrationName") ?? text(supplier, "PartyName", "Name") ?? "",
      tradeName: text(supplier, "PartyName", "Name"),
      ...ublTaxIds(supplier),
      electronicAddress: ublElectronic(supplier),
      email: text(supplier, "Contact", "ElectronicMail"),
      address: ublAddress(at(supplier, "PostalAddress")) ?? {},
    }),
    buyer: compact({
      name: text(customer, "PartyLegalEntity", "RegistrationName") ?? text(customer, "PartyName", "Name"),
      vatId: ublTaxIds(customer).vatId,
      electronicAddress: ublElectronic(customer),
      address: ublAddress(at(customer, "PostalAddress")),
    }),
    payee: payeeName ? { name: payeeName } : undefined,
    payment: compact({
      meansCode: text(means, "PaymentMeansCode"),
      iban: normIban(text(means, "PayeeFinancialAccount", "ID")),
      bic: text(means, "PayeeFinancialAccount", "FinancialInstitutionBranch", "ID"),
      accountName: text(means, "PayeeFinancialAccount", "Name"),
      termsText: termsText || undefined,
      skonto: parseSkontoTerms(termsText),
    }),
    lines,
    allowancesCharges,
    vatBreakdown,
    totals,
    attachments: attachmentMeta,
  });
  return { invoice, attachments };
}
