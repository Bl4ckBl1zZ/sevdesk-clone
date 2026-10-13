/**
 * Extension point for the matching slice (F07 BNK-040…049, 03 `matchSuggestions`). This slice imports and stores
 * booked transactions; the matching slice scores them against open documents. The contract between both:
 *
 *  - Convex query `banking:unmatched` returns `UnmatchedTransaction[]` (booked, status `open`/`partially_matched`,
 *    open amount > 0; pending feed rows never appear, RI-10);
 *  - the matching slice implements a `MatchCandidateProvider` (pure, `src/domain/banking/match.ts`) and computes its
 *    `MatchCandidate`s on read (like `banking.todos`; rejections persist in `matchRejections`); confirming one runs
 *    F05 `payments.record` with
 *    `source.kind = "bank"`, which raises `bankTransactions.allocatedCents` and sets the status through
 *    `applyAllocation` (convex/model/bankTransactions.ts) — the only allowed write path (BNK-122).
 */
import type { TypeDefault } from "./type-defaults";

export type MatchTargetKind =
  | "salesDocument"
  | "opening_item"
  | "voucher"
  | "contactCredit"
  | "payment"
  | "cashTransfer";

export type MatchReason =
  | "number_in_purpose"
  | "rf_reference"
  | "exact_amount"
  | "bill_amount"
  | "skonto_amount"
  | "known_iban"
  | "name_similarity"
  | "date_window"
  | "rule"
  | "existing_manual_payment"
  | "recurring_expected"
  | "amount_tolerance"
  | "partial"
  | "ambiguous";

export interface MatchAllocation {
  target: { kind: MatchTargetKind; id: string };
  amountCents: number;
  differences?: { reason: string; amountCents: number }[];
}

export interface MatchCandidate {
  kind: "single" | "combined" | "partial";
  allocations: MatchAllocation[];
  /** 0…1 (BNK-042). */
  score: number;
  reasons: MatchReason[];
}

/** What the matching slice reads for one booked, not fully allocated transaction. */
export interface UnmatchedTransaction {
  id: string;
  accountId: string;
  accountName: string;
  bookingDate: string;
  valueDate?: string;
  amountCents: number;
  currency: string;
  /** EUR value for non-EUR pockets when known (BNK-028). */
  amountEurCents?: number;
  /** |amount| − allocated. */
  openCents: number;
  direction: "in" | "out";
  counterpartyName?: string;
  counterpartyIban?: string;
  purpose: string;
  reference?: string;
  endToEndId?: string;
  mandateRef?: string;
  merchantName?: string;
  instructedAmount?: { amountMinor: number; currency: string };
  typeDefault?: TypeDefault;
}

export type MatchCandidateProvider = (tx: UnmatchedTransaction) => MatchCandidate[];

export const openAmountCents = (tx: { amountCents: number; allocatedCents: number }): number =>
  Math.abs(tx.amountCents) - tx.allocatedCents;

/** Allocation status after a change of `allocatedCents` (BNK-122 whitelist: status + allocatedCents). */
export function allocationStatus(
  tx: { amountCents: number },
  allocatedCents: number,
): "open" | "partially_matched" | "matched" {
  if (allocatedCents < 0 || allocatedCents > Math.abs(tx.amountCents))
    throw new RangeError("allocation out of range (RI-10)");
  if (allocatedCents === 0) return "open";
  return allocatedCents === Math.abs(tx.amountCents) ? "matched" : "partially_matched";
}
