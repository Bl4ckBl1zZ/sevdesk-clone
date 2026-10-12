/**
 * Date-effective rule tables (ADR-005, 01 "Design rules" 1, F01 SET-120…124).
 *
 * Every rate, threshold and note text is a row `{ validFrom, validTo?, value, source }`. Rows are chosen by a
 * business date passed in by the caller (supply date, invoice date … — never "now"). Tables are validated when
 * they are defined (module load): no overlaps, no gaps (unless allowed), an open-ended row only at the end,
 * and a legal source on every row.
 *
 * Row IDs are `<tableId>@<validFrom>` for shipped rows (F03 §4.3) and `override:<id>` for owner overrides; each
 * document stores the row IDs it used (02 §5 "Rule versions", SET-122).
 */

import { err, type Issue, issue, ok, type Result } from "../result";
import { addDays, type CalendarDate, formatGermanDate, isCalendarDate } from "../time/calendar-date";

export interface RuleEntry<T> {
  readonly validFrom: CalendarDate;
  /** Inclusive; absent = open-ended (only allowed for the last row). */
  readonly validTo?: CalendarDate;
  readonly value: T;
  /** Legal source (statute, BGBl., BMF letter, Bundesbank publication, owner reference). */
  readonly source: string;
}

export interface RuleTable<T> {
  readonly id: string;
  /** Sorted by `validFrom`. */
  readonly entries: readonly RuleEntry<T>[];
}

/** Owner override (F01 SET-121): wins over shipped rows for its validity range (SET-122). */
export interface RuleOverride<T> extends RuleEntry<T> {
  readonly id: string;
}

export interface RuleRow<T> extends RuleEntry<T> {
  readonly rowId: string;
  readonly origin: "code" | "override";
}

export type RuleTableIssueCode =
  | "rule_table_empty"
  | "rule_date_invalid"
  | "rule_range_inverted"
  | "rule_overlap"
  | "rule_gap"
  | "rule_source_missing";

export interface RawRuleEntry<T> {
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly value: T;
  readonly source: string;
}

export class RuleTableError extends Error {
  readonly issues: readonly Issue<RuleTableIssueCode>[];
  constructor(tableId: string, issues: readonly Issue<RuleTableIssueCode>[]) {
    super(`rule table "${tableId}" is invalid: ${issues.map((i) => `${i.code} (${i.message})`).join("; ")}`);
    this.name = "RuleTableError";
    this.issues = issues;
  }
}

export const ruleRowId = (tableId: string, validFrom: string): string => `${tableId}@${validFrom}`;

/** Load-time validation; returns all problems (empty array = valid). */
export function validateRuleEntries<T>(
  tableId: string,
  entries: readonly RawRuleEntry<T>[],
  options: { allowGaps?: boolean } = {},
): Issue<RuleTableIssueCode>[] {
  const issues: Issue<RuleTableIssueCode>[] = [];
  const at = (e: RawRuleEntry<T>) => ruleRowId(tableId, e.validFrom);
  if (entries.length === 0) return [issue("rule_table_empty", `${tableId} has no rows`)];
  for (const e of entries) {
    if (!isCalendarDate(e.validFrom) || (e.validTo !== undefined && !isCalendarDate(e.validTo))) {
      issues.push(issue("rule_date_invalid", `${at(e)}: invalid date`));
    } else if (e.validTo !== undefined && e.validTo < e.validFrom) {
      issues.push(issue("rule_range_inverted", `${at(e)}: validTo ${e.validTo} < validFrom`));
    }
    if (e.source.trim() === "") issues.push(issue("rule_source_missing", `${at(e)}: no legal source`));
  }
  if (issues.length > 0) return issues;
  const sorted = [...entries].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as RawRuleEntry<T>;
    const cur = sorted[i] as RawRuleEntry<T>;
    if (prev.validTo === undefined || prev.validTo >= cur.validFrom) {
      issues.push(issue("rule_overlap", `${at(prev)} overlaps ${at(cur)}`));
    } else if (!options.allowGaps && addDays(prev.validTo as CalendarDate, 1) !== cur.validFrom) {
      issues.push(issue("rule_gap", `gap between ${at(prev)} (until ${prev.validTo}) and ${at(cur)}`));
    }
  }
  return issues;
}

function sortedEntries<T>(entries: readonly RawRuleEntry<T>[]): RuleEntry<T>[] {
  return [...entries]
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0))
    .map((e) => ({
      validFrom: e.validFrom as CalendarDate,
      ...(e.validTo === undefined ? {} : { validTo: e.validTo as CalendarDate }),
      value: e.value,
      source: e.source,
    }));
}

/** Defines (and validates) a shipped table; throws `RuleTableError` at module load if the data is inconsistent. */
export function defineRuleTable<T>(
  id: string,
  entries: readonly RawRuleEntry<T>[],
  options: { allowGaps?: boolean } = {},
): RuleTable<T> {
  const issues = validateRuleEntries(id, entries, options);
  if (issues.length > 0) throw new RuleTableError(id, issues);
  return { id, entries: sortedEntries(entries) };
}

const covers = (e: RuleEntry<unknown>, date: CalendarDate) =>
  e.validFrom <= date && (e.validTo === undefined || date <= e.validTo);

function checkedOverrides<T>(tableId: string, overrides: readonly RuleOverride<T>[]): readonly RuleOverride<T>[] {
  if (overrides.length === 0) return overrides;
  const issues = validateRuleEntries(`${tableId} overrides`, overrides, { allowGaps: true });
  if (issues.length > 0) throw new RuleTableError(`${tableId} overrides`, issues);
  return overrides;
}

function effectiveRow<T>(
  table: RuleTable<T>,
  date: CalendarDate,
  overrides: readonly RuleOverride<T>[],
): RuleRow<T> | null {
  const o = overrides.find((e) => covers(e, date));
  if (o) {
    const { id, ...entry } = o;
    return { ...entry, rowId: `override:${id}`, origin: "override" };
  }
  const e = table.entries.find((x) => covers(x, date));
  return e ? { ...e, rowId: ruleRowId(table.id, e.validFrom), origin: "code" } : null;
}

export type RuleMissing = Issue<"rule_missing">;

const missing = (tableId: string, date: CalendarDate): RuleMissing =>
  issue(
    "rule_missing",
    `Für ${formatGermanDate(date)} ist keine Regel „${tableId}“ hinterlegt. Bitte unter Einstellungen › Regeln ergänzen.`,
    { tableId, date },
  );

/** The row valid on `date` (override first). `rule_missing` if no row covers it — never a guess (EC-127). */
export function lookupRule<T>(
  table: RuleTable<T>,
  date: CalendarDate,
  overrides: readonly RuleOverride<T>[] = [],
): Result<RuleRow<T>, RuleMissing> {
  const row = effectiveRow(table, date, checkedOverrides(table.id, overrides));
  return row ? ok(row) : err(missing(table.id, date));
}

export type PeriodLookupError = RuleMissing | Issue<"rule_changes_in_period"> | Issue<"period_inverted">;

/**
 * The single row valid **throughout** `from … to` (both inclusive). If the effective row changes inside the period,
 * the caller must split it (F03 PRD-021, 10 EC-024/EC-025): `rule_changes_in_period` with the first change date.
 */
export function lookupRuleForPeriod<T>(
  table: RuleTable<T>,
  from: CalendarDate,
  to: CalendarDate,
  overrides: readonly RuleOverride<T>[] = [],
): Result<RuleRow<T>, PeriodLookupError> {
  if (to < from) {
    return err(issue("period_inverted", "Das Ende des Leistungszeitraums liegt vor dem Beginn.", { from, to }));
  }
  const checked = checkedOverrides(table.id, overrides);
  const first = effectiveRow(table, from, checked);
  if (!first) return err(missing(table.id, from));
  const boundaries = [...table.entries, ...checked]
    .flatMap((e) => [e.validFrom, ...(e.validTo === undefined ? [] : [addDays(e.validTo, 1)])])
    .filter((b) => b > from && b <= to)
    .sort();
  for (const b of boundaries) {
    const row = effectiveRow(table, b, checked);
    if (row?.rowId !== first.rowId) {
      if (!row) return err(missing(table.id, b));
      return err(
        issue(
          "rule_changes_in_period",
          `Im Leistungszeitraum ändert sich „${table.id}“ am ${formatGermanDate(b)}. Bitte die Position in zwei Zeiträume aufteilen.`,
          { tableId: table.id, changeDate: b },
        ),
      );
    }
  }
  return ok(first);
}
