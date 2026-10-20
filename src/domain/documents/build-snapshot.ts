/**
 * Builds the immutable document snapshot (F04 DOC-27, §4.6.1 step 1b/2d) from resolved draft data.
 *
 * The caller (the finalisation action) has already resolved the parties as read in the commit transaction, the
 * line categories/rates by supply date (DOC-13), the number, dates, FX rate and the e-invoice format/decision. This
 * function adds everything that is *derived*: totals and the VAT breakdown (DOC-09/10, App. E, via `totals.ts`), the
 * exemption reasons per group (App. A.9), subtotal amounts (DOC-04), BT-127 line notes (App. A.1), the legal and
 * standard notes per tax case and flags with their rule rows (INV-23, App. B), BT-10 (App. A.3), BG-3 references,
 * Skonto amounts (DOC-50), the payment reference (DOC-51), EUR VAT (App. E.6) and the §35a subtotal (App. E.7).
 * Pure and deterministic: the same input always yields the same snapshot (and hash).
 */

import { resolveBuyerReference } from "../einvoice/buyer-reference";
import { fcToEurCents, parseFxRate } from "../money/convert";
import { roundHalfAway } from "../money/rounding";
import { vatExact } from "../money/vat";
import { err, type Issue, issue, ok, type Result } from "../result";
import { lookupNoteText, type NoteTextId, type NoteTextValue } from "../rules/note-texts";
import { lookupRc13bType } from "../rules/rc13b-types";
import type { RuleOverride } from "../rules/rule-table";
import { isWithinKleinbetragLimit } from "../rules/thresholds";
import type { VatCategory } from "../tax/vat-category";
import { addDays, type CalendarDate } from "../time/calendar-date";
import { type DocLanguage, formatAmount, formatDate, formatRate } from "./i18n";
import {
  type DocumentSnapshot,
  type EinvoiceFormat,
  type Er03Decision,
  type PaymentMethodKind,
  type PrecedingInvoiceRef,
  type SalesDocType,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotAddress,
  type SnapshotBuyer,
  type SnapshotDeduction,
  type SnapshotFx,
  type SnapshotItemLine,
  type SnapshotLine,
  type SnapshotNote,
  type SnapshotReminder,
  type SnapshotSeller,
  type SnapshotTotals,
  type SnapshotVatGroup,
  type SupplyDate,
  type TaxCase,
} from "./snapshot";
import { computeTotals, type DocumentAdjustment, type DocumentTotals } from "./totals";

export interface SnapshotInputItem {
  readonly kind: "item";
  readonly name: string;
  readonly description?: string;
  readonly quantityMilli: number;
  readonly unitCode: string;
  /** Printed label of the unit in the document language (frozen; default: the seeded label). */
  readonly unitLabel?: string;
  readonly unitPriceMicros: number;
  readonly discount?:
    | { readonly kind: "percent"; readonly bp: number }
    | { readonly kind: "amount"; readonly cents: number };
  readonly vatCategory: VatCategory;
  readonly vatRateBp: number;
  readonly vatRuleRowId?: string;
  /** VATEX code (E lines; default VATEX-EU-132). */
  readonly exemptionReasonCode?: string;
  /** Exemption text (E lines); default: the `exempt_4` note with `exemptionParagraph`. */
  readonly exemptionReasonText?: string;
  /** § 4 Nr. of an E line, e.g. "14" (fills `exempt_4`). */
  readonly exemptionParagraph?: string;
  /** § 13b type of an AE line (fills `rc_13b`). */
  readonly reverseCharge13b?: string;
  readonly period?: { readonly from: string; readonly to: string };
  readonly itemNumber?: string;
  readonly buyerItemNumber?: string;
  /** DOC-53: cost centre number (DATEV KOST1). */
  readonly costCenter?: string;
  readonly optional?: boolean;
  readonly isLaborCost?: boolean;
}

export type SnapshotInputLine =
  | SnapshotInputItem
  | { readonly kind: "heading" | "text"; readonly text: string }
  | { readonly kind: "subtotal"; readonly text?: string };

export interface SnapshotInput {
  readonly type: SalesDocType;
  readonly correctionKind?: "credit" | "rectification";
  readonly number: string;
  readonly documentDate: string;
  /** Default: documentDate + dueDays for invoice types and proforma. */
  readonly dueDate?: string;
  readonly validUntil?: string;
  readonly supplyDate?: SupplyDate;
  readonly supplyDateIsDocumentDate?: boolean;
  readonly language: DocLanguage;
  readonly currency: string;
  readonly fx?: SnapshotFx;
  readonly priceMode: "net" | "gross";
  readonly taxCase: TaxCase;
  readonly flags?: DocumentSnapshot["flags"];
  readonly seller: SnapshotSeller;
  readonly buyer: SnapshotBuyer;
  readonly delivery?: { readonly address?: SnapshotAddress; readonly partyName?: string };
  readonly references?: {
    readonly buyerReference?: string;
    readonly contactBuyerReference?: string;
    readonly contractReference?: string;
    readonly orderReference?: string;
    readonly salesOrderReference?: string;
    readonly deliveryNoteNumbers?: readonly string[];
    readonly projectReference?: string;
  };
  /** Cancellation/correction/Nachberechnung: the original invoice (BT-25/26). */
  readonly original?: { readonly number: string; readonly date: string };
  /** Earlier corrections of the same original (INV-15, extra BG-3 entries). */
  readonly earlierCorrections?: readonly { readonly number: string; readonly date: string }[];
  /** Advance/partial/final chain root for `advance_info` / `final_info`. */
  readonly chain?: {
    readonly orderLabel: { readonly de: string; readonly en: string };
    readonly orderNumber: string;
    readonly orderDate: string;
  };
  readonly texts?: DocumentSnapshot["texts"];
  readonly lines: readonly SnapshotInputLine[];
  readonly adjustment?: {
    readonly type: "allowance" | "charge";
    readonly percentBp?: number;
    readonly amountCents?: number;
    readonly reason: string;
    readonly reasonCode?: string;
  };
  readonly deductions?: readonly SnapshotDeduction[];
  readonly payment: {
    readonly method: PaymentMethodKind;
    readonly methodText?: string;
    readonly dueDays: number;
    readonly skonto?: { readonly percentBp: number; readonly days: number };
    readonly termsText?: string;
    readonly bankAccount?: DocumentSnapshot["payment"]["bankAccount"];
    readonly refundIban?: string;
    /** Setting `paymentReferencePrefix` (DOC-51), e.g. "RE ". */
    readonly paymentReferencePrefix?: string;
    readonly showEpcQr: boolean;
  };
  readonly einvoice: { readonly format: EinvoiceFormat; readonly decision?: Er03Decision };
  readonly rectifiedFields?: readonly string[];
  readonly reminder?: SnapshotReminder;
  readonly customFields?: DocumentSnapshot["customFields"];
  readonly attachments?: DocumentSnapshot["attachments"];
  readonly layoutVersionId: string;
  readonly ruleVersions?: Readonly<Record<string, string>>;
  /** Owner overrides of note texts (F01 SET-121). */
  readonly noteOverrides?: Partial<Record<NoteTextId, readonly RuleOverride<NoteTextValue>[]>>;
}

export type SnapshotBuildIssueCode =
  | "amount_invalid"
  | "amount_too_large"
  | "rule_missing"
  | "note_text_unknown"
  | "note_placeholder_missing"
  | "rc13b_type_unknown"
  | "chain_reference_missing"
  | "original_reference_missing"
  | "fx_rate_invalid"
  | "kleinbetrag_not_allowed";

type BuildIssue = Issue<SnapshotBuildIssueCode>;

const INVOICE_FAMILY: readonly SalesDocType[] = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"];
const PAYABLE_TYPES: readonly SalesDocType[] = [...INVOICE_FAMILY, "proforma", "correction", "cancellation"];
const PRICED_TYPES: readonly SalesDocType[] = [...PAYABLE_TYPES, "quote", "order_confirmation", "self_billing"];

const FX_SOURCE_LABEL = {
  bmf_monthly: { de: "BMF-Umrechnungskurs", en: "BMF monthly rate" },
  ecb_daily: { de: "EZB-Referenzkurs", en: "ECB reference rate" },
  manual: { de: "manuell erfasster Kurs", en: "manually entered rate" },
} as const;

/** Fills `{name}` placeholders; a missing parameter is an error (never a silently empty legal text). */
export function fillPlaceholders(
  text: string,
  params: Readonly<Record<string, string>>,
): Result<string, Issue<"note_placeholder_missing">> {
  let missing: string | null = null;
  const out = text.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    if (v === undefined) {
      missing ??= name;
      return m;
    }
    return v;
  });
  return missing === null
    ? ok(out)
    : err(
        issue("note_placeholder_missing", `Platzhalter {${missing}} im Hinweistext ist nicht belegt.`, {
          name: missing,
        }),
      );
}

class NoteCollector {
  readonly notes: SnapshotNote[] = [];
  readonly ruleVersions: Record<string, string> = {};
  error: BuildIssue | null = null;
  constructor(
    private readonly date: CalendarDate,
    private readonly overrides: SnapshotInput["noteOverrides"],
  ) {}

  add(
    id: NoteTextId,
    zone: SnapshotNote["zone"],
    params: { de?: Record<string, string>; en?: Record<string, string> } = {},
    xmlSubjectCode?: SnapshotNote["xmlSubjectCode"],
  ): void {
    if (this.error) return;
    const row = lookupNoteText(id, this.date, this.overrides?.[id] ?? []);
    if (!row.ok) {
      this.error = row.error;
      return;
    }
    const de = fillPlaceholders(row.value.value.de, params.de ?? {});
    const en = fillPlaceholders(row.value.value.en, params.en ?? params.de ?? {});
    if (!de.ok || !en.ok) {
      this.error = (de.ok ? null : de.error) ?? (en.ok ? null : en.error);
      return;
    }
    if (this.notes.some((n) => n.id === id && n.de === de.value)) return;
    this.notes.push({
      id,
      ruleRowId: row.value.rowId,
      de: de.value,
      en: en.value,
      zone,
      ...(xmlSubjectCode ? { xmlSubjectCode } : {}),
    });
    this.ruleVersions[`note:${id}`] = row.value.rowId;
  }
}

const isItem = (l: SnapshotInputLine): l is SnapshotInputItem => l.kind === "item";

function toAdjustment(a: SnapshotInput["adjustment"]): DocumentAdjustment | undefined {
  if (!a) return undefined;
  if (a.percentBp !== undefined) return { type: a.type, percentBp: a.percentBp };
  return { type: a.type, amountCents: a.amountCents ?? 0 };
}

/** Distinct values in insertion order. */
const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function buildSnapshot(input: SnapshotInput): Result<DocumentSnapshot, BuildIssue> {
  const lang = input.language;
  const date = input.documentDate as CalendarDate;
  const items = input.lines.filter(isItem);
  const billable = items.filter((l) => !l.optional);
  const deductedGross = (input.deductions ?? []).reduce((a, d) => a + d.deductedGrossCents, 0);

  const totalsResult = computeTotals({
    priceMode: input.priceMode,
    lines: items.map((l) => ({
      quantityMilli: l.quantityMilli,
      unitPriceMicros: l.unitPriceMicros,
      discount: l.discount,
      vatCategory: l.vatCategory,
      rateBp: l.vatRateBp,
      optional: l.optional,
    })),
    adjustment: toAdjustment(input.adjustment),
    prepaidCents: deductedGross,
  });
  if (!totalsResult.ok) return totalsResult;
  const t = totalsResult.value;

  let fxRate: ReturnType<typeof parseFxRate> | null = null;
  if (input.fx) {
    fxRate = parseFxRate(input.fx.rate);
    if (!fxRate.ok) return fxRate;
  }

  // UST-14 / DOC-44: a Kleinbetragsrechnung only up to the limit (EUR gross) and never for K/AE lines.
  if (input.flags?.kleinbetrag) {
    const grossEur = fxRate?.ok ? fcToEurCents(t.grossCents, fxRate.value) : t.grossCents;
    const within = isWithinKleinbetragLimit(grossEur, date);
    if (!within.ok) return within;
    if (!within.value || billable.some((l) => l.vatCategory === "K" || l.vatCategory === "AE")) {
      return err(
        issue(
          "kleinbetrag_not_allowed",
          "Kleinbetragsrechnung nur bis 250,00 € brutto und nicht für innergemeinschaftliche Lieferungen, Fernverkäufe oder § 13b UStG.",
        ),
      );
    }
  }

  // ── notes (App. B) ─────────────────────────────────────────────────────────────
  const notes = new NoteCollector(date, input.noteOverrides);
  const sellerVatId = input.seller.vatId ?? "";
  const buyerVatId = input.buyer.vatId ?? "";
  const isPriced = PRICED_TYPES.includes(input.type) && (input.type !== "delivery_note" || input.flags?.showPrices);
  const isInvoice = INVOICE_FAMILY.includes(input.type) || ["cancellation", "correction"].includes(input.type);
  const fmtDate = (d: string, l: DocLanguage) => formatDate(d, l);

  // Title-zone notes (App. F zone T).
  if (input.type === "advance_invoice" || input.type === "partial_invoice" || input.type === "final_invoice") {
    if (!input.chain) {
      return err(
        issue("chain_reference_missing", "Für Abschlags-, Teil- und Schlussrechnungen fehlt der Auftragsbezug."),
      );
    }
    const c = input.chain;
    const n = String(input.flags?.chainIndex ?? 1);
    notes.add(
      input.type === "final_invoice" ? "final_info" : "advance_info",
      "title",
      {
        de: { n, orderType: c.orderLabel.de, orderNumber: c.orderNumber, orderDate: fmtDate(c.orderDate, "de") },
        en: { n, orderType: c.orderLabel.en, orderNumber: c.orderNumber, orderDate: fmtDate(c.orderDate, "en") },
      },
      "AAI",
    );
  }
  if (input.type === "cancellation" || input.type === "correction") {
    if (!input.original) {
      return err(issue("original_reference_missing", "Für Storno und Korrekturen fehlt die Originalrechnung."));
    }
    const o = input.original;
    const id: NoteTextId =
      input.type === "cancellation"
        ? "storno_info"
        : input.correctionKind === "rectification"
          ? "rect_info"
          : "credit_info";
    const fields = (input.rectifiedFields ?? []).join(", ");
    notes.add(
      id,
      "title",
      {
        de: { nr: o.number, date: fmtDate(o.date, "de"), fields },
        en: { nr: o.number, date: fmtDate(o.date, "en"), fields },
      },
      "AAI",
    );
  }
  if (input.type === "proforma") notes.add("proforma_info", "title", {}, "AAI");
  // UST-11 / INV-16: a Gutschrift states that the recipient issues it (§ 14 Abs. 2 Satz 2 UStG)
  if (input.type === "self_billing") notes.add("sb_info", "title", {}, "AAI");

  // Tax-case notes (zone L, BT-22 subject REG).
  const categories = new Set(billable.map((l) => l.vatCategory));
  if (isPriced || input.type === "delivery_note") {
    if (input.taxCase === "kleinunternehmer" || categories.has("KU")) notes.add("ku_note_19", "legal", {}, "REG");
    if (input.taxCase === "eu_b2b_service") notes.add("rc_eu", "legal", { de: { sellerVatId, buyerVatId } }, "REG");
    if (input.taxCase === "intra_community_supply")
      notes.add("igl", "legal", { de: { sellerVatId, buyerVatId } }, "REG");
    if (input.taxCase === "export") notes.add("export", "legal", {}, "REG");
    if (input.taxCase === "not_taxable_domestic") {
      notes.add(input.buyer.isConsumer ? "o_3a4" : "o_3a2", "legal", {}, "REG");
    }
    for (const type of distinct(
      billable.filter((l) => l.vatCategory === "AE" && l.reverseCharge13b).map((l) => l.reverseCharge13b as string),
    )) {
      const rc = lookupRc13bType(type, date);
      if (!rc.ok) return err(rc.error);
      notes.ruleVersions[`rc13b:${type}`] = rc.value.rowId;
      notes.add("rc_13b", "legal", { de: { nr: rc.value.value.paragraphNr } }, "REG");
    }
    for (const nr of distinct(
      billable.filter((l) => l.vatCategory === "E" && l.exemptionParagraph).map((l) => l.exemptionParagraph as string),
    )) {
      notes.add("exempt_4", "legal", { de: { nr } }, "REG");
    }
    if (categories.has("Z")) notes.add("zero_pv", "legal", {}, "REG");
    if (isInvoice && input.buyer.isConsumer && input.flags?.propertyRelated) notes.add("p14b", "legal", {}, "REG");
    // UST-13 (LEGAL-OPEN: 01 open item 1): Ist companies, document date ≥ 2028-01-01, not on KU invoices (F04 9.10).
    if (
      isInvoice &&
      input.seller.vatAccounting === "ist" &&
      !input.seller.kleinunternehmer &&
      input.documentDate >= "2028-01-01"
    ) {
      notes.add("ist_2028", "legal", {}, "REG");
    }
  }
  if (input.supplyDateIsDocumentDate && input.supplyDate?.kind === "date") {
    notes.add("supply_same", "legal", {
      de: { date: fmtDate(input.supplyDate.date, "de") },
      en: { date: fmtDate(input.supplyDate.date, "en") },
    });
  }

  // Payment notes (zone L) for documents with a payable amount.
  const payable = t.payableCents;
  const dueDate =
    input.dueDate ??
    (PAYABLE_TYPES.includes(input.type) && payable > 0 ? addDays(date, input.payment.dueDays) : undefined);
  let skonto: DocumentSnapshot["payment"]["skonto"];
  if (PAYABLE_TYPES.includes(input.type) && input.type !== "cancellation" && payable > 0) {
    const amount = (c: number) => ({
      de: formatAmount(c, input.currency, "de"),
      en: formatAmount(c, input.currency, "en"),
    });
    if (input.payment.skonto && dueDate) {
      const s = input.payment.skonto;
      const skontoDate = addDays(date, s.days);
      const skontoAmount = Number(roundHalfAway(BigInt(payable) * BigInt(s.percentBp), 10_000n));
      skonto = {
        percentBp: s.percentBp,
        days: s.days,
        date: skontoDate,
        amountCents: skontoAmount,
        payableCents: payable - skontoAmount,
      };
      const a = amount(skontoAmount);
      const p = amount(payable - skontoAmount);
      notes.add("skonto", "payment", {
        de: {
          skontoDate: fmtDate(skontoDate, "de"),
          percent: formatRate(s.percentBp, "de"),
          skontoAmount: a.de,
          skontoPayable: p.de,
          dueDate: fmtDate(dueDate, "de"),
        },
        en: {
          skontoDate: fmtDate(skontoDate, "en"),
          percent: formatRate(s.percentBp, "en"),
          skontoAmount: a.en,
          skontoPayable: p.en,
          dueDate: fmtDate(dueDate, "en"),
        },
      });
    } else if (input.payment.dueDays === 0) {
      notes.add("terms_immediate", "payment");
    } else if (dueDate) {
      notes.add("terms", "payment", {
        de: { dueDate: fmtDate(dueDate, "de") },
        en: { dueDate: fmtDate(dueDate, "en") },
      });
    }
  }
  const paymentReference = `${input.payment.paymentReferencePrefix ?? ""}${input.number}`;
  if (INVOICE_FAMILY.includes(input.type) && payable > 0 && input.payment.method === "transfer") {
    notes.add("pay_ref", "payment", { de: { paymentReference } });
  }
  // §286 Abs. 3 BGB (MAHN-01, INV-26): consumers, invoice family, payable > 0.
  if (INVOICE_FAMILY.includes(input.type) && input.buyer.isConsumer && payable > 0)
    notes.add("b2c_286", "legal", {}, undefined);

  // ── totals extras ──────────────────────────────────────────────────────────────
  const labor = laborSubtotal(items, t);
  if (labor && input.buyer.isConsumer && isInvoice) {
    const f = (c: number, l: DocLanguage) => formatAmount(c, input.currency, l);
    notes.add("p35a", "totals", {
      de: { net: f(labor.netCents, "de"), vat: f(labor.vatCents, "de"), gross: f(labor.grossCents, "de") },
      en: { net: f(labor.netCents, "en"), vat: f(labor.vatCents, "en"), gross: f(labor.grossCents, "en") },
    });
  }
  const groupsEur = fxRate?.ok ? t.groups.map((g) => fcToEurCents(g.vatCents, fxRate.value)) : null;
  const vatEurCents = groupsEur ? groupsEur.reduce((a, b) => a + b, 0) : undefined;
  if (input.fx && vatEurCents !== undefined && isPriced) {
    const src = input.fx.sourceText;
    notes.add("fx", "totals", {
      de: {
        vatEur: formatAmount(vatEurCents, "EUR", "de"),
        rate: input.fx.rate.replace(".", ","),
        currency: input.currency,
        source: src ?? FX_SOURCE_LABEL[input.fx.source].de,
        date: fmtDate(input.fx.date, "de"),
      },
      en: {
        vatEur: formatAmount(vatEurCents, "EUR", "en"),
        rate: input.fx.rate,
        currency: input.currency,
        source: src ?? FX_SOURCE_LABEL[input.fx.source].en,
        date: fmtDate(input.fx.date, "en"),
      },
    });
  }
  if (notes.error) return err(notes.error);

  const byGroup: SnapshotVatGroup[] = t.groups.map((g, gi) => ({
    category: g.vatCategory,
    rateBp: g.rateBp,
    lineNetSumCents: g.lineNetSumCents,
    allowanceCents: g.allowanceCents,
    chargeCents: g.chargeCents,
    baseCents: g.baseCents,
    vatCents: g.vatCents,
    ...exemptionFor(g.vatCategory, billable, notes.notes, lang),
    ...(g.enteredGrossCents === undefined
      ? {}
      : {
          enteredGrossCents: g.enteredGrossCents,
          grossDeviationCents: g.baseCents + g.vatCents - g.enteredGrossCents,
        }),
    ...(groupsEur ? { vatEurCents: groupsEur[gi] ?? 0 } : {}),
  }));

  const totals: SnapshotTotals = {
    lineNetSumCents: t.lineNetSumCents,
    allowanceTotalCents: t.allowanceTotalCents,
    chargeTotalCents: t.chargeTotalCents,
    netCents: t.taxExclusiveCents,
    vatCents: t.vatTotalCents,
    grossCents: t.grossCents,
    advancesDeductedGrossCents: t.prepaidCents,
    roundingCents: 0,
    payableCents: t.payableCents,
    byGroup,
    ...(vatEurCents === undefined ? {} : { vatEurCents }),
    ...(labor && input.buyer.isConsumer && isInvoice ? { labor } : {}),
  };

  const references = buildReferences(input);
  const lines = buildLines(input, t);

  const snapshot: DocumentSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    type: input.type,
    ...(input.correctionKind ? { correctionKind: input.correctionKind } : {}),
    number: input.number,
    documentDate: input.documentDate,
    ...(dueDate ? { dueDate } : {}),
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    ...(input.supplyDate ? { supplyDate: input.supplyDate } : {}),
    ...(input.supplyDateIsDocumentDate ? { supplyDateIsDocumentDate: true } : {}),
    language: lang,
    currency: input.currency,
    ...(input.fx ? { fx: input.fx } : {}),
    priceMode: input.priceMode,
    taxCase: input.taxCase,
    flags: input.flags ?? {},
    seller: input.seller,
    buyer: input.buyer,
    ...(input.delivery ? { delivery: input.delivery } : {}),
    references,
    texts: input.texts ?? {},
    notes: notes.notes,
    lines,
    ...(input.adjustment
      ? {
          adjustment: {
            type: input.adjustment.type,
            reason: input.adjustment.reason,
            ...(input.adjustment.percentBp === undefined ? {} : { percentBp: input.adjustment.percentBp }),
            ...(input.adjustment.reasonCode ? { reasonCode: input.adjustment.reasonCode } : {}),
          },
        }
      : {}),
    totals,
    ...(input.deductions?.length ? { deductions: input.deductions } : {}),
    payment: {
      method: input.payment.method,
      ...(input.payment.methodText ? { methodText: input.payment.methodText } : {}),
      dueDays: input.payment.dueDays,
      ...(skonto ? { skonto } : {}),
      ...(input.payment.termsText ? { termsText: input.payment.termsText } : {}),
      ...(input.payment.bankAccount ? { bankAccount: input.payment.bankAccount } : {}),
      ...(input.payment.refundIban ? { refundIban: input.payment.refundIban } : {}),
      paymentReference,
      showEpcQr: input.payment.showEpcQr,
    },
    einvoice: input.einvoice,
    ...(input.rectifiedFields?.length ? { rectifiedFields: input.rectifiedFields } : {}),
    ...(input.reminder ? { reminder: input.reminder } : {}),
    ...(input.customFields?.length ? { customFields: input.customFields } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    layoutVersionId: input.layoutVersionId,
    ruleVersions: sortKeys({
      ...(input.ruleVersions ?? {}),
      ...Object.fromEntries(
        items
          .filter((l) => l.vatRuleRowId)
          .map((l) => [`vat:${(l.vatRuleRowId as string).split("@")[0]}`, l.vatRuleRowId as string]),
      ),
      ...notes.ruleVersions,
    }),
  };
  return ok(snapshot);
}

const sortKeys = (r: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** App. A.9: BT-120/BT-121 per group. */
function exemptionFor(
  category: VatCategory,
  lines: readonly SnapshotInputItem[],
  notes: readonly SnapshotNote[],
  lang: DocLanguage,
): { exemptionReasonCode?: string; exemptionReasonText?: string } {
  const noteText = (...ids: NoteTextId[]) => {
    const n = notes.filter((x) => ids.includes(x.id));
    if (!n.length) return undefined;
    return n.map((x) => (lang === "en" ? `${x.en} / ${x.de}` : x.de)).join(" ");
  };
  switch (category) {
    case "KU": {
      const text = noteText("ku_note_19");
      return text ? { exemptionReasonText: text } : {};
    }
    case "E": {
      const own = lines.filter((l) => l.vatCategory === "E");
      const code = own.find((l) => l.exemptionReasonCode)?.exemptionReasonCode ?? "VATEX-EU-132";
      const texts = distinct(own.map((l) => l.exemptionReasonText).filter((x): x is string => !!x));
      const text = texts.length ? texts.join("; ") : (noteText("exempt_4") ?? "Steuerfreie Leistung nach § 4 UStG.");
      return { exemptionReasonCode: code, exemptionReasonText: text };
    }
    case "AE":
      return {
        exemptionReasonCode: "VATEX-EU-AE",
        exemptionReasonText:
          lang === "en"
            ? "Reverse charge / Steuerschuldnerschaft des Leistungsempfängers"
            : "Steuerschuldnerschaft des Leistungsempfängers",
      };
    case "K":
      return {
        exemptionReasonCode: "VATEX-EU-IC",
        exemptionReasonText: noteText("igl") ?? "Steuerfreie innergemeinschaftliche Lieferung",
      };
    case "G":
      return {
        exemptionReasonCode: "VATEX-EU-G",
        exemptionReasonText: noteText("export") ?? "Steuerfreie Ausfuhrlieferung",
      };
    case "O":
      return {
        exemptionReasonCode: "VATEX-EU-O",
        exemptionReasonText: noteText("o_3a2", "o_3a4") ?? "Nicht im Inland steuerbare Leistung",
      };
    default:
      return {};
  }
}

/** App. E.7: labour lines → net, VAT per group, gross. */
function laborSubtotal(items: readonly SnapshotInputItem[], t: DocumentTotals): SnapshotTotals["labor"] | undefined {
  const byRate = new Map<number, bigint>();
  let any = false;
  items.forEach((l, i) => {
    const lt = t.lines[i];
    if (!l.isLaborCost || !lt?.included) return;
    any = true;
    byRate.set(l.vatRateBp, (byRate.get(l.vatRateBp) ?? 0n) + BigInt(lt.netCents));
  });
  if (!any) return undefined;
  let net = 0n;
  let vat = 0n;
  for (const [rate, n] of byRate) {
    net += n;
    vat += vatExact(n, rate);
  }
  return { netCents: Number(net), vatCents: Number(vat), grossCents: Number(net + vat) };
}

function buildReferences(input: SnapshotInput): DocumentSnapshot["references"] {
  const r = input.references ?? {};
  const bt10 = resolveBuyerReference({
    format: input.einvoice.format,
    isPublicAuthority: input.buyer.isPublicAuthority,
    sources: {
      document: r.buyerReference,
      contact: r.contactBuyerReference,
      orderReference: r.orderReference,
      contactNumber: input.buyer.contactNumber,
    },
  });
  const preceding: PrecedingInvoiceRef[] = [
    ...(input.original
      ? [{ number: input.original.number, date: input.original.date, role: "original" as const }]
      : []),
    ...(input.earlierCorrections ?? []).map((c) => ({
      number: c.number,
      date: c.date,
      role: "earlier_correction" as const,
    })),
    ...(input.deductions ?? []).map((d) => ({
      number: d.advanceNumber,
      date: d.advanceDate,
      role: "advance" as const,
    })),
  ];
  return {
    ...(bt10.value ? { buyerReference: bt10.value } : {}),
    ...(r.contractReference ? { contractReference: r.contractReference } : {}),
    ...(r.orderReference ? { orderReference: r.orderReference } : {}),
    ...(r.salesOrderReference ? { salesOrderReference: r.salesOrderReference } : {}),
    ...(r.deliveryNoteNumbers?.length ? { deliveryNoteNumbers: r.deliveryNoteNumbers } : {}),
    ...(r.projectReference ? { projectReference: r.projectReference } : {}),
    precedingInvoices: preceding,
  };
}

/** Item positions, BT-127 notes from preceding heading/text lines, subtotal amounts (DOC-04). */
function buildLines(input: SnapshotInput, t: DocumentTotals): SnapshotLine[] {
  const out: SnapshotLine[] = [];
  let pendingText: string[] = [];
  let running = 0;
  let itemIndex = 0;
  let position = 0;
  const gross = input.priceMode === "gross";
  for (const l of input.lines) {
    if (l.kind === "subtotal") {
      out.push({
        kind: "subtotal",
        text: l.text ?? (input.language === "en" ? "Subtotal" : "Zwischensumme"),
        amountCents: running,
      });
      running = 0;
      continue;
    }
    if (!isItem(l)) {
      out.push({ kind: l.kind, text: l.text });
      pendingText.push(l.text);
      if (l.kind === "heading") running = 0;
      continue;
    }
    const lt = t.lines[itemIndex++];
    const netCents = lt?.netCents ?? 0;
    const grossCents = lt?.grossCents ?? null;
    if (lt?.included) running += gross && grossCents !== null ? grossCents : netCents;
    const discountNote =
      gross && l.discount
        ? l.discount.kind === "percent"
          ? `inkl. ${formatRate(l.discount.bp, "de")} % Rabatt`
          : `inkl. ${formatAmount(l.discount.cents, input.currency, "de")} Rabatt`
        : undefined;
    const note = [...pendingText, ...(discountNote ? [discountNote] : [])].join("\n");
    pendingText = [];
    const item: SnapshotItemLine = {
      kind: "item",
      position: ++position,
      name: l.name,
      ...(l.description ? { description: l.description } : {}),
      ...(note ? { note } : {}),
      quantityMilli: l.quantityMilli,
      unitCode: l.unitCode,
      ...(l.unitLabel ? { unitLabel: l.unitLabel } : {}),
      unitPriceMicros: l.unitPriceMicros,
      ...(l.discount ? { discount: l.discount } : {}),
      vatCategory: l.vatCategory,
      vatRateBp: l.vatRateBp,
      ...(l.vatRuleRowId ? { vatRuleRowId: l.vatRuleRowId } : {}),
      ...(l.exemptionReasonCode ? { exemptionReasonCode: l.exemptionReasonCode } : {}),
      ...(l.exemptionReasonText ? { exemptionReasonText: l.exemptionReasonText } : {}),
      netCents,
      ...(grossCents !== null ? { grossCents } : {}),
      ...(l.period ? { period: l.period } : {}),
      ...(l.itemNumber ? { itemNumber: l.itemNumber } : {}),
      ...(l.buyerItemNumber ? { buyerItemNumber: l.buyerItemNumber } : {}),
      ...(l.costCenter ? { costCenter: l.costCenter } : {}),
      ...(l.optional ? { optional: true } : {}),
      ...(l.isLaborCost ? { isLaborCost: true } : {}),
    };
    out.push(item);
  }
  return out;
}
