/**
 * Which ledger accounts a voucher line may carry (F06 VOU-002, VOU-011, VOU-024, EC-VOU-37/38).
 *
 *  - System accounts posted only by bank/cash functions (cash, Geldtransit, bank ledger accounts, private and
 *    shareholder accounts) are reserved (EC-VOU-38).
 *  - Receivables/payables, VAT accounts (except Einfuhrumsatzsteuer on purchases, VOU-024), advances and opening
 *    accounts are never line accounts; expense vouchers take expense accounts, fixed-asset accounts (class 0) and
 *    pass-through accounts (Durchlaufende Posten, VOU-011); income vouchers take revenue and pass-through accounts
 *    (EC-VOU-37).
 * The chart seed and the resolved role accounts are passed in (`src/domain/rules/accounting`, F08 ACC-008). Pure.
 */
import { type Issue, issue } from "../result";
import { type Chart, type ChartAccount, chartAccounts, lookupRoleMapping } from "../rules/accounting";
import type { CalendarDate } from "../time/calendar-date";
import { TAX_RULE_LABEL_DE } from "./tax-rules";
import type { TaxRule, VoucherDirection } from "./types";

export interface AccountContext {
  chart: Chart;
  /** Chart seed valid on the voucher date. */
  accounts: readonly ChartAccount[];
  /** Resolved account per static role (null = unmapped), e.g. from `resolveRole`. */
  roleAccounts: Readonly<Record<string, string | null>>;
  /** Ledger accounts of the `bankAccounts` rows. */
  bankLedgerAccounts: readonly string[];
}

const RESERVED_ROLES = [
  "cash",
  "transit",
  "private.withdrawal",
  "private.deposit",
  "private.taxes",
  "shareholder.clearing",
];
const BLOCKED_ROLE_PREFIXES = ["receivable", "payable", "vat.", "advance.", "opening."];

/** Accounts behind roles matching the predicate. */
function roleAccountsWhere(ctx: AccountContext, pred: (role: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const [role, account] of Object.entries(ctx.roleAccounts)) if (account && pred(role)) out.add(account);
  return out;
}

export const isFixedAssetAccount = (a: Pick<ChartAccount, "number" | "type">): boolean =>
  a.type === "asset" && a.number.startsWith("0");

export type AccountIssue = Issue<"account_reserved" | "account_not_allowed" | "account_unknown">;

const DIRECTION_DE: Record<VoucherDirection, string> = { expense: "Ausgaben", income: "Einnahmen" };

/** EC-VOU-37/38 for one line account. */
export function checkLineAccount(
  account: string,
  v: { direction: VoucherDirection; taxRule: TaxRule },
  ctx: AccountContext,
): AccountIssue | null {
  const reserved = roleAccountsWhere(ctx, (r) => RESERVED_ROLES.includes(r));
  for (const b of ctx.bankLedgerAccounts) reserved.add(b);
  if (reserved.has(account)) {
    return issue(
      "account_reserved",
      `Das Konto ${account} wird nur über Bankfunktionen gebucht (Privat/Geldtransit).`,
      {
        account,
      },
    );
  }
  const notAllowed = () =>
    issue(
      "account_not_allowed",
      `Das Konto ${account} ist für ${DIRECTION_DE[v.direction]} mit Steuerregel ${TAX_RULE_LABEL_DE[v.taxRule]} nicht zulässig.`,
      { account },
    );
  const importVat = ctx.roleAccounts["vat.import"];
  if (v.direction === "expense" && importVat && account === importVat) return null; // VOU-024
  if (roleAccountsWhere(ctx, (r) => BLOCKED_ROLE_PREFIXES.some((p) => r === p || r.startsWith(p))).has(account)) {
    return notAllowed();
  }
  const seed = ctx.accounts.find((a) => a.number === account);
  if (!seed) {
    return issue("account_unknown", `Konto ${account} ist im Kontenrahmen ${ctx.chart} nicht vorhanden.`, { account });
  }
  if (seed.passThrough) return null; // VOU-011
  if (v.direction === "expense") return seed.type === "expense" || isFixedAssetAccount(seed) ? null : notAllowed();
  return seed.type === "revenue" ? null : notAllowed();
}

/** The accounts offered in the line account combobox for a direction and tax rule. */
export function allowedAccounts(
  v: { direction: VoucherDirection; taxRule: TaxRule },
  ctx: AccountContext,
): ChartAccount[] {
  return ctx.accounts.filter((a) => checkLineAccount(a.number, v, ctx) === null);
}

/**
 * EC-VOU-15: an income voucher on a revenue account of own sales (Erlöse aus Lieferungen/Leistungen) — own sales
 * must be invoiced with a gapless number (AO-04, UST-06). Interest, other income and pass-through accounts are fine.
 */
export function looksLikeOwnSales(account: string, ctx: AccountContext): boolean {
  const seed = ctx.accounts.find((a) => a.number === account);
  return seed?.type === "revenue" && seed.bwaGroup === "UMSATZ";
}

/**
 * The account context from the shipped chart seed and role mapping valid on `date`, with company role overrides
 * (`accountRoleOverrides`, ACC-008) applied. Null when no rule row covers the date.
 */
export function accountContextFor(
  chart: Chart,
  date: CalendarDate,
  opts: { bankLedgerAccounts?: readonly string[]; roleOverrides?: Readonly<Record<string, string | null>> } = {},
): AccountContext | null {
  const accounts = chartAccounts(chart, date);
  const mapping = lookupRoleMapping(date);
  if (!accounts.ok || !mapping.ok) return null;
  const roleAccounts: Record<string, string | null> = {};
  for (const row of mapping.value.value.rows) roleAccounts[row.role] = row[chart];
  Object.assign(roleAccounts, opts.roleOverrides ?? {});
  return { chart, accounts: accounts.value, roleAccounts, bankLedgerAccounts: opts.bankLedgerAccounts ?? [] };
}
