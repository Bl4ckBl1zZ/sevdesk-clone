/**
 * Cash never-negative check (AO-05, F07 CSH-026 §4.7, RI-11, EC-149). The balance of the `cash` account, ordered by
 * (date, journal seq), must be ≥ 0 after **every** movement — a backdated outflow that dips the balance on a
 * later date is refused even if a later inflow cures it (golden C3). Pure; the journal model runs it inside the
 * posting mutation (serialisable, EC-151) and the invariant check runs it over the whole journal.
 */
import { formatEuro } from "../money";
import { type Issue, issue } from "../result";

export interface CashMovement {
  date: string;
  seq: number;
  /** Signed: debit on the cash account = +, credit = −. */
  amountCents: number;
}

export interface CashDip {
  date: string;
  seq: number;
  balanceCents: number;
}

const byDateSeq = (a: CashMovement, b: CashMovement) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq);

/** First movement after which the running balance is negative, or null. */
export function firstNegativeBalance(movements: readonly CashMovement[]): CashDip | null {
  let balance = 0;
  for (const m of [...movements].sort(byDateSeq)) {
    balance += m.amountCents;
    if (balance < 0) return { date: m.date, seq: m.seq, balanceCents: balance };
  }
  return null;
}

/** EC-CSH-08: the till changed between the check and the posting (a concurrent movement won, EC-151). */
export const CASH_CHANGED = "Der Kassenbestand hat sich geändert. Bitte erneut versuchen.";

/** EC-CSH-09 (GOBD-07): every cash movement references an invoice, a voucher or an Eigenbeleg. */
export const CASH_BELEG_REQUIRED = "Jede Kassenbewegung braucht einen Beleg (Rechnung, Beleg oder Eigenbeleg).";

export const de = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const money = (cents: number) => formatEuro(cents).replace("-", "−");

/** EC-CSH-01 / EC-CSH-02 / EC-CSH-04 messages. */
export function cashNegativeIssue(dip: CashDip, postingDate: string, reversal: boolean): Issue<"cash_negative"> {
  const params = { date: dip.date, balanceCents: dip.balanceCents };
  if (reversal) {
    return issue(
      "cash_negative",
      `Storno nicht möglich: Der Kassenbestand würde am ${de(dip.date)} negativ werden.`,
      params,
    );
  }
  if (dip.date === postingDate) {
    return issue(
      "cash_negative",
      `Der Kassenbestand würde negativ werden (${money(dip.balanceCents)} am ${de(dip.date)}). Bitte zuerst fehlende Bareinnahmen erfassen oder ‚privat bezahlt‘ wählen.`,
      params,
    );
  }
  return issue(
    "cash_negative",
    `Nicht möglich: Durch die Buchung zum ${de(postingDate)} wäre der Kassenbestand am ${de(dip.date)} negativ (${money(dip.balanceCents)}).`,
    params,
  );
}
