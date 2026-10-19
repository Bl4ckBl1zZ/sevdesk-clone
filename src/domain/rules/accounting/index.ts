/**
 * Accounting rule data as date-effective tables (ADR-005, F08 §4.1, CLAUDE.md rule 2): the SKR03/SKR04 chart seeds
 * and the role mapping. A new DATEV chart release or a changed default mapping is a new row with its `validFrom`,
 * never a code change. Postings resolve the row valid on their business date.
 */

import { err, ok, type Result } from "../../result";
import type { CalendarDate } from "../../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleRow, type RuleTable } from "../rule-table";
import { ROLE_MAPPING_ROWS, ROLE_MAPPING_VERSION } from "./role-mapping";
import { SKR03_ACCOUNTS } from "./skr03";
import { SKR04_ACCOUNTS } from "./skr04";
import type { Chart, ChartAccount, ChartSeed, RoleMappingSeed } from "./types";

export { GOODS_EXPENSE_ACCOUNTS } from "./goods-accounts";
export { ROLE_MAPPING_ROWS, ROLE_MAPPING_VERSION } from "./role-mapping";
export * from "./types";

/**
 * Earliest supported posting date. Older business events (imported history) are archived records without journal
 * entries (EC-190, ACC-014 Buchungsbeginn), so no older chart release is shipped.
 */
export const ACCOUNTING_RULES_FROM = "2020-01-01";

const CHART_SOURCE = (chart: Chart) =>
  `DATEV Standardkontenrahmen ${chart} (Stand 2025); Auswahl nach F08 §4.1.1/§4.1.3 (LEGAL-OPEN: F08-Q1, ohne Steuerberaterprüfung)`;

export const CHART_TABLES: Readonly<Record<Chart, RuleTable<ChartSeed>>> = {
  SKR03: defineRuleTable<ChartSeed>("chart-skr03", [
    {
      validFrom: ACCOUNTING_RULES_FROM,
      value: { chart: "SKR03", accounts: SKR03_ACCOUNTS },
      source: CHART_SOURCE("SKR03"),
    },
  ]),
  SKR04: defineRuleTable<ChartSeed>("chart-skr04", [
    {
      validFrom: ACCOUNTING_RULES_FROM,
      value: { chart: "SKR04", accounts: SKR04_ACCOUNTS },
      source: CHART_SOURCE("SKR04"),
    },
  ]),
};

export const ROLE_MAPPING_TABLE: RuleTable<RoleMappingSeed> = defineRuleTable<RoleMappingSeed>("account-roles", [
  {
    validFrom: ACCOUNTING_RULES_FROM,
    value: { version: ROLE_MAPPING_VERSION, rows: ROLE_MAPPING_ROWS },
    source:
      "F08 §4.1.1 Rollen und Standardkonten (Version roles-2026.2, entschiedene Standardwerte; ⚠ = LEGAL-OPEN F08-Q1)",
  },
]);

export const ACCOUNTING_RULE_TABLES: readonly RuleTable<unknown>[] = [
  CHART_TABLES.SKR03,
  CHART_TABLES.SKR04,
  ROLE_MAPPING_TABLE,
];

/** The chart seed valid on `date`. */
export function lookupChart(chart: Chart, date: CalendarDate): Result<RuleRow<ChartSeed>, RuleMissing> {
  return lookupRule(CHART_TABLES[chart], date);
}

/** The shipped role mapping valid on `date`. */
export function lookupRoleMapping(date: CalendarDate): Result<RuleRow<RoleMappingSeed>, RuleMissing> {
  return lookupRule(ROLE_MAPPING_TABLE, date);
}

/** Seeded account by number (chart release valid on `date`), or null. */
export function seededAccount(chart: Chart, date: CalendarDate, number: string): ChartAccount | null {
  const row = lookupChart(chart, date);
  if (!row.ok) return null;
  return row.value.value.accounts.find((a) => a.number === number) ?? null;
}

export function chartAccounts(chart: Chart, date: CalendarDate): Result<readonly ChartAccount[], RuleMissing> {
  const row = lookupChart(chart, date);
  return row.ok ? ok(row.value.value.accounts) : err(row.error);
}
