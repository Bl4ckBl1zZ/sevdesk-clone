/**
 * Custom Sachkonten (F08 ACC-009, GOBD-02; E-ACC-06/07). Pure: the caller passes the seeded accounts, the existing
 * custom accounts and whether an account has postings / is assigned to a role or bank account.
 *
 * - number: four digits within the chart's range for the type (E-ACC-07), not already used
 * - system (seeded) accounts are never deleted; any account with postings can only be archived; an archived account
 *   takes no new postings (E-ACC-06, enforced by the role/account resolution)
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { ACCOUNT_TYPE_LABEL, inAccountRange } from "../rules/accounting/ranges";
import {
  type AccountType,
  type BwaGroup,
  type Chart,
  type ChartAccount,
  EUER_KEYS,
  type EuerKey,
} from "../rules/accounting/types";

export interface CustomAccountInput {
  chart: Chart;
  number: string;
  name: string;
  type: AccountType;
  euerKey?: string;
  /** Default tax key offered in the manual entry editor (e.g. „USt19“, „VSt19“). */
  taxKeyDefault?: string;
}

export type AccountIssue = Issue<"E-ACC-07" | "account_exists" | "account_invalid" | "E-ACC-06" | "account_in_use">;

export const ACCOUNT_MESSAGES = {
  range: (nr: string, type: AccountType, chart: Chart) =>
    `Kontonummer ${nr} liegt nicht im zulässigen Bereich für ${ACCOUNT_TYPE_LABEL[type]} (${chart}).`,
  exists: (nr: string) => `Konto ${nr} ist bereits vorhanden.`,
  archived: (nr: string) => `Konto ${nr} ist archiviert und kann nicht bebucht werden.`,
  name: "Bitte eine Bezeichnung mit höchstens 40 Zeichen angeben.",
  euerKey: "Unbekannter EÜR-Schlüssel.",
  taxKey: "Unbekannter Steuerschlüssel.",
  systemDelete: (nr: string) => `Konto ${nr} gehört zum Kontenrahmen und kann nur archiviert werden.`,
  usedDelete: (nr: string) => `Konto ${nr} wurde bereits bebucht und kann nur archiviert werden.`,
  inUse: (nr: string, what: string) => `Konto ${nr} ist ${what} zugeordnet. Bitte zuerst die Zuordnung ändern.`,
} as const;

export const ACCOUNT_TAX_KEYS = ["USt19", "USt7", "VSt19", "VSt7"] as const;

const DEFAULT_EUER: Record<AccountType, EuerKey> = {
  asset: "NONE",
  liability: "NONE",
  equity: "NONE",
  revenue: "BE.SONSTIGE",
  expense: "BA.SONSTIGE",
  neutral: "NONE",
};

const DEFAULT_BWA: Record<AccountType, BwaGroup> = {
  asset: "NONE",
  liability: "NONE",
  equity: "NONE",
  revenue: "UMSATZ",
  expense: "SONSTIGE",
  neutral: "NONE",
};

/** Validates a new custom account and returns the account record (ChartAccount shape, `verified: true`). */
export function validateCustomAccount(
  input: CustomAccountInput,
  taken: ReadonlySet<string>,
): Result<ChartAccount & { taxKeyDefault?: string }, AccountIssue> {
  const number = input.number.trim();
  if (!inAccountRange(input.chart, input.type, number)) {
    return err(issue("E-ACC-07", ACCOUNT_MESSAGES.range(number, input.type, input.chart), { number }));
  }
  if (taken.has(number)) return err(issue("account_exists", ACCOUNT_MESSAGES.exists(number), { number }));
  const name = input.name.trim();
  if (name.length === 0 || name.length > 40) return err(issue("account_invalid", ACCOUNT_MESSAGES.name));
  const euerKey = (input.euerKey ?? DEFAULT_EUER[input.type]) as EuerKey;
  if (!(EUER_KEYS as readonly string[]).includes(euerKey))
    return err(issue("account_invalid", ACCOUNT_MESSAGES.euerKey));
  if (input.taxKeyDefault && !(ACCOUNT_TAX_KEYS as readonly string[]).includes(input.taxKeyDefault)) {
    return err(issue("account_invalid", ACCOUNT_MESSAGES.taxKey));
  }
  return ok({
    number,
    name,
    type: input.type,
    euerKey,
    bwaGroup: DEFAULT_BWA[input.type],
    verified: true,
    ...(input.taxKeyDefault ? { taxKeyDefault: input.taxKeyDefault } : {}),
  });
}

export type RemovalDecision = { action: "delete" } | { action: "archive" };

/**
 * ACC-009: what „Entfernen“ means for an account — custom and unused → delete; with postings or seeded → archive.
 * Accounts assigned to a role or a bank account cannot be archived (the postings would fail, E-ACC-06).
 */
export function removalOf(a: {
  number: string;
  isSystem: boolean;
  used: boolean;
  assignedTo?: string;
}): Result<RemovalDecision, AccountIssue> {
  if (a.assignedTo) return err(issue("account_in_use", ACCOUNT_MESSAGES.inUse(a.number, a.assignedTo)));
  if (!a.isSystem && !a.used) return ok({ action: "delete" });
  return ok({ action: "archive" });
}
