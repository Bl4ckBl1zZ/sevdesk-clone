/**
 * Offene Posten report (F08 RPT-006; E-RPT-06): debtors (sales documents, opening items) or creditors (vouchers) as of
 * a date — history reconstructed from payments/write-offs ≤ date (F05 PAY-003 `computeOpenItems`), with dunning level,
 * aging buckets and the reconciliation to the receivable/payable account balance on that date. Pure.
 */
import { formatCents } from "../money";
import {
  computeOpenItems,
  type OpenItemDocument,
  type OpenItemsResult,
  type SettlementRow,
} from "../payments/open-items";

export type OposSide = "debtors" | "creditors";

export interface OposReport extends OpenItemsResult {
  side: OposSide;
  dunningLevels: Record<string, number>;
  reconciliation: {
    accountBalanceCents: number;
    openItemsCents: number;
    differenceCents: number;
    /** E-RPT-06 message, or null when the open items match the account. */
    message: string | null;
    /** Likely causes: manual entries on the account (entry ids with text). */
    causes: { entryId: string; seq: number; date: string; text: string; cents: number }[];
  };
}

export const oposDifferenceMessage = (diffCents: number) =>
  `Offene Posten weichen vom Kontosaldo um ${formatCents(diffCents)} € ab.`;

export function computeOpos(input: {
  side: OposSide;
  documents: readonly OpenItemDocument[];
  rows: readonly SettlementRow[];
  asOf: string;
  /** Receivable: debit − credit; payable: credit − debit (both positive when we have open items). */
  accountBalanceCents: number;
  dunningLevels?: Readonly<Record<string, number>>;
  manualEntries?: readonly { entryId: string; seq: number; date: string; text: string; cents: number }[];
  contactNames?: ReadonlyMap<string, string>;
}): OposReport {
  const r = computeOpenItems({
    documents: input.documents,
    rows: input.rows,
    asOf: input.asOf,
    ...(input.contactNames ? { contactNames: input.contactNames } : {}),
  });
  const openItems = r.totals.openCents - r.totals.creditCents;
  const diff = input.accountBalanceCents - openItems;
  return {
    ...r,
    side: input.side,
    dunningLevels: { ...(input.dunningLevels ?? {}) },
    reconciliation: {
      accountBalanceCents: input.accountBalanceCents,
      openItemsCents: openItems,
      differenceCents: diff,
      message: diff === 0 ? null : oposDifferenceMessage(diff),
      causes: diff === 0 ? [] : [...(input.manualEntries ?? [])].filter((m) => m.date <= input.asOf),
    },
  };
}
