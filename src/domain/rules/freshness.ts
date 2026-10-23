import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { BASISZINSSATZ } from "./basiszinssatz";
import {
  effectiveOverrides,
  groupOverrides,
  OVERRIDE_RULE_SET_LABEL_DE,
  overrideTable,
  type StoredOverride,
} from "./overrides";
import { lookupRule } from "./rule-table";

/**
 * F01 SET-124 / 02 §7 `rules.freshness` (weekly): (a) owner overrides that now duplicate a shipped row, (b) overrides a
 * later release contradicts for the same period (SET-E26: the override stays effective, the owner is told), and (c)
 * stale tables — the Basiszinssatz has no row for the current half-year from 2 January / 2 July on (F05 DUN-021).
 */
export interface FreshnessFinding {
  readonly code: "override_duplicates_shipped" | "override_differs_from_shipped" | "table_stale";
  readonly tableId: string;
  readonly overrideId?: string;
  readonly message: string;
}

const FAR_FUTURE = "9999-12-31";

/** Compares rule values ignoring the implied VAT category of a tax-rate override. */
function sameValue(shipped: unknown, override: StoredOverride["value"]): boolean {
  const s = shipped as Record<string, unknown>;
  if ("rateBp" in override) return s.rateBp === override.rateBp;
  return s.de === override.de && s.en === override.en;
}

export function rulesFreshness(overrides: readonly StoredOverride[], today: CalendarDate): FreshnessFinding[] {
  const out: FreshnessFinding[] = [];
  for (const o of effectiveOverrides(overrides)) {
    const table = overrideTable(o.ruleSet, o.tableId);
    if (!table) continue;
    const to = o.validTo ?? FAR_FUTURE;
    const overlapping = table.entries.filter((e) => e.validFrom <= to && (e.validTo ?? FAR_FUTURE) >= o.validFrom);
    if (overlapping.length === 0) continue;
    const label = `${OVERRIDE_RULE_SET_LABEL_DE[o.ruleSet]}${o.ruleSet === "basiszinssatz" ? "" : ` ${o.tableId}`} ab ${formatGermanDate(o.validFrom as CalendarDate)}`;
    if (overlapping.every((e) => sameValue(e.value, o.value))) {
      out.push({
        code: "override_duplicates_shipped",
        tableId: o.tableId,
        overrideId: o.id,
        message: `Ihre Überschreibung entspricht der ausgelieferten Regel — entfernen? (${label})`,
      });
    } else {
      out.push({
        code: "override_differs_from_shipped",
        tableId: o.tableId,
        overrideId: o.id,
        message: `Die ausgelieferte Regel weicht von Ihrer Überschreibung ab (${label}). Ihre Überschreibung bleibt wirksam; bitte prüfen, ob Korrekturen nötig sind.`,
      });
    }
  }
  // (c) Basiszinssatz half-year row, checked from the 2nd day of the half-year
  const halfStart = `${today.slice(0, 4)}-${today.slice(5, 7) < "07" ? "01" : "07"}-01` as CalendarDate;
  if (today >= addDays(halfStart, 1)) {
    const row = lookupRule(BASISZINSSATZ, halfStart, groupOverrides(overrides).basiszinssatz);
    if (!row.ok) {
      out.push({
        code: "table_stale",
        tableId: BASISZINSSATZ.id,
        message: `Der Basiszinssatz ab ${formatGermanDate(halfStart)} ist nicht hinterlegt. Bitte die Bundesbank-Bekanntgabe unter Einstellungen › Regeln ergänzen oder die App aktualisieren.`,
      });
    }
  }
  return out;
}
