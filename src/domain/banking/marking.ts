/**
 * Marking booked transactions (F07 BNK-060 Privat, BNK-061 Geldtransit, CSH-025 Bargeldabhebung in die Kasse,
 * BNK-063 restricted „Ignorieren“; EC-BNK-21/67, EC-CSH-35). Pure validation and the resulting status; the Convex
 * model posts the journal entry (F08 T1/T2, T4, T9) in the same mutation.
 */

import { isCorporation } from "../accounting/roles";
import type { LegalForm } from "../company/legal-forms";
import { type Issue, issue } from "../result";

export type MarkKind = "private" | "transfer" | "cash_withdrawal" | "ignored";
export type IgnoreReason = "duplicate_of_file_import" | "neutralised_pair" | "test_or_zero";
export const IGNORE_REASONS: readonly IgnoreReason[] = ["duplicate_of_file_import", "neutralised_pair", "test_or_zero"];

export const MARK_LABEL_DE: Readonly<Record<MarkKind, string>> = {
  private: "Privat",
  transfer: "Geldtransit",
  cash_withdrawal: "Bargeld in die Kasse",
  ignored: "Ignoriert",
};

export interface MarkableTx {
  amountCents: number;
  currency: string;
  status: string;
  allocatedCents: number;
  feeCents?: number;
}

export interface MarkInput {
  as: MarkKind;
  reason?: IgnoreReason;
  /** `ignored`: the linked transaction (duplicate or the other half of a neutralised pair). */
  link?: MarkableTx & { id: string; accountId: string };
  /** `private` for corporations: Verrechnungskonto Gesellschafter (F08 ACC-028). */
  shareholder?: { name: string; note: string };
}

export const MARK_MESSAGES = {
  notOpen: "Der Umsatz ist bereits zugeordnet oder markiert. Bitte zuerst die Zuordnung bzw. Markierung aufheben.",
  corporation: "Kapitalgesellschaften haben kein Privatkonto. Bitte ‚Verrechnungskonto Gesellschafter‘ verwenden.",
  ignoreRestricted:
    "Gebuchte Bankbewegungen müssen gebucht werden. Ignorieren ist nur für Dubletten aus Dateiimporten oder neutralisierte Hin-/Rückbuchungen möglich.",
  cashOnlyDebits: "Nur Abbuchungen können als Bargeldabhebung in die Kasse markiert werden.",
  cashEurOnly: "Barzahlungen sind nur in EUR möglich.",
} as const;

export function checkMark(tx: MarkableTx, input: MarkInput, legalForm: LegalForm): Issue<"mark_rejected"> | null {
  const fail = (m: string) => issue("mark_rejected", m);
  if (tx.status !== "open" || tx.allocatedCents !== 0) return fail(MARK_MESSAGES.notOpen);
  switch (input.as) {
    case "private":
      if (isCorporation(legalForm) && !(input.shareholder?.name.trim() && input.shareholder.note.trim())) {
        return fail(MARK_MESSAGES.corporation);
      }
      return tx.amountCents === 0 ? fail(MARK_MESSAGES.ignoreRestricted) : null;
    case "transfer":
      return tx.amountCents === 0 ? fail(MARK_MESSAGES.ignoreRestricted) : null;
    case "cash_withdrawal":
      if (tx.amountCents >= 0) return fail(MARK_MESSAGES.cashOnlyDebits);
      if (tx.currency !== "EUR") return fail(MARK_MESSAGES.cashEurOnly);
      return null;
    case "ignored": {
      if (!input.reason || !IGNORE_REASONS.includes(input.reason)) return fail(MARK_MESSAGES.ignoreRestricted);
      if (input.reason === "test_or_zero") return tx.amountCents === 0 ? null : fail(MARK_MESSAGES.ignoreRestricted);
      const l = input.link;
      if (!l) return fail(MARK_MESSAGES.ignoreRestricted);
      if (input.reason === "neutralised_pair") {
        return l.amountCents === -tx.amountCents &&
          l.currency === tx.currency &&
          l.status === "open" &&
          l.allocatedCents === 0
          ? null
          : fail(MARK_MESSAGES.ignoreRestricted);
      }
      // duplicate_of_file_import: the same booking, already present.
      return l.amountCents === tx.amountCents && l.currency === tx.currency
        ? null
        : fail(MARK_MESSAGES.ignoreRestricted);
    }
  }
}

export function statusForMark(kind: MarkKind): "private" | "transfer" | "ignored" {
  if (kind === "private") return "private";
  if (kind === "ignored") return "ignored";
  return "transfer";
}

/** CSH-025: the cash that reached the till; an ATM fee in the same row is a bank fee (F08 R5). */
export const cashWithdrawalAmount = (tx: Pick<MarkableTx, "amountCents" | "feeCents">): number =>
  Math.abs(tx.amountCents) - (tx.feeCents ?? 0);
