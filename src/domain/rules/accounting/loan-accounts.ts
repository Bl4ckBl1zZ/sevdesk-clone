/**
 * Default accounts for bank loans (F07 BNK-062): „Verbindlichkeiten gegenüber Kreditinstituten“ for the principal
 * and „Zinsen und ähnliche Aufwendungen“ for the interest, per chart (rule data, `loan-accounts-2026.1`). The owner
 * may pick another account of the chart per marking (e.g. a long-term loan account or a private lender).
 */
export const LOAN_ACCOUNTS_VERSION = "loan-accounts-2026.1";

export const LOAN_ACCOUNT_DEFAULTS = {
  SKR03: { loan: "0630", interest: "2100" },
  SKR04: { loan: "3150", interest: "7300" },
} as const satisfies Record<"SKR03" | "SKR04", { loan: string; interest: string }>;
