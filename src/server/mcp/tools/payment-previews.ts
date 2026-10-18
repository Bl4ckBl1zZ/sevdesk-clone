import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { prefixedId } from "@/domain/schemas/api/common";
import {
  cashTransferArgs,
  cashTransferWire,
  combinedPaymentArgs,
  combinedPaymentWire,
  markArgs,
  markWire,
  matchArgs,
  matchWire,
  serializePayment,
  serializePaymentPreview,
  serializeSuggestions,
} from "@/domain/schemas/api/payments";
import { ApiProblem } from "../../api/http";
import { rawId } from "../../api/resources/shared";
import type { ToolContext } from "../tool";
import type { PreviewPlan } from "./previews";

/**
 * `preview_action` plans for the F05/F07 ⚠ tools (06 §2.3, §3.5, §3.7). Each plan returns exactly the arguments the
 * tool passes to its Convex function — built by the same wire → Convex mapping — so the confirm token's params hash
 * matches; the effect runs the same validation as the act (payments preview, mark/cash Eigenbeleg context).
 */

export const paymentReverseParams = z
  .object({
    id: prefixedId("payments"),
    reason: z.string().min(5).max(500).meta({ description: "Grund (mind. 5 Zeichen)" }),
  })
  .strict();

export const bankMatchParams = matchWire.extend({ transaction_id: prefixedId("bankTransactions") });
export const bankMarkParams = markWire.extend({ transaction_id: prefixedId("bankTransactions") });

const notFound = (what: string) => new ApiProblem("not_found", { detail: `${what} nicht gefunden.` });

type Entity = PreviewPlan["entities"][number];

function sourceEntities(source: { kind: string; transactionId?: string }): Entity[] {
  return source.kind === "bank" && source.transactionId
    ? [{ table: "bankTransactions", id: source.transactionId }]
    : [];
}

function targetEntities(allocations: readonly { target: { kind: string; id: string } }[]): Entity[] {
  const table: Record<string, string> = {
    salesDocument: "salesDocuments",
    opening_item: "openingItems",
    contactCredit: "contacts",
    payment: "payments",
  };
  return allocations.flatMap((a) =>
    table[a.target.kind] ? [{ table: table[a.target.kind] as string, id: a.target.id }] : [],
  );
}

function ackHint(unacknowledged: readonly string[]) {
  return unacknowledged.length > 0
    ? `Vor dem Buchen bestätigen: acknowledge_warnings = [${unacknowledged.map((c) => `"${c}"`).join(", ")}] (dann erneut preview_action).`
    : null;
}

export async function paymentRecordPlan(params: z.infer<typeof combinedPaymentWire>, { convex }: ToolContext) {
  const args = combinedPaymentArgs(params);
  if (!args) throw notFound("Ziel oder Quelle");
  const preview = serializePaymentPreview(await convex.query(api.payments.preview, args as never));
  return {
    args,
    entities: [...sourceEntities(args.source), ...targetEntities(args.allocations)],
    effect: {
      ...preview,
      hint: ackHint(preview.unacknowledged),
      summary: `${preview.allocations.length} Zuordnung(en), ${(preview.total_cents / 100).toFixed(2)} € am ${preview.date}.`,
    },
  } satisfies PreviewPlan;
}

export async function paymentReversePlan(params: z.infer<typeof paymentReverseParams>, { convex }: ToolContext) {
  const paymentId = rawId("payments", params.id);
  const payment = serializePayment(await convex.query(api.payments.get, { id: paymentId as never }));
  if (payment.reversed_by_id || payment.reversal_of_id) {
    throw new ApiProblem("conflict", { detail: "Diese Zahlung ist bereits storniert bzw. selbst eine Stornozeile." });
  }
  return {
    args: { paymentId, reason: params.reason },
    entities: [{ table: "payments", id: paymentId }],
    effect: {
      payment,
      summary: `Gegenbuchung über ${(payment.amount_cents / 100).toFixed(2)} € (${payment.number ?? "Zahlung"}); der offene Betrag steigt wieder, die Zahlung bleibt unverändert sichtbar.`,
    },
  } satisfies PreviewPlan;
}

export async function bankMatchPlan(params: z.infer<typeof bankMatchParams>, { convex }: ToolContext) {
  const { transaction_id, ...wire } = params;
  const args = matchArgs(transaction_id, wire);
  if (!args) throw notFound("Umsatz oder Ziel");
  const s = await convex.query(api.matching.suggestions, { transactionId: args.transactionId as never });
  if (!s.transaction) throw new ApiProblem("conflict", { detail: "Der Umsatz ist bereits vollständig zugeordnet." });
  let booking: ReturnType<typeof serializePaymentPreview> | null = null;
  const plain = args.allocations.every((a) => a.target.kind !== "payment");
  if (plain && s.transaction.amountCents > 0) {
    booking = serializePaymentPreview(
      await convex.query(api.payments.preview, {
        source: { kind: "bank", transactionId: args.transactionId },
        date: s.transaction.bookingDate,
        allocations: args.allocations,
        ...(args.acknowledgeWarnings ? { acknowledgeWarnings: args.acknowledgeWarnings } : {}),
      } as never),
    );
  }
  // PAY-033 (b): an outgoing debit on a credit correction is a refund — same check as the act (EC-PAY-33).
  const [first] = args.allocations;
  let refund: { open_refund_cents: number; open_refund_after_cents: number; date: string } | null = null;
  if (s.transaction.amountCents < 0 && args.allocations.length === 1 && first?.target.kind === "salesDocument") {
    const r = await convex.query(api.payments.previewCorrectionRefund, {
      documentId: first.target.id as never,
      amountCents: first.amountCents,
      source: { kind: "bank", transactionId: args.transactionId as never },
      date: s.transaction.bookingDate,
    });
    if (!r.ok)
      throw new ApiProblem("validation_failed", {
        detail: r.message,
        errors: [{ code: r.reason ?? "invalid", field: "targets.0.amount_cents", message: r.message }],
      });
    refund = { open_refund_cents: r.openRefundCents, open_refund_after_cents: -r.openAfterCents, date: r.date };
  }
  const euros = (cents: number) => (cents / 100).toFixed(2);
  return {
    args,
    entities: [{ table: "bankTransactions", id: args.transactionId }, ...targetEntities(args.allocations)],
    effect: {
      transaction: serializeSuggestions({ transaction: s.transaction, candidates: [] }).transaction,
      targets: wire.targets,
      remainder: wire.remainder ?? null,
      booking,
      refund,
      hint: booking ? ackHint(booking.unacknowledged) : null,
      summary: refund
        ? `Erstattung an den Kunden: ${euros(first?.amountCents ?? 0)} € zur Rechnungskorrektur werden gebucht (PAY-033); danach offene Erstattung ${euros(refund.open_refund_after_cents)} €.`
        : s.transaction.amountCents < 0
          ? "Erstattung an den Kunden: der Umsatz wird dem Ziel zugeordnet und die Erstattung gebucht (PAY-033)."
          : "Der Umsatz wird den Zielen zugeordnet; die Zahlungen werden gebucht (F05).",
    },
  } satisfies PreviewPlan;
}

const MARK_LABEL: Record<string, string> = {
  private: "Privat (Entnahme/Einlage)",
  transfer: "Geldtransit",
  cash_withdrawal: "Bargeld in die Kasse",
  ignored: "Ignorieren",
};

export async function bankMarkPlan(params: z.infer<typeof bankMarkParams>, { convex }: ToolContext) {
  const { transaction_id, ...wire } = params;
  const args = markArgs(transaction_id, wire);
  if (!args) throw notFound("Umsatz");
  const eigenbeleg = await convex.query(api.banking.markContext, args as never);
  return {
    args,
    entities: [{ table: "bankTransactions", id: args.transactionId }],
    effect: {
      transaction_id,
      as: wire.as,
      eigenbeleg: eigenbeleg
        ? { kind: eigenbeleg.kind, date: eigenbeleg.date, amount_cents: eigenbeleg.amountCents }
        : null,
      summary: `Markierung „${MARK_LABEL[wire.as] ?? wire.as}“${eigenbeleg ? " mit Eigenbeleg und Buchung" : " ohne Buchung"}.`,
    },
  } satisfies PreviewPlan;
}

export async function cashTransferPlan(params: z.infer<typeof cashTransferWire>, { convex }: ToolContext) {
  const args = cashTransferArgs(params);
  if (!args) throw notFound("Bankkonto");
  // Same checks as the act (dating, never negative, GmbH private withdrawal) — throws with the act's message.
  const eigenbeleg = await convex.query(api.cash.transferContext, args as never);
  const cash = await convex.query(api.cash.overview, {});
  return {
    args,
    entities: args.bankAccountId ? [{ table: "bankAccounts", id: args.bankAccountId }] : [],
    effect: {
      kind: params.kind,
      date: params.date,
      amount_cents: params.amount_cents,
      eigenbeleg: { kind: eigenbeleg.kind, account: eigenbeleg.account ?? null },
      cash_balance_cents: cash.balanceCents,
      cash_balance_after_cents: cash.balanceCents - params.amount_cents,
      summary: `${params.kind === "deposit_to_bank" ? "Einzahlung auf die Bank" : "Privatentnahme"} über ${(params.amount_cents / 100).toFixed(2)} € am ${params.date}; Kassenbestand danach ${((cash.balanceCents - params.amount_cents) / 100).toFixed(2)} €.`,
    },
  } satisfies PreviewPlan;
}

export const PAYMENT_PREVIEWS = {
  payment_record: { scope: "payments:write", params: combinedPaymentWire, plan: paymentRecordPlan },
  payment_reverse: { scope: "payments:write", params: paymentReverseParams, plan: paymentReversePlan },
  bank_match_confirm: { scope: "banking:write", params: bankMatchParams, plan: bankMatchPlan },
  bank_transaction_mark: { scope: "banking:write", params: bankMarkParams, plan: bankMarkPlan },
  cash_transfer_record: { scope: "banking:write", params: cashTransferWire, plan: cashTransferPlan },
} as const;
