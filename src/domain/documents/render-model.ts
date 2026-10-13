/**
 * Render model for the PDF templates (F04 App. F zones H/S/W/I/T/P/∑/L/F/Z, F01 SET-071 layout config, DOC-30/31,
 * DOC-32 "Kopie", §4.10.2 "Lesefassung"). Pure: every printed string is decided here, in the document language
 * (DOC-16; EN legal notes bilingual), so the react-pdf components only lay it out and the golden PDF text can be
 * reasoned about from the snapshot alone.
 */
import { geschaeftsbriefFooter } from "../company/footer";
import { footerItems } from "../company/legal-forms";
import { girocodeFor } from "../epc/girocode";
import { SEED_UNITS } from "../lookups/units";
import { lookupNoteText } from "../rules/note-texts";
import type { CalendarDate } from "../time/calendar-date";
import { type DocLanguage, formatAmount, formatDate, formatQuantity, formatRate, formatUnitPrice } from "./i18n";
import { footerVisible } from "./layout";
import {
  billableItems,
  type DocumentSnapshot,
  monthBounds,
  type SnapshotAddress,
  type SnapshotItemLine,
  type SnapshotNote,
} from "./snapshot";

export type RenderVariant = "original" | "copy" | "reading" | "draft";

/** Layout version config (03 `layoutVersions.config`, F01 SET-071, §6.6). */
export interface RenderLayout {
  readonly template: "classic" | "modern" | "minimal";
  readonly accentColor: string;
  readonly font: "inter" | "noto" | "source-serif";
  readonly logoPosition: "left" | "right";
  readonly printOptions: {
    readonly foldMarks: boolean;
    readonly pageNumbers: boolean;
    readonly senderLine: boolean;
    readonly vatPerLine: boolean;
    readonly productNumbers: boolean;
    readonly lineDescriptions: boolean;
    readonly grossLineTotals: boolean;
    readonly epcQr: boolean;
    readonly allInvoiceAccountsInFooter: boolean;
    readonly footerInLetterhead: { readonly confirmedAt: number; readonly items: readonly string[] } | null;
  };
}

export const DEFAULT_LAYOUT: RenderLayout = {
  template: "modern",
  accentColor: "#1F6FEB",
  font: "inter",
  logoPosition: "right",
  printOptions: {
    foldMarks: true,
    pageNumbers: true,
    senderLine: true,
    vatPerLine: false,
    productNumbers: false,
    lineDescriptions: true,
    grossLineTotals: true,
    epcQr: true,
    allInvoiceAccountsInFooter: false,
    footerInLetterhead: null,
  },
};

export interface RenderColumn {
  readonly key: "pos" | "name" | "quantity" | "unit" | "unitPrice" | "vat" | "discount" | "amount";
  readonly label: string;
  readonly align: "left" | "right";
}

export type RenderRow =
  | {
      readonly kind: "item";
      readonly pos: string;
      readonly name: string;
      readonly itemNumber?: string;
      readonly description?: string;
      readonly period?: string;
      readonly quantity: string;
      readonly unit: string;
      readonly unitPrice: string;
      readonly vat: string;
      readonly discount: string;
      readonly amount: string;
      readonly optional: boolean;
    }
  | { readonly kind: "heading" | "text"; readonly text: string }
  | { readonly kind: "subtotal"; readonly text: string; readonly amount: string };

export interface RenderTotalRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: "strong" | "muted";
}

export interface RenderModel {
  readonly language: DocLanguage;
  readonly variant: RenderVariant;
  readonly title: string;
  readonly number: string;
  /** Header-right stamp ("Kopie", "Lesefassung – …"), plus a diagonal watermark for copies and drafts. */
  readonly stamp?: string;
  readonly watermark?: string;
  readonly sellerName: string;
  readonly senderLine?: string;
  readonly recipient: readonly string[];
  readonly info: readonly { readonly label: string; readonly value: string }[];
  readonly subject?: string;
  readonly titleNotes: readonly string[];
  readonly headText?: string;
  readonly columns: readonly RenderColumn[];
  readonly rows: readonly RenderRow[];
  readonly totals: readonly RenderTotalRow[];
  readonly totalsNotes: readonly string[];
  readonly legalNotes: readonly string[];
  readonly payment: {
    readonly lines: readonly string[];
    readonly bank?: readonly { readonly label: string; readonly value: string }[];
    /** EPC QR payload (DOC-51); null when not applicable. */
    readonly epcPayload: string | null;
  };
  readonly reminder?: {
    readonly rows: readonly RenderTotalRow[];
    readonly interest?: readonly (readonly string[])[];
    readonly interestHeader?: readonly string[];
  };
  readonly footText?: string;
  readonly customFields: readonly { readonly label: string; readonly value: string }[];
  readonly footer: readonly (readonly string[])[] | null;
  readonly einvoiceHint?: string;
  readonly pageLabel: { readonly page: string; readonly of: string };
  readonly layout: RenderLayout;
  readonly meta: {
    readonly title: string;
    readonly author: string;
    readonly subject: string;
    readonly keywords: readonly string[];
  };
}

const L = {
  de: {
    number: "Nummer",
    date: "Datum",
    invoiceDate: "Rechnungsdatum",
    quoteDate: "Angebotsdatum",
    supplyDate: "Leistungsdatum",
    supplyPeriod: "Leistungszeitraum",
    deliveryDate: "Lieferdatum",
    expectedSupply: "Voraussichtlicher Leistungszeitpunkt/-zeitraum",
    customerNumber: "Kundennummer",
    orderReference: "Ihre Bestellung",
    buyerReference: "Ihre Referenz",
    leitwegId: "Leitweg-ID",
    contract: "Vertrag",
    deliveryNotes: "Lieferschein(e)",
    original: "Zur Rechnung",
    validUntil: "Gültig bis",
    deliveryTerms: "Lieferbedingungen",
    dueDate: "Fällig am",
    contactPerson: "Ansprechpartner",
    phone: "Telefon",
    email: "E-Mail",
    ourVatId: "Unsere USt-IdNr.",
    yourVatId: "Ihre USt-IdNr.",
    pos: "Pos.",
    name: "Bezeichnung",
    quantity: "Menge",
    unit: "Einheit",
    unitPriceNet: "Einzelpreis netto",
    unitPriceGross: "Einzelpreis brutto",
    unitPrice: "Einzelpreis",
    vat: "USt",
    discount: "Rabatt",
    amountNet: "Gesamt netto",
    amountGross: "Gesamt brutto",
    amount: "Gesamt",
    optional: "Optional",
    itemNumber: "Art.-Nr.",
    period: "Zeitraum",
    lineSum: "Summe Positionen",
    allowance: "Gesamtrabatt",
    charge: "Zuschlag",
    net: "Summe netto",
    vatOn: (rate: string, base: string) => `zzgl. ${rate} % USt auf ${base}`,
    gross: "Gesamtbetrag",
    deduction: (nr: string, date: string, rate: string, net: string, vat: string) =>
      `abzgl. Abschlagsrechnung ${nr} vom ${date}: netto ${net} zzgl. ${rate} % USt ${vat}`,
    deductedTotal: "Summe der Abzüge",
    payable: "Zahlbetrag",
    refund: "Erstattungsbetrag",
    refundText: "Der Betrag wird erstattet.",
    noPayable: "Kein Zahlbetrag.",
    accountHolder: "Kontoinhaber",
    iban: "IBAN",
    bic: "BIC",
    bank: "Bank",
    paymentMethod: "Zahlungsart",
    page: "Seite",
    of: "von",
    einvoiceZugferd: "Diese Rechnung enthält eine E-Rechnung nach EN 16931 (ZUGFeRD 2.5).",
    reading: "Lesefassung – maßgeblich ist die XRechnung",
    draft: "ENTWURF – keine gültige Rechnung",
    subtotal: "Zwischensumme",
    reminderInvoice: (nr: string, date: string) => `Rechnung ${nr} vom ${date}`,
    reminderDue: "fällig seit",
    reminderGross: "Rechnungsbetrag",
    reminderPaid: "bereits gezahlt",
    reminderOpen: "offener Betrag",
    reminderFee: "Mahngebühr",
    reminderInterest: "Verzugszinsen",
    reminderFlat: "Verzugspauschale (§ 288 Abs. 5 BGB)",
    reminderFlatClaimed: "Verzugspauschale bereits geltend gemacht",
    reminderTotal: "Gesamtforderung",
    reminderDeadline: (d: string) => `Bitte überweisen Sie den Gesamtbetrag bis zum ${d}.`,
    interestHeader: ["Zeitraum", "Tage", "Zinssatz", "Betrag"],
  },
  en: {
    number: "Number",
    date: "Date",
    invoiceDate: "Invoice date",
    quoteDate: "Quotation date",
    supplyDate: "Date of supply",
    supplyPeriod: "Period of supply",
    deliveryDate: "Delivery date",
    expectedSupply: "Expected date/period of supply",
    customerNumber: "Customer no.",
    orderReference: "Your order",
    buyerReference: "Your reference",
    leitwegId: "Leitweg-ID",
    contract: "Contract",
    deliveryNotes: "Delivery note(s)",
    original: "Relating to invoice",
    validUntil: "Valid until",
    deliveryTerms: "Terms of delivery",
    dueDate: "Due date",
    contactPerson: "Contact",
    phone: "Phone",
    email: "E-mail",
    ourVatId: "Our VAT ID",
    yourVatId: "Your VAT ID",
    pos: "Item",
    name: "Description",
    quantity: "Qty",
    unit: "Unit",
    unitPriceNet: "Unit price (net)",
    unitPriceGross: "Unit price (gross)",
    unitPrice: "Unit price",
    vat: "VAT",
    discount: "Discount",
    amountNet: "Amount (net)",
    amountGross: "Amount (gross)",
    amount: "Amount",
    optional: "Optional",
    itemNumber: "Item no.",
    period: "Period",
    lineSum: "Line total",
    allowance: "Discount",
    charge: "Surcharge",
    net: "Total net",
    vatOn: (rate: string, base: string) => `plus ${rate} % VAT on ${base}`,
    gross: "Total amount",
    deduction: (nr: string, date: string, rate: string, net: string, vat: string) =>
      `less advance invoice ${nr} dated ${date}: net ${net} plus ${rate} % VAT ${vat}`,
    deductedTotal: "Total deductions",
    payable: "Amount payable",
    refund: "Amount to be refunded",
    refundText: "The amount will be refunded.",
    noPayable: "No amount payable.",
    accountHolder: "Account holder",
    iban: "IBAN",
    bic: "BIC",
    bank: "Bank",
    paymentMethod: "Payment method",
    page: "Page",
    of: "of",
    einvoiceZugferd: "This invoice contains an EN 16931 e-invoice (ZUGFeRD 2.5).",
    reading: "Reading copy – the XRechnung is authoritative / Lesefassung – maßgeblich ist die XRechnung",
    draft: "DRAFT – not a valid invoice / ENTWURF – keine gültige Rechnung",
    subtotal: "Subtotal",
    reminderInvoice: (nr: string, date: string) => `Invoice ${nr} dated ${date}`,
    reminderDue: "due since",
    reminderGross: "Invoice amount",
    reminderPaid: "already paid",
    reminderOpen: "amount outstanding",
    reminderFee: "Reminder fee",
    reminderInterest: "Default interest",
    reminderFlat: "Flat-rate compensation (Section 288 (5) BGB)",
    reminderFlatClaimed: "Flat-rate compensation already claimed",
    reminderTotal: "Total claim",
    reminderDeadline: (d: string) => `Please transfer the total amount by ${d}.`,
    interestHeader: ["Period", "Days", "Rate", "Amount"],
  },
} as const;

const TITLES: Record<string, { de: string; en: string }> = {
  quote: { de: "Angebot", en: "Quotation" },
  order_confirmation: { de: "Auftragsbestätigung", en: "Order confirmation" },
  delivery_note: { de: "Lieferschein", en: "Delivery note" },
  proforma: { de: "Proforma-Rechnung", en: "Pro forma invoice" },
  invoice: { de: "Rechnung", en: "Invoice" },
  final_invoice: { de: "Schlussrechnung", en: "Final invoice" },
  cancellation: { de: "Stornorechnung", en: "Cancellation invoice" },
  credit: { de: "Rechnungskorrektur", en: "Invoice correction (credit note)" },
  rectification: { de: "Rechnungsberichtigung", en: "Corrected invoice" },
  self_billing: { de: "Gutschrift", en: "Self-billing invoice (Gutschrift)" },
};

function title(s: DocumentSnapshot): string {
  const lang = s.language;
  const n = String(s.flags.chainIndex ?? 1);
  if (s.type === "advance_invoice") return lang === "en" ? `Advance invoice no. ${n}` : `${n}. Abschlagsrechnung`;
  if (s.type === "partial_invoice") return lang === "en" ? `Partial invoice no. ${n}` : `${n}. Teilrechnung`;
  if (s.type === "reminder") return s.reminder?.title ?? (lang === "en" ? "Payment reminder" : "Zahlungserinnerung");
  if (s.type === "correction")
    return TITLES[s.correctionKind === "rectification" ? "rectification" : "credit"]?.[lang] ?? "";
  return TITLES[s.type]?.[lang] ?? s.type;
}

const regionNames = {
  de: new Intl.DisplayNames(["de"], { type: "region" }),
  en: new Intl.DisplayNames(["en"], { type: "region" }),
};

function addressLines(a: SnapshotAddress | undefined, lang: DocLanguage): string[] {
  if (!a) return [];
  const out: string[] = [];
  if (a.department) out.push(a.department);
  if (a.street) out.push(a.street);
  if (a.street2) out.push(a.street2);
  if (a.poBox) out.push(a.poBox);
  out.push([a.postalCode, a.city].filter(Boolean).join(" "));
  if (a.countryCode !== "DE") out.push((regionNames[lang].of(a.countryCode) ?? a.countryCode).toUpperCase());
  return out;
}

const noteLines = (notes: readonly SnapshotNote[], lang: DocLanguage): string[] =>
  notes.flatMap((n) => (lang === "en" && n.en !== n.de ? [n.en, `/ ${n.de}`] : [lang === "en" ? n.en : n.de]));

function supplyText(s: DocumentSnapshot): { label: string; value: string } | null {
  const l = L[s.language];
  const sd = s.supplyDate;
  if (!sd) return null;
  const advance = s.type === "advance_invoice" || s.type === "partial_invoice";
  const fd = (d: string) => formatDate(d, s.language);
  if (sd.kind === "date") {
    return {
      label: advance ? l.expectedSupply : s.type === "delivery_note" ? l.deliveryDate : l.supplyDate,
      value: fd(sd.date),
    };
  }
  const p = sd.kind === "month" ? monthBounds(sd.month) : sd;
  return { label: advance ? l.expectedSupply : l.supplyPeriod, value: `${fd(p.from)} – ${fd(p.to)}` };
}

function unitLabel(line: SnapshotItemLine, lang: DocLanguage): string {
  if (line.unitLabel) return line.unitLabel;
  return SEED_UNITS.find((u) => u.code === line.unitCode)?.label[lang] ?? line.unitCode;
}

/** Stamp text of the "Kopie" variant from the versioned note row (DOC-32). */
function copyStamp(s: DocumentSnapshot): string {
  const row = lookupNoteText("copy_stamp", s.documentDate as CalendarDate);
  if (!row.ok) return s.language === "en" ? "Copy / Kopie" : "Kopie";
  return s.language === "en" ? row.value.value.en : row.value.value.de;
}

export function buildRenderModel(
  s: DocumentSnapshot,
  layout: RenderLayout = DEFAULT_LAYOUT,
  variant: RenderVariant = "original",
): RenderModel {
  const lang = s.language;
  const l = L[lang];
  const money = (c: number) => formatAmount(c, s.currency, lang);
  const fd = (d: string) => formatDate(d, lang);
  const isKu = s.taxCase === "kleinunternehmer" || s.totals.byGroup.some((g) => g.category === "KU");
  const priced = s.type !== "delivery_note" || s.flags.showPrices === true;
  const gross = s.priceMode === "gross";
  const items = s.lines.filter((x): x is SnapshotItemLine => x.kind === "item");
  const rates = new Set(billableItems(s).map((x) => `${x.vatCategory}${x.vatRateBp}`));
  const showVat = priced && !isKu && (rates.size > 1 || layout.printOptions.vatPerLine);
  const showDiscount = priced && items.some((x) => x.discount);
  const invoiceLike = [
    "invoice",
    "advance_invoice",
    "partial_invoice",
    "final_invoice",
    "cancellation",
    "correction",
  ].includes(s.type);

  // ── info block (zone I) ──
  const info: { label: string; value: string }[] = [{ label: l.number, value: s.number }];
  info.push({
    label: invoiceLike ? l.invoiceDate : s.type === "quote" ? l.quoteDate : l.date,
    value: fd(s.documentDate),
  });
  const supply = supplyText(s);
  if (supply) info.push(supply);
  if (s.validUntil) info.push({ label: l.validUntil, value: fd(s.validUntil) });
  if (s.buyer.contactNumber) info.push({ label: l.customerNumber, value: s.buyer.contactNumber });
  if (s.references.orderReference) info.push({ label: l.orderReference, value: s.references.orderReference });
  if (s.references.buyerReference && s.references.buyerReference !== s.buyer.contactNumber) {
    info.push({
      label: s.buyer.isPublicAuthority ? l.leitwegId : l.buyerReference,
      value: s.references.buyerReference,
    });
  }
  if (s.references.contractReference) info.push({ label: l.contract, value: s.references.contractReference });
  if (s.references.deliveryNoteNumbers?.length)
    info.push({ label: l.deliveryNotes, value: s.references.deliveryNoteNumbers.join(", ") });
  const original = s.references.precedingInvoices.find((p) => p.role === "original");
  if (original) info.push({ label: l.original, value: `${original.number} (${fd(original.date)})` });
  if (s.seller.contact.name) info.push({ label: l.contactPerson, value: s.seller.contact.name });
  if (s.seller.contact.phone) info.push({ label: l.phone, value: s.seller.contact.phone });
  if (s.seller.contact.email) info.push({ label: l.email, value: s.seller.contact.email });
  const euCase = s.taxCase === "eu_b2b_service" || s.taxCase === "intra_community_supply";
  if (euCase && s.seller.vatId) info.push({ label: l.ourVatId, value: s.seller.vatId });
  if ((euCase || s.taxCase === "reverse_charge_13b") && s.buyer.vatId)
    info.push({ label: l.yourVatId, value: s.buyer.vatId });

  // ── positions (zone P) ──
  const columns: RenderColumn[] = [
    { key: "pos", label: l.pos, align: "left" },
    { key: "name", label: l.name, align: "left" },
    { key: "quantity", label: l.quantity, align: "right" },
    { key: "unit", label: l.unit, align: "left" },
  ];
  if (priced) {
    columns.push({
      key: "unitPrice",
      label: isKu ? l.unitPrice : gross ? l.unitPriceGross : l.unitPriceNet,
      align: "right",
    });
    if (showVat) columns.push({ key: "vat", label: l.vat, align: "right" });
    if (showDiscount) columns.push({ key: "discount", label: l.discount, align: "right" });
    columns.push({ key: "amount", label: isKu ? l.amount : gross ? l.amountGross : l.amountNet, align: "right" });
  }
  const rows: RenderRow[] = s.lines.map((x): RenderRow => {
    if (x.kind === "subtotal") return { kind: "subtotal", text: x.text, amount: priced ? money(x.amountCents) : "" };
    if (x.kind !== "item") return { kind: x.kind, text: x.text };
    const amountCents = gross ? (x.grossCents ?? x.netCents) : x.netCents;
    const amount = priced ? (x.optional ? `(${money(amountCents)})` : money(amountCents)) : "";
    const discount = x.discount
      ? x.discount.kind === "percent"
        ? `${formatRate(x.discount.bp, lang)} %`
        : money(x.discount.cents)
      : "";
    return {
      kind: "item",
      pos: String(x.position),
      name: x.optional ? `${l.optional}: ${x.name}` : x.name,
      ...(x.itemNumber && layout.printOptions.productNumbers ? { itemNumber: `${l.itemNumber} ${x.itemNumber}` } : {}),
      ...(x.description && layout.printOptions.lineDescriptions ? { description: x.description } : {}),
      ...(x.period ? { period: `${l.period}: ${fd(x.period.from)} – ${fd(x.period.to)}` } : {}),
      quantity: formatQuantity(x.quantityMilli, lang),
      unit: unitLabel(x, lang),
      unitPrice: priced
        ? `${formatUnitPrice(x.unitPriceMicros, lang)}${lang === "de" ? ` ${s.currency === "EUR" ? "€" : s.currency}` : ""}`
        : "",
      vat: showVat ? `${formatRate(x.vatRateBp, lang)} %` : "",
      discount: showDiscount ? discount : "",
      amount,
      optional: x.optional === true,
    };
  });

  // ── totals (zone ∑) ──
  const t = s.totals;
  const totals: RenderTotalRow[] = [];
  if (priced && s.type !== "reminder") {
    if (!isKu) {
      if (t.allowanceTotalCents !== 0 || t.chargeTotalCents !== 0) {
        totals.push({ label: l.lineSum, value: money(t.lineNetSumCents) });
        const reason = s.adjustment?.reason ? ` (${s.adjustment.reason})` : "";
        if (t.allowanceTotalCents !== 0)
          totals.push({ label: `${l.allowance}${reason}`, value: money(-t.allowanceTotalCents) });
        if (t.chargeTotalCents !== 0) totals.push({ label: `${l.charge}${reason}`, value: money(t.chargeTotalCents) });
      }
      totals.push({ label: l.net, value: money(t.netCents) });
      for (const g of t.byGroup.filter((x) => x.category === "S" || x.category === "Z")) {
        totals.push({ label: l.vatOn(formatRate(g.rateBp, lang), money(g.baseCents)), value: money(g.vatCents) });
      }
    }
    totals.push({ label: l.gross, value: money(t.grossCents), emphasis: "strong" });
    for (const d of s.deductions ?? []) {
      for (const g of d.byGroup) {
        // UST-41 (§ 14 Abs. 5 S. 2 UStG): deducted net and VAT per advance and rate.
        const label = l.deduction(
          d.advanceNumber,
          fd(d.advanceDate),
          formatRate(g.rateBp, lang),
          money(g.netCents),
          money(g.vatCents),
        );
        totals.push({ label, value: money(-g.grossCents) });
      }
    }
    if (t.advancesDeductedGrossCents !== 0) {
      totals.push({
        label: t.payableCents < 0 ? l.refund : l.payable,
        value: money(t.payableCents),
        emphasis: "strong",
      });
    }
  }

  // ── payment (zone L) ──
  const payNotes = s.notes.filter((n) => n.zone === "payment");
  const paymentLines = noteLines(payNotes, lang);
  const paymentRelevant = ["invoice", "advance_invoice", "partial_invoice", "final_invoice", "proforma"].includes(
    s.type,
  );
  if (paymentRelevant && t.payableCents < 0) paymentLines.push(l.refundText);
  else if (paymentRelevant && t.payableCents === 0) paymentLines.push(l.noPayable);
  if (s.payment.methodText && paymentRelevant && t.payableCents > 0)
    paymentLines.push(`${l.paymentMethod}: ${s.payment.methodText}`);
  const acc = s.payment.bankAccount;
  const showBank =
    acc && s.payment.method === "transfer" && ((paymentRelevant && t.payableCents > 0) || s.type === "reminder");
  const bank = showBank
    ? [
        { label: l.accountHolder, value: acc.accountHolder },
        { label: l.iban, value: acc.iban.replace(/(.{4})/g, "$1 ").trim() },
        ...(acc.bic ? [{ label: l.bic, value: acc.bic }] : []),
        ...(acc.bankName ? [{ label: l.bank, value: acc.bankName }] : []),
      ]
    : undefined;
  const epcPayload = layout.printOptions.epcQr ? girocodeFor(s) : null;

  // ── reminder (F05 DUN-005) ──
  let reminder: RenderModel["reminder"];
  if (s.type === "reminder" && s.reminder) {
    const r = s.reminder;
    const rrows: RenderTotalRow[] = [
      {
        label: `${l.reminderInvoice(r.invoiceNumber, fd(r.invoiceDate))}, ${l.reminderDue} ${fd(r.invoiceDueDate)}`,
        value: "",
      },
      { label: l.reminderGross, value: money(r.invoiceGrossCents) },
      ...(r.paymentsReceivedCents ? [{ label: l.reminderPaid, value: money(-r.paymentsReceivedCents) }] : []),
      { label: l.reminderOpen, value: money(r.openAmountCents) },
      ...(r.feeCents ? [{ label: l.reminderFee, value: money(r.feeCents) }] : []),
      ...(r.interestCents ? [{ label: l.reminderInterest, value: money(r.interestCents) }] : []),
      ...(r.flatFee40Cents ? [{ label: l.reminderFlat, value: money(r.flatFee40Cents) }] : []),
      ...(r.flatFeeAlreadyClaimed ? [{ label: l.reminderFlatClaimed, value: "", emphasis: "muted" as const }] : []),
      { label: l.reminderTotal, value: money(r.totalCents), emphasis: "strong" },
    ];
    reminder = {
      rows: rrows,
      ...(r.interestSegments?.length
        ? {
            interestHeader: l.interestHeader,
            interest: r.interestSegments.map((seg) => [
              `${fd(seg.from)} – ${fd(seg.to)}`,
              String(seg.days),
              `${formatRate(seg.rateBp, lang)} %`,
              money(seg.amountCents),
            ]),
          }
        : {}),
    };
    paymentLines.push(l.reminderDeadline(fd(r.newDueDate)));
  }

  // ── footer (zone Z) ──
  const required = ["Firma", ...footerItems(s.seller.legalForm)];
  const footer = !footerVisible({ footerInLetterhead: layout.printOptions.footerInLetterhead }, required)
    ? null
    : geschaeftsbriefFooter(
        s.seller,
        acc ? [{ iban: acc.iban, ...(acc.bic ? { bic: acc.bic } : {}), accountHolder: acc.accountHolder }] : [],
        { allInvoiceAccounts: layout.printOptions.allInvoiceAccountsInFooter },
      ).columns;

  const seller = s.seller;
  const recipient = [
    s.buyer.name,
    ...(s.buyer.tradeName ? [s.buyer.tradeName] : []),
    ...(s.buyer.address?.name2 ? [s.buyer.address.name2] : []),
    ...(s.buyer.contactPerson?.name ? [`${lang === "en" ? "Attn." : "z. Hd."} ${s.buyer.contactPerson.name}`] : []),
    ...addressLines(s.buyer.address, lang),
  ];
  const docTitle = title(s);
  const stamp =
    variant === "copy" ? copyStamp(s) : variant === "reading" ? l.reading : variant === "draft" ? l.draft : undefined;

  return {
    language: lang,
    variant,
    title: docTitle,
    number: s.number,
    ...(stamp ? { stamp } : {}),
    ...(variant === "copy"
      ? { watermark: copyStamp(s) }
      : variant === "draft"
        ? { watermark: lang === "en" ? "DRAFT" : "ENTWURF" }
        : {}),
    sellerName: seller.name,
    ...(layout.printOptions.senderLine
      ? {
          senderLine: [
            seller.name,
            seller.address.street || seller.address.poBox,
            `${seller.address.postalCode} ${seller.address.city}`,
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : {}),
    recipient,
    info,
    ...(s.texts.subject ? { subject: s.texts.subject } : {}),
    titleNotes: noteLines(
      s.notes.filter((n) => n.zone === "title"),
      lang,
    ),
    ...(s.texts.headText ? { headText: s.texts.headText } : {}),
    columns,
    rows,
    totals,
    totalsNotes: noteLines(
      s.notes.filter((n) => n.zone === "totals"),
      lang,
    ),
    legalNotes: noteLines(
      s.notes.filter((n) => n.zone === "legal"),
      lang,
    ),
    payment: { lines: paymentLines, ...(bank ? { bank } : {}), epcPayload },
    ...(reminder ? { reminder } : {}),
    ...(s.texts.footText || s.texts.deliveryTerms
      ? {
          footText: [
            s.texts.deliveryTerms ? `${l.deliveryTerms}: ${s.texts.deliveryTerms}` : "",
            s.texts.footText ?? "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }
      : {}),
    customFields: s.customFields ?? [],
    footer,
    ...(s.einvoice.format === "zugferd_en16931" || s.einvoice.format === "zugferd_xrechnung"
      ? { einvoiceHint: l.einvoiceZugferd }
      : {}),
    pageLabel: { page: l.page, of: l.of },
    layout,
    meta: {
      title: `${docTitle} ${s.number}`,
      author: seller.name,
      subject: `${docTitle} ${s.number} – ${s.buyer.name}`,
      keywords: [
        docTitle,
        s.number,
        ...(s.einvoice.format.startsWith("zugferd") ? ["ZUGFeRD", "Factur-X", "EN 16931"] : []),
      ],
    },
  };
}
