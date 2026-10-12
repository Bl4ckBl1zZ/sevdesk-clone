/**
 * Snapshot → EN 16931 semantic model (F04 INV-19, App. A; 02 §2 ADR-007). Pure. The serializers (`cii.ts`, `ubl.ts`)
 * only write what this mapping produced, so every business rule about *content* lives here:
 *
 * - TypeCode (App. A.2) and credit-note signs (App. A.8: 381 documents are written with positive amounts).
 * - VAT categories incl. KU → E with the KU note as BT-120 and no BT-121 (App. A.9, F04 9.2,
 *   LEGAL-OPEN: 01 open item 2), VATEX codes, O without rate and without BT-31/BT-48 (BR-O-02).
 * - Line prices: net mode with BG-27 line allowances (App. A.10); gross mode with BT-146/BT-149 per App. E.3 step 5.
 * - BT-10/BT-49 (App. A.3), BT-20 Skonto (App. A.4), BG-16 (App. A.5), final invoices BT-113/BT-115/BG-3 and the
 *   per-rate deduction notes (App. A.6), BT-111 in EUR for foreign currency (MISC-08), BT-83 = payment reference.
 */
import { geschaeftsbriefFooter } from "../company/footer";
import { formatAmount, formatDate, formatRate } from "../documents/i18n";
import {
  billableItems,
  type DocumentSnapshot,
  monthBounds,
  type SnapshotAddress,
  type SnapshotItemLine,
  type SnapshotNote,
} from "../documents/snapshot";
import { roundHalfAway } from "../money/rounding";
import type { VatCategory } from "../tax/vat-category";
import { resolveBuyerReference } from "./buyer-reference";
import {
  BUSINESS_PROCESS_ID,
  CUSTOMIZATION_ID,
  type En16931Invoice,
  type En16931Profile,
  type XmlAddress,
  type XmlAttachment,
  type XmlElectronicAddress,
  type XmlLine,
  type XmlNote,
  type XmlVatCategory,
} from "./model";
import { paymentMeansFor, paymentTermsText } from "./payment";
import { invoiceTypeCode, isCreditNote } from "./type-code";

export class EinvoiceMappingError extends Error {
  readonly code: "no_xml_for_type";
  constructor(code: "no_xml_for_type", message: string) {
    super(message);
    this.name = "EinvoiceMappingError";
    this.code = code;
  }
}

export interface MapOptions {
  /** BT-24 profile: plain EN 16931 (ZUGFeRD EN16931) or XRechnung 3.0 (XRechnung UBL/CII, ZUGFeRD XRECHNUNG). */
  readonly profile: En16931Profile;
  /** BG-24 embedded attachments (DOC-18 `embedInXml`); the snapshot holds only their hashes. */
  readonly attachments?: readonly XmlAttachment[];
}

const xmlCategory = (c: VatCategory): XmlVatCategory => (c === "KU" ? "E" : c);
const xmlRate = (c: VatCategory, rateBp: number): number | null => (c === "O" ? null : rateBp);

function address(a: SnapshotAddress | undefined, fallbackCountry: string): XmlAddress {
  if (!a) return { countryCode: fallbackCountry };
  const line1 = a.street || a.poBox;
  return {
    ...(line1 ? { line1 } : {}),
    ...(a.street2 ? { line2: a.street2 } : {}),
    ...(a.department ? { line3: a.department } : {}),
    ...(a.city ? { city: a.city } : {}),
    ...(a.postalCode ? { postalCode: a.postalCode } : {}),
    countryCode: a.countryCode,
  };
}

/** Notes are written in the document language; EN documents carry the German text too (App. B, DOC-16). */
const noteText = (n: Pick<SnapshotNote, "de" | "en">, lang: "de" | "en") =>
  lang === "en" ? `${n.en} / ${n.de}` : n.de;

/** App. A.6: one AAI line per (advance, rate). */
function deductionNotes(s: DocumentSnapshot): XmlNote[] {
  const lang = s.language;
  const out: XmlNote[] = [];
  for (const d of s.deductions ?? []) {
    for (const g of d.byGroup) {
      const paid = d.paidOn ? formatDate(d.paidOn, lang) : undefined;
      const amount = (c: number) => formatAmount(c, s.currency, lang);
      out.push({
        subjectCode: "AAI",
        text:
          lang === "en"
            ? `Less advance invoice ${d.advanceNumber} dated ${formatDate(d.advanceDate, lang)}: net ${amount(g.netCents)}, VAT ${formatRate(g.rateBp, lang)} % ${amount(g.vatCents)}, gross ${amount(g.grossCents)}${paid ? ` (received ${paid})` : ""}`
            : `Abzüglich Abschlagsrechnung ${d.advanceNumber} vom ${formatDate(d.advanceDate, lang)}: netto ${amount(g.netCents)}, USt ${formatRate(g.rateBp, lang)} % ${amount(g.vatCents)}, brutto ${amount(g.grossCents)}${paid ? ` (erhalten am ${paid})` : ""}`,
      });
    }
  }
  return out;
}

function notesFor(s: DocumentSnapshot): XmlNote[] {
  const lang = s.language;
  const notes: XmlNote[] = [];
  if (s.texts.subject) notes.push({ subjectCode: "AAI", text: s.texts.subject });
  for (const n of s.notes.filter((x) => x.zone === "title" && x.xmlSubjectCode)) {
    notes.push({ subjectCode: n.xmlSubjectCode, text: noteText(n, lang) });
  }
  if (s.texts.headText) notes.push({ subjectCode: "AAI", text: s.texts.headText });
  if (s.rectifiedFields?.length && !s.notes.some((n) => n.id === "rect_info")) {
    notes.push({ subjectCode: "AAI", text: `Berichtigt: ${s.rectifiedFields.join(", ")}` });
  }
  notes.push(...deductionNotes(s));
  const dn = s.references.deliveryNoteNumbers ?? [];
  if (dn.length > 1)
    notes.push({ subjectCode: "AAI", text: `${lang === "en" ? "Delivery notes" : "Lieferscheine"}: ${dn.join(", ")}` });
  for (const n of s.notes.filter((x) => x.zone !== "title" && x.xmlSubjectCode)) {
    notes.push({ subjectCode: n.xmlSubjectCode, text: noteText(n, lang) });
  }
  if (s.texts.footText) notes.push({ subjectCode: "SUR", text: s.texts.footText });
  return notes;
}

/** BT-33: the Geschäftsbrief items (court, register, managing directors, share capital) as one string (A.1). */
function sellerLegalInfo(s: DocumentSnapshot): string | undefined {
  const legal = geschaeftsbriefFooter(s.seller, []).columns[1].filter(
    (l) => !l.startsWith("Steuernummer") && !l.startsWith("USt-IdNr"),
  );
  return legal.length ? legal.join(" · ") : undefined;
}

/** App. A.3: BT-49 = contact electronic address → invoice e-mail (EM) → for B2G the Leitweg-ID (0204). */
function buyerElectronicAddress(s: DocumentSnapshot): XmlElectronicAddress | undefined {
  const b = s.buyer;
  if (b.electronicAddress) return { scheme: b.electronicAddress.scheme, value: b.electronicAddress.value };
  if (b.invoiceEmail) return { scheme: "EM", value: b.invoiceEmail };
  if (b.isPublicAuthority && s.references.buyerReference) return { scheme: "0204", value: s.references.buyerReference };
  return undefined;
}

function line(l: SnapshotItemLine, s: DocumentSnapshot, sign: 1 | -1): XmlLine {
  // Keep BT-146 non-negative (BR-27): a negative unit price moves its sign to the quantity.
  const priceSign = l.unitPriceMicros < 0 ? -1 : 1;
  let quantity = l.quantityMilli * priceSign;
  const net = l.netCents;
  let priceMicros: number;
  let baseQuantityMilli: number | undefined;
  let allowance: XmlLine["allowance"];
  if (s.priceMode === "net") {
    priceMicros = Math.abs(l.unitPriceMicros);
    const base = Number(roundHalfAway(BigInt(quantity) * BigInt(priceMicros), 100_000n));
    if (l.discount && base !== net) {
      allowance = {
        amountCents: (base - net) * sign,
        baseCents: base * sign,
        ...(l.discount.kind === "percent" ? { percentBp: l.discount.bp } : {}),
        reason: s.language === "en" ? "Discount" : "Rabatt",
        reasonCode: "95",
      };
    }
  } else {
    // App. E.3 step 5: BT-146 = round(lineNet × 10³ / qty, 4 dp); if qty × BT-146 ≠ lineNet → BT-149 = qty, BT-146 = lineNet.
    const p = roundHalfAway(BigInt(net) * 100_000n, BigInt(quantity));
    const back = roundHalfAway(BigInt(quantity) * p, 100_000n);
    if (p >= 0n && Number(back) === net) priceMicros = Number(p);
    else {
      baseQuantityMilli = Math.abs(quantity);
      priceMicros = Math.abs(net) * 100;
      quantity = Math.sign(net || 1) * Math.abs(quantity);
    }
  }
  return {
    id: String(l.position),
    ...(l.note ? { note: l.note } : {}),
    quantityMilli: quantity * sign,
    unitCode: l.unitCode,
    netCents: net * sign,
    ...(l.period ? { period: l.period } : {}),
    ...(allowance ? { allowance } : {}),
    priceMicros,
    ...(baseQuantityMilli !== undefined ? { baseQuantityMilli: baseQuantityMilli } : {}),
    category: xmlCategory(l.vatCategory),
    rateBp: xmlRate(l.vatCategory, l.vatRateBp),
    name: l.name,
    ...(l.description ? { description: l.description } : {}),
    ...(l.itemNumber ? { sellerItemId: l.itemNumber } : {}),
    ...(l.buyerItemNumber ? { buyerItemId: l.buyerItemNumber } : {}),
  };
}

export function mapToEn16931(s: DocumentSnapshot, options: MapOptions): En16931Invoice {
  const typeCode = invoiceTypeCode({
    type: s.type,
    correctionKind: s.correctionKind,
    constructionWork: s.flags.constructionWork,
  });
  if (!typeCode)
    throw new EinvoiceMappingError("no_xml_for_type", `Für den Dokumenttyp „${s.type}“ gibt es keine E-Rechnung.`);
  const sign: 1 | -1 = isCreditNote(typeCode) ? -1 : 1;
  const t = s.totals;
  const items = billableItems(s);
  const onlyO = t.byGroup.length > 0 && t.byGroup.every((g) => g.category === "O");
  const seller = s.seller;
  const registerNumber = seller.register?.number
    ? `${seller.register.type} ${seller.register.number}`.trim()
    : undefined;
  const supply = s.supplyDate;
  const period =
    supply?.kind === "period"
      ? { from: supply.from, to: supply.to }
      : supply?.kind === "month"
        ? monthBounds(supply.month)
        : undefined;
  const deliveryDate = supply?.kind === "date" ? supply.date : undefined;
  const deliveryAddress = s.delivery?.address;
  const deliveryName = s.delivery?.partyName ?? deliveryAddress?.name;
  const dn = s.references.deliveryNoteNumbers ?? [];
  const legalInfo = sellerLegalInfo(s);
  const buyerEa = buyerElectronicAddress(s);
  const terms = paymentTermsText(s);
  // BT-10 was resolved for the snapshot's own format; an XRechnung rendering of it applies the B2B fallback chain
  // (App. A.3, BR-DE-15) so that every XRechnung carries a buyer reference.
  const buyerReference =
    options.profile === "xrechnung"
      ? resolveBuyerReference({
          format: "xrechnung_ubl",
          isPublicAuthority: s.buyer.isPublicAuthority,
          sources: {
            document: s.references.buyerReference,
            orderReference: s.references.orderReference,
            contactNumber: s.buyer.contactNumber,
          },
        }).value
      : s.references.buyerReference;
  const allowanceCharges = t.byGroup.flatMap((g) => {
    const out: En16931Invoice["allowanceCharges"][number][] = [];
    const percent = s.priceMode === "net" ? s.adjustment?.percentBp : undefined;
    const common = { category: xmlCategory(g.category), rateBp: xmlRate(g.category, g.rateBp) };
    if (g.allowanceCents !== 0) {
      out.push({
        charge: false,
        amountCents: g.allowanceCents * sign,
        ...(percent !== undefined ? { percentBp: percent, baseCents: g.lineNetSumCents * sign } : {}),
        ...common,
        reason: s.adjustment?.reason ?? (s.language === "en" ? "Discount" : "Rabatt"),
        reasonCode: s.adjustment?.reasonCode ?? "95",
      });
    }
    if (g.chargeCents !== 0) {
      out.push({
        charge: true,
        amountCents: g.chargeCents * sign,
        ...(percent !== undefined ? { percentBp: percent, baseCents: g.lineNetSumCents * sign } : {}),
        ...common,
        reason: s.adjustment?.reason ?? (s.language === "en" ? "Surcharge" : "Zuschlag"),
        reasonCode: s.adjustment?.reasonCode ?? "ZZZ",
      });
    }
    return out;
  });

  return {
    profile: options.profile,
    customizationId: CUSTOMIZATION_ID[options.profile],
    ...(options.profile === "xrechnung" ? { businessProcessId: BUSINESS_PROCESS_ID } : {}),
    number: s.number,
    issueDate: s.documentDate,
    typeCode,
    currency: s.currency,
    ...(s.currency !== "EUR" ? { taxCurrency: "EUR" as const } : {}),
    ...(s.dueDate && t.payableCents > 0 ? { dueDate: s.dueDate } : {}),
    ...(buyerReference ? { buyerReference } : {}),
    ...(s.references.projectReference ? { projectReference: s.references.projectReference } : {}),
    ...(s.references.contractReference ? { contractReference: s.references.contractReference } : {}),
    ...(s.references.orderReference ? { orderReference: s.references.orderReference } : {}),
    ...(s.references.salesOrderReference ? { salesOrderReference: s.references.salesOrderReference } : {}),
    ...(dn.length === 1 && dn[0] ? { despatchAdviceReference: dn[0] } : {}),
    ...(terms ? { paymentTerms: terms } : {}),
    notes: notesFor(s),
    precedingInvoices: s.references.precedingInvoices.map((p) => ({ number: p.number, date: p.date })),
    seller: {
      name: seller.name,
      ...(seller.tradeName ? { tradeName: seller.tradeName } : {}),
      // BR-CO-26: without BT-30 and BT-31 (KU without USt-IdNr., O-only invoices of unregistered traders) the
      // Steuernummer also identifies the seller as BT-29.
      ...(!registerNumber && !(seller.vatId && !onlyO) && seller.taxNumber ? { identifier: seller.taxNumber } : {}),
      ...(registerNumber ? { registerNumber } : {}),
      ...(seller.vatId && !onlyO ? { vatId: seller.vatId } : {}),
      ...(seller.taxNumber ? { taxNumber: seller.taxNumber } : {}),
      ...(legalInfo ? { legalInfo } : {}),
      ...(seller.electronicAddress ? { electronicAddress: seller.electronicAddress } : {}),
      address: address(
        { ...seller.address, street: seller.address.street, countryCode: seller.address.countryCode },
        "DE",
      ),
      contact: {
        ...(seller.contact.name ? { name: seller.contact.name } : {}),
        ...(seller.contact.phone ? { phone: seller.contact.phone } : {}),
        ...(seller.contact.email ? { email: seller.contact.email } : {}),
      },
    },
    buyer: {
      name: s.buyer.name,
      ...(s.buyer.tradeName ? { tradeName: s.buyer.tradeName } : {}),
      ...(s.buyer.contactNumber ? { identifier: s.buyer.contactNumber } : {}),
      ...(s.buyer.registerNumber ? { registerNumber: s.buyer.registerNumber } : {}),
      ...(s.buyer.vatId && !onlyO ? { vatId: s.buyer.vatId } : {}),
      ...(buyerEa ? { electronicAddress: buyerEa } : {}),
      address: address(s.buyer.address, "DE"),
      ...(s.buyer.contactPerson ? { contact: s.buyer.contactPerson } : {}),
    },
    ...(deliveryDate || deliveryAddress || deliveryName
      ? {
          delivery: {
            ...(deliveryName ? { partyName: deliveryName } : {}),
            ...(deliveryAddress ? { address: address(deliveryAddress, deliveryAddress.countryCode) } : {}),
            ...(deliveryDate ? { date: deliveryDate } : {}),
          },
        }
      : {}),
    ...(period ? { invoicePeriod: period } : {}),
    paymentMeans: [paymentMeansFor(s)],
    allowanceCharges,
    totals: {
      lineNetCents: t.lineNetSumCents * sign,
      allowanceCents: t.allowanceTotalCents * sign,
      chargeCents: t.chargeTotalCents * sign,
      taxExclusiveCents: t.netCents * sign,
      vatCents: t.vatCents * sign,
      ...(t.vatEurCents !== undefined ? { vatAccountingCurrencyCents: t.vatEurCents * sign } : {}),
      taxInclusiveCents: t.grossCents * sign,
      prepaidCents: t.advancesDeductedGrossCents * sign,
      roundingCents: t.roundingCents * sign,
      payableCents: t.payableCents * sign,
    },
    vatBreakdown: t.byGroup.map((g) => ({
      baseCents: g.baseCents * sign,
      vatCents: g.vatCents * sign,
      category: xmlCategory(g.category),
      // BR-DE-14 (XRechnung): BT-119 is mandatory in every breakdown, also for O (0.00); lines keep no rate (BR-O-05).
      rateBp: g.category === "O" && options.profile === "xrechnung" ? 0 : xmlRate(g.category, g.rateBp),
      ...(g.exemptionReasonText ? { exemptionReason: g.exemptionReasonText } : {}),
      ...(g.exemptionReasonCode && g.category !== "KU" ? { exemptionReasonCode: g.exemptionReasonCode } : {}),
    })),
    attachments: options.attachments ?? [],
    lines: items.map((l) => line(l, s, sign)),
  };
}
