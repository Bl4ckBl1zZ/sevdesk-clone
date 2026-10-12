/**
 * Role → account resolution (F08 ACC-008, 03 §8 `accountRoleMappings`): the latest owner override with
 * `validFrom` ≤ posting date per (chart, role) wins over the shipped mapping valid on that date; `bank.<id>` uses
 * the bank account's own ledger account. UNSURE roles without an override block the posting (TST-ACC-39).
 */

import { err, type Issue, issue, ok, type Result } from "../result";
import {
  type Chart,
  type ChartAccount,
  chartAccounts,
  lookupRoleMapping,
  type RoleMappingRow,
} from "../rules/accounting";
import type { CalendarDate } from "../time/calendar-date";
import type { RoleLine } from "./post";
import { parseRole, roleLabel, STATIC_ROLES, UNCERTAIN_ROLES } from "./roles";

/** An owner override row of `accountRoleMappings` (source "override"). */
export interface RoleOverride {
  chart: Chart;
  role: string;
  account: string;
  validFrom: string;
  mappingVersion: string;
  sourceText?: string;
}

export interface ResolveContext {
  chart: Chart;
  date: CalendarDate;
  overrides: readonly RoleOverride[];
  bankAccounts: readonly { id: string; ledgerAccount: string; archived?: boolean }[];
}

export type ResolveIssue = Issue<"role_unmapped" | "account_unknown" | "account_archived" | "rule_missing">;

export interface ResolvedLine extends RoleLine {
  account: string;
}

export const roleUnmappedIssue = (role: string): ResolveIssue =>
  issue(
    "role_unmapped",
    `Für „${roleLabel(role)}“ ist noch kein Konto zugeordnet. Bitte unter Buchhaltung → Konten → Rollen ein Konto anlegen oder zuordnen.`,
    { role },
  );

/** Every account that can be posted to on `date`: the chart seed plus the bank accounts' ledger accounts. */
export function postableAccounts(ctx: ResolveContext): Result<Map<string, ChartAccount | null>, ResolveIssue> {
  const seed = chartAccounts(ctx.chart, ctx.date);
  if (!seed.ok) return err(seed.error);
  const map = new Map<string, ChartAccount | null>(seed.value.map((a) => [a.number, a]));
  for (const b of ctx.bankAccounts) if (!map.has(b.ledgerAccount)) map.set(b.ledgerAccount, null);
  return ok(map);
}

function latestOverride(ctx: ResolveContext, role: string): RoleOverride | undefined {
  let best: RoleOverride | undefined;
  for (const o of ctx.overrides) {
    if (o.chart !== ctx.chart || o.role !== role || o.validFrom > ctx.date) continue;
    if (
      !best ||
      o.validFrom > best.validFrom ||
      (o.validFrom === best.validFrom && o.mappingVersion > best.mappingVersion)
    ) {
      best = o;
    }
  }
  return best;
}

export interface RoleResolution {
  account: string | null;
  source: "seed" | "override" | "bank";
  version: string;
  uncertain: boolean;
}

export function resolveRole(role: string, ctx: ResolveContext): Result<RoleResolution, ResolveIssue> {
  const parsed = parseRole(role);
  if (parsed.kind === "bank") {
    const bank = ctx.bankAccounts.find((b) => b.id === parsed.bankAccountId);
    if (!bank) return err(issue("account_unknown", "Das Bankkonto ist nicht eingerichtet.", { role }));
    if (bank.archived) {
      return err(
        issue("account_archived", `Konto ${bank.ledgerAccount} ist archiviert und kann nicht bebucht werden.`),
      );
    }
    return ok({ account: bank.ledgerAccount, source: "bank", version: "bank", uncertain: false });
  }
  if (parsed.kind === "unknown") return err(issue("account_unknown", `Unbekannte Kontenrolle „${role}“.`, { role }));
  const override = latestOverride(ctx, role);
  if (override)
    return ok({ account: override.account, source: "override", version: override.mappingVersion, uncertain: false });
  const seed = lookupRoleMapping(ctx.date);
  if (!seed.ok) return err(seed.error);
  const row = seed.value.value.rows.find((r: RoleMappingRow) => r.role === role);
  return ok({
    account: row?.[ctx.chart] ?? null,
    source: "seed",
    version: seed.value.value.version,
    uncertain: UNCERTAIN_ROLES.includes(role),
  });
}

/**
 * Resolves every line to an account of the chart valid on the posting date. Fails on unmapped roles
 * (UNSURE without override), unknown or archived accounts (E-ACC-06).
 */
export function resolveLines(
  lines: readonly RoleLine[],
  ctx: ResolveContext,
): Result<{ lines: ResolvedLine[]; roleMappingVersion: string }, ResolveIssue> {
  const accounts = postableAccounts(ctx);
  if (!accounts.ok) return accounts;
  const versions = new Set<string>();
  const seedVersion = lookupRoleMapping(ctx.date);
  const out: ResolvedLine[] = [];
  for (const l of lines) {
    let account = l.account;
    if (account === undefined) {
      if (!l.role) return err(issue("account_unknown", "Buchungszeile ohne Konto und Rolle."));
      const r = resolveRole(l.role, ctx);
      if (!r.ok) return r;
      if (r.value.account === null) return err(roleUnmappedIssue(l.role));
      if (r.value.source === "override") versions.add(r.value.version);
      account = r.value.account;
    }
    if (!accounts.value.has(account)) {
      return err(
        issue("account_unknown", `Konto ${account} ist im Kontenrahmen ${ctx.chart} nicht vorhanden.`, { account }),
      );
    }
    out.push({ ...l, account });
  }
  const base = seedVersion.ok ? seedVersion.value.value.version : "unknown";
  const roleMappingVersion = versions.size > 0 ? `${base}+${[...versions].sort().join("+")}` : base;
  return ok({ lines: out, roleMappingVersion });
}

/** „Rollen & Standardkonten“ (F08 §6): every static role with its current account and badges. */
export interface RoleMappingView {
  role: string;
  label: string;
  account: string | null;
  accountName: string | null;
  source: "seed" | "override";
  uncertain: boolean;
  unmapped: boolean;
  sourceText?: string;
}

export function roleMappingView(ctx: ResolveContext): RoleMappingView[] {
  const accounts = chartAccounts(ctx.chart, ctx.date);
  const names = new Map((accounts.ok ? accounts.value : []).map((a) => [a.number, a.name]));
  return STATIC_ROLES.map((role) => {
    const override = latestOverride(ctx, role);
    const r = resolveRole(role, ctx);
    const account = r.ok ? r.value.account : null;
    return {
      role,
      label: roleLabel(role),
      account,
      accountName: account ? (names.get(account) ?? null) : null,
      source: override ? "override" : "seed",
      uncertain: !override && UNCERTAIN_ROLES.includes(role),
      unmapped: account === null,
      ...(override?.sourceText ? { sourceText: override.sourceText } : {}),
    };
  });
}
