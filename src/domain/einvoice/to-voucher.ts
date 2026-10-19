/**
 * Received E-Rechnung → purchase-voucher draft (F06 INB-043, VOU-012, MISC-08). Pure.
 *
 *  BT-1 → documentNumber · BT-2 → documentDate · BT-72 / BG-14 → supplyDate · BT-9 → dueDate · BT-20 → Skonto
 *  (`#SKONTO#`) · BT-27/31/32/BG-5 → supplier · BT-84 → payee IBAN · BT-5/BT-6/BT-111 → currency (EUR VAT hint) ·
 *  BG-23 → lines grouped by (category, rate) — so Σ lines equals BG-23 including document-level allowances and
 *  charges (golden V6) — or, with `perLine`, one line per BG-25 plus the document-level allowances/charges ·
 *  BT-3 381 → supplier credit note (negative amounts, link via BT-25) · BT-113 prepaid → payment hint.
 *
 * Accounts are left empty (`""`): the account suggestion (VOU-041) fills them. For self-assessment categories (AE
 * reverse charge, K intra-Community) the supplier shows no VAT; each line carries the German rate valid on the supply
 * date (`germanRateBp`), from which the voucher domain computes the self-assessed VAT (VOU-022).
 */
import { lookupVatRate } from "../rules/vat-rates";
import type { CalendarDate } from "../time/calendar-date";
import type { ReceivedInvoice } from "./received";

export type ReceivedTaxRule =
  | "input_vat_deductible"
  | "no_input_vat"
  | "reverse_charge_13b_de"
  | "reverse_charge_eu"
  | "reverse_charge_non_eu"
  | "intra_community_acquisition"
  | "kleinunternehmer_supplier";

export interface PrefillLine {
  account: string;
  description?: string;
  quantityMilli?: number;
  amountCents: number;
  vatRateBp: number;
  vatCents?: number;
}

/** Assignable to the Convex `vVoucherDraftInput` (convex/voucherValidators.ts). */
export interface VoucherDraftPrefill {
  direction: "expense";
  supplierName?: string;
  supplierVatId?: string;
  supplierTaxNumber?: string;
  supplierAddress?: string;
  supplierIban?: string;
  documentNumber?: string;
  documentDate?: string;
  supplyDate?: { kind: "date"; date: string } | { kind: "period"; from: string; to: string };
  dueDate?: string;
  currency: string;
  priceMode: "net";
  taxRule: ReceivedTaxRule;
  lines: PrefillLine[];
  statedTotals: { grossCents: number; byRate: { rateBp: number; netCents: number; vatCents: number }[] };
  skontoTerms?: { percentBp: number; days: number; baseCents?: number };
}

export interface ReceivedVoucherDraft {
  input: VoucherDraftPrefill;
  payee?: { name: string; iban: string; bic?: string };
  creditNote: boolean;
  precedingInvoiceNumber?: string;
  prepaidCents: number;
  warnings: { code: string; message: string }[];
}

export interface ToVoucherOptions {
  perLine?: boolean;
  /** German rate for a supply date (from the date-effective rate table, src/domain/rules/vat-rates.ts). */
  germanRateBp: (date: string, key: "standard" | "reduced") => number;
}

/** EU member states (VAT prefixes use EL for Greece). */
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

const SELF_ASSESSED = new Set(["AE", "K"]);
const KU_HINT = /§\s*19|kleinunternehmer|small business/i;

function sellerCountry(inv: ReceivedInvoice): string | undefined {
  const c = inv.seller.address.countryCode?.toUpperCase();
  if (c) return c;
  const prefix = inv.seller.vatId?.slice(0, 2).toUpperCase();
  return prefix && /^[A-Z]{2}$/.test(prefix) ? (prefix === "EL" ? "GR" : prefix) : undefined;
}

function taxRuleOf(inv: ReceivedInvoice): ReceivedTaxRule {
  const groups = inv.vatBreakdown.length > 0 ? inv.vatBreakdown : inv.lines;
  const cats = new Set(groups.map((g) => g.category));
  if (cats.has("AE")) {
    const c = sellerCountry(inv);
    if (c === "DE") return "reverse_charge_13b_de";
    return c && EU.has(c) ? "reverse_charge_eu" : "reverse_charge_non_eu";
  }
  if (cats.has("K")) return "intra_community_acquisition";
  if (cats.has("S") || cats.has("Z") || cats.has("L") || cats.has("M")) return "input_vat_deductible";
  if (cats.has("E") && inv.vatBreakdown.some((v) => v.category === "E" && KU_HINT.test(v.exemptionReason ?? ""))) {
    return "kleinunternehmer_supplier";
  }
  if (cats.size === 0) return "input_vat_deductible";
  return "no_input_vat";
}

function oneLineAddress(a: ReceivedInvoice["seller"]["address"]): string | undefined {
  const city = [a.postalCode, a.city].filter(Boolean).join(" ");
  const parts = [a.line1, a.line2, city, a.countryCode && a.countryCode !== "DE" ? a.countryCode : undefined].filter(
    (p): p is string => !!p && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

const formatRate = (bp: number) => `${(bp / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;

function clip(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function receivedToVoucherDraft(inv: ReceivedInvoice, opts: ToVoucherOptions): ReceivedVoucherDraft {
  const warnings: { code: string; message: string }[] = [];
  const creditNote = inv.typeCode === "381";
  // Credit notes print positive amounts; a negative voucher reduces the input VAT (VOU-012). Already negative → kept.
  const sign = creditNote && inv.totals.taxInclusiveCents > 0 ? -1 : 1;
  const s = (n: number) => sign * n;
  const supplyRef = inv.supplyDate ?? inv.period?.to ?? inv.issueDate;
  const rateFor = (category: string, rateBp: number) =>
    SELF_ASSESSED.has(category) ? opts.germanRateBp(supplyRef, "standard") : rateBp;
  const selfAssessed = (category: string) => SELF_ASSESSED.has(category);
  if ([...inv.vatBreakdown, ...inv.lines].some((g) => selfAssessed(g.category))) {
    warnings.push({
      code: "einvoice_self_assessment_rate",
      message: `Steuerschuldnerschaft des Leistungsempfängers: Für die Selbstberechnung wurde der Regelsteuersatz ${formatRate(opts.germanRateBp(supplyRef, "standard"))} angenommen – bitte prüfen.`,
    });
  }

  const lines: PrefillLine[] = [];
  if (opts.perLine && inv.lines.length > 0) {
    for (const l of inv.lines) {
      lines.push({
        account: "",
        description: clip(l.description ? `${l.name} – ${l.description}` : l.name),
        quantityMilli: l.quantityMilli,
        amountCents: s(l.netCents),
        vatRateBp: rateFor(l.category, l.rateBp),
      });
    }
    for (const ac of inv.allowancesCharges) {
      lines.push({
        account: "",
        description: clip(ac.reason ?? (ac.charge ? "Zuschlag" : "Nachlass")),
        amountCents: s(ac.charge ? ac.amountCents : -ac.amountCents),
        vatRateBp: rateFor(ac.category, ac.rateBp),
      });
    }
  } else if (inv.vatBreakdown.length > 0) {
    for (const v of inv.vatBreakdown) {
      const names = inv.lines.filter((l) => l.category === v.category && l.rateBp === v.rateBp).map((l) => l.name);
      const description = names.length > 0 ? clip(names.join(", ")) : `Rechnungsbetrag ${formatRate(v.rateBp)}`;
      const line: PrefillLine = {
        account: "",
        description,
        amountCents: s(v.taxableCents),
        vatRateBp: rateFor(v.category, v.rateBp),
      };
      if (!selfAssessed(v.category)) line.vatCents = s(v.taxCents);
      lines.push(line);
    }
  } else if (inv.totals.taxExclusiveCents !== 0) {
    // MINIMUM without BG-23: one line only when the VAT matches a German rate exactly (prefill for the owner's review).
    const net = inv.totals.taxExclusiveCents;
    const vat = inv.totals.taxCents;
    const rate = [opts.germanRateBp(supplyRef, "standard"), opts.germanRateBp(supplyRef, "reduced"), 0].find(
      (r) => Math.abs(Math.round((net * r) / 10_000) - vat) <= 1,
    );
    if (rate !== undefined) {
      lines.push({
        account: "",
        description: `Rechnungsbetrag ${formatRate(rate)}`,
        amountCents: s(net),
        vatRateBp: rate,
        vatCents: s(vat),
      });
    }
  }

  // Stated totals in the voucher's terms (rates as on the lines; self-assessed lines show no VAT).
  const byRate: { rateBp: number; netCents: number; vatCents: number }[] = [];
  if (!opts.perLine || inv.lines.length === 0) {
    for (const l of lines) {
      const row = byRate.find((r) => r.rateBp === l.vatRateBp);
      const vat = l.vatCents ?? 0;
      if (row) {
        row.netCents += l.amountCents;
        row.vatCents += vat;
      } else byRate.push({ rateBp: l.vatRateBp, netCents: l.amountCents, vatCents: vat });
    }
  } else {
    for (const v of inv.vatBreakdown) {
      const rateBp = rateFor(v.category, v.rateBp);
      const vat = selfAssessed(v.category) ? 0 : s(v.taxCents);
      const row = byRate.find((r) => r.rateBp === rateBp);
      if (row) {
        row.netCents += s(v.taxableCents);
        row.vatCents += vat;
      } else byRate.push({ rateBp, netCents: s(v.taxableCents), vatCents: vat });
    }
  }

  const supplyDate: VoucherDraftPrefill["supplyDate"] = inv.supplyDate
    ? { kind: "date", date: inv.supplyDate }
    : inv.period
      ? { kind: "period", from: inv.period.from, to: inv.period.to }
      : undefined;
  const skonto = inv.payment.skonto[0];
  const address = oneLineAddress(inv.seller.address);
  const input: VoucherDraftPrefill = {
    direction: "expense",
    supplierName: inv.seller.name,
    ...(inv.seller.vatId ? { supplierVatId: inv.seller.vatId } : {}),
    ...(inv.seller.taxNumber ? { supplierTaxNumber: inv.seller.taxNumber } : {}),
    ...(address ? { supplierAddress: address } : {}),
    ...(inv.payment.iban ? { supplierIban: inv.payment.iban } : {}),
    documentNumber: inv.number,
    documentDate: inv.issueDate,
    ...(supplyDate ? { supplyDate } : {}),
    ...(inv.dueDate ? { dueDate: inv.dueDate } : {}),
    currency: inv.currency.toUpperCase(),
    priceMode: "net",
    taxRule: taxRuleOf(inv),
    lines,
    statedTotals: { grossCents: s(inv.totals.taxInclusiveCents), byRate },
    ...(skonto
      ? {
          skontoTerms: {
            percentBp: skonto.percentBp,
            days: skonto.days,
            ...(skonto.baseCents !== undefined ? { baseCents: skonto.baseCents } : {}),
          },
        }
      : {}),
  };

  if (inv.currency.toUpperCase() !== "EUR" && inv.vatCurrency?.toUpperCase() === "EUR") {
    warnings.push({
      code: "einvoice_vat_currency",
      message:
        inv.taxTotalVatCurrencyCents !== undefined
          ? `Rechnung in ${inv.currency}; die Umsatzsteuer in EUR laut Rechnung (BT-111) beträgt ${(inv.taxTotalVatCurrencyCents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 })} € und hat Vorrang.`
          : `Rechnung in ${inv.currency} mit Steuerwährung EUR – bitte Umrechnungskurs prüfen.`,
    });
  }
  if (inv.totals.prepaidCents !== 0) {
    warnings.push({
      code: "einvoice_prepaid",
      message: `Laut Rechnung bereits gezahlt: ${(inv.totals.prepaidCents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 })} € (BT-113). Bitte Zahlung zuordnen.`,
    });
  }
  const preceding = inv.precedingInvoices[0]?.number;
  const payeeName = inv.payee?.name ?? inv.payment.accountName ?? inv.seller.name;
  return {
    input,
    ...(inv.payment.iban
      ? { payee: { name: payeeName, iban: inv.payment.iban, ...(inv.payment.bic ? { bic: inv.payment.bic } : {}) } }
      : {}),
    creditNote,
    ...(preceding ? { precedingInvoiceNumber: preceding } : {}),
    prepaidCents: inv.totals.prepaidCents,
    warnings,
  };
}

/** `germanRateBp` backed by the date-effective rate table (src/domain/rules/vat-rates.ts); 0 if no row exists. */
export function germanRateFromRules(date: string, key: "standard" | "reduced"): number {
  const row = lookupVatRate(key, date as CalendarDate);
  return row.ok ? row.value.value.rateBp : 0;
}
