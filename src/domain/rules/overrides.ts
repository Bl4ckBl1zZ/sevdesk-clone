/**
 * Owner rule overrides (F01 SET-121…123, 03 §1 `ruleOverrides`, F01 §5.11 messages).
 *
 * The code-shipped tables stay authoritative; an override adds a row for an existing table that wins over the shipped
 * row for its validity range (SET-122). Every finalised document records the row IDs it used (`ruleVersions`); an
 * override referenced there is locked (SET-123, GOBD-06) — it is corrected by adding a new row, and only an
 * unreferenced override may be deleted (audited).
 *
 * Supported rule sets: `basiszinssatz`, `taxRate` (existing VAT keys with a standard-rated category) and `noteText`
 * (existing note ids). `ustvaMapping` is not offered: the UStVA form mapping is not modelled as a rule table yet.
 * LEGAL-OPEN: SET-121 ustvaMapping — add the rule set together with the UStVA mapping table (F08, P2).
 */
import { rateSuffix } from "../accounting/roles";
import { formatBasisPoints } from "../money/format";
import { type Issue, issue } from "../result";
import { type CalendarDate, isCalendarDate } from "../time/calendar-date";
import { BASISZINSSATZ, type BasiszinssatzValue } from "./basiszinssatz";
import { NOTE_TEXTS, type NoteTextId, type NoteTextValue } from "./note-texts";
import { lookupRule, type RuleOverride, type RuleTable, ruleRowId, validateRuleEntries } from "./rule-table";
import { VAT_RATE_KEYS, type VatRateValue } from "./vat-rates";

export const OVERRIDE_RULE_SETS = ["basiszinssatz", "taxRate", "noteText"] as const;
export type OverrideRuleSet = (typeof OVERRIDE_RULE_SETS)[number];

export const OVERRIDE_RULE_SET_LABEL_DE: Readonly<Record<OverrideRuleSet, string>> = {
  basiszinssatz: "Basiszinssatz (§ 247 BGB)",
  taxRate: "Steuersatz",
  noteText: "Hinweistext",
};

export type OverrideValue = { readonly rateBp: number } | { readonly de: string; readonly en: string };

/** A stored override row (`ruleOverrides`); `id` is the record id, the row id is `override:<id>`. */
export interface StoredOverride {
  readonly id: string;
  readonly ruleSet: OverrideRuleSet;
  /** The shipped table it extends: `basiszinssatz`, a VAT rate key or a note id. */
  readonly tableId: string;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly value: OverrideValue;
  readonly source: string;
}

export interface OverrideInput {
  readonly ruleSet: OverrideRuleSet;
  readonly tableId: string;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly rateBp?: number | undefined;
  readonly de?: string | undefined;
  readonly en?: string | undefined;
  readonly source: string;
}

export type OverrideIssueCode =
  | "SOURCE_REQUIRED"
  | "OUT_OF_RANGE"
  | "RULE_KEY_UNKNOWN"
  | "DATE_RANGE_INVALID"
  | "RULE_OVERLAP"
  | "VALUE_REQUIRED"
  | "PLACEHOLDER_MISSING";

export const overrideRowId = (id: string): string => `override:${id}`;

/** The shipped table an override of `ruleSet`/`tableId` extends; null for unknown keys. */
export function overrideTable(ruleSet: OverrideRuleSet, tableId: string): RuleTable<unknown> | null {
  if (ruleSet === "basiszinssatz") return tableId === BASISZINSSATZ.id ? (BASISZINSSATZ as RuleTable<unknown>) : null;
  if (ruleSet === "taxRate") {
    const t = (VAT_RATE_KEYS as Record<string, RuleTable<VatRateValue>>)[tableId];
    // Only standard-rated keys carry a rate that can change; zero-rated/exempt keys are fixed at 0 %.
    return t && t.entries.at(-1)?.value.category === "S" ? (t as RuleTable<unknown>) : null;
  }
  const n = (NOTE_TEXTS as Record<string, RuleTable<NoteTextValue>>)[tableId];
  return n ? (n as RuleTable<unknown>) : null;
}

/** Selectable tables per rule set (Einstellungen › Regeln). */
export function overrideTableIds(ruleSet: OverrideRuleSet): string[] {
  if (ruleSet === "basiszinssatz") return [BASISZINSSATZ.id];
  const ids = ruleSet === "taxRate" ? Object.keys(VAT_RATE_KEYS) : Object.keys(NOTE_TEXTS);
  return ids.filter((id) => overrideTable(ruleSet, id) !== null);
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];

export interface OverrideCheck {
  readonly value?: OverrideValue;
  readonly error?: Issue<OverrideIssueCode>;
  readonly warnings: readonly Issue[];
}

/**
 * Validates a new override against the shipped table and the existing overrides of the same table (F01 §5.11). The
 * overrides of one table must not overlap each other (otherwise every lookup of that table would fail).
 */
export function checkOverride(input: OverrideInput, existing: readonly StoredOverride[]): OverrideCheck {
  const warnings: Issue[] = [];
  const fail = (code: OverrideIssueCode, message: string, params?: Record<string, string | number>): OverrideCheck => ({
    error: issue(code, message, params),
    warnings,
  });
  const table = overrideTable(input.ruleSet, input.tableId);
  if (!table) {
    return fail(
      "RULE_KEY_UNKNOWN",
      input.ruleSet === "taxRate"
        ? `Unbekannter Steuersatz-Schlüssel ${input.tableId}.`
        : `Unbekannte Regel ${input.tableId}.`,
      { key: input.tableId },
    );
  }
  if (input.source.trim() === "") {
    return fail("SOURCE_REQUIRED", "Bitte eine Quelle angeben (z. B. Link zur Bundesbank-Mitteilung).");
  }
  if (!isCalendarDate(input.validFrom) || (input.validTo !== undefined && !isCalendarDate(input.validTo))) {
    return fail("DATE_RANGE_INVALID", "Bitte gültige Datumsangaben machen.");
  }
  if (input.validTo !== undefined && input.validTo < input.validFrom) {
    return fail("DATE_RANGE_INVALID", "Das Enddatum liegt vor dem Startdatum.");
  }
  let value: OverrideValue;
  if (input.ruleSet === "noteText") {
    const de = input.de?.trim() ?? "";
    const en = input.en?.trim() ?? "";
    if (!de || !en) return fail("VALUE_REQUIRED", "Bitte den Hinweistext auf Deutsch und Englisch angeben.");
    const shipped = lookupRule(table as RuleTable<NoteTextValue>, input.validFrom as CalendarDate);
    const reference = shipped.ok ? shipped.value.value : (table.entries.at(-1)?.value as NoteTextValue);
    for (const [lang, text] of [
      ["de", de],
      ["en", en],
    ] as const) {
      const missing = placeholders(reference[lang]).filter((p) => !placeholders(text).includes(p));
      if (missing.length > 0) {
        return fail(
          "PLACEHOLDER_MISSING",
          `Der Hinweistext (${lang.toUpperCase()}) muss die Platzhalter ${missing.map((p) => `{${p}}`).join(", ")} enthalten.`,
          { lang, placeholders: missing.join(",") },
        );
      }
    }
    if (reference.de.includes("§") && !de.includes("§")) {
      warnings.push(
        issue("NOTE_LEGAL_BASIS", "Der Hinweistext sollte die Rechtsgrundlage nennen (z. B. „§ 19 Abs. 1 UStG“)."),
      );
    }
    value = { de, en };
  } else {
    const rateBp = input.rateBp;
    if (rateBp === undefined || !Number.isInteger(rateBp)) {
      return fail("VALUE_REQUIRED", "Bitte einen Satz in Prozent angeben.");
    }
    if (input.ruleSet === "basiszinssatz") {
      if (rateBp < -1000 || rateBp > 2000)
        return fail("OUT_OF_RANGE", "Basiszinssatz außerhalb des plausiblen Bereichs.");
      const md = input.validFrom.slice(5);
      if (md !== "01-01" && md !== "07-01") {
        warnings.push(
          issue("BASISZINS_DATE", "Der Basiszinssatz ändert sich üblicherweise zum 1. Januar und 1. Juli (§ 247 BGB)."),
        );
      }
    } else if (rateBp < 0 || rateBp > 10_000) {
      return fail("OUT_OF_RANGE", `Steuersatz ${formatBasisPoints(rateBp)} % außerhalb des zulässigen Bereichs.`);
    } else if (rateSuffix(rateBp) === null) {
      // LEGAL-OPEN: F08-Q1 — the posting refuses rates without an account role rather than guessing an account.
      warnings.push(
        issue(
          "RATE_WITHOUT_ACCOUNT_ROLE",
          `Für den Steuersatz ${formatBasisPoints(rateBp)} % gibt es keine Kontenrolle. Rechnungen mit diesem Satz können erst nach einem Update gebucht und daher nicht fertiggestellt werden.`,
        ),
      );
    }
    value = { rateBp };
  }
  const sameTable = existing.filter((o) => o.ruleSet === input.ruleSet && o.tableId === input.tableId);
  const overlap = validateRuleEntries(
    `${input.tableId} overrides`,
    [...sameTable, { validFrom: input.validFrom, validTo: input.validTo, value, source: input.source }],
    { allowGaps: true },
  ).find((i) => i.code === "rule_overlap");
  if (overlap) {
    return fail(
      "RULE_OVERLAP",
      "Der Zeitraum überschneidet sich mit einer bestehenden Überschreibung. Bitte deren Gültigkeit beachten oder ein anderes Datum wählen.",
    );
  }
  return { value, warnings };
}

/** The lookup inputs of the domain functions (DocumentContext, snapshot builder, dunning claim). */
export interface GroupedOverrides {
  readonly vatRateOverrides: Readonly<Record<string, readonly RuleOverride<VatRateValue>[]>>;
  readonly noteOverrides: Partial<Record<NoteTextId, readonly RuleOverride<NoteTextValue>[]>>;
  readonly basiszinssatz: readonly RuleOverride<BasiszinssatzValue>[];
}

const entryOf = <T>(o: StoredOverride, value: T): RuleOverride<T> => ({
  id: o.id,
  validFrom: o.validFrom as CalendarDate,
  ...(o.validTo ? { validTo: o.validTo as CalendarDate } : {}),
  value,
  source: o.source,
});

export function groupOverrides(rows: readonly StoredOverride[]): GroupedOverrides {
  const vat: Record<string, RuleOverride<VatRateValue>[]> = {};
  const notes: Record<string, RuleOverride<NoteTextValue>[]> = {};
  const basis: RuleOverride<BasiszinssatzValue>[] = [];
  const sorted = [...rows].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  for (const o of sorted) {
    if (o.ruleSet === "basiszinssatz" && "rateBp" in o.value) basis.push(entryOf(o, { rateBp: o.value.rateBp }));
    if (o.ruleSet === "taxRate" && "rateBp" in o.value) {
      vat[o.tableId] = [...(vat[o.tableId] ?? []), entryOf(o, { category: "S" as const, rateBp: o.value.rateBp })];
    }
    if (o.ruleSet === "noteText" && "de" in o.value) {
      notes[o.tableId] = [...(notes[o.tableId] ?? []), entryOf(o, { de: o.value.de, en: o.value.en })];
    }
  }
  return { vatRateOverrides: vat, noteOverrides: notes as GroupedOverrides["noteOverrides"], basiszinssatz: basis };
}

/** SET-122: the Basiszinssatz rows a reminder's interest used, as `ruleVersions` entries. */
export function basiszinsRuleVersions(
  segments: readonly { readonly from: string; readonly basiszinsRowId: string }[],
): Record<string, string> {
  return Object.fromEntries(segments.map((s) => [`basiszins:${s.from}`, s.basiszinsRowId]));
}

/** SET-123: an override used by a finalised document (any `ruleVersions` value) is locked. */
export function overrideLockIssue(
  id: string,
  ruleVersions: Iterable<Readonly<Record<string, string>>>,
): Issue<"RULE_ROW_LOCKED"> | null {
  const rowId = overrideRowId(id);
  for (const rv of ruleVersions) {
    if (Object.values(rv).includes(rowId)) {
      return issue(
        "RULE_ROW_LOCKED",
        "Diese Regel wurde bereits in fertiggestellten Dokumenten verwendet. Bitte eine neue Zeile mit neuem Gültigkeitsdatum anlegen.",
      );
    }
  }
  return null;
}

// ── SET-120 overview (Einstellungen › Regeln) ──────────────────────────────────────────────────────────────────

export type RuleGroup = "taxRate" | "basiszinssatz" | "noteText" | "other";

export const RULE_GROUP_LABEL_DE: Readonly<Record<RuleGroup, string>> = {
  taxRate: "Steuersätze",
  basiszinssatz: "Basiszinssatz",
  noteText: "Hinweistexte",
  other: "Schwellenwerte und weitere Tabellen",
};

export interface RuleRowView {
  readonly rowId: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly value: string;
  readonly source: string;
  readonly origin: "code" | "override";
  /** The row effective today (override first). */
  readonly current: boolean;
  /** Override record id (deletion). */
  readonly overrideId?: string;
}

export interface RuleTableView {
  readonly id: string;
  readonly group: RuleGroup;
  /** Rule set an owner override may be added to (null = shipped only). */
  readonly overridable: OverrideRuleSet | null;
  readonly rows: readonly RuleRowView[];
}

/** Display text of a rule value: rates as percent, note texts in German, other values as compact JSON. */
export function ruleValueText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v.rateBp === "number" && Object.keys(v).every((k) => k === "rateBp" || k === "category")) {
      return `${formatBasisPoints(v.rateBp)} %${typeof v.category === "string" ? ` (${v.category})` : ""}`;
    }
    if (typeof v.de === "string") return v.de;
  }
  const json = JSON.stringify(value) ?? String(value);
  return json.length > 240 ? `${json.slice(0, 239)}…` : json;
}

function groupOf(table: RuleTable<unknown>): { group: RuleGroup; overridable: OverrideRuleSet | null } {
  if (table.id === BASISZINSSATZ.id) return { group: "basiszinssatz", overridable: "basiszinssatz" };
  if (table.id in VAT_RATE_KEYS && (VAT_RATE_KEYS as Record<string, unknown>)[table.id] === table) {
    return { group: "taxRate", overridable: overrideTable("taxRate", table.id) ? "taxRate" : null };
  }
  if (table.id in NOTE_TEXTS && (NOTE_TEXTS as Record<string, unknown>)[table.id] === table) {
    return { group: "noteText", overridable: "noteText" };
  }
  return { group: "other", overridable: null };
}

/** All shipped tables with their owner overrides merged in, the row effective `today` marked (SET-120). */
export function ruleOverview(
  tables: readonly RuleTable<unknown>[],
  overrides: readonly StoredOverride[],
  today: CalendarDate,
): RuleTableView[] {
  return tables.map((table) => {
    const { group, overridable } = groupOf(table);
    const own = overridable
      ? overrides.filter((o) => o.ruleSet === overridable && o.tableId === table.id)
      : ([] as StoredOverride[]);
    const effective = lookupRule(
      table,
      today,
      own.map((o) => entryOf(o, o.value as unknown)),
    );
    const currentId = effective.ok ? effective.value.rowId : null;
    const rows: RuleRowView[] = [
      ...table.entries.map((e) => ({
        rowId: ruleRowId(table.id, e.validFrom),
        validFrom: e.validFrom,
        ...(e.validTo ? { validTo: e.validTo } : {}),
        value: ruleValueText(e.value),
        source: e.source,
        origin: "code" as const,
        current: ruleRowId(table.id, e.validFrom) === currentId,
      })),
      ...own.map((o) => ({
        rowId: overrideRowId(o.id),
        validFrom: o.validFrom,
        ...(o.validTo ? { validTo: o.validTo } : {}),
        value: ruleValueText(
          overridable === "taxRate" && "rateBp" in o.value ? { category: "S", ...o.value } : o.value,
        ),
        source: o.source,
        origin: "override" as const,
        current: overrideRowId(o.id) === currentId,
        overrideId: o.id,
      })),
    ].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
    return { id: table.id, group, overridable, rows };
  });
}
