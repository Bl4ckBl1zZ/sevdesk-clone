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
