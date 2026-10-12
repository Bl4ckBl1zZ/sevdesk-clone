/**
 * Basiszinssatz (§ 247 BGB) — F05 DUN-021, §4.7; MAHN-02. Half-year rows (changes on 1 January / 1 July),
 * published by the Deutsche Bundesbank. May be negative. Every row is closed at its half-year end, so a missing
 * row for a new half-year is detected (EC-127, EC-DUN-10) instead of silently extending the last value.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import {
  defineRuleTable,
  lookupRule,
  type RuleMissing,
  type RuleOverride,
  type RuleRow,
  type RuleTable,
} from "./rule-table";
import { lookupVerzugSurcharges } from "./thresholds";

export interface BasiszinssatzValue {
  readonly rateBp: number;
}

const BUBA = "Deutsche Bundesbank, Basiszinssatz nach § 247 BGB";

export const BASISZINSSATZ: RuleTable<BasiszinssatzValue> = defineRuleTable<BasiszinssatzValue>("basiszinssatz", [
  { validFrom: "2016-07-01", validTo: "2022-12-31", value: { rateBp: -88 }, source: BUBA },
  { validFrom: "2023-01-01", validTo: "2023-06-30", value: { rateBp: 162 }, source: BUBA },
  { validFrom: "2023-07-01", validTo: "2023-12-31", value: { rateBp: 312 }, source: BUBA },
  { validFrom: "2024-01-01", validTo: "2024-06-30", value: { rateBp: 362 }, source: BUBA },
  { validFrom: "2024-07-01", validTo: "2024-12-31", value: { rateBp: 337 }, source: BUBA },
  { validFrom: "2025-01-01", validTo: "2025-06-30", value: { rateBp: 227 }, source: BUBA },
  { validFrom: "2025-07-01", validTo: "2025-12-31", value: { rateBp: 127 }, source: BUBA },
  // LEGAL-OPEN: README A18 / F05 Q-02 — the 2026-01-01 value is inferred from MAHN-02's golden example
  // (10,27 % B2B in June 2026); verify against the Bundesbank publication before the P1 release.
  { validFrom: "2026-01-01", validTo: "2026-06-30", value: { rateBp: 127 }, source: `${BUBA} (zu verifizieren)` },
  {
    validFrom: "2026-07-01",
    validTo: "2026-12-31",
    value: { rateBp: 152 },
    source: `${BUBA}; Bekanntgabe zum 01.07.2026 (1,52 %)`,
  },
]);

const halfYearStart = (date: CalendarDate) => `${date.slice(0, 4)}-${date.slice(5, 7) < "07" ? "01" : "07"}-01`;

export type BasiszinssatzMissing = Issue<"basiszinssatz_missing">;

export function lookupBasiszinssatz(
  date: CalendarDate,
  overrides: readonly RuleOverride<BasiszinssatzValue>[] = [],
): Result<RuleRow<BasiszinssatzValue>, BasiszinssatzMissing> {
  const r = lookupRule(BASISZINSSATZ, date, overrides);
  if (r.ok) return r;
  const from = halfYearStart(date) as CalendarDate;
  return err(
    issue(
      "basiszinssatz_missing",
      `Der Basiszinssatz ab ${formatGermanDate(from)} ist nicht hinterlegt. Bitte unter Einstellungen › Regeln ergänzen.`,
      { date, halfYearStart: from },
    ),
  );
}

export interface DefaultInterestRate {
  /** Basiszinssatz + 5 (B2C) or + 9 (B2B) percentage points, in basis points. */
  readonly rateBp: number;
  readonly basiszinsRowId: string;
  readonly surchargeRowId: string;
}

/** Verzugszinssatz on `date` (§ 288 Abs. 1/2 BGB). The interest calculator splits periods at row changes (DUN-020). */
export function defaultInterestRateBp(
  date: CalendarDate,
  kind: "b2c" | "b2b",
  overrides: readonly RuleOverride<BasiszinssatzValue>[] = [],
): Result<DefaultInterestRate, BasiszinssatzMissing | RuleMissing> {
  const surcharge = lookupVerzugSurcharges(date);
  if (!surcharge.ok) return surcharge;
  const base = lookupBasiszinssatz(date, overrides);
  if (!base.ok) return base;
  const points = kind === "b2c" ? surcharge.value.value.b2cBp : surcharge.value.value.b2bBp;
  return ok({
    rateBp: base.value.value.rateBp + points,
    basiszinsRowId: base.value.rowId,
    surchargeRowId: surcharge.value.rowId,
  });
}
