import type { VoucherPaidEvent, VoucherPaymentDifference } from "../../src/domain/accounting/events";
import { isCorporation } from "../../src/domain/accounting/roles";
import { checkCashDating } from "../../src/domain/cash/dating";
import { splitDifferenceByVat } from "../../src/domain/payments/split";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, daysBetween, isCalendarDate } from "../../src/domain/time/calendar-date";
import { checkPaymentChoice, PAYMENT_MESSAGES } from "../../src/domain/vouchers/payment-choice";
import { jaroWinkler, normaliseSupplierName } from "../../src/domain/vouchers/supplier-key";
import { deductsInputVat } from "../../src/domain/vouchers/tax-rules";
import type { TaxRule } from "../../src/domain/vouchers/types";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { applyAllocation, requireTransaction } from "./bankTransactions";
import { cashOpeningDate } from "./cash";
import { getCompanyProfile } from "./companyProfile";
import { cashOutflowDip, postJournalEntry } from "./journal";
import { closedPeriods, reversePayment } from "./payments";
import type { ModelCtx, ReadCtx } from "./types";
import { refreshVoucher } from "./voucherStatus";

/**
 * Voucher payments (F06 VOU-131…139; F07 CSH-022/023; F08 V2/V3/T6/T7) — the only writer of `payments` rows with
 * `target.kind = "voucher"`. Row, journal entry, voucher status and the bank allocation commit in one transaction; the
 * cash never-negative check (CSH-026) runs inside `postJournalEntry`, so a failed check books nothing (EC-151).
 * Reversals use the F05 path (`reversePayment`, which re-derives the voucher via `refreshTarget`).
 */

export type VoucherPaymentMethod = "bank" | "cash" | "private";

export interface VoucherPaymentArgs {
  voucherId: Id<"vouchers">;
  method: VoucherPaymentMethod;
  /** Cash/private: payment date (default: document date); bank: the booking date of the transaction. */
  date?: string;
  amountCents?: number;
  transactionId?: Id<"bankTransactions">;
  backdateReason?: string;
  note?: string;
  /** VOU-132: Skonto (+, settles more than the money), bank fees (−, the money exceeds the voucher), other (account). */
  differences?: { reason: "skonto" | "bank_fees" | "other"; amountCents: number; account?: string }[];
  acknowledgeWarnings?: string[];
  match?: { score: number; reasons: string[]; auto: boolean };
}

const MESSAGES = {
  notOpen: "Der Beleg ist nicht offen (Entwurf, storniert oder bezahlt).",
  transactionRequired: "Bitte den Bankumsatz angeben.",
  direction: "Der Bankumsatz passt nicht zur Richtung des Belegs (Ausgabe = Abbuchung, Einnahme = Gutschrift).",
  exceeds: "Der Betrag übersteigt den noch nicht zugeordneten Teil des Bankumsatzes.",
  fx: "Fremdwährungsumsätze werden noch nicht zugeordnet.",
} as const;

const warningsMissing = (warnings: { code: string; acknowledge: boolean }[], acknowledged: readonly string[]) =>
  warnings.filter((w) => w.acknowledge && !acknowledged.includes(w.code));

async function voucherLinesEur(ctx: ReadCtx, v: Doc<"vouchers">) {
  const lines = await ctx.db
    .query("voucherLines")
    .withIndex("by_voucher", (q) => q.eq("voucherId", v._id))
    .collect();
  return lines.map((l) => ({
    rateBp: l.vatRateBp,
    netCents: l.netEurCents ?? l.netCents,
    vatCents: l.vatEurCents ?? l.vatCents,
  }));
}

function kuAt(profile: Doc<"companyProfile"> | null, date: string): boolean {
  const row = [...(profile?.kleinunternehmer ?? [])]
    .filter((k) => k.validFrom <= date)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    .at(-1);
  return row?.isKU ?? false;
}

/** Ist basis of an income voucher with output VAT (VE-pay): the not-due VAT its booking posted. */
async function istBasis(ctx: ReadCtx, v: Doc<"vouchers">) {
  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", v._id))
    .collect();
  const reversed = new Set(entries.flatMap((e) => (e.reversalOfId ? [e.reversalOfId as string] : [])));
  const live = entries.filter((e) => !e.reversalOfId && !reversed.has(e._id));
  const notDue = new Map<number, number>();
  for (const e of live) {
    for (const l of e.lines) {
      const m = l.role?.match(/^vat\.output\.notdue\.(19|7)$/);
      if (!m) continue;
      const rate = Number(m[1]) * 100;
      notDue.set(rate, (notDue.get(rate) ?? 0) + l.creditCents - l.debitCents);
    }
  }
  return [...notDue.entries()].filter(([, c]) => c !== 0).map(([rateBp, vatCents]) => ({ rateBp, vatCents }));
}

/** Records a payment on a booked voucher (VOU-131/136…138) and returns the payment id. */
export async function recordVoucherPayment(
  ctx: ModelCtx,
  args: VoucherPaymentArgs,
): Promise<{ paymentId: Id<"payments">; warnings: { code: string; message: string }[] }> {
  const v = await ctx.db.get(args.voucherId);
  if (!v) throw appError("not_found", "Der Beleg existiert nicht.");
  if (v.status === "draft" || v.status === "cancelled" || v.status === "paid") {
    throw appError("invalid_input", MESSAGES.notOpen, { reason: "VOUCHER_NOT_OPEN" });
  }
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const corporation = isCorporation(profile.legalForm);
  const today = berlinCalendarDate(ctx.now());
  const open = v.openAmountCents;
  const sign = Math.sign(open) || 1;
  let tx: Doc<"bankTransactions"> | null = null;
  let date = args.date ?? v.documentDate ?? today;
  let amount = args.amountCents;
  if (args.method === "bank") {
    if (!args.transactionId) throw appError("invalid_input", MESSAGES.transactionRequired);
    tx = await requireTransaction(ctx, args.transactionId);
    if (tx.currency !== "EUR") throw appError("invalid_input", MESSAGES.fx, { reason: "FX_DEFERRED" });
    // Expense = debit (amount < 0); income = credit. A supplier refund on a credit-note voucher is a credit (VOU-134).
    const expected = v.direction === "expense" ? -sign : sign;
    if (Math.sign(tx.amountCents) !== expected)
      throw appError("invalid_input", MESSAGES.direction, { reason: "DIRECTION" });
    const free = Math.abs(tx.amountCents) - tx.allocatedCents;
    amount ??= Math.min(free, Math.abs(open));
    if (amount > free) throw appError("invalid_input", MESSAGES.exceeds, { reason: "ALLOCATION_EXCEEDS" });
    date = tx.bookingDate;
  }
  amount ??= Math.abs(open);
  const differences = args.differences ?? [];
  const settles = amount + differences.reduce((s, d) => s + d.amountCents, 0);
  const warnings: { code: string; message: string; acknowledge: boolean }[] = [];
  if (args.method !== "bank") {
    const choice = checkPaymentChoice({
      method: args.method,
      direction: v.direction,
      date,
      amountCents: settles,
      openCents: open,
      today,
      closedPeriods: await closedPeriods(ctx),
      ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
      corporation,
    });
    if (!choice.ok) throw appError("invalid_input", choice.error.message, { reason: choice.error.code.toUpperCase() });
    warnings.push(...choice.value.warnings);
    if (args.method === "cash") {
      const opening = await cashOpeningDate(ctx);
      const dating = checkCashDating({
        date,
        today,
        amountCents: amount,
        ...(opening ? { openingDate: opening } : {}),
        ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
      });
      if (!dating.ok)
        throw appError("invalid_input", dating.error.message, { reason: dating.error.code.toUpperCase() });
      // EC-VOU-39 / CSH-026: an outflow that would make the till negative on any date is refused with the hint to
      // „Privat bezahlt“ before anything is written (the journal check stays the backstop).
      const deltaCents = (v.direction === "expense" ? -sign : sign) * amount;
      const dip = deltaCents < 0 ? await cashOutflowDip(ctx, date, -deltaCents) : null;
      if (dip) {
        throw appError("cash_negative", PAYMENT_MESSAGES.cashNegative(dip.date, dip.balanceCents), {
          date: dip.date,
          balanceCents: dip.balanceCents,
        });
      }
    }
  } else if (settles <= 0 || settles > Math.abs(open)) {
    throw appError("invalid_input", "Der Betrag darf den offenen Betrag nicht übersteigen.", {
      reason: "PAYMENT_AMOUNT_INVALID",
    });
  }
  const missing = warningsMissing(warnings, args.acknowledgeWarnings ?? []);
  if (missing.length > 0) {
    throw appError("invalid_input", missing.map((w) => (w as { message?: string }).message ?? w.code).join(" "), {
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: missing.map((w) => w.code).join(","),
    });
  }

  // VOU-132: Skonto split per rate (pro rata by gross, UST-32); fees and other differences without VAT.
  const lines = await voucherLinesEur(ctx, v);
  const groups = lines.map((l) => ({
    category: (l.rateBp > 0 ? "S" : "Z") as "S" | "Z",
    rateBp: l.rateBp,
    grossCents: l.netCents + l.vatCents,
  }));
  const stored = differences.map((d) => ({
    reason: d.reason,
    amountCents: sign * d.amountCents,
    ...(d.account ? { account: d.account } : {}),
    ...(d.reason === "skonto" ? { vatCorrection: splitDifferenceByVat(sign * d.amountCents, groups) } : {}),
  }));
  const source =
    args.method === "bank" && tx
      ? { kind: "bank" as const, transactionId: tx._id }
      : args.method === "cash"
        ? { kind: "cash" as const }
        : { kind: "private" as const };
  const reason = args.backdateReason?.trim();
  const paymentId = await auditedInsert(
    ctx,
    "payments",
    {
      target: { kind: "voucher", id: v._id },
      ...(v.supplierContactId ? { contactId: v.supplierContactId } : {}),
      ...(v.internalNumber ? { number: v.internalNumber } : {}),
      date,
      amountCents: sign * amount,
      currency: "EUR",
      source,
      ...(tx ? { bankTransactionId: tx._id } : {}),
      differences: stored,
      journalEntryIds: [],
      ...(reason && args.method === "cash" ? { backdateReason: reason } : {}),
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(args.match ? { match: args.match } : {}),
      actor: ctx.actor,
      recordedAt: ctx.now(),
    },
    {
      action: "payment.record",
      label: v.internalNumber ?? "Beleg",
      ...(reason && args.method === "cash" ? { reason } : {}),
    },
  );
  const ku = kuAt(profile, v.documentDate ?? today);
  const notDue = v.direction === "income" ? await istBasis(ctx, v) : [];
  const payable = v.totalsEur?.grossCents ?? v.totals.grossCents;
  const event: VoucherPaidEvent = {
    kind: "voucher_paid",
    paymentId,
    date,
    direction: v.direction,
    means: tx
      ? { kind: "bank_account", bankAccountId: tx.accountId }
      : { kind: args.method === "cash" ? "cash" : "private" },
    amountCents: sign * amount,
    voucher: { id: v._id, ...(v.internalNumber ? { number: v.internalNumber } : {}) },
    ...(v.supplierContactId ? { contactId: v.supplierContactId } : {}),
    ...(v.supplierName ? { counterpartyName: v.supplierName } : {}),
    ...(stored.length
      ? {
          differences: stored.map(
            (d): VoucherPaymentDifference => ({
              reason: d.reason,
              amountCents: d.amountCents,
              ...(d.vatCorrection ? { vatCorrection: d.vatCorrection } : {}),
              ...(d.account ? { account: d.account } : {}),
            }),
          ),
        }
      : {}),
    inputVatDeducted: v.direction === "expense" && deductsInputVat(v.taxRule as TaxRule, ku),
    ...(notDue.length > 0
      ? { ist: { notDueVat: notDue, payableCents: payable, settledBeforeCents: payable - open } }
      : {}),
    corporation,
  };
  const posted = await postJournalEntry(ctx, event);
  if (posted.status === "posted") {
    await auditedPatch(ctx, "payments", paymentId, { journalEntryIds: posted.entryIds }, { action: "payment.record" });
  }
  await refreshVoucher(ctx, v._id, "payment.record");
  if (tx) await applyAllocation(ctx, { transactionId: tx._id, deltaCents: amount });
  return { paymentId, warnings: warnings.map((w) => ({ code: w.code, message: w.message })) };
}

/** Active (not reversed) payments of a voucher. */
export async function activeVoucherPayments(ctx: ReadCtx, voucherId: Id<"vouchers">) {
  return (
    await ctx.db
      .query("payments")
      .withIndex("by_target", (q) => q.eq("target.kind", "voucher").eq("target.id", voucherId))
      .collect()
  ).filter((p) => !p.reversedById && !p.reversalOfId);
}

/**
 * VOU-139 „Zahlung umbuchen“ (EC-VOU-43): the voucher was recorded as paid cash/private, the bank debit shows it was
 * paid by bank — reverse the cash/private payments (F05 reversal, reason; a cash reversal is subject to CSH-026)
 * and match the bank transaction, in one confirmed step.
 */
export async function rebookVoucherPayment(
  ctx: ModelCtx,
  args: { voucherId: Id<"vouchers">; transactionId: Id<"bankTransactions">; reason: string },
): Promise<{ paymentId: Id<"payments">; reversalIds: Id<"payments">[] }> {
  const reason = args.reason.trim();
  if (reason.length < 5) throw appError("invalid_input", "Bitte einen Grund angeben (mindestens 5 Zeichen).");
  const rows = (await activeVoucherPayments(ctx, args.voucherId)).filter(
    (p) => p.source.kind === "cash" || p.source.kind === "private",
  );
  if (rows.length === 0) {
    throw appError("invalid_input", "Der Beleg ist nicht als bar oder privat bezahlt erfasst.", {
      reason: "NOTHING_TO_REBOOK",
    });
  }
  const reversalIds: Id<"payments">[] = [];
  for (const r of rows) {
    const rev = await reversePayment(ctx, { paymentId: r._id, reason, preferredDate: r.date });
    reversalIds.push(...rev.reversalIds);
  }
  const { paymentId } = await recordVoucherPayment(ctx, {
    voucherId: args.voucherId,
    method: "bank",
    transactionId: args.transactionId,
  });
  return { paymentId, reversalIds };
}

// ── suggestions (VOU-131, VOU-139) ──────────────────────────────────────────────────────────────────────

export interface BankSuggestion {
  transactionId: Id<"bankTransactions">;
  bookingDate: string;
  amountCents: number;
  openCents: number;
  counterpartyName: string | null;
  purpose: string;
  score: number;
  reasons: string[];
}

/**
 * Bank debits that may pay the voucher (simple amount/date/name score; the full F07 BNK-049 scorer replaces it with
 * the matching slice). Shows whether the voucher is already settled cash/private (VOU-139: then the action is
 * „Zahlung umbuchen“, not a payment).
 */
export async function voucherBankSuggestions(ctx: ReadCtx, voucherId: Id<"vouchers">) {
  const v = await ctx.db.get(voucherId);
  if (!v) throw appError("not_found", "Der Beleg existiert nicht.");
  const settledBy = (await activeVoucherPayments(ctx, voucherId))
    .map((p) => p.source.kind)
    .filter((k): k is "cash" | "private" => k === "cash" || k === "private");
  const target =
    v.status === "paid" && settledBy.length > 0
      ? Math.abs(v.totalsEur?.grossCents ?? v.totals.grossCents)
      : Math.abs(v.openAmountCents);
  const date = (
    v.documentDate && isCalendarDate(v.documentDate) ? v.documentDate : berlinCalendarDate(Date.now())
  ) as CalendarDate;
  const wantSign = v.direction === "expense" ? -1 : 1;
  const out: BankSuggestion[] = [];
  for (const status of ["open", "partially_matched"] as const) {
    const txs = await ctx.db
      .query("bankTransactions")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    for (const t of txs) {
      if (Math.sign(t.amountCents) !== wantSign || t.currency !== "EUR") continue;
      const free = Math.abs(t.amountCents) - t.allocatedCents;
      if (free <= 0) continue;
      const days = isCalendarDate(t.bookingDate) ? Math.abs(daysBetween(date, t.bookingDate as CalendarDate)) : 999;
      if (days > 60) continue;
      const reasons: string[] = [];
      let score = 0;
      if (free === target) {
        score += 0.6;
        reasons.push("Betrag");
      } else if (Math.abs(free - target) <= Math.max(100, target * 0.03)) {
        score += 0.3;
        reasons.push("Betrag ähnlich");
      }
      if (days <= 7) {
        score += 0.2;
        reasons.push("Datum");
      }
      const name = normaliseSupplierName(v.supplierName ?? "");
      const other = normaliseSupplierName(`${t.counterpartyName ?? ""} ${t.purpose}`);
      if (
        name &&
        (other.includes(name) || jaroWinkler(name, normaliseSupplierName(t.counterpartyName ?? "")) >= 0.85)
      ) {
        score += 0.2;
        reasons.push("Name");
      }
      if (v.internalNumber && t.purpose.includes(v.internalNumber)) {
        score += 0.2;
        reasons.push("Belegnummer");
      }
      if (v.documentNumber && t.purpose.replace(/\s+/g, "").includes(v.documentNumber.replace(/\s+/g, ""))) {
        score += 0.2;
        reasons.push("Rechnungsnummer");
      }
      if (score < 0.3) continue;
      out.push({
        transactionId: t._id,
        bookingDate: t.bookingDate,
        amountCents: t.amountCents,
        openCents: free,
        counterpartyName: t.counterpartyName ?? null,
        purpose: t.purpose,
        score: Math.min(1, Math.round(score * 100) / 100),
        reasons,
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.bookingDate.localeCompare(b.bookingDate));
  return {
    suggestions: out.slice(0, 10),
    alreadySettled: settledBy.length > 0 ? (settledBy.includes("cash") ? "cash" : "private") : null,
    alreadySettledLabel:
      settledBy.length > 0 ? `Bereits als ${settledBy.includes("cash") ? "bar" : "privat"} bezahlt erfasst` : null,
  };
}
