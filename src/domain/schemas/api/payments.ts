import { z } from "zod";
import type {} from "zod-openapi";
import { decodeId, encodeId } from "../../api/ids";
import { DIFFERENCE_REASONS, WRITE_OFF_REASONS } from "../../payments/plan";
import { instant, isoDate, prefixedId, toInstant } from "./common";

/**
 * Wire schemas of the payment, open-item, matching and cash endpoints (05 §4.4, §4.6) and the MCP tools
 * `payment_record`, `payment_reverse`, `bank_match_confirm`, `bank_transaction_mark`, `cash_transfer_record`
 * (06 §3.5, §3.7). One mapping wire → Convex arguments is shared by REST, the MCP tool and its `preview_action`, so
 * the confirm token's params hash is computed over identical arguments (06 §2.3).
 */

const cents = (description: string) => z.number().int().meta({ description, example: 119000 });

export const differenceWire = z
  .object({
    reason: z.enum(DIFFERENCE_REASONS),
    amount_cents: cents("+ = Minderung (Skonto, Gebühren, Ausfall); − = Mehrbetrag (Mahngebühren, Zinsen)"),
    sub_reason: z.enum(WRITE_OFF_REASONS).optional(),
    account: z.string().max(20).optional().meta({ description: "Nur „other“: Buchungskonto" }),
    text: z.string().max(500).optional().meta({ description: "Nur „other“: Grund (mind. 5 Zeichen)" }),
    with_vat: z.boolean().optional().meta({ description: "Nur „other“: Preisminderung mit USt-Korrektur (Standard)" }),
  })
  .strict()
  .meta({ id: "PaymentDifference" });

export const paymentSourceWire = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("bank"), transaction_id: prefixedId("bankTransactions") }).strict(),
    z.object({ kind: z.literal("clearing"), account_id: prefixedId("bankAccounts") }).strict(),
    z.object({ kind: z.literal("cash") }).strict(),
  ])
  .meta({ id: "PaymentSource", description: "bank = gebuchter Bankumsatz, clearing = Konto ohne Umsatz, cash = bar" });

export const acknowledgeWarnings = z
  .array(z.string().max(60))
  .max(10)
  .optional()
  .meta({ description: "Codes der ⚑-Hinweise, die bestätigt werden (z. B. cash_daily_recording)" });

export const invoicePaymentWire = z
  .object({
    date: isoDate,
    amount_cents: cents("Gezahlter Betrag in Cent (> 0)"),
    source: paymentSourceWire,
    differences: z.array(differenceWire).max(5).optional(),
    excess: z
      .object({ mode: z.enum(["credit", "unallocated"]) })
      .strict()
      .optional()
      .meta({ description: "Mehrbetrag: Guthaben des Kunden oder (nur Bank) nicht zugeordnet lassen (PAY-030)" }),
    backdate_reason: z.string().max(500).optional(),
    note: z.string().max(500).optional(),
    acknowledge_warnings: acknowledgeWarnings,
  })
  .strict()
  .meta({ id: "InvoicePaymentRequest" });
export type InvoicePaymentWire = z.infer<typeof invoicePaymentWire>;

const targetWire = z
  .object({
    kind: z.enum(["invoice", "opening_item", "credit"]),
    id: z
      .string()
      .meta({ description: "inv_… (Rechnung), opi_… (offener Posten der Eröffnungsbilanz), con_… (Guthaben)" }),
  })
  .strict();

export const combinedPaymentWire = z
  .object({
    source: paymentSourceWire,
    date: isoDate,
    allocations: z
      .array(
        z
          .object({
            target: targetWire,
            amount_cents: cents("Betrag dieser Zuordnung"),
            differences: z.array(differenceWire).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    backdate_reason: z.string().max(500).optional(),
    note: z.string().max(500).optional(),
    acknowledge_warnings: acknowledgeWarnings,
  })
  .strict()
  .meta({ id: "PaymentRequest" });
export type CombinedPaymentWire = z.infer<typeof combinedPaymentWire>;

export const reverseWire = z
  .object({ reason: z.string().min(5).max(500).meta({ description: "Grund (mind. 5 Zeichen)" }) })
  .strict()
  .meta({ id: "PaymentReverseRequest" });

// ── wire → Convex ──────────────────────────────────────────────────────────────────────────────────────

type ConvexSource =
  | { kind: "bank"; transactionId: string }
  | { kind: "clearing"; accountId: string }
  | { kind: "cash" };

export function sourceArgs(s: z.infer<typeof paymentSourceWire>): ConvexSource | null {
  if (s.kind === "cash") return { kind: "cash" };
  if (s.kind === "bank") {
    const id = decodeId("bankTransactions", s.transaction_id);
    return id ? { kind: "bank", transactionId: id } : null;
  }
  const id = decodeId("bankAccounts", s.account_id);
  return id ? { kind: "clearing", accountId: id } : null;
}

export function differenceArgs(d: z.infer<typeof differenceWire>) {
  return {
    reason: d.reason,
    amountCents: d.amount_cents,
    ...(d.sub_reason ? { subReason: d.sub_reason } : {}),
    ...(d.account ? { account: d.account } : {}),
    ...(d.text ? { text: d.text } : {}),
    ...(d.with_vat !== undefined ? { withVat: d.with_vat } : {}),
  };
}

/** `POST /invoices/{id}/payments` → `payments.recordForInvoice` arguments (without `confirmToken`). */
export function invoicePaymentArgs(invoiceId: string, w: InvoicePaymentWire) {
  const documentId = decodeId("invoices", invoiceId);
  const source = sourceArgs(w.source);
  if (!documentId || !source) return null;
  return {
    documentId,
    source,
    date: w.date,
    amountCents: w.amount_cents,
    ...(w.differences?.length ? { differences: w.differences.map(differenceArgs) } : {}),
    ...(w.excess ? { excess: { mode: w.excess.mode } } : {}),
    ...(w.backdate_reason ? { backdateReason: w.backdate_reason } : {}),
    ...(w.note ? { note: w.note } : {}),
    ...(w.acknowledge_warnings?.length ? { acknowledgeWarnings: w.acknowledge_warnings } : {}),
  };
}

function targetArgs(t: z.infer<typeof targetWire>) {
  const id =
    t.kind === "invoice"
      ? decodeId("invoices", t.id)
      : t.kind === "opening_item"
        ? decodeId("openingItems", t.id)
        : decodeId("contacts", t.id);
  if (!id) return null;
  const kind = t.kind === "invoice" ? "salesDocument" : t.kind === "credit" ? "contactCredit" : "opening_item";
  return { kind: kind as "salesDocument" | "opening_item" | "contactCredit", id };
}

/** `POST /payments` / MCP `payment_record` → `payments.record` arguments (without `confirmToken`). */
export function combinedPaymentArgs(w: CombinedPaymentWire) {
  const source = sourceArgs(w.source);
  if (!source) return null;
  const allocations = [];
  for (const a of w.allocations) {
    const target = targetArgs(a.target);
    if (!target) return null;
    allocations.push({
      target,
      amountCents: a.amount_cents,
      ...(a.differences?.length ? { differences: a.differences.map(differenceArgs) } : {}),
    });
  }
  return {
    source,
    date: w.date,
    allocations,
    ...(w.backdate_reason ? { backdateReason: w.backdate_reason } : {}),
    ...(w.note ? { note: w.note } : {}),
    ...(w.acknowledge_warnings?.length ? { acknowledgeWarnings: w.acknowledge_warnings } : {}),
  };
}

// ── Convex → wire ──────────────────────────────────────────────────────────────────────────────────────

export const paymentOut = z
  .object({
    id: z.string().meta({ description: "pay_…" }),
    target: z.object({
      kind: z.enum(["invoice", "opening_item", "credit", "correction"]).meta({
        description: "correction = Erstattung einer Rechnungskorrektur (negativer Betrag, PAY-033)",
      }),
      id: z.string(),
    }),
    number: z.string().nullable(),
    contact_id: z.string().nullable(),
    date: isoDate,
    amount_cents: z.number().int(),
    settles_cents: z.number().int().meta({ description: "Betrag + Differenzen (Minderung des offenen Betrags)" }),
    currency: z.string(),
    source: z.object({
      kind: z.enum(["bank", "clearing", "cash", "credit", "adjustment"]),
      transaction_id: z.string().nullable(),
    }),
    differences: z.array(
      z.object({
        reason: z.string(),
        amount_cents: z.number().int(),
        sub_reason: z.string().nullable(),
        vat_correction: z.array(z.object({ rate_bp: z.number(), net_cents: z.number(), vat_cents: z.number() })),
      }),
    ),
    allocation_group_id: z.string().nullable(),
    reversal_of_id: z.string().nullable(),
    reversed_by_id: z.string().nullable(),
    reason: z.string().nullable(),
    note: z.string().nullable(),
    backdate_reason: z.string().nullable(),
    reconciled_transaction_id: z.string().nullable(),
    match: z.object({ score: z.number(), reasons: z.array(z.string()), auto: z.boolean() }).nullable(),
    receipt_sha256: z.string().nullable(),
    recorded_at: instant,
  })
  .meta({ id: "Payment" });
export type PaymentOut = z.infer<typeof paymentOut>;

export interface PaymentViewLike {
  id: string;
  target: { kind: string; id: string };
  /** Type of the target sales document (a `correction` is encoded `cor_…`). */
  targetType?: string | null;
  number: string | null;
  contactId: string | null;
  date: string;
  amountCents: number;
  settlesCents: number;
  currency: string;
  source: string;
  bankTransactionId: string | null;
  differences: readonly {
    reason: string;
    amountCents: number;
    subReason?: string;
    vatCorrection?: readonly { rateBp: number; netCents: number; vatCents: number }[];
  }[];
  allocationGroupId: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  reason: string | null;
  note: string | null;
  backdateReason: string | null;
  reconciledTransactionId: string | null;
  match: { score: number; reasons: string[]; auto: boolean } | null;
  receipt: { sha256: string } | null;
  recordedAt: number;
}

const wireTarget = (t: { kind: string; id: string }, targetType?: string | null) =>
  t.kind === "salesDocument" && targetType === "correction"
    ? { kind: "correction" as const, id: encodeId("corrections", t.id) }
    : t.kind === "salesDocument"
      ? { kind: "invoice" as const, id: encodeId("invoices", t.id) }
      : t.kind === "opening_item"
        ? { kind: "opening_item" as const, id: encodeId("openingItems", t.id) }
        : { kind: "credit" as const, id: encodeId("contacts", t.id) };

const opt = (table: Parameters<typeof encodeId>[0], id: string | null) => (id ? encodeId(table, id) : null);

export function serializePayment(p: PaymentViewLike): PaymentOut {
  return {
    id: encodeId("payments", p.id),
    target: wireTarget(p.target, p.targetType),
    number: p.number,
    contact_id: opt("contacts", p.contactId),
    date: p.date,
    amount_cents: p.amountCents,
    settles_cents: p.settlesCents,
    currency: p.currency,
    source: {
      kind: p.source as PaymentOut["source"]["kind"],
      transaction_id: opt("bankTransactions", p.bankTransactionId),
    },
    differences: p.differences.map((d) => ({
      reason: d.reason,
      amount_cents: d.amountCents,
      sub_reason: d.subReason ?? null,
      vat_correction: (d.vatCorrection ?? []).map((c) => ({
        rate_bp: c.rateBp,
        net_cents: c.netCents,
        vat_cents: c.vatCents,
      })),
    })),
    allocation_group_id: p.allocationGroupId,
    reversal_of_id: opt("payments", p.reversalOfId),
    reversed_by_id: opt("payments", p.reversedById),
    reason: p.reason,
    note: p.note,
    backdate_reason: p.backdateReason,
    reconciled_transaction_id: opt("bankTransactions", p.reconciledTransactionId),
    match: p.match ? { score: p.match.score, reasons: [...p.match.reasons], auto: p.match.auto } : null,
    receipt_sha256: p.receipt?.sha256 ?? null,
    recorded_at: toInstant(p.recordedAt),
  };
}

export const openItemOut = z
  .object({
    id: z.string(),
    kind: z.enum(["invoice", "opening_item", "correction"]).meta({
      description: "correction = Rechnungskorrektur mit offener Erstattung (negativer offener Betrag, PAY-033)",
    }),
    number: z.string(),
    contact_id: z.string().nullable(),
    contact_name: z.string(),
    document_date: isoDate,
    due_date: isoDate.nullable(),
    payable_cents: z.number().int(),
    paid_cents: z.number().int(),
    open_cents: z.number().int(),
    days_overdue: z.number().int(),
    is_overdue: z.boolean(),
    bucket: z.string(),
  })
  .meta({ id: "OpenItem" });

export interface OpenItemLike {
  id: string;
  kind: "salesDocument" | "opening_item";
  docType?: string;
  number: string;
  contactId?: string;
  contactName: string;
  documentDate: string;
  dueDate?: string;
  payableCents: number;
  paidCents: number;
  openCents: number;
  daysOverdue: number;
  overdue: boolean;
  bucket: string;
}

export function serializeOpenItem(i: OpenItemLike): z.infer<typeof openItemOut> {
  return {
    id:
      i.kind === "opening_item"
        ? encodeId("openingItems", i.id)
        : encodeId(i.docType === "correction" ? "corrections" : "invoices", i.id),
    kind: i.kind === "opening_item" ? "opening_item" : i.docType === "correction" ? "correction" : "invoice",
    number: i.number,
    contact_id: i.contactId ? encodeId("contacts", i.contactId) : null,
    contact_name: i.contactName,
    document_date: i.documentDate,
    due_date: i.dueDate ?? null,
    payable_cents: i.payableCents,
    paid_cents: i.paidCents,
    open_cents: i.openCents,
    days_overdue: i.daysOverdue,
    is_overdue: i.overdue,
    bucket: i.bucket,
  };
}

export const openItemsOut = z
  .object({
    as_of: isoDate,
    data: z.array(openItemOut),
    credits: z.array(z.object({ contact_id: z.string(), contact_name: z.string(), balance_cents: z.number().int() })),
    totals: z.object({
      open_cents: z.number().int(),
      overdue_cents: z.number().int(),
      due_within_7_cents: z.number().int(),
      credit_cents: z.number().int(),
      buckets: z.array(
        z.object({ key: z.string(), label: z.string(), open_cents: z.number().int(), count: z.number() }),
      ),
    }),
  })
  .meta({ id: "OpenItems" });

export function serializeOpenItems(r: {
  asOf: string;
  items: readonly OpenItemLike[];
  credits: readonly { contactId: string; contactName: string; balanceCents: number }[];
  totals: {
    openCents: number;
    overdueCents: number;
    dueWithin7Cents: number;
    creditCents: number;
    buckets: readonly { key: string; label: string; openCents: number; count: number }[];
  };
}): z.infer<typeof openItemsOut> {
  return {
    as_of: r.asOf,
    data: r.items.map(serializeOpenItem),
    credits: r.credits.map((c) => ({
      contact_id: encodeId("contacts", c.contactId),
      contact_name: c.contactName,
      balance_cents: c.balanceCents,
    })),
    totals: {
      open_cents: r.totals.openCents,
      overdue_cents: r.totals.overdueCents,
      due_within_7_cents: r.totals.dueWithin7Cents,
      credit_cents: r.totals.creditCents,
      buckets: r.totals.buckets.map((b) => ({ key: b.key, label: b.label, open_cents: b.openCents, count: b.count })),
    },
  };
}

// ── bank matching (05 §4.6) ────────────────────────────────────────────────────────────────────────────

export const matchWire = z
  .object({
    targets: z
      .array(
        z
          .object({
            kind: z.enum(["invoice", "opening_item", "credit", "payment", "correction"]).meta({
              description:
                "invoice (Eingang), opening_item, credit (Guthaben, id = con_…), payment (vorhandene Kontozahlung), correction (Ausgang: Erstattung einer Rechnungskorrektur cor_…, PAY-033)",
            }),
            id: z.string(),
            amount_cents: cents("Zugeordneter Betrag"),
            differences: z.array(differenceWire).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    remainder: z
      .enum(["credit", "unallocated"])
      .optional()
      .meta({ description: "Restbetrag eines Eingangs (PAY-030)" }),
    acknowledge_warnings: acknowledgeWarnings,
  })
  .strict()
  .meta({ id: "BankMatchRequest" });
export type MatchWire = z.infer<typeof matchWire>;

/** `POST /bank-transactions/{id}/match` / MCP `bank_match_confirm` → `matching.confirm` arguments. */
export function matchArgs(transactionId: string, w: MatchWire) {
  const tx = decodeId("bankTransactions", transactionId);
  if (!tx) return null;
  const allocations = [];
  for (const t of w.targets) {
    const id =
      t.kind === "invoice"
        ? decodeId("invoices", t.id)
        : t.kind === "correction"
          ? decodeId("corrections", t.id)
          : t.kind === "opening_item"
            ? decodeId("openingItems", t.id)
            : t.kind === "credit"
              ? decodeId("contacts", t.id)
              : decodeId("payments", t.id);
    if (!id) return null;
    const kind =
      t.kind === "invoice" || t.kind === "correction"
        ? "salesDocument"
        : t.kind === "credit"
          ? "contactCredit"
          : t.kind === "payment"
            ? "payment"
            : "opening_item";
    allocations.push({
      target: { kind, id },
      amountCents: t.amount_cents,
      ...(t.differences?.length ? { differences: t.differences.map(differenceArgs) } : {}),
    });
  }
  return {
    transactionId: tx,
    allocations,
    ...(w.remainder ? { remainder: w.remainder } : {}),
    ...(w.acknowledge_warnings?.length ? { acknowledgeWarnings: w.acknowledge_warnings } : {}),
  };
}

/** Candidate target (Convex) → wire. */
/** Convex match target → wire target; a sales document of type `correction` is a `cor_…` refund target (PAY-033 b). */
export function wireMatchTarget(t: { kind: string; id: string }, docType?: string | null) {
  switch (t.kind) {
    case "salesDocument":
      return docType === "correction"
        ? { kind: "correction", id: encodeId("corrections", t.id) }
        : { kind: "invoice", id: encodeId("invoices", t.id) };
    case "opening_item":
      return { kind: "opening_item", id: encodeId("openingItems", t.id) };
    case "contactCredit":
      return { kind: "credit", id: encodeId("contacts", t.id) };
    case "payment":
      return { kind: "payment", id: encodeId("payments", t.id) };
    default:
      return { kind: t.kind, id: t.id };
  }
}

// ── cash transfers and bank marks (05 §4.6) ────────────────────────────────────────────────────────────

export const cashTransferWire = z
  .object({
    kind: z.enum(["deposit_to_bank", "private_withdrawal"]),
    date: isoDate,
    amount_cents: cents("Betrag in Cent (> 0)"),
    bank_account_id: prefixedId("bankAccounts").optional(),
    note: z.string().max(500).optional(),
    backdate_reason: z.string().max(500).optional(),
    shareholder: z
      .object({ name: z.string().max(200), note: z.string().max(500) })
      .strict()
      .optional(),
  })
  .strict()
  .meta({ id: "CashTransferRequest" });
export type CashTransferWire = z.infer<typeof cashTransferWire>;

export function cashTransferArgs(w: CashTransferWire) {
  const bankAccountId = w.bank_account_id ? decodeId("bankAccounts", w.bank_account_id) : undefined;
  if (bankAccountId === null) return null;
  return {
    kind: w.kind,
    date: w.date,
    amountCents: w.amount_cents,
    ...(bankAccountId ? { bankAccountId } : {}),
    ...(w.note ? { note: w.note } : {}),
    ...(w.backdate_reason ? { backdateReason: w.backdate_reason } : {}),
    ...(w.shareholder ? { shareholder: w.shareholder } : {}),
  };
}

export const markWire = z
  .object({
    as: z.enum(["private", "transfer", "cash_withdrawal", "ignored"]),
    reason: z.enum(["duplicate_of_file_import", "neutralised_pair", "test_or_zero"]).optional(),
    link_id: prefixedId("bankTransactions").optional(),
    shareholder: z
      .object({ name: z.string().max(200), note: z.string().max(500) })
      .strict()
      .optional(),
  })
  .strict()
  .meta({ id: "BankMarkRequest" });
export type MarkWire = z.infer<typeof markWire>;

export function markArgs(transactionId: string, w: MarkWire) {
  const tx = decodeId("bankTransactions", transactionId);
  const link = w.link_id ? decodeId("bankTransactions", w.link_id) : undefined;
  if (!tx || link === null) return null;
  return {
    transactionId: tx,
    as: w.as,
    ...(w.reason ? { reason: w.reason } : {}),
    ...(link ? { linkId: link } : {}),
    ...(w.shareholder ? { shareholder: w.shareholder } : {}),
  };
}

// ── previews and suggestions (05 §4.4 `POST /payments/preview`, §4.6 `GET /bank-transactions/{id}/suggestions`) ─

const bookingLine = z.object({
  account: z.string(),
  debit_cents: z.number().int(),
  credit_cents: z.number().int(),
});

export const paymentPreviewOut = z
  .object({
    date: isoDate,
    total_cents: z.number().int(),
    unallocated_cents: z.number().int().nullable(),
    allocations: z.array(
      z.object({
        target: z.object({ kind: z.string(), id: z.string() }),
        number: z.string().nullable(),
        amount_cents: z.number().int(),
        settles_cents: z.number().int(),
        open_after_cents: z.number().int(),
        differences: z.array(
          z.object({
            reason: z.string(),
            amount_cents: z.number().int(),
            vat_correction: z.array(z.object({ rate_bp: z.number(), net_cents: z.number(), vat_cents: z.number() })),
          }),
        ),
        booking: z.object({ status: z.string(), text: z.string().nullable(), lines: z.array(bookingLine) }),
      }),
    ),
    warnings: z.array(z.object({ code: z.string(), message: z.string(), requires_ack: z.boolean() })),
    unacknowledged: z.array(z.string()),
  })
  .meta({ id: "PaymentPreview" });

export interface PaymentPreviewLike {
  plan: {
    date: string;
    totalCents: number;
    unallocatedCents?: number;
    rows: readonly {
      target: { kind: string; id: string };
      number?: string;
      amountCents: number;
      settlesCents: number;
      openAfterCents: number;
      differences: readonly {
        reason: string;
        amountCents: number;
        vatCorrection?: readonly { rateBp: number; netCents: number; vatCents: number }[];
      }[];
    }[];
    warnings: readonly { code: string; message: string; ack: boolean }[];
  };
  postings: readonly (
    | { status: "lines"; text: string; lines: readonly { account: string; debitCents: number; creditCents: number }[] }
    | { status: "skipped" | "error"; message?: string }
  )[];
  unacknowledged: readonly { code: string }[];
}

export function serializePaymentPreview(p: PaymentPreviewLike): z.infer<typeof paymentPreviewOut> {
  return {
    date: p.plan.date,
    total_cents: p.plan.totalCents,
    unallocated_cents: p.plan.unallocatedCents ?? null,
    allocations: p.plan.rows.map((r, i) => {
      const posting = p.postings[i];
      return {
        target: wireMatchTarget(r.target),
        number: r.number ?? null,
        amount_cents: r.amountCents,
        settles_cents: r.settlesCents,
        open_after_cents: r.openAfterCents,
        differences: r.differences.map((d) => ({
          reason: d.reason,
          amount_cents: d.amountCents,
          vat_correction: (d.vatCorrection ?? []).map((c) => ({
            rate_bp: c.rateBp,
            net_cents: c.netCents,
            vat_cents: c.vatCents,
          })),
        })),
        booking:
          posting?.status === "lines"
            ? {
                status: "lines",
                text: posting.text,
                lines: posting.lines.map((l) => ({
                  account: l.account,
                  debit_cents: l.debitCents,
                  credit_cents: l.creditCents,
                })),
              }
            : { status: posting?.status ?? "skipped", text: posting?.message ?? null, lines: [] },
      };
    }),
    warnings: p.plan.warnings.map((w) => ({ code: w.code, message: w.message, requires_ack: w.ack })),
    unacknowledged: p.unacknowledged.map((w) => w.code),
  };
}

export const matchSuggestionsOut = z
  .object({
    transaction: z
      .object({
        id: z.string(),
        booking_date: isoDate,
        amount_cents: z.number().int(),
        open_cents: z.number().int(),
        currency: z.string(),
        counterparty_name: z.string().nullable(),
        purpose: z.string(),
      })
      .nullable(),
    candidates: z.array(
      z.object({
        kind: z.enum(["single", "combined", "partial"]),
        score: z.number(),
        safe: z.boolean(),
        reasons: z.array(z.string()),
        labels: z.array(z.string()),
        targets: z.array(
          z.object({
            kind: z.string(),
            id: z.string(),
            label: z.string(),
            contact_name: z.string(),
            amount_cents: z.number().int(),
            open_cents: z.number().int(),
            differences: z.array(z.object({ reason: z.string(), amount_cents: z.number().int() })),
          }),
        ),
      }),
    ),
  })
  .meta({ id: "BankMatchSuggestions" });

export interface SuggestionsLike {
  transaction: {
    id: string;
    bookingDate: string;
    amountCents: number;
    openCents: number;
    currency: string;
    counterpartyName?: string;
    purpose: string;
  } | null;
  candidates: readonly {
    kind: "single" | "combined" | "partial";
    score: number;
    safe: boolean;
    reasons: readonly string[];
    labels: readonly string[];
    allocations: readonly {
      target: { kind: string; id: string };
      amountCents: number;
      differences?: readonly { reason: string; amountCents: number }[];
      label: string;
      contactName: string;
      openCents: number;
      /** Type of a `salesDocument` target (`correction` = refund of a credit correction, encoded `cor_…`). */
      docType?: string | null;
    }[];
  }[];
}

export function serializeSuggestions(s: SuggestionsLike): z.infer<typeof matchSuggestionsOut> {
  return {
    transaction: s.transaction
      ? {
          id: encodeId("bankTransactions", s.transaction.id),
          booking_date: s.transaction.bookingDate,
          amount_cents: s.transaction.amountCents,
          open_cents: s.transaction.openCents,
          currency: s.transaction.currency,
          counterparty_name: s.transaction.counterpartyName ?? null,
          purpose: s.transaction.purpose,
        }
      : null,
    candidates: s.candidates.map((c) => ({
      kind: c.kind,
      score: c.score,
      safe: c.safe,
      reasons: [...c.reasons],
      labels: [...c.labels],
      targets: c.allocations.map((a) => ({
        ...wireMatchTarget(a.target, a.docType),
        label: a.label,
        contact_name: a.contactName,
        amount_cents: a.amountCents,
        open_cents: a.openCents,
        differences: (a.differences ?? []).map((d) => ({ reason: d.reason, amount_cents: d.amountCents })),
      })),
    })),
  };
}
