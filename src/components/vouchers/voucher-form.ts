/**
 * Voucher editor state (F06 §6.3, VOU-001/002): German text fields ⇄ the Convex draft input (integer cents, basis
 * points). Pure; the totals, VAT and every legal check are computed by Convex/src/domain from the saved draft — the
 * editor only parses what was typed.
 */
import { formatCents } from "@/domain/money/format";
import { parseBasisPoints, parseCents } from "@/domain/money/parse";
import { BOOK_BUTTON_DE, type VoucherPaymentMethod } from "@/domain/vouchers/payment-choice";

export type Direction = "expense" | "income";
export type VoucherKind = "standard" | "bewirtung" | "eigenbeleg" | "asset" | "tax_payment" | "private";
export type PriceMode = "net" | "gross";

export interface VoucherLineForm {
  account: string;
  description: string;
  /** Net or gross per price mode, German format („119,00“). */
  amount: string;
  /** Percent („19“, „7“, „0“). */
  rate: string;
  /** VAT as printed (optional; empty = computed). Cleared when amount or rate change. */
  vat: string;
  /** Non-deductible share in percent (Bewirtung 30, private share). */
  nonDeductible: string;
}

export interface VoucherForm {
  direction: Direction;
  kind: VoucherKind;
  supplierName: string;
  supplierVatId: string;
  supplierTaxNumber: string;
  supplierAddress: string;
  supplierIban: string;
  documentNumber: string;
  documentDate: string;
  /** Leistungsdatum; empty = document date. */
  supplyDate: string;
  dueDate: string;
  currency: string;
  /** 1 EUR = x foreign currency (03 FxRate), German decimal. */
  fxRate: string;
  priceMode: PriceMode;
  /** Empty = automatic (the model suggests by supplier, KU status and direction). */
  taxRule: string;
  statedGross: string;
  internalNote: string;
  lines: VoucherLineForm[];
}

export interface FormIssue {
  field: string;
  message: string;
}

export const emptyLine = (rate = "19"): VoucherLineForm => ({
  account: "",
  description: "",
  amount: "",
  rate,
  vat: "",
  nonDeductible: "",
});

export function emptyVoucherForm(today: string, direction: Direction = "expense"): VoucherForm {
  return {
    direction,
    kind: "standard",
    supplierName: "",
    supplierVatId: "",
    supplierTaxNumber: "",
    supplierAddress: "",
    supplierIban: "",
    documentNumber: "",
    documentDate: today,
    supplyDate: "",
    dueDate: "",
    currency: "EUR",
    fxRate: "",
    priceMode: "gross",
    taxRule: "",
    statedGross: "",
    internalNote: "",
    lines: [emptyLine()],
  };
}

const pct = (bp: number) => (bp / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 });

export interface StoredVoucher {
  direction: Direction;
  kind: VoucherKind;
  supplierName?: string;
  supplierVatId?: string;
  supplierTaxNumber?: string;
  supplierAddress?: string;
  supplierIban?: string;
  documentNumber?: string;
  documentDate?: string;
  supplyDate?: { kind: string; date?: string; from?: string; to?: string; month?: string };
  dueDate?: string;
  currency: string;
  fxRateToEur?: { rate: string };
  priceMode: PriceMode;
  taxRule: string;
  statedTotals?: { grossCents?: number };
  internalNote?: string;
}

export interface StoredLine {
  account: string;
  description?: string;
  netCents: number;
  vatRateBp: number;
  vatCents: number;
  grossCents: number;
  nonDeductibleShareBp?: number;
}

/** Form from the stored draft. The automatic tax rule of a fresh draft stays „automatisch“ until it is chosen. */
export function voucherFormFrom(v: StoredVoucher, lines: readonly StoredLine[], today: string): VoucherForm {
  const base = emptyVoucherForm(today, v.direction);
  return {
    ...base,
    kind: v.kind,
    supplierName: v.supplierName ?? "",
    supplierVatId: v.supplierVatId ?? "",
    supplierTaxNumber: v.supplierTaxNumber ?? "",
    supplierAddress: v.supplierAddress ?? "",
    supplierIban: v.supplierIban ?? "",
    documentNumber: v.documentNumber ?? "",
    documentDate: v.documentDate ?? "",
    supplyDate: v.supplyDate?.kind === "date" ? (v.supplyDate.date ?? "") : "",
    dueDate: v.dueDate ?? "",
    currency: v.currency,
    fxRate: v.fxRateToEur ? v.fxRateToEur.rate.replace(".", ",") : "",
    priceMode: v.priceMode,
    taxRule: v.taxRule,
    statedGross: v.statedTotals?.grossCents !== undefined ? formatCents(v.statedTotals.grossCents) : "",
    internalNote: v.internalNote ?? "",
    lines:
      lines.length > 0
        ? lines.map((l) => ({
            account: l.account,
            description: l.description ?? "",
            amount: formatCents(v.priceMode === "gross" ? l.grossCents : l.netCents),
            rate: pct(l.vatRateBp),
            vat: formatCents(l.vatCents),
            nonDeductible: l.nonDeductibleShareBp ? pct(l.nonDeductibleShareBp) : "",
          }))
        : [emptyLine()],
  };
}

/** Changing amount or rate drops a VAT typed for the old values (it would no longer match, EC-VOU-04). */
export function updateLine(line: VoucherLineForm, patch: Partial<VoucherLineForm>): VoucherLineForm {
  const next = { ...line, ...patch };
  const changed =
    (patch.amount !== undefined && patch.amount !== line.amount) ||
    (patch.rate !== undefined && patch.rate !== line.rate);
  if (changed && patch.vat === undefined) next.vat = "";
  return next;
}

const blankLine = (l: VoucherLineForm) => !l.account.trim() && !l.description.trim() && !l.amount.trim();

function percentToBp(text: string): number | null {
  const r = parseBasisPoints(text.replace(/\s*%$/, "").trim() || "0");
  return r.ok && r.value <= 10_000 && r.value >= 0 ? r.value : null;
}

/** Form → `vVoucherDraftInput`. Blank lines are dropped; unparsable numbers are reported per field. */
export function toDraftInput(f: VoucherForm): { input: Record<string, unknown>; issues: FormIssue[] } {
  const issues: FormIssue[] = [];
  const lines: Record<string, unknown>[] = [];
  f.lines.forEach((l, i) => {
    if (blankLine(l)) return;
    const amount = parseCents(l.amount.trim());
    if (!amount.ok) issues.push({ field: `lines.${i}.amount`, message: "Betrag ungültig." });
    const rate = percentToBp(l.rate);
    if (rate === null) issues.push({ field: `lines.${i}.rate`, message: "Steuersatz ungültig." });
    const vat = l.vat.trim() ? parseCents(l.vat.trim()) : null;
    if (vat && !vat.ok) issues.push({ field: `lines.${i}.vat`, message: "USt-Betrag ungültig." });
    const nd = l.nonDeductible.trim() ? percentToBp(l.nonDeductible) : 0;
    if (nd === null) issues.push({ field: `lines.${i}.nonDeductible`, message: "Anteil ungültig." });
    if (!amount.ok || rate === null || nd === null || (vat && !vat.ok)) return;
    lines.push({
      account: l.account.trim(),
      ...(l.description.trim() ? { description: l.description.trim() } : {}),
      amountCents: amount.value,
      vatRateBp: rate,
      ...(vat?.ok ? { vatCents: vat.value } : {}),
      ...(nd ? { nonDeductibleShareBp: nd } : {}),
    });
  });
  let fx: { rate: string; source: "manual"; date: string } | null = null;
  if (f.currency !== "EUR" && f.fxRate.trim()) {
    const rate = f.fxRate.trim().replace(/\./g, "").replace(",", ".");
    if (/^\d+(\.\d{1,6})?$/.test(rate) && Number(rate) > 0) fx = { rate, source: "manual", date: f.documentDate };
    else issues.push({ field: "fxRate", message: "Kurs ungültig (z. B. 1,0850)." });
  }
  let stated: number | null = null;
  if (f.statedGross.trim()) {
    const r = parseCents(f.statedGross.trim());
    if (r.ok) stated = r.value;
    else issues.push({ field: "statedGross", message: "Betrag ungültig." });
  }
  const text = (s: string) => s.trim();
  const input: Record<string, unknown> = {
    direction: f.direction,
    kind: f.kind,
    supplierName: text(f.supplierName),
    supplierVatId: text(f.supplierVatId).replace(/\s+/g, "").toUpperCase(),
    supplierTaxNumber: text(f.supplierTaxNumber),
    supplierAddress: text(f.supplierAddress),
    supplierIban: text(f.supplierIban).replace(/\s+/g, "").toUpperCase(),
    documentNumber: text(f.documentNumber),
    ...(f.documentDate ? { documentDate: f.documentDate } : {}),
    ...(f.supplyDate ? { supplyDate: { kind: "date", date: f.supplyDate } } : {}),
    ...(f.dueDate ? { dueDate: f.dueDate } : {}),
    currency: f.currency,
    ...(fx ? { fxRateToEur: fx } : {}),
    priceMode: f.priceMode,
    ...(f.taxRule ? { taxRule: f.taxRule } : {}),
    ...(stated !== null ? { statedTotals: { grossCents: stated } } : {}),
    internalNote: text(f.internalNote),
    lines,
  };
  return { input, issues };
}

// ── „Bezahlt mit“ (VOU-136) ─────────────────────────────────────────────────────────────────────────────

export interface PaymentForm {
  method: VoucherPaymentMethod;
  /** Empty = document date. */
  date: string;
  /** Empty = open amount. */
  amount: string;
  backdateReason: string;
}

export const defaultPaymentForm = (method: VoucherPaymentMethod = "bank"): PaymentForm => ({
  method,
  date: "",
  amount: "",
  backdateReason: "",
});

/** Income vouchers offer Bank and Bar only (VOU-136). */
export function paymentMethodsFor(direction: Direction): VoucherPaymentMethod[] {
  return direction === "income" ? ["bank", "cash"] : ["bank", "card_pending", "cash", "private"];
}

/** Label of the „Buchen“ button following the choice („Buchen – bar bezahlt“). */
export function bookButtonLabel(method: VoucherPaymentMethod): string {
  return BOOK_BUTTON_DE[method];
}

/** Payment form → the `payment` argument of `vouchers.finalize`/`preview` (none for the default „Bank folgt“). */
export function paymentInput(p: PaymentForm): { payment?: Record<string, unknown>; issues: FormIssue[] } {
  const issues: FormIssue[] = [];
  const amount = p.amount.trim() ? parseCents(p.amount.trim()) : null;
  if (amount && (!amount.ok || amount.value <= 0)) issues.push({ field: "amount", message: "Betrag ungültig." });
  if (p.method === "bank" && !p.date && !amount) return { issues };
  return {
    payment: {
      method: p.method,
      ...(p.date ? { date: p.date } : {}),
      ...(amount?.ok && amount.value > 0 ? { amountCents: amount.value } : {}),
      ...(p.backdateReason.trim() ? { backdateReason: p.backdateReason.trim() } : {}),
    },
    issues,
  };
}
