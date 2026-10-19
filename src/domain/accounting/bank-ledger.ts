/**
 * Default ledger account (Finanzkonto) for a bank account (F01 SET-053, SET-050a; DATEV-02): 1200 in SKR03 (the
 * default chart), 1800 in SKR04, then the next free account of the chart's bank range.
 */
export type Chart = "SKR03" | "SKR04";

/** Bank account ranges of the standard charts (SKR03 1200–1299, SKR04 1800–1899). */
export const BANK_LEDGER_RANGE: Readonly<Record<Chart, { first: number; last: number }>> = {
  SKR03: { first: 1200, last: 1299 },
  SKR04: { first: 1800, last: 1899 },
};

export function defaultBankLedgerAccount(chart: Chart, used: readonly string[]): string | null {
  const { first, last } = BANK_LEDGER_RANGE[chart];
  const taken = new Set(used);
  for (let n = first; n <= last; n++) if (!taken.has(String(n))) return String(n);
  return null;
}

/**
 * ACC-027 (P1 → P2 bank catch-up): in P1 only invoice matches, bank marks and cash transfers are journalised, so a
 * bank ledger account is incomplete while the account has transactions without a journal posting (`open`,
 * `partially_matched`). From P2 every booked transaction is posted and RI-27 becomes a pre-lock blocker.
 */
export const UNJOURNALISED_TX_STATUSES: readonly string[] = ["open", "partially_matched"];

export const bankLedgerIncomplete = (statuses: Iterable<string>): boolean => {
  for (const s of statuses) if (UNJOURNALISED_TX_STATUSES.includes(s)) return true;
  return false;
};

/**
 * BNK-001: a chosen ledger account of a bank/clearing/PayPal account must lie in the chart's bank range and be unique
 * across bank accounts and the cash account. Returns the German error or null.
 */
export function bankLedgerAccountProblem(
  chart: Chart,
  account: string,
  used: readonly string[],
  cashAccount: string | null,
): string | null {
  const { first, last } = BANK_LEDGER_RANGE[chart];
  const n = Number(account);
  if (!Number.isInteger(n) || n < first || n > last) {
    return `Das Finanzkonto muss im Bereich ${first}–${last} (${chart}) liegen.`;
  }
  if (account === cashAccount) return `Konto ${account} ist das Kassenkonto.`;
  if (used.includes(account)) return `Konto ${account} ist bereits einem anderen Konto zugeordnet.`;
  return null;
}
