/**
 * Links between booked transactions (pure candidate search; the owner confirms):
 *  - bank reversals (F07 BNK-121, EC-141, EC-BNK-14): a separate booked counter-entry with the inverse amount on the
 *    same account, the same end-to-end ID or reference, within 60 days after the original;
 *  - Geldtransit pairs (F07 BNK-061, EC-144): a transfer between two own accounts arriving as two transactions —
 *    the inverse amount in another own account of the same currency on the same booking date, an exchange between
 *    pockets (same booking date, EUR side × rate ≈ foreign side), or a counterparty IBAN that is an own account.
 */
import { type CalendarDate, daysBetween, formatGermanDate } from "../time/calendar-date";
import { formatMoneyDe } from "./amount";
import { normaliseIban, normaliseText } from "./normalise";

export interface LinkRow {
  id: string;
  accountId: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  purpose: string;
  reference?: string;
  endToEndId?: string;
  counterpartyIban?: string;
  instructedAmount?: { amountMinor: number; currency: string };
  /** Card payments: the merchant (EC-BNK-27 card refunds carry no reference to the original). */
  merchantName?: string;
  reversal?: boolean;
  reversalOfId?: string;
  status: string;
}

export const REVERSAL_WINDOW_DAYS = 60;

const merchantKey = (m: string | undefined) => normaliseText(m).replace(/ /g, "");

/** Same card merchant on both rows (EC-BNK-27 card refunds carry no reference to the original). */
const sameMerchant = (a: Pick<LinkRow, "merchantName">, b: Pick<LinkRow, "merchantName">) =>
  !!a.merchantName && merchantKey(a.merchantName) === merchantKey(b.merchantName);

/** EC-BNK-27: the counter-entry is a card refund of the original — a credit from the same merchant. */
export function isCardRefund(
  counter: Pick<LinkRow, "merchantName" | "amountCents">,
  original: Pick<LinkRow, "merchantName">,
): boolean {
  return counter.amountCents > 0 && sameMerchant(counter, original);
}

export interface ReversalCandidate {
  originalId: string;
  label: string;
  reasons: ("end_to_end_id" | "reference" | "purpose" | "merchant" | "reversal_flag")[];
}

/** Originals that `counter` may reverse, best first. */
export function findReversalCandidates(counter: LinkRow, rows: readonly LinkRow[]): ReversalCandidate[] {
  if (counter.reversalOfId) return [];
  const out: (ReversalCandidate & { score: number; date: string })[] = [];
  for (const o of rows) {
    if (o.id === counter.id || o.accountId !== counter.accountId || o.currency !== counter.currency) continue;
    if (o.amountCents !== -counter.amountCents || o.reversal) continue;
    const days = daysBetween(o.bookingDate as CalendarDate, counter.bookingDate as CalendarDate);
    if (days < 0 || days > REVERSAL_WINDOW_DAYS) continue;
    if (rows.some((r) => r.reversalOfId === o.id)) continue;
    const reasons: ReversalCandidate["reasons"] = [];
    if (counter.endToEndId && counter.endToEndId === o.endToEndId) reasons.push("end_to_end_id");
    if (counter.reference && counter.reference === o.reference) reasons.push("reference");
    if (normaliseText(o.purpose) && normaliseText(counter.purpose).includes(normaliseText(o.purpose)))
      reasons.push("purpose");
    // EC-BNK-27: a card refund without a link to the original — same merchant and the inverse amount (suggestion only).
    if (sameMerchant(counter, o)) reasons.push("merchant");
    if (reasons.length === 0) continue;
    if (counter.reversal) reasons.push("reversal_flag");
    out.push({
      originalId: o.id,
      label: `${isCardRefund(counter, o) ? "Kartenerstattung" : "Rückbuchung"} von ${formatGermanDate(o.bookingDate as CalendarDate)} ${formatMoneyDe(o.amountCents, o.currency)}`,
      reasons,
      score: reasons.length,
      date: o.bookingDate,
    });
  }
  return out
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .map(({ score: _s, date: _d, ...c }) => c);
}

export interface TransferCandidate {
  peerId: string;
  reason: "inverse_amount" | "exchange" | "own_iban";
}

/** Counter transactions in other own accounts for a Geldtransit pair (BNK-061). */
export function findTransferCandidates(
  tx: LinkRow,
  rows: readonly LinkRow[],
  ownAccounts: readonly { id: string; iban?: string; currency: string }[],
): TransferCandidate[] {
  const out: TransferCandidate[] = [];
  const ownIban = tx.counterpartyIban
    ? ownAccounts.find(
        (a) =>
          a.iban && normaliseIban(a.iban) === normaliseIban(tx.counterpartyIban as string) && a.id !== tx.accountId,
      )
    : undefined;
  for (const r of rows) {
    if (r.id === tx.id || r.accountId === tx.accountId || r.bookingDate !== tx.bookingDate) continue;
    if (r.status !== "open" && r.status !== "transfer") continue;
    if (Math.sign(r.amountCents) === Math.sign(tx.amountCents)) continue;
    if (r.currency === tx.currency && r.amountCents === -tx.amountCents) {
      out.push({ peerId: r.id, reason: ownIban?.id === r.accountId ? "own_iban" : "inverse_amount" });
      continue;
    }
    // Exchange between pockets: the instructed (other-currency) amount of one side equals the other side.
    const a = tx.instructedAmount;
    const b = r.instructedAmount;
    if (
      (a && a.currency === r.currency && a.amountMinor === Math.abs(r.amountCents)) ||
      (b && b.currency === tx.currency && b.amountMinor === Math.abs(tx.amountCents))
    ) {
      out.push({ peerId: r.id, reason: "exchange" });
    }
  }
  return out;
}
