/**
 * Open Geldtransit (F07 BNK-061, CSH-024; F08 E-ACC-18/23/31). A transfer between own accounts — another pocket,
 * another own bank account or the till — posts each side to `transit` on its own date; the pair is linked when the
 * other side is marked. This module derives, without storage (like the statement to-do), which sides are still
 * unpaired and how loudly to say so, and decides whether a bank credit may be paired with a cash deposit. Pure;
 * `today` is the Europe/Berlin date.
 *
 *  - E-ACC-23: the counter side is missing for more than 3 days → „Gegenbuchung im Konto … fehlt“;
 *  - EC-BNK-68 / EC-CSH-15: still unpaired after more than 7 days → warning;
 *  - EC-BNK-20: an exchange into a currency for which no own account exists → warning at once;
 *  - E-ACC-31: a bank credit pairs with a cash deposit only for exactly the same amount (automatically only within
 *    10 days after the deposit).
 */
import { type CalendarDate, daysBetween, formatGermanDate } from "../time/calendar-date";
import { formatMoneyDe } from "./amount";

export const TRANSIT_COUNTERPART_DAYS = 3;
export const TRANSIT_OPEN_DAYS = 7;
export const DEPOSIT_PAIRING_DAYS = 10;

export interface TransitAccount {
  id: string;
  name: string;
  currency: string;
}

/** A bank row marked „Geldtransit“ (status `transfer`, not an ATM withdrawal into the till). */
export interface TransitBankRow {
  id: string;
  accountId: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  /** The other currency of an exchange between pockets (instructed/original amount). */
  instructedCurrency?: string;
  paired: boolean;
}

/** A „Bargeld eingezahlt“ cash transfer (CSH-024) whose bank credit may still be missing. */
export interface TransitCashDeposit {
  id: string;
  date: string;
  amountCents: number;
  bankAccountId: string;
  paired: boolean;
}

export type TransitWarningKind = "transit_unmapped" | "transit_missing" | "transit_open" | "cash_deposit_open";

export interface TransitWarning {
  id: string;
  kind: TransitWarningKind;
  accountId: string;
  date: string;
  severity: "info" | "warning";
  title: string;
}

const de = (d: string) => formatGermanDate(d as CalendarDate);
const age = (date: string, today: string) => daysBetween(date as CalendarDate, today as CalendarDate);

export const TRANSIT_MESSAGES = {
  unmapped: (currency: string) =>
    `Gegenbuchung in einem nicht übernommenen Konto (${currency}). Bitte Konto übernehmen.`,
  missing: (date: string, account: string, currency: string) =>
    `Devisentausch/Umbuchung vom ${de(date)}: Gegenbuchung im Konto ${account} (${currency}) fehlt.`,
  open: (date: string, amountCents: number, currency: string) =>
    `Geldtransit vom ${de(date)} über ${formatMoneyDe(Math.abs(amountCents), currency)} ohne Gegenbuchung.`,
  depositOpen: (date: string, amountCents: number) =>
    `Bareinzahlung vom ${de(date)} (${formatMoneyDe(amountCents, "EUR")}) noch nicht auf dem Bankkonto gefunden.`,
  depositMismatch: (creditCents: number, date: string, depositCents: number) =>
    `Der Betrag der Gutschrift (${formatMoneyDe(creditCents, "EUR")}) entspricht nicht der Bareinzahlung vom ${de(date)} (${formatMoneyDe(depositCents, "EUR")}).`,
  depositBefore: (date: string) => `Die Gutschrift liegt vor der Bareinzahlung vom ${de(date)}.`,
} as const;

export function transitWarnings(
  rows: readonly TransitBankRow[],
  deposits: readonly TransitCashDeposit[],
  accounts: readonly TransitAccount[],
  today: string,
): TransitWarning[] {
  const out: TransitWarning[] = [];
  for (const r of rows) {
    if (r.paired) continue;
    const counterCurrency = r.instructedCurrency ?? r.currency;
    const counter = accounts.filter((a) => a.id !== r.accountId && a.currency === counterCurrency);
    const base = { id: r.id, accountId: r.accountId, date: r.bookingDate };
    if (r.instructedCurrency && r.instructedCurrency !== r.currency && counter.length === 0) {
      out.push({
        ...base,
        kind: "transit_unmapped",
        severity: "warning",
        title: TRANSIT_MESSAGES.unmapped(counterCurrency),
      });
      continue;
    }
    const days = age(r.bookingDate, today);
    if (days > TRANSIT_OPEN_DAYS) {
      out.push({
        ...base,
        kind: "transit_open",
        severity: "warning",
        title: TRANSIT_MESSAGES.open(r.bookingDate, r.amountCents, r.currency),
      });
    } else if (days > TRANSIT_COUNTERPART_DAYS) {
      const name = counter.length === 1 ? (counter[0] as TransitAccount).name : "eines eigenen Kontos";
      out.push({
        ...base,
        kind: "transit_missing",
        severity: "info",
        title: TRANSIT_MESSAGES.missing(r.bookingDate, name, counterCurrency),
      });
    }
  }
  for (const d of deposits) {
    if (d.paired || age(d.date, today) <= TRANSIT_OPEN_DAYS) continue;
    out.push({
      id: d.id,
      kind: "cash_deposit_open",
      accountId: d.bankAccountId,
      date: d.date,
      severity: "warning",
      title: TRANSIT_MESSAGES.depositOpen(d.date, d.amountCents),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface DepositCredit {
  accountId: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
}

/**
 * Automatic pairing of a bank credit with an open cash deposit (CSH-024 T5 bank leg, E-ACC-31): same EUR account,
 * exactly the same amount, booked 0…10 days after the deposit, and only when exactly one deposit qualifies.
 */
export function autoDepositPair(credit: DepositCredit, deposits: readonly TransitCashDeposit[]): string | null {
  if (credit.amountCents <= 0 || credit.currency !== "EUR") return null;
  const hits = deposits.filter((d) => {
    if (d.paired || d.bankAccountId !== credit.accountId || d.amountCents !== credit.amountCents) return false;
    const days = age(d.date, credit.bookingDate);
    return days >= 0 && days <= DEPOSIT_PAIRING_DAYS;
  });
  return hits.length === 1 ? (hits[0] as TransitCashDeposit).id : null;
}

/** The owner pairs explicitly: the amount must be exactly the deposit's (E-ACC-31), never before the deposit. */
export function checkDepositPair(credit: DepositCredit, deposit: TransitCashDeposit): string | null {
  if (deposit.paired || deposit.bankAccountId !== credit.accountId || credit.currency !== "EUR") {
    return "Diese Bareinzahlung ist bereits zugeordnet oder gehört zu einem anderen Konto.";
  }
  if (credit.amountCents !== deposit.amountCents) {
    return TRANSIT_MESSAGES.depositMismatch(credit.amountCents, deposit.date, deposit.amountCents);
  }
  if (age(deposit.date, credit.bookingDate) < 0) return TRANSIT_MESSAGES.depositBefore(deposit.date);
  return null;
}
