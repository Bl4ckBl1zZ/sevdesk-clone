import { z } from "zod";
import { decodeId, encodeId, encodeOptionalId } from "../../api/ids";
import { isoDate, listEnvelope, prefixedId, toInstant, toOptionalInstant } from "./common";

/**
 * Wire schemas of `/vouchers` (05 §4.5, F06 §7) and the MCP voucher tools (06 §3): snake_case, prefixed IDs (`vou_`,
 * `con_`, `btx_`, `pay_`), integer cents and basis points, ISO dates. The mapping to the Convex arguments lives here so
 * REST, MCP and the `preview_action` plan build byte-identical arguments (the confirm token hashes them).
 */

const cents = (description: string) => z.number().int().meta({ description });

export const VOUCHER_TAX_RULES = [
  "input_vat_deductible",
  "no_input_vat",
  "reverse_charge_13b_de",
  "reverse_charge_eu",
  "reverse_charge_non_eu",
  "intra_community_acquisition",
  "import_vat",
  "kleinunternehmer_supplier",
  "output_vat",
  "exempt_income",
  "not_taxable",
] as const;

export const voucherLineWire = z
  .object({
    account: z.string().min(1).max(10).meta({ description: "Sachkonto (SKR03/SKR04)", example: "6815" }),
    description: z.string().max(500).optional(),
    quantity_milli: z.number().int().min(0).optional().meta({ description: "Menge × 1000 (Standard 1000)" }),
    amount_cents: cents("Betrag netto (price_mode net) oder brutto (price_mode gross) in Cent"),
    vat_rate_bp: z.number().int().min(0).max(10_000).meta({ description: "Steuersatz in Basispunkten (1900 = 19 %)" }),
    vat_cents: cents("USt laut Beleg (±1 Cent toleriert); ohne Angabe berechnet").optional(),
    non_deductible_share_bp: z.number().int().min(0).max(10_000).optional().meta({
      description: "Nicht abziehbarer Anteil in Basispunkten (Bewirtung 3000, Privatanteil)",
    }),
    asset_decision: z.enum(["gwg", "pool", "asset", "none"]).optional(),
  })
  .strict();

const supplyDateWire = z.union([
  z.object({ kind: z.literal("date"), date: isoDate }).strict(),
  z.object({ kind: z.literal("period"), from: isoDate, to: isoDate }).strict(),
  z.object({ kind: z.literal("month"), month: z.string().regex(/^\d{4}-\d{2}$/) }).strict(),
]);

export const voucherDraftWire = z
  .object({
    direction: z.enum(["expense", "income"]).optional(),
    kind: z.enum(["standard", "bewirtung", "eigenbeleg", "asset", "tax_payment", "private"]).optional(),
    supplier_contact_id: prefixedId("contacts").optional(),
    supplier_name: z.string().max(200).optional(),
    supplier_vat_id: z.string().max(20).optional(),
    supplier_tax_number: z.string().max(30).optional(),
    supplier_address: z.string().max(500).optional(),
    supplier_iban: z.string().max(40).optional(),
    document_number: z.string().max(100).optional(),
    document_date: isoDate.optional(),
    supply_date: supplyDateWire.optional(),
    due_date: isoDate.optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    fx_rate: z
      .object({
        rate: z
          .string()
          .regex(/^\d+(\.\d{1,6})?$/)
          .meta({ description: "1 EUR = x Fremdwährung (03 FxRate)" }),
        source: z.enum(["bmf_monthly", "ecb_daily", "manual", "transaction"]),
        date: isoDate,
      })
      .strict()
      .optional(),
    price_mode: z.enum(["net", "gross"]).optional(),
    tax_rule: z.enum(VOUCHER_TAX_RULES).optional(),
    lines: z.array(voucherLineWire).max(200).optional(),
    stated_gross_cents: cents("Belegsumme laut Dokument (EC-VOU-03)").optional(),
    tax_payment: z
      .object({
        subtype: z.enum(["ust_prepayment", "sondervorauszahlung", "ust_annual", "gewerbesteuer", "est_private", "kst"]),
        period: z.string().max(10).optional(),
      })
      .strict()
      .optional(),
    credit_note_of_id: prefixedId("vouchers").optional(),
    internal_note: z.string().max(2000).optional(),
  })
  .strict();
export type VoucherDraftWire = z.infer<typeof voucherDraftWire>;

/** The Convex `vVoucherDraftInput` shape (kept structural: the domain does not import Convex types). */
export interface VoucherDraftArgs {
  [key: string]: unknown;
}

export interface WireIssue {
  field: string;
  message: string;
}

/** Wire draft → Convex draft input; unknown ids become issues. */
export function wireToDraftInput(w: VoucherDraftWire): { input: VoucherDraftArgs; issues: WireIssue[] } {
  const issues: WireIssue[] = [];
  const contact = w.supplier_contact_id ? decodeId("contacts", w.supplier_contact_id) : null;
  if (w.supplier_contact_id && !contact)
    issues.push({ field: "supplier_contact_id", message: "Unbekannte Kontakt-ID." });
  const creditOf = w.credit_note_of_id ? decodeId("vouchers", w.credit_note_of_id) : null;
  if (w.credit_note_of_id && !creditOf) issues.push({ field: "credit_note_of_id", message: "Unbekannte Beleg-ID." });
  const input: VoucherDraftArgs = {
    ...(w.direction ? { direction: w.direction } : {}),
    ...(w.kind ? { kind: w.kind } : {}),
    ...(contact ? { supplierContactId: contact } : {}),
    ...(w.supplier_name !== undefined ? { supplierName: w.supplier_name } : {}),
    ...(w.supplier_vat_id !== undefined ? { supplierVatId: w.supplier_vat_id } : {}),
    ...(w.supplier_tax_number !== undefined ? { supplierTaxNumber: w.supplier_tax_number } : {}),
    ...(w.supplier_address !== undefined ? { supplierAddress: w.supplier_address } : {}),
    ...(w.supplier_iban !== undefined ? { supplierIban: w.supplier_iban } : {}),
    ...(w.document_number !== undefined ? { documentNumber: w.document_number } : {}),
    ...(w.document_date ? { documentDate: w.document_date } : {}),
    ...(w.supply_date ? { supplyDate: w.supply_date } : {}),
    ...(w.due_date ? { dueDate: w.due_date } : {}),
    ...(w.currency ? { currency: w.currency } : {}),
    ...(w.fx_rate ? { fxRateToEur: { rate: w.fx_rate.rate, source: w.fx_rate.source, date: w.fx_rate.date } } : {}),
    ...(w.price_mode ? { priceMode: w.price_mode } : {}),
    ...(w.tax_rule ? { taxRule: w.tax_rule } : {}),
    ...(w.lines
      ? {
          lines: w.lines.map((l) => ({
            account: l.account,
            ...(l.description !== undefined ? { description: l.description } : {}),
            ...(l.quantity_milli !== undefined ? { quantityMilli: l.quantity_milli } : {}),
            amountCents: l.amount_cents,
            vatRateBp: l.vat_rate_bp,
            ...(l.vat_cents !== undefined ? { vatCents: l.vat_cents } : {}),
            ...(l.non_deductible_share_bp !== undefined ? { nonDeductibleShareBp: l.non_deductible_share_bp } : {}),
            ...(l.asset_decision ? { assetDecision: l.asset_decision } : {}),
          })),
        }
      : {}),
    ...(w.stated_gross_cents !== undefined ? { statedTotals: { grossCents: w.stated_gross_cents } } : {}),
    ...(w.tax_payment ? { taxPayment: w.tax_payment } : {}),
    ...(creditOf ? { creditNoteOfId: creditOf } : {}),
    ...(w.internal_note !== undefined ? { internalNote: w.internal_note } : {}),
  };
  return { input, issues };
}

export const voucherPaymentWire = z
  .object({
    method: z.enum(["bank", "card_pending", "cash", "private"]).meta({
      description:
        "bank = Zahlung per Bank folgt (Standard), card_pending = Bankumsatz folgt, cash = bar, private = privat",
    }),
    date: isoDate.optional().meta({ description: "Zahlungsdatum (Standard: Belegdatum)" }),
    amount_cents: z.number().int().min(1).optional().meta({ description: "Standard: offener Betrag" }),
    backdate_reason: z.string().max(500).optional().meta({ description: "Pflicht bei Barzahlung > 10 Tage zurück" }),
    note: z.string().max(500).optional(),
  })
  .strict();

export const voucherFinalizeWire = z
  .object({
    version: z.number().int().min(1).optional(),
    acknowledge_warnings: z.array(z.string().max(60)).max(20).optional(),
    payment: voucherPaymentWire.optional(),
  })
  .strict();
export type VoucherFinalizeWire = z.infer<typeof voucherFinalizeWire>;

/** Exactly the arguments of `vouchers.finalize` (without `confirmToken`) — REST, MCP tool and preview plan. */
export function voucherFinalizeArgs(rawId: string, w: VoucherFinalizeWire): Record<string, unknown> {
  return {
    id: rawId,
    ...(w.version !== undefined ? { version: w.version } : {}),
    ...(w.acknowledge_warnings?.length ? { acknowledgeWarnings: [...w.acknowledge_warnings] } : {}),
    ...(w.payment
      ? {
          payment: {
            method: w.payment.method,
            ...(w.payment.date ? { date: w.payment.date } : {}),
            ...(w.payment.amount_cents !== undefined ? { amountCents: w.payment.amount_cents } : {}),
            ...(w.payment.backdate_reason ? { backdateReason: w.payment.backdate_reason } : {}),
            ...(w.payment.note ? { note: w.payment.note } : {}),
          },
        }
      : {}),
  };
}

export const voucherLaterPaymentWire = z
  .object({
    method: z.enum(["bank", "cash", "private"]),
    transaction_id: prefixedId("bankTransactions").optional().meta({ description: "Pflicht bei method bank" }),
    date: isoDate.optional(),
    amount_cents: z.number().int().min(1).optional(),
    backdate_reason: z.string().max(500).optional(),
    note: z.string().max(500).optional(),
    differences: z
      .array(
        z
          .object({
            reason: z.enum(["skonto", "bank_fees", "other"]),
            amount_cents: z.number().int(),
            account: z.string().max(10).optional(),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    acknowledge_warnings: z.array(z.string().max(60)).max(20).optional(),
  })
  .strict();

export function voucherPaymentArgs(rawId: string, w: z.infer<typeof voucherLaterPaymentWire>) {
  const tx = w.transaction_id ? decodeId("bankTransactions", w.transaction_id) : null;
  return {
    id: rawId,
    method: w.method,
    ...(tx ? { transactionId: tx } : {}),
    ...(w.date ? { date: w.date } : {}),
    ...(w.amount_cents !== undefined ? { amountCents: w.amount_cents } : {}),
    ...(w.backdate_reason ? { backdateReason: w.backdate_reason } : {}),
    ...(w.note ? { note: w.note } : {}),
    ...(w.differences?.length
      ? {
          differences: w.differences.map((d) => ({
            reason: d.reason,
            amountCents: d.amount_cents,
            ...(d.account ? { account: d.account } : {}),
          })),
        }
      : {}),
    ...(w.acknowledge_warnings?.length ? { acknowledgeWarnings: [...w.acknowledge_warnings] } : {}),
  };
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────────

export const voucherOut = z
  .object({
    id: z.string(),
    status: z.string(),
    status_label: z.string(),
    direction: z.string(),
    kind: z.string(),
    internal_number: z.string().nullable(),
    document_number: z.string().nullable(),
    supplier_name: z.string().nullable(),
    supplier_contact_id: z.string().nullable(),
    document_date: z.string().nullable(),
    due_date: z.string().nullable(),
    currency: z.string(),
    price_mode: z.string(),
    tax_rule: z.string(),
    totals: z.object({ net_cents: z.number(), vat_cents: z.number(), gross_cents: z.number() }),
    open_amount_cents: z.number(),
    version: z.number(),
    lines: z.array(z.record(z.string(), z.unknown())).optional(),
    files: z.array(z.record(z.string(), z.unknown())).optional(),
    payments: z.array(z.record(z.string(), z.unknown())).optional(),
    check: z.record(z.string(), z.unknown()).nullable().optional(),
    booked_at: z.string().nullable(),
    recorded_at: z.string(),
  })
  .meta({ id: "Voucher" });

export const voucherRowOut = z
  .object({
    id: z.string(),
    status: z.string(),
    status_label: z.string(),
    direction: z.string(),
    kind: z.string(),
    internal_number: z.string().nullable(),
    document_number: z.string().nullable(),
    supplier_name: z.string().nullable(),
    document_date: z.string().nullable(),
    due_date: z.string().nullable(),
    currency: z.string(),
    gross_cents: z.number(),
    open_amount_cents: z.number(),
    tax_rule: z.string(),
    received_at: z.string(),
  })
  .meta({ id: "VoucherRow" });

export const voucherList = listEnvelope(voucherRowOut, "VoucherList");

export interface VoucherListRecord {
  _id: string;
  status: string;
  statusLabel: string;
  direction: string;
  kind: string;
  internalNumber: string | null;
  documentNumber: string | null;
  supplierName: string | null;
  documentDate: string | null;
  dueDate: string | null;
  currency: string;
  grossCents: number;
  openAmountCents: number;
  taxRule: string;
  receivedAt: number;
}

export function serializeVoucherRow(r: VoucherListRecord) {
  return {
    id: encodeId("vouchers", r._id),
    status: r.status,
    status_label: r.statusLabel,
    direction: r.direction,
    kind: r.kind,
    internal_number: r.internalNumber,
    document_number: r.documentNumber,
    supplier_name: r.supplierName,
    document_date: r.documentDate,
    due_date: r.dueDate,
    currency: r.currency,
    gross_cents: r.grossCents,
    open_amount_cents: r.openAmountCents,
    tax_rule: r.taxRule,
    received_at: toInstant(r.receivedAt),
  };
}

export interface VoucherDetailRecord {
  voucher: {
    _id: string;
    status: string;
    statusLabel: string;
    direction: string;
    kind: string;
    internalNumber?: string;
    documentNumber?: string;
    supplierName?: string;
    supplierContactId?: string;
    documentDate?: string;
    dueDate?: string;
    currency: string;
    priceMode: string;
    taxRule: string;
    totals: { netCents: number; vatCents: number; grossCents: number };
    openAmountCents: number;
    version: number;
    bookedAt?: number;
    recordedAt: number;
  };
  lines: {
    position: number;
    account: string;
    description?: string;
    netCents: number;
    vatRateBp: number;
    vatCents: number;
    grossCents: number;
    selfAssessedVatCents?: number;
  }[];
  files: { index: number; name: string; mime: string; bytes: number; sha256: string; replacedBy: number | null }[];
  payments: { id: string; date: string; amountCents: number; source: string; reversed: boolean }[];
  check: Record<string, unknown> | null;
}

export function serializeVoucher(d: VoucherDetailRecord) {
  const v = d.voucher;
  return {
    id: encodeId("vouchers", v._id),
    status: v.status,
    status_label: v.statusLabel,
    direction: v.direction,
    kind: v.kind,
    internal_number: v.internalNumber ?? null,
    document_number: v.documentNumber ?? null,
    supplier_name: v.supplierName ?? null,
    supplier_contact_id: encodeOptionalId("contacts", v.supplierContactId),
    document_date: v.documentDate ?? null,
    due_date: v.dueDate ?? null,
    currency: v.currency,
    price_mode: v.priceMode,
    tax_rule: v.taxRule,
    totals: { net_cents: v.totals.netCents, vat_cents: v.totals.vatCents, gross_cents: v.totals.grossCents },
    open_amount_cents: v.openAmountCents,
    version: v.version,
    lines: d.lines.map((l) => ({
      position: l.position,
      account: l.account,
      description: l.description ?? null,
      net_cents: l.netCents,
      vat_rate_bp: l.vatRateBp,
      vat_cents: l.vatCents,
      gross_cents: l.grossCents,
      self_assessed_vat_cents: l.selfAssessedVatCents ?? 0,
    })),
    files: d.files.map((f) => ({
      index: f.index,
      name: f.name,
      mime: f.mime,
      bytes: f.bytes,
      sha256: f.sha256,
      replaced_by: f.replacedBy,
    })),
    payments: d.payments.map((p) => ({
      id: encodeId("payments", p.id),
      date: p.date,
      amount_cents: p.amountCents,
      source: p.source,
      reversed: p.reversed,
    })),
    check: d.check,
    booked_at: toOptionalInstant(v.bookedAt),
    recorded_at: toInstant(v.recordedAt),
  };
}

// ── recurring vouchers (VOU-064/065, `/recurring-vouchers`) ─────────────────────────────────────────────

export const RECURRING_VOUCHER_INTERVALS = [
  "P1W",
  "P2W",
  "P1M",
  "P2M",
  "P3M",
  "P6M",
  "P1Y",
  "P2Y",
  "P3Y",
  "P4Y",
  "P5Y",
] as const;

export const recurringVoucherTemplateWire = z
  .object({
    direction: z.enum(["expense", "income"]).default("expense"),
    kind: z.enum(["standard", "bewirtung", "eigenbeleg", "asset", "tax_payment", "private"]).default("standard"),
    supplier_contact_id: prefixedId("contacts").optional(),
    supplier_name: z.string().max(200).optional(),
    supplier_vat_id: z.string().max(20).optional(),
    document_number: z.string().max(100).optional().meta({ description: "Vertrags- oder Kundennummer" }),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("EUR"),
    price_mode: z.enum(["net", "gross"]).default("gross"),
    tax_rule: z.enum(VOUCHER_TAX_RULES),
    lines: z.array(voucherLineWire).min(1).max(50),
    internal_note: z.string().max(2000).optional(),
  })
  .strict();

export const recurringVoucherWire = z
  .object({
    name: z.string().min(1).max(200),
    template: recurringVoucherTemplateWire,
    interval: z.enum(RECURRING_VOUCHER_INTERVALS),
    first_date: isoDate,
    end_date: isoDate.optional(),
    create_as: z.enum(["open", "draft"]).default("draft").meta({
      description: "open bucht nur, wenn die Prüfung ohne Fehler und Warnungen ist; sonst entsteht ein Entwurf",
    }),
    expected_mandate_ref: z.string().max(100).optional(),
    expected_iban: z.string().max(40).optional(),
    recurring_payment: z.boolean().optional(),
  })
  .strict();

export const recurringVoucherPatchWire = z
  .object({
    name: z.string().min(1).max(200).optional(),
    template: recurringVoucherTemplateWire.optional(),
    interval: z.enum(RECURRING_VOUCHER_INTERVALS).optional(),
    first_date: isoDate.optional(),
    end_date: isoDate.optional(),
    create_as: z.enum(["open", "draft"]).optional(),
    expected_mandate_ref: z.string().max(100).optional(),
    expected_iban: z.string().max(40).optional(),
    recurring_payment: z.boolean().optional(),
    active: z.boolean().optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();

type TemplateWire = z.infer<typeof recurringVoucherTemplateWire>;

function templateArgs(t: TemplateWire, issues: WireIssue[]) {
  const contact = t.supplier_contact_id ? decodeId("contacts", t.supplier_contact_id) : null;
  if (t.supplier_contact_id && !contact) {
    issues.push({ field: "template.supplier_contact_id", message: "Unbekannte Kontakt-ID." });
  }
  const { input } = wireToDraftInput({ lines: t.lines });
  return {
    direction: t.direction,
    kind: t.kind,
    ...(contact ? { supplierContactId: contact } : {}),
    ...(t.supplier_name !== undefined ? { supplierName: t.supplier_name } : {}),
    ...(t.supplier_vat_id !== undefined ? { supplierVatId: t.supplier_vat_id } : {}),
    ...(t.document_number !== undefined ? { documentNumber: t.document_number } : {}),
    currency: t.currency,
    priceMode: t.price_mode,
    taxRule: t.tax_rule,
    lines: input.lines,
    ...(t.internal_note !== undefined ? { internalNote: t.internal_note } : {}),
  };
}

type RecurringWireInput = Omit<z.infer<typeof recurringVoucherPatchWire>, "version">;

/** Wire → `vouchers.createRecurring` / `updateRecurring.patch` arguments. */
export function recurringVoucherArgs(w: RecurringWireInput): { args: Record<string, unknown>; issues: WireIssue[] } {
  const issues: WireIssue[] = [];
  const args: Record<string, unknown> = {
    ...(w.name !== undefined ? { name: w.name } : {}),
    ...(w.template ? { template: templateArgs(w.template, issues) } : {}),
    ...(w.interval ? { interval: w.interval } : {}),
    ...(w.first_date ? { firstDate: w.first_date } : {}),
    ...(w.end_date ? { endDate: w.end_date } : {}),
    ...(w.create_as ? { createAs: w.create_as } : {}),
    ...(w.expected_mandate_ref !== undefined ? { expectedMandateRef: w.expected_mandate_ref } : {}),
    ...(w.expected_iban !== undefined ? { expectedIban: w.expected_iban } : {}),
    ...(w.recurring_payment !== undefined ? { recurringPayment: w.recurring_payment } : {}),
    ...(w.active !== undefined ? { active: w.active } : {}),
  };
  return { args, issues };
}

export interface RecurringVoucherRecord {
  _id: string;
  name: string;
  interval: string;
  firstDate: string;
  nextDate: string;
  endDate?: string;
  active: boolean;
  createAs: string;
  template: {
    direction: string;
    kind: string;
    supplierName?: string;
    currency: string;
    priceMode: string;
    taxRule: string;
    lines: { account: string; description?: string; amountCents: number; vatRateBp: number }[];
  };
  lastGeneratedIds: string[];
  upcoming?: string[];
  version: number;
}

export const recurringVoucherOut = z
  .object({
    id: z.string(),
    name: z.string(),
    interval: z.string(),
    first_date: z.string(),
    next_date: z.string(),
    end_date: z.string().nullable(),
    active: z.boolean(),
    create_as: z.string(),
    supplier_name: z.string().nullable(),
    tax_rule: z.string(),
    currency: z.string(),
    price_mode: z.string(),
    lines: z.array(z.record(z.string(), z.unknown())),
    upcoming: z.array(z.string()),
    last_generated_ids: z.array(z.string()),
    version: z.number(),
  })
  .meta({ id: "RecurringVoucher" });

export function serializeRecurringVoucher(r: RecurringVoucherRecord) {
  return {
    id: encodeId("recurringVouchers", r._id),
    name: r.name,
    interval: r.interval,
    first_date: r.firstDate,
    next_date: r.nextDate,
    end_date: r.endDate ?? null,
    active: r.active,
    create_as: r.createAs,
    supplier_name: r.template.supplierName ?? null,
    tax_rule: r.template.taxRule,
    currency: r.template.currency,
    price_mode: r.template.priceMode,
    lines: r.template.lines.map((l) => ({
      account: l.account,
      description: l.description ?? null,
      amount_cents: l.amountCents,
      vat_rate_bp: l.vatRateBp,
    })),
    upcoming: r.upcoming ?? [],
    last_generated_ids: r.lastGeneratedIds.map((id) => encodeId("vouchers", id)),
    version: r.version,
  };
}

export const duplicateResolutionWire = z
  .object({
    is_duplicate: z
      .boolean()
      .meta({ description: "true: der Entwurf wird gelöscht (Löschung mit Inhalt protokolliert)" }),
    of_id: prefixedId("vouchers"),
  })
  .strict();
