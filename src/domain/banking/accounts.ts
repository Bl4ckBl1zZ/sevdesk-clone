import { type Issue, issue } from "../result";

/**
 * Invoice bank accounts (F01 SET-051, SET-054, §5.4). Archiving sets `archivedAt`; the default invoice account
 * cannot be archived while it is the only account shown on invoices (`LAST_INVOICE_ACCOUNT`), and a default that
 * has alternatives must first hand the default over (SET-051: exactly one default per currency).
 */
export const LAST_INVOICE_ACCOUNT_MESSAGE =
  "Mindestens ein Konto muss auf Rechnungen angezeigt werden. Bitte zuerst ein anderes Konto als Standard festlegen.";

export interface AccountRef {
  id: string;
  currency: string;
  showOnInvoices: boolean;
  isDefaultForInvoices: boolean;
  archivedAt?: number;
}

export function checkArchiveAccount(
  account: AccountRef,
  all: readonly AccountRef[],
): Issue<"last_invoice_account" | "default_account" | "already_archived"> | null {
  if (account.archivedAt !== undefined) return issue("already_archived", "Das Konto ist bereits archiviert.");
  if (!account.isDefaultForInvoices) return null;
  const shown = all.filter((a) => a.id !== account.id && a.archivedAt === undefined && a.showOnInvoices);
  if (shown.length === 0) return issue("last_invoice_account", LAST_INVOICE_ACCOUNT_MESSAGE);
  return issue(
    "default_account",
    `Das Konto ist das Standardkonto für ${account.currency}. Bitte zuerst ein anderes Konto als Standard festlegen.`,
  );
}
