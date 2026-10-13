/**
 * Sales-document drafts (F04 §4.4, DOC-03…DOC-23): the editable shape stored in `salesDocuments`/`documentLines`
 * while `status = draft`, the read context the server assembles for it, and the pure resolution that the editor
 * (live, DOC-19) and the server (authoritative, DOC-09) share:
 *
 *   draft + context → tax case (App. C) → per-line category/rate by supply date (DOC-13) → totals (App. E)
 *
 * Nothing here reads a clock: `today` (Europe/Berlin) is part of the context.
 */
import type { Certificate13b, PdfConsent } from "../contacts/consent";
import type { GateCheck } from "../contacts/vat-check";
import type { PreferredFormat } from "../einvoice/format";
import { fcToEurCents, parseFxRate } from "../money/convert";
import type { LineDiscount } from "../money/line";
import { type Issue, issue } from "../result";
import { lookupVatRate, lookupVatRateForPeriod } from "../rules/vat-rates";
import type { VatCategory } from "../tax/vat-category";
import type { CalendarDate } from "../time/calendar-date";
import {
  type EinvoiceFormat,
  monthBounds,
  type PaymentMethodKind,
  type SalesDocType,
  type SnapshotAddress,
  type SnapshotBuyer,
  type SnapshotFx,
  type SnapshotPayment,
  type SnapshotSeller,
  type SupplyDate,
  type TaxCase,
} from "./snapshot";
import { type DerivableTaxCase, defaultCategoryFor, deriveTaxCase, type TaxCaseDerivation } from "./tax-case";
import { computeTotals, type DocumentTotals } from "./totals";

// ── stored draft shape (03 §4) ─────────────────────────────────────────────────────────────────────────────────

/** 03 `documentLines.discount`. */
export interface StoredDiscount {
  readonly kind: "percent" | "amount";
  readonly valueBp?: number | undefined;
  readonly amountCents?: number | undefined;
}

export interface DraftLine {
  readonly kind: "item" | "heading" | "text" | "subtotal";
  readonly productId?: string | undefined;
  /** Copied from the product (App. C input); free lines count as services. */
  readonly productType?: "good" | "service" | undefined;
  readonly productSyncedVersion?: number | undefined;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly quantityMilli?: number | undefined;
  readonly unitCode?: string | undefined;
  readonly unitPriceMicros?: number | undefined;
  readonly discount?: StoredDiscount | undefined;
  readonly vatRateKey?: string | undefined;
  /** Owner's category choice (DOC-12, only within App. C.3); otherwise derived. */
  readonly vatCategoryOverride?: VatCategory | undefined;
  /** Cached result of the last resolution (shown as `rate_changed_notice` when it moves). */
  readonly vatCategory?: VatCategory | undefined;
  readonly vatRateBp?: number | undefined;
  readonly exemptionReasonCode?: string | undefined;
  readonly exemptionReasonText?: string | undefined;
  readonly placeOfSupplyRule?: string | undefined;
  readonly reverseCharge13b?: string | undefined;
  readonly linePeriod?: { readonly from: string; readonly to: string } | undefined;
  readonly isLaborCost?: boolean | undefined;
  readonly itemNumber?: string | undefined;
  readonly revenueAccount?: string | undefined;
}

export interface DraftDocument {
  readonly type: SalesDocType;
  readonly contactId?: string | undefined;
  readonly billingAddress?: SnapshotAddress | undefined;
  readonly deliveryAddress?: SnapshotAddress | undefined;
  readonly supplyDate?: SupplyDate | undefined;
  readonly supplyDateMode: "explicit" | "document_date";
  /** Chosen earlier document date (DOC-26); absent = Berlin date of the commit instant. */
  readonly documentDate?: string | undefined;
  readonly backdateReason?: string | undefined;
  readonly currency: string;
  readonly fxRateToEur?: SnapshotFx | undefined;
  readonly priceMode: "net" | "gross";
  readonly taxCaseOverride?: { readonly taxCase: TaxCase; readonly reason: string } | undefined;
  readonly subject?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
  readonly buyerReference?: string | undefined;
  readonly orderReference?: string | undefined;
  readonly contractReference?: string | undefined;
  readonly paymentTerms: {
    readonly dueDays: number;
    readonly skontoPercentBp?: number | undefined;
    readonly skontoDays?: number | undefined;
    readonly text?: string | undefined;
  };
  readonly showEpcQr: boolean;
  readonly kleinbetrag?: boolean | undefined;
  readonly propertyRelated?: boolean | undefined;
  readonly constructionWork?: boolean | undefined;
  readonly documentDiscount?:
    | {
        readonly kind: "percent" | "amount";
        readonly valueBp?: number | undefined;
        readonly amountCents?: number | undefined;
        readonly isSurcharge: boolean;
        readonly reason?: string | undefined;
      }
    | undefined;
  readonly language: "de" | "en";
  /** Chosen e-invoice format; absent = the default of §4.6.3. */
  readonly einvoiceFormat?: EinvoiceFormat | undefined;
  readonly lines: readonly DraftLine[];
}

// ── read context (assembled by the model layer; also re-read in the commit transaction, EC-004) ──────────────────

export interface CompanyContext {
  /** Seller block without the date-dependent flags (filled per document). */
  readonly seller: Omit<SnapshotSeller, "kleinunternehmer" | "vatAccounting">;
  /** F01 `validateCompanyForDocuments` (SET-012). */
  readonly validation: { readonly blocking: readonly Issue[]; readonly warnings: readonly Issue[] };
  readonly kleinunternehmer: readonly { readonly validFrom: string; readonly isKU: boolean }[];
  readonly taxationMethod: readonly { readonly validFrom: string; readonly method: "soll" | "ist" }[];
  readonly priorYearTurnover: readonly { readonly year: number; readonly amountCents: number }[];
  readonly foundedOn?: string | undefined;
  readonly backdateWindowDays: number;
  readonly paymentReferencePrefix?: string | undefined;
}

export interface ContactContext {
  readonly id: string;
  /** Buyer block as it would be frozen now (DOC-22). */
  readonly buyer: SnapshotBuyer;
  readonly countryCode: string;
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
  readonly vatId?: string | undefined;
  readonly vatIdStatus?:
    | { readonly status: "valid" | "invalid" | "unavailable"; readonly qualified: boolean }
    | undefined;
  /** Checks of the current VAT ID, newest first (INV-28 gate). */
  readonly vatChecks: readonly GateCheck[];
  readonly defaultTaxCase?: TaxCase | undefined;
  readonly preferredFormat: PreferredFormat;
  readonly pdfConsents: readonly PdfConsent[];
  readonly certificates13b: readonly Certificate13b[];
  readonly buyerReference?: string | undefined;
  readonly archived?: boolean | undefined;
}

export interface DocumentContext {
  /** Europe/Berlin calendar date of "now". */
  readonly today: CalendarDate;
  readonly setupComplete: boolean;
  readonly integrityAlertOpen: boolean;
  readonly numberRangeAvailable: boolean;
  readonly company: CompanyContext;
  readonly contact: ContactContext | null;
  readonly bankAccount?: SnapshotPayment["bankAccount"] | undefined;
  readonly paymentMethod: { readonly kind: PaymentMethodKind; readonly text?: string | undefined };
  /** Active unit codes (Rec 20/21 subset seeded in `units`). */
  readonly unitCodes: ReadonlySet<string>;
  readonly unitLabels?: Readonly<Record<string, { readonly de: string; readonly en: string }>> | undefined;
  /** Last day of the latest locked period (RI-13), if any. */
  readonly lockedThrough?: string | undefined;
  /** Finalised invoices of the same contact (DOC-43 duplicate guard). */
  readonly recentInvoices?: readonly {
    readonly number: string;
    readonly documentDate: string;
    readonly grossCents: number;
    readonly supplyEnd?: string | undefined;
  }[];
  /** KU companies: current calendar year turnover of finalised invoices (EUR cents, KU-01). */
  readonly kuYearTurnoverCents?: number | undefined;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The entry of a `validFrom` history valid on `date` (histories are sorted ascending). */
export function historyAt<T extends { readonly validFrom: string }>(
  entries: readonly T[],
  date: string,
): T | undefined {
  let found: T | undefined;
  for (const e of [...entries].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))) {
    if (e.validFrom <= date) found = e;
  }
  return found;
}

export const isKleinunternehmerAt = (c: Pick<CompanyContext, "kleinunternehmer">, date: string): boolean =>
  historyAt(c.kleinunternehmer, date)?.isKU ?? false;

export const vatAccountingAt = (c: Pick<CompanyContext, "taxationMethod">, date: string): "soll" | "ist" =>
  historyAt(c.taxationMethod, date)?.method ?? "soll";

export const toLineDiscount = (d: StoredDiscount | undefined): LineDiscount | undefined => {
  if (!d) return undefined;
  if (d.kind === "percent") return d.valueBp ? { kind: "percent", bp: d.valueBp } : undefined;
  return d.amountCents ? { kind: "amount", cents: d.amountCents } : undefined;
};

/** The document date the draft would get now (DOC-26). */
export const effectiveDocumentDate = (draft: Pick<DraftDocument, "documentDate">, today: CalendarDate): CalendarDate =>
  (draft.documentDate ?? today) as CalendarDate;

/** The supply date the draft would get now ("Leistungsdatum = Rechnungsdatum" resolves to the document date). */
export function effectiveSupplyDate(
  draft: Pick<DraftDocument, "supplyDate" | "supplyDateMode" | "documentDate">,
  today: CalendarDate,
): SupplyDate | undefined {
  if (draft.supplyDateMode === "document_date") return { kind: "date", date: effectiveDocumentDate(draft, today) };
  return draft.supplyDate;
}

export function supplyRange(supply: SupplyDate | undefined): { from: string; to: string } | undefined {
  if (!supply) return undefined;
  if (supply.kind === "date") return { from: supply.date, to: supply.date };
  if (supply.kind === "period") return { from: supply.from, to: supply.to };
  return monthBounds(supply.month);
}

/** Supply range of a line: its own period (BG-26), else the document supply date (DOC-13). */
export function lineSupplyRange(
  line: Pick<DraftLine, "linePeriod">,
  docSupply: SupplyDate | undefined,
): { from: string; to: string } | undefined {
  return line.linePeriod ?? supplyRange(docSupply);
}

export const itemLines = (lines: readonly DraftLine[]): DraftLine[] => lines.filter((l) => l.kind === "item");

// ── resolution ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolvedLine {
  /** Index into `draft.lines`. */
  readonly index: number;
  /** 1-based position among item lines (BT-126, "Position {n}"). */
  readonly position: number;
  readonly vatCategory: VatCategory;
  readonly vatRateBp: number;
  readonly vatRuleRowId?: string | undefined;
  /** Rate lookup failure of this line (`supply_period_crosses_rate_change` / unknown key). */
  readonly rateIssue?: Issue | undefined;
  /** The cached stored rate differed (`rate_changed_notice`, DOC-13). */
  readonly rateChanged?: { readonly from: number; readonly to: number; readonly date: string } | undefined;
}

export interface ResolvedDraft {
  readonly documentDate: CalendarDate;
  readonly supplyDate?: SupplyDate | undefined;
  readonly kleinunternehmer: boolean;
  readonly derivation: TaxCaseDerivation;
  /** The tax case in effect (override if set, else derived; `domestic` while blocked). */
  readonly taxCase: DerivableTaxCase;
  readonly derivedTaxCase?: DerivableTaxCase | undefined;
  readonly lines: readonly ResolvedLine[];
  readonly totals: DocumentTotals | null;
  readonly totalsIssue?: Issue | undefined;
  /** Gross in EUR cents (thresholds, DOC-56). */
  readonly grossEurCents: number | null;
}

const businessCustomer = (c: ContactContext | null) => !c?.isConsumer || c.isPublicAuthority;

/** Draft → tax case → categories/rates → totals. Pure, shared by editor and server. */
export function resolveDraft(draft: DraftDocument, ctx: DocumentContext): ResolvedDraft {
  const documentDate = effectiveDocumentDate(draft, ctx.today);
  const supplyDate = effectiveSupplyDate(draft, ctx.today);
  const refDate = supplyRange(supplyDate)?.to ?? documentDate;
  const kleinunternehmer = isKleinunternehmerAt(ctx.company, refDate);
  const items = draft.lines.map((l, i) => [l, i] as const).filter(([l]) => l.kind === "item");
  const c = ctx.contact;
  const derivation = deriveTaxCase({
    companyIsKleinunternehmer: kleinunternehmer,
    companyHasVatId: !!ctx.company.seller.vatId,
    contact: c && {
      countryCode: c.countryCode,
      isConsumer: c.isConsumer,
      isPublicAuthority: c.isPublicAuthority,
      vatId: c.vatId,
      vatIdStatus: c.vatIdStatus,
      defaultTaxCase: c.defaultTaxCase,
    },
    deliveryCountry: draft.deliveryAddress?.countryCode,
    lines: items.map(([l]) => ({
      productType: l.productType,
      placeOfSupplyRule: l.placeOfSupplyRule,
      reverseCharge13b: l.reverseCharge13b,
      vatRateKey: l.vatRateKey,
    })),
    override: draft.taxCaseOverride?.taxCase,
    date: refDate as CalendarDate,
  });
  const taxCase: DerivableTaxCase = derivation.kind === "ok" ? derivation.taxCase : "domestic";
  let derivedTaxCase: DerivableTaxCase | undefined;
  if (draft.taxCaseOverride) {
    const without = deriveTaxCase({
      companyIsKleinunternehmer: kleinunternehmer,
      companyHasVatId: !!ctx.company.seller.vatId,
      contact: c && { ...c, defaultTaxCase: c.defaultTaxCase },
      deliveryCountry: draft.deliveryAddress?.countryCode,
      lines: items.map(([l]) => l),
      date: refDate as CalendarDate,
    });
    derivedTaxCase = without.kind === "ok" ? without.taxCase : undefined;
  }

  const lines: ResolvedLine[] = items.map(([l, index], k) => {
    const range = lineSupplyRange(l, supplyDate) ?? { from: documentDate, to: documentDate };
    const key = l.vatRateKey ?? "standard";
    const lookup =
      range.from === range.to
        ? lookupVatRate(key, range.from as CalendarDate)
        : lookupVatRateForPeriod(key, range.from as CalendarDate, range.to as CalendarDate);
    let rateIssue: Issue | undefined;
    let rateCategory: "S" | "Z" | "E" = "S";
    let rateBp = 0;
    let ruleRowId: string | undefined;
    if (lookup.ok) {
      rateCategory = lookup.value.value.category;
      rateBp = lookup.value.value.rateBp;
      ruleRowId = lookup.value.rowId;
    } else if (lookup.error.code === "rule_changes_in_period") {
      const at = (lookup.error.params?.changeDate as string | undefined) ?? range.to;
      rateIssue = issue(
        "supply_period_crosses_rate_change",
        `Position ${k + 1}: Der Leistungszeitraum überschreitet die Steuersatzänderung am ${at.split("-").reverse().join(".")}. Bitte die Position in Teilzeiträume aufteilen.`,
        { n: k + 1, date: at },
      );
    } else {
      rateIssue = issue(
        "rate_not_valid_for_date",
        `Position ${k + 1}: Kein Steuersatz für „${key}“ am Leistungsdatum.`,
        {
          n: k + 1,
        },
      );
    }
    const derived = defaultCategoryFor(taxCase, l, rateCategory, businessCustomer(c));
    const vatCategory = l.vatCategoryOverride ?? derived;
    const vatRateBp = vatCategory === "S" ? rateBp : 0;
    const rateChanged =
      l.vatRateBp !== undefined && l.vatCategory === vatCategory && l.vatRateBp !== vatRateBp && vatCategory === "S"
        ? { from: l.vatRateBp, to: vatRateBp, date: range.to }
        : undefined;
    return {
      index,
      position: k + 1,
      vatCategory,
      vatRateBp,
      vatRuleRowId:
        vatCategory === "S" || vatCategory === "Z" || (vatCategory === "E" && key === "exempt") ? ruleRowId : undefined,
      rateIssue,
      rateChanged,
    };
  });

  const adjustment = draft.documentDiscount;
  const totalsResult = computeTotals({
    priceMode: draft.priceMode,
    lines: items.map(([l], k) => ({
      quantityMilli: l.quantityMilli ?? 0,
      unitPriceMicros: l.unitPriceMicros ?? 0,
      discount: toLineDiscount(l.discount),
      vatCategory: lines[k]?.vatCategory ?? "S",
      rateBp: lines[k]?.vatRateBp ?? 0,
    })),
    adjustment:
      adjustment &&
      (adjustment.kind === "percent"
        ? adjustment.valueBp
          ? { type: adjustment.isSurcharge ? "charge" : "allowance", percentBp: adjustment.valueBp }
          : undefined
        : adjustment.amountCents
          ? { type: adjustment.isSurcharge ? "charge" : "allowance", amountCents: adjustment.amountCents }
          : undefined),
  });
  const totals = totalsResult.ok ? totalsResult.value : null;
  return {
    documentDate,
    supplyDate,
    kleinunternehmer,
    derivation,
    taxCase,
    derivedTaxCase,
    lines,
    totals,
    totalsIssue: totalsResult.ok ? undefined : totalsResult.error,
    grossEurCents: totals ? toEur(totals.grossCents, draft) : null,
  };
}

/** Converts a document-currency amount to EUR cents with the draft FX rate ("1 EUR = x FC"); EUR passes through. */
export function toEur(cents: number, draft: Pick<DraftDocument, "currency" | "fxRateToEur">): number {
  if (draft.currency === "EUR" || !draft.fxRateToEur) return cents;
  const rate = parseFxRate(draft.fxRateToEur.rate);
  return rate.ok ? fcToEurCents(cents, rate.value) : cents;
}
