/**
 * VAT rate keys (F03 PRD-020, 03 §0.2 `VatRateKey`, UST-15). Products and lines carry a key; the rate is resolved
 * by the supply date (DOC-13, PRD-021). A rate change is new data, never new code (MISC-09).
 *
 * Rows before 2021 reproduce the temporary 2020 reduction and the 2020–2023 restaurant rates, so imported or late
 * documents for those supply dates resolve correctly (F09 sevdesk import, UST-01 late invoices).
 */
import { formatBasisPoints } from "../money/format";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { VatCategory } from "../tax/vat-category";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import {
  defineRuleTable,
  lookupRule,
  lookupRuleForPeriod,
  type PeriodLookupError,
  type RuleMissing,
  type RuleOverride,
  type RuleRow,
  type RuleTable,
} from "./rule-table";

export interface VatRateValue {
  readonly category: Extract<VatCategory, "S" | "Z" | "E">;
  readonly rateBp: number;
}

const S = (rateBp: number): VatRateValue => ({ category: "S", rateBp });

export const VAT_RATE_KEYS = {
  standard: defineRuleTable<VatRateValue>("standard", [
    {
      validFrom: "2007-01-01",
      validTo: "2020-06-30",
      value: S(1900),
      source: "§ 12 Abs. 1 UStG (19 % seit 01.01.2007, Haushaltsbegleitgesetz 2006, BGBl. 2006 I S. 1402)",
    },
    {
      validFrom: "2020-07-01",
      validTo: "2020-12-31",
      value: S(1600),
      source: "§ 28 Abs. 1 UStG i. d. F. Zweites Corona-Steuerhilfegesetz vom 29.06.2020 (BGBl. 2020 I S. 1512)",
    },
    { validFrom: "2021-01-01", value: S(1900), source: "§ 12 Abs. 1 UStG" },
  ]),
  reduced: defineRuleTable<VatRateValue>("reduced", [
    { validFrom: "2007-01-01", validTo: "2020-06-30", value: S(700), source: "§ 12 Abs. 2 UStG mit Anlage 2" },
    {
      validFrom: "2020-07-01",
      validTo: "2020-12-31",
      value: S(500),
      source: "§ 28 Abs. 2 UStG i. d. F. Zweites Corona-Steuerhilfegesetz vom 29.06.2020 (BGBl. 2020 I S. 1512)",
    },
    { validFrom: "2021-01-01", value: S(700), source: "§ 12 Abs. 2 UStG mit Anlage 2" },
  ]),
  // Restaurant and catering services, drinks excluded (drinks are separate products keyed `standard`, PRD-026).
  restaurant_food: defineRuleTable<VatRateValue>("restaurant_food", [
    {
      validFrom: "2007-01-01",
      validTo: "2020-06-30",
      value: S(1900),
      source: "§ 12 Abs. 1 UStG (Restaurant- und Verpflegungsdienstleistungen zum Regelsteuersatz)",
    },
    {
      validFrom: "2020-07-01",
      validTo: "2020-12-31",
      value: S(500),
      source:
        "§ 12 Abs. 2 Nr. 15 i. V. m. § 28 Abs. 2 UStG (Corona-Steuerhilfegesetz, BGBl. 2020 I S. 1385; Zweites Corona-Steuerhilfegesetz, BGBl. 2020 I S. 1512)",
    },
    {
      validFrom: "2021-01-01",
      validTo: "2023-12-31",
      value: S(700),
      source:
        "§ 12 Abs. 2 Nr. 15 UStG a. F. (verlängert durch Drittes Corona-Steuerhilfegesetz, BGBl. 2021 I S. 330, und Gesetz vom 19.10.2022, BGBl. 2022 I S. 1743)",
    },
    {
      validFrom: "2024-01-01",
      validTo: "2025-12-31",
      value: S(1900),
      source: "§ 12 Abs. 1 UStG (Befristung des § 12 Abs. 2 Nr. 15 UStG zum 31.12.2023 ausgelaufen)",
    },
    {
      validFrom: "2026-01-01",
      value: S(700),
      source: "§ 12 Abs. 2 Nr. 15 UStG i. d. F. StÄndG 2025 (BGBl. 2025 I Nr. 363); Getränke ausgenommen",
    },
  ]),
  zero: defineRuleTable<VatRateValue>("zero", [
    {
      validFrom: "2023-01-01",
      value: { category: "Z", rateBp: 0 },
      source: "§ 12 Abs. 3 UStG i. d. F. JStG 2022 (BGBl. 2022 I S. 2294) — Photovoltaikanlagen",
    },
  ]),
  exempt: defineRuleTable<VatRateValue>("exempt", [
    {
      validFrom: "2007-01-01",
      value: { category: "E", rateBp: 0 },
      source: "§ 4 UStG (Befreiungsgrund je Position, VATEX-Code und Hinweistext erforderlich, PRD-024)",
    },
  ]),
} as const satisfies Record<string, RuleTable<VatRateValue>>;

export type VatRateKey = keyof typeof VAT_RATE_KEYS;

/** German labels for selects (F03 §6); the rate itself always comes from the table. */
export const VAT_RATE_KEY_LABELS: Readonly<Record<VatRateKey, string>> = {
  standard: "Standard",
  reduced: "Ermäßigt",
  restaurant_food: "Speisen in der Gastronomie",
  zero: "PV-Nullsatz",
  exempt: "Steuerfrei (§ 4 UStG)",
};

export const isVatRateKey = (key: string): key is VatRateKey => Object.hasOwn(VAT_RATE_KEYS, key);

type UnknownKey = Issue<"vat_key_invalid">;
const unknownKey = (key: string): UnknownKey => issue("vat_key_invalid", "Unbekannter Steuersatz-Schlüssel.", { key });

/** Rate for a single supply date. */
export function lookupVatRate(
  key: string,
  supplyDate: CalendarDate,
  overrides: readonly RuleOverride<VatRateValue>[] = [],
): Result<RuleRow<VatRateValue>, UnknownKey | RuleMissing> {
  return isVatRateKey(key) ? lookupRule(VAT_RATE_KEYS[key], supplyDate, overrides) : err(unknownKey(key));
}

/** Rate valid throughout a supply period (month or range); a change inside → `rule_changes_in_period` (EC-024). */
export function lookupVatRateForPeriod(
  key: string,
  from: CalendarDate,
  to: CalendarDate,
  overrides: readonly RuleOverride<VatRateValue>[] = [],
): Result<RuleRow<VatRateValue>, UnknownKey | PeriodLookupError> {
  return isVatRateKey(key) ? lookupRuleForPeriod(VAT_RATE_KEYS[key], from, to, overrides) : err(unknownKey(key));
}

/**
 * RI-22 / F04 `rate_not_valid_for_date`: the stored category and rate of a line must equal the rule row for its key
 * at the supply date (or period). Returns the matching row ID for the snapshot (DOC-13).
 */
export function checkStoredRate(
  key: string,
  from: CalendarDate,
  to: CalendarDate,
  stored: VatRateValue | { readonly category: VatCategory; readonly rateBp: number },
  overrides: readonly RuleOverride<VatRateValue>[] = [],
): Result<string, UnknownKey | PeriodLookupError | Issue<"rate_not_valid_for_date">> {
  const r = lookupVatRateForPeriod(key, from, to, overrides);
  if (!r.ok) return r;
  const expected = r.value.value;
  if (expected.category === stored.category && expected.rateBp === stored.rateBp) return ok(r.value.rowId);
  const when = from === to ? formatGermanDate(from) : `${formatGermanDate(from)}–${formatGermanDate(to)}`;
  return err(
    issue(
      "rate_not_valid_for_date",
      `Der Steuersatz ${formatBasisPoints(stored.rateBp)} % gilt nicht für das Leistungsdatum ${when} (richtig: ${formatBasisPoints(expected.rateBp)} %).`,
      { key, expectedRowId: r.value.rowId, expectedRateBp: expected.rateBp, storedRateBp: stored.rateBp },
    ),
  );
}
