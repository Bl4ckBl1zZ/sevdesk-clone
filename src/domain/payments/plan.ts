/**
 * Payment validation and planning (F05 §4.1 step 2–3, PAY-010…PAY-063, §5.1 EC-PAY-*). Pure: the Convex model loads
 * the facts (targets, source, periods), calls `planPayment` and writes exactly the planned rows; REST/MCP previews
 * call the same function (06 §2.3 „same domain validation as the real call“).
 *
 * One planned row per allocation (03 §5). Invariant per row (RI-09): `amountCents + Σ differences.amountCents` =
 * the reduction of the target's open amount (`settlesCents`), never above the open amount — an excess is either a
 * `contactCredit` row (PAY-030 c), further documents (a), fees/interest up to the claimed amounts (b) or, for bank
 * sources only, left unallocated on the transaction (d).
 */
import { CASH_REASON_DAYS, CASH_REASON_MIN_LENGTH, CASH_WARNING_DAYS } from "../cash/dating";
import { err, type Issue, issue, ok, type Result } from "../result";
import { type CalendarDate, daysBetween, isCalendarDate } from "../time/calendar-date";
import { PAY_MESSAGES } from "./messages";
import { evaluateSkonto, type SkontoTerms, splitReceipt } from "./skonto";
import { type GrossGroup, type RateCorrection, splitDifferenceByVat } from "./split";

// ── input ───────────────────────────────────────────────────────────────────────────────────────────────

export type SourceInput =
  | { kind: "bank"; transactionId: string }
  | { kind: "clearing"; accountId: string }
  | { kind: "cash" }
  | { kind: "credit" }
  | { kind: "adjustment" }
  | { kind: "private" };

export type TargetKind = "salesDocument" | "opening_item" | "contactCredit";
export interface TargetRef {
  kind: TargetKind;
  id: string;
}

export const DIFFERENCE_REASONS = [
  "skonto",
  "bank_fees",
  "dunning_fees",
  "default_interest",
  "write_off",
  "other",
] as const;
export type DifferenceReason = (typeof DIFFERENCE_REASONS)[number];
export const WRITE_OFF_REASONS = ["insolvency", "uncollectible", "statute_barred", "waiver"] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export interface DifferenceInput {
  reason: DifferenceReason;
  /** + = settles more than the cash (underpayment accepted); − = cash exceeds the claim (fees, interest). */
  amountCents: number;
  subReason?: WriteOffReason;
  /** `other`: ledger account chosen by the owner. */
  account?: string;
  /** `other`: reason text ≥ 5 characters. */
  text?: string;
  /** `other`: „Preisminderung (mit USt-Korrektur)“ (default) or „ohne USt-Korrektur“ (PAY-027). */
  withVat?: boolean;
}

export interface AllocationInput {
  target: TargetRef;
  amountCents: number;
  differences?: DifferenceInput[];
}

export interface PaymentInput {
  source: SourceInput;
  /** Payment date; bank sources always use the transaction's booking date (PAY-010). */
  date: string;
  allocations: AllocationInput[];
  backdateReason?: string;
  note?: string;
}

// ── facts loaded by the model ───────────────────────────────────────────────────────────────────────────

export type TaxationMethod = "soll" | "ist";

export interface TargetFacts {
  ref: TargetRef;
  contactId?: string;
  number?: string;
  /** salesDocument */
  docType?: string;
  status?: string;
  paymentStatus?: string;
  currency: string;
  documentDate?: string;
  dueDate?: string;
  payableCents: number;
  openAmountCents: number;
  groups?: readonly GrossGroup[];
  skonto?: SkontoTerms | null;
  /** Method the target's VAT was recognised with (EC-PAY-17) and the one valid on the payment date. */
  taxedAs?: TaxationMethod;
  methodOnDate?: TaxationMethod;
  claimedFeesCents?: number;
  claimedInterestCents?: number;
  /** contactCredit: the current credit balance of the contact. */
  creditBalanceCents?: number;
}

export interface SourceFacts {
  kind: SourceInput["kind"];
  bank?: {
    bookingDate: string;
    amountCents: number;
    allocatedCents: number;
    currency: string;
    status: string;
  };
  clearing?: { currency: string; archived?: boolean };
  cashOpeningDate?: string;
}

export interface PlanContext {
  today: string;
  /** Locked and locking months `YYYY-MM` (ACC-006, PAY-045). */
  closedPeriods: ReadonlySet<string>;
  source: SourceFacts;
  /** keyed by `targetKey(ref)` */
  targets: ReadonlyMap<string, TargetFacts>;
  /** PAY-026: the recovery wizard records a payment on a written-off document after reversing the write-off. */
  allowWrittenOff?: boolean;
}

export const targetKey = (r: TargetRef): string => `${r.kind}:${r.id}`;

// ── output ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PlannedDifference {
  reason: DifferenceReason;
  amountCents: number;
  subReason?: WriteOffReason;
  account?: string;
  text?: string;
  vatCorrection?: RateCorrection[];
}

export interface PlannedRow {
  target: TargetRef;
  contactId?: string;
  number?: string;
  amountCents: number;
  differences: PlannedDifference[];
  settlesCents: number;
  /** Open amount of the target after this row (contactCredit: credit balance after). */
  openAfterCents: number;
}

export type PaymentWarningCode =
  | "before_document_date"
  | "bank_fees_high"
  | "cash_daily_recording"
  | "write_off_ist"
  | "taxation_method_changed";

export interface PaymentWarning {
  code: PaymentWarningCode;
  message: string;
  /** ⚑ warnings must be acknowledged (UI checkbox, API `acknowledge_warnings`). */
  ack: boolean;
}

export interface PaymentPlan {
  date: string;
  rows: PlannedRow[];
  warnings: PaymentWarning[];
  /** Money moved by the source (Σ row amounts; 0 for adjustments and credit applications). */
  totalCents: number;
  /** Bank only: what stays unallocated on the transaction after this payment. */
  unallocatedCents?: number;
}

export type PaymentErrorCode =
  | "no_allocations"
  | "duplicate_target"
  | "private_source"
  | "date_invalid"
  | "future_date"
  | "period_locked"
  | "cash_reason_required"
  | "cash_date_range"
  | "cash_eur_only"
  | "tx_not_allocatable"
  | "tx_direction"
  | "source_exceeded"
  | "target_unknown"
  | "draft"
  | "cancelled"
  | "written_off"
  | "not_payable"
  | "fx_deferred"
  | "amount_positive"
  | "amount_invalid"
  | "excess"
  | "skonto_not_allowed"
  | "no_skonto_terms"
  | "skonto_without_vat_rate"
  | "write_off_reason"
  | "not_yet_barred"
  | "other_incomplete"
  | "fees_exceed_claim"
  | "differences_not_allowed"
  | "credit_insufficient"
  | "credit_other_contact"
  | "credit_pair_unbalanced"
  | "adjustment_invalid";

export type PaymentIssue = Issue<PaymentErrorCode>;

const fail = (code: PaymentErrorCode, message: string, params?: Record<string, string | number>) =>
  err(issue(code, message, params));

/** DUN-040: limitation date = 31.12. of (year of due date + 3) (§§ 195, 199 BGB). */
export const limitationDate = (dueDate: string): string => `${Number(dueDate.slice(0, 4)) + 3}-12-31`;

const PAYABLE_TYPES = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"];
const BANK_FEES_WARNING_CENTS = 2500; // EC-PAY-10
const isInt = Number.isSafeInteger;
const userDated = (k: SourceInput["kind"]) => k !== "bank";

export function planPayment(input: PaymentInput, ctx: PlanContext): Result<PaymentPlan, PaymentIssue> {
  const src = input.source;
  if (src.kind === "private") return fail("private_source", PAY_MESSAGES.privateOnSales);
  if (input.allocations.length === 0) return fail("no_allocations", PAY_MESSAGES.noAllocations);
  const seen = new Set<string>();
  for (const a of input.allocations) {
    const k = targetKey(a.target);
    if (seen.has(k)) return fail("duplicate_target", PAY_MESSAGES.duplicateTarget);
    seen.add(k);
  }
  const warnings: PaymentWarning[] = [];

  // ── date (PAY-010, PAY-014, PAY-045, PAY-061) ──
  const bank = src.kind === "bank" ? ctx.source.bank : undefined;
  if (src.kind === "bank" && !bank) return fail("tx_not_allocatable", PAY_MESSAGES.txNotAllocatable);
  const date = bank ? bank.bookingDate : input.date;
  if (!isCalendarDate(date)) return fail("date_invalid", "Bitte ein gültiges Zahlungsdatum angeben.");
  const daysBack = daysBetween(date as CalendarDate, ctx.today as CalendarDate);
  if (daysBack < 0) return fail("future_date", PAY_MESSAGES.future);
  if (userDated(src.kind) && ctx.closedPeriods.has(date.slice(0, 7))) {
    return fail("period_locked", PAY_MESSAGES.periodLocked(date.slice(0, 7)), { period: date.slice(0, 7) });
  }
  if (src.kind === "cash") {
    const opening = ctx.source.cashOpeningDate;
    if (opening && date < opening) {
      return fail(
        "cash_date_range",
        `Das Datum muss zwischen dem Anfangsbestand der Kasse (${opening.slice(8, 10)}.${opening.slice(5, 7)}.${opening.slice(0, 4)}) und heute liegen.`,
      );
    }
    if (daysBack > CASH_REASON_DAYS && (input.backdateReason?.trim().length ?? 0) < CASH_REASON_MIN_LENGTH) {
      return fail("cash_reason_required", PAY_MESSAGES.cashReason);
    }
    if (daysBack > CASH_WARNING_DAYS) {
      warnings.push({ code: "cash_daily_recording", message: PAY_MESSAGES.cashDaily(daysBack), ack: true });
    }
  }

  // ── source (PAY-011, EC-PAY-02/25, EC-BNK-61) ──
  let available = Number.POSITIVE_INFINITY;
  if (bank) {
    if (!["open", "partially_matched", "matched"].includes(bank.status)) {
      return fail("tx_not_allocatable", PAY_MESSAGES.txNotAllocatable);
    }
    if (bank.amountCents <= 0) return fail("tx_direction", PAY_MESSAGES.txDirection);
    available = Math.abs(bank.amountCents) - bank.allocatedCents;
  }

  // ── rows ──
  const rows: PlannedRow[] = [];
  for (const a of input.allocations) {
    const facts = ctx.targets.get(targetKey(a.target));
    if (!facts) return fail("target_unknown", "Die Rechnung wurde nicht gefunden.");
    if (!isInt(a.amountCents)) return fail("amount_invalid", "Bitte höchstens zwei Nachkommastellen angeben.");
    const r =
      a.target.kind === "salesDocument"
        ? planDocumentRow(a, facts, date, src.kind, ctx, warnings)
        : a.target.kind === "opening_item"
          ? planOpeningRow(a, facts, src.kind)
          : planCreditRow(a, facts, src.kind);
    if (!r.ok) return r;
    rows.push(r.value);
  }

  // ── source-level sums ──
  const money = rows.reduce((s, r) => s + r.amountCents, 0);
  if (src.kind === "adjustment") {
    if (rows.some((r) => r.amountCents !== 0)) {
      return fail("adjustment_invalid", "Eine Ausbuchung ohne Zahlung hat keinen Zahlbetrag.");
    }
  } else if (src.kind === "credit") {
    const creditRows = rows.filter((r) => r.target.kind === "contactCredit");
    const docRows = rows.filter((r) => r.target.kind !== "contactCredit");
    if (creditRows.length !== 1 || docRows.length === 0 || money !== 0) {
      return fail("credit_pair_unbalanced", PAY_MESSAGES.creditPairUnbalanced);
    }
    const creditContact = creditRows[0]?.target.id;
    if (docRows.some((r) => r.contactId !== creditContact)) {
      return fail("credit_other_contact", PAY_MESSAGES.creditOtherContact);
    }
  } else if (money > available) {
    return fail("source_exceeded", PAY_MESSAGES.sourceExceeded(money, available), { sum: money, available });
  }
  return ok({
    date,
    rows,
    warnings,
    totalCents: src.kind === "credit" || src.kind === "adjustment" ? 0 : money,
    ...(bank ? { unallocatedCents: available - money } : {}),
  });
}

function planDocumentRow(
  a: AllocationInput,
  f: TargetFacts,
  date: string,
  sourceKind: SourceInput["kind"],
  ctx: PlanContext,
  warnings: PaymentWarning[],
): Result<PlannedRow, PaymentIssue> {
  if (f.status === "draft") return fail("draft", PAY_MESSAGES.draft);
  if (f.status === "cancelled" || f.docType === "cancellation") return fail("cancelled", PAY_MESSAGES.cancelled);
  if (!f.docType || !PAYABLE_TYPES.includes(f.docType)) {
    return fail("not_payable", "Auf dieses Dokument können keine Zahlungen gebucht werden.");
  }
  if (f.paymentStatus === "written_off" && !ctx.allowWrittenOff) return fail("written_off", PAY_MESSAGES.writtenOff);
  if (f.currency !== "EUR") {
    return sourceKind === "cash"
      ? fail("cash_eur_only", PAY_MESSAGES.cashEurOnly)
      : fail("fx_deferred", PAY_MESSAGES.fxDeferred);
  }
  if (sourceKind === "adjustment") {
    if (a.amountCents !== 0) return fail("adjustment_invalid", "Eine Ausbuchung ohne Zahlung hat keinen Zahlbetrag.");
  } else if (a.amountCents <= 0) {
    return fail("amount_positive", PAY_MESSAGES.amountPositive);
  }
  if (f.documentDate && date < f.documentDate) {
    warnings.push({ code: "before_document_date", message: PAY_MESSAGES.beforeDocument, ack: true });
  }
  const inputs = a.differences ?? [];
  if (inputs.length > 0 && f.docType === "advance_invoice") {
    return fail("differences_not_allowed", "Auf Abschlagsrechnungen sind nur Zahlungen ohne Differenz möglich.");
  }
  if (sourceKind === "adjustment" && inputs.some((d) => d.reason !== "write_off" && d.reason !== "other")) {
    return fail("adjustment_invalid", "Ohne Zahlung sind nur Forderungsausfall und Preisminderung möglich.");
  }
  const groups = f.groups ?? [];
  const diffs: PlannedDifference[] = [];
  let fees = 0;
  let interest = 0;
  let vatCorrecting = false;
  for (const d of inputs) {
    if (!isInt(d.amountCents) || d.amountCents === 0) {
      return fail("amount_invalid", "Differenzbeträge müssen ganze Cent ungleich 0 sein.");
    }
    switch (d.reason) {
      case "skonto": {
        if (d.amountCents < 0) return fail("amount_positive", PAY_MESSAGES.amountPositive);
        const v = evaluateSkonto({ terms: f.skonto, paymentDate: date, shortfallCents: d.amountCents });
        if (!v.eligible) {
          return v.reason === "no_terms"
            ? fail("no_skonto_terms", v.message)
            : fail("skonto_not_allowed", v.message, { reason: v.reason });
        }
        const vatCorrection = splitDifferenceByVat(d.amountCents, groups);
        if (vatCorrection.some((c) => c.rateBp === 0)) {
          return fail("skonto_without_vat_rate", PAY_MESSAGES.skontoWithoutVatRate);
        }
        vatCorrecting = true;
        diffs.push({ reason: "skonto", amountCents: d.amountCents, vatCorrection });
        break;
      }
      case "bank_fees":
        if (d.amountCents < 0) return fail("amount_positive", PAY_MESSAGES.amountPositive);
        if (d.amountCents > BANK_FEES_WARNING_CENTS) {
          warnings.push({ code: "bank_fees_high", message: PAY_MESSAGES.bankFeesHigh(d.amountCents), ack: true });
        }
        diffs.push({ reason: "bank_fees", amountCents: d.amountCents });
        break;
      case "dunning_fees":
      case "default_interest":
        if (d.amountCents > 0) {
          return fail("amount_invalid", "Mahngebühren und Zinsen sind Mehrbeträge (negativ anzugeben).");
        }
        if (d.reason === "dunning_fees") fees -= d.amountCents;
        else interest -= d.amountCents;
        diffs.push({ reason: d.reason, amountCents: d.amountCents });
        break;
      case "write_off": {
        if (d.amountCents < 0) return fail("amount_positive", PAY_MESSAGES.amountPositive);
        if (!d.subReason) return fail("write_off_reason", PAY_MESSAGES.writeOffReason);
        if (d.subReason === "statute_barred") {
          const limit = f.dueDate ? limitationDate(f.dueDate) : undefined;
          if (!limit || ctx.today <= limit) {
            return fail("not_yet_barred", PAY_MESSAGES.notYetBarred(limit ?? ctx.today), { date: limit ?? "" });
          }
        }
        if (f.taxedAs === "ist")
          warnings.push({ code: "write_off_ist", message: PAY_MESSAGES.writeOffIst, ack: false });
        vatCorrecting = true;
        diffs.push({
          reason: "write_off",
          amountCents: d.amountCents,
          subReason: d.subReason,
          vatCorrection: splitDifferenceByVat(d.amountCents, groups),
        });
        break;
      }
      case "other": {
        const text = d.text?.trim() ?? "";
        const account = d.account?.trim() ?? "";
        if (text.length < 5 || !account) return fail("other_incomplete", PAY_MESSAGES.otherIncomplete);
        const withVat = d.withVat ?? true;
        if (withVat) vatCorrecting = true;
        diffs.push({
          reason: "other",
          amountCents: d.amountCents,
          account,
          text,
          ...(withVat ? { vatCorrection: splitDifferenceByVat(d.amountCents, groups) } : {}),
        });
        break;
      }
    }
  }
  const claimed = (f.claimedFeesCents ?? 0) + (f.claimedInterestCents ?? 0);
  if (fees > (f.claimedFeesCents ?? 0) || interest > (f.claimedInterestCents ?? 0)) {
    return fail("fees_exceed_claim", PAY_MESSAGES.feesExceedClaim(claimed));
  }
  if (vatCorrecting && f.taxedAs && f.methodOnDate && f.taxedAs !== f.methodOnDate) {
    const label = f.taxedAs === "ist" ? "Ist-Versteuerung" : "Soll-Versteuerung";
    warnings.push({ code: "taxation_method_changed", message: PAY_MESSAGES.methodChanged(label), ack: false });
  }
  const settles = a.amountCents + diffs.reduce((s, d) => s + d.amountCents, 0);
  if (settles <= 0) return fail("amount_positive", PAY_MESSAGES.amountPositive);
  if (settles > f.openAmountCents) {
    return fail("excess", PAY_MESSAGES.excess(settles - f.openAmountCents), {
      excessCents: settles - f.openAmountCents,
    });
  }
  return ok({
    target: a.target,
    ...(f.contactId ? { contactId: f.contactId } : {}),
    ...(f.number ? { number: f.number } : {}),
    amountCents: a.amountCents,
    differences: diffs,
    settlesCents: settles,
    openAfterCents: f.openAmountCents - settles,
  });
}

function planOpeningRow(
  a: AllocationInput,
  f: TargetFacts,
  sourceKind: SourceInput["kind"],
): Result<PlannedRow, PaymentIssue> {
  if ((a.differences ?? []).length > 0) return fail("differences_not_allowed", PAY_MESSAGES.openingItemDifferences);
  if (sourceKind === "adjustment" || a.amountCents <= 0) return fail("amount_positive", PAY_MESSAGES.amountPositive);
  if (a.amountCents > f.openAmountCents) {
    return fail("excess", PAY_MESSAGES.excess(a.amountCents - f.openAmountCents), {
      excessCents: a.amountCents - f.openAmountCents,
    });
  }
  return ok({
    target: a.target,
    ...(f.contactId ? { contactId: f.contactId } : {}),
    ...(f.number ? { number: f.number } : {}),
    amountCents: a.amountCents,
    differences: [],
    settlesCents: a.amountCents,
    openAfterCents: f.openAmountCents - a.amountCents,
  });
}

function planCreditRow(
  a: AllocationInput,
  f: TargetFacts,
  sourceKind: SourceInput["kind"],
): Result<PlannedRow, PaymentIssue> {
  if ((a.differences ?? []).length > 0) return fail("differences_not_allowed", PAY_MESSAGES.differencesOnCredit);
  const balance = f.creditBalanceCents ?? 0;
  if (sourceKind === "credit") {
    if (a.amountCents >= 0) return fail("credit_pair_unbalanced", PAY_MESSAGES.creditPairUnbalanced);
    if (-a.amountCents > balance) return fail("credit_insufficient", PAY_MESSAGES.creditInsufficient(balance));
  } else if (sourceKind === "adjustment" || a.amountCents <= 0) {
    return fail("amount_positive", PAY_MESSAGES.amountPositive);
  }
  return ok({
    target: a.target,
    contactId: a.target.id,
    amountCents: a.amountCents,
    differences: [],
    settlesCents: 0,
    openAfterCents: balance + a.amountCents,
  });
}

/** ⚑ warnings the caller has not acknowledged (UI checkbox / API `acknowledge_warnings`). */
export function unacknowledged(plan: Pick<PaymentPlan, "warnings">, acknowledged: readonly string[] = []) {
  return plan.warnings.filter((w) => w.ack && !acknowledged.includes(w.code));
}

// ── single-invoice shape (REST `POST /invoices/{id}/payments`, the „Zahlung buchen“ dialog) ─────────────

export type ExcessMode = "credit" | "allocate" | "fees" | "unallocated";

export interface SingleInvoicePayment {
  invoice: {
    id: string;
    contactId?: string;
    openAmountCents: number;
    claimedFeesCents?: number;
    claimedInterestCents?: number;
  };
  sourceKind: SourceInput["kind"];
  amountCents: number;
  differences?: DifferenceInput[];
  excess?: { mode: ExcessMode; allocations?: { invoiceId: string; amountCents: number }[] };
  allocationOrder?: "principal_first" | "bgb_367";
}

/**
 * PAY-030: turns the dialog/REST input into allocations. Without an excess → one allocation. With an excess the
 * caller must choose exactly one resolution; cash and clearing cannot leave it unallocated (EC-PAY-50).
 */
export function allocationsForInvoice(p: SingleInvoicePayment): Result<AllocationInput[], PaymentIssue> {
  const target: TargetRef = { kind: "salesDocument", id: p.invoice.id };
  const diffs = p.differences ?? [];
  const settles = p.amountCents + diffs.reduce((s, d) => s + d.amountCents, 0);
  const excess = settles - p.invoice.openAmountCents;
  if (excess <= 0) return ok([{ target, amountCents: p.amountCents, ...(diffs.length ? { differences: diffs } : {}) }]);
  const own = { target, amountCents: p.amountCents - excess, ...(diffs.length ? { differences: diffs } : {}) };
  switch (p.excess?.mode) {
    case undefined:
      return fail("excess", PAY_MESSAGES.excess(excess), { excessCents: excess });
    case "credit":
      if (!p.invoice.contactId) return fail("excess", PAY_MESSAGES.excess(excess), { excessCents: excess });
      return ok([own, { target: { kind: "contactCredit", id: p.invoice.contactId }, amountCents: excess }]);
    case "allocate": {
      const extra = p.excess.allocations ?? [];
      const sum = extra.reduce((s, x) => s + x.amountCents, 0);
      if (sum !== excess) return fail("excess", PAY_MESSAGES.excess(excess - sum), { excessCents: excess - sum });
      return ok([
        own,
        ...extra.map((x) => ({
          target: { kind: "salesDocument" as const, id: x.invoiceId },
          amountCents: x.amountCents,
        })),
      ]);
    }
    case "fees": {
      const split = splitReceipt({
        cashCents: settles,
        principalOpenCents: p.invoice.openAmountCents,
        claimedFeesCents: p.invoice.claimedFeesCents ?? 0,
        claimedInterestCents: p.invoice.claimedInterestCents ?? 0,
        order: "principal_first",
      });
      if (split.excessCents > 0) {
        return fail("fees_exceed_claim", PAY_MESSAGES.feesExceedClaim(split.feesCents + split.interestCents));
      }
      const feeDiffs: DifferenceInput[] = [
        ...(split.feesCents ? [{ reason: "dunning_fees" as const, amountCents: -split.feesCents }] : []),
        ...(split.interestCents ? [{ reason: "default_interest" as const, amountCents: -split.interestCents }] : []),
      ];
      return ok([{ target, amountCents: p.amountCents, differences: [...diffs, ...feeDiffs] }]);
    }
    case "unallocated":
      if (p.sourceKind === "cash") return fail("excess", PAY_MESSAGES.cashExcess);
      if (p.sourceKind !== "bank") return fail("excess", PAY_MESSAGES.excess(excess), { excessCents: excess });
      return ok([own]);
  }
}
