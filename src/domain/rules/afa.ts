/**
 * Depreciation (AfA) rule data (F08 AST-003, AO-03, MISC-09; 01-compliance open item 4).
 *
 * `afaRules` holds the method windows that depend on the **acquisition date**: degressive AfA (§ 7 Abs. 2 EStG) and
 * the special AfA for new purely electric vehicles (§ 7 Abs. 2a EStG). The GWG / Sammelposten thresholds are the
 * shared `asset_thresholds` table in ./thresholds (also used by the voucher „Anlagegut?“ prompt) — one source.
 *
 * The JStG-2026 placeholder (GWG 1.200 €, Sammelposten abolished) ships **disabled**: it is an exported row outside
 * the table that a data release (or the owner's rule override, SET-121) activates once the law is enacted.
 */
import type { Result } from "../result";
import { type CalendarDate, calendarDate } from "../time/calendar-date";
import {
  defineRuleTable,
  lookupRule,
  type RuleEntry,
  type RuleMissing,
  type RuleOverride,
  type RuleRow,
} from "./rule-table";
import type { AssetThresholds } from "./thresholds";

export interface AfaMethodRules {
  /** Degressive AfA for movable assets: yearly rate = min(maxRateBp, maxMultipleOfLinear × linear rate). */
  readonly degressive: { readonly maxRateBp: number; readonly maxMultipleOfLinear: number } | null;
  /**
   * Special AfA for new, purely electric vehicles: share of the cost per year (year 1 = acquisition year),
   * `firstYearProRata` false = the full first-year share regardless of the acquisition month.
   */
  readonly evSpecial: { readonly scheduleBp: readonly number[]; readonly firstYearProRata: boolean } | null;
}

export const AFA_RULES = defineRuleTable<AfaMethodRules>("afa_rules", [
  {
    validFrom: "2018-01-01",
    validTo: "2025-06-30",
    value: { degressive: null, evSpecial: null },
    source:
      "§ 7 Abs. 1 EStG (lineare AfA); degressive AfA nur für Anschaffungen 2020–2022 (§ 7 Abs. 2 EStG a. F.), vor dem Buchungsbeginn nicht abgebildet",
  },
  {
    validFrom: "2025-07-01",
    validTo: "2027-12-31",
    value: {
      degressive: { maxRateBp: 3000, maxMultipleOfLinear: 3 },
      // LEGAL-OPEN: 01-compliance open item 4 — schedule and „no pro rata in year 1“ per § 7 Abs. 2a EStG
      // (Gesetz für ein steuerliches Investitionssofortprogramm, BGBl. 2025 I Nr. 161) to be re-verified.
      evSpecial: { scheduleBp: [7500, 1000, 500, 500, 300, 200], firstYearProRata: false },
    },
    source:
      "§ 7 Abs. 2 EStG (degressiv 30 %, höchstens das Dreifache der linearen AfA) und § 7 Abs. 2a EStG (E-Fahrzeuge 75/10/5/5/3/2 %) für Anschaffungen nach dem 30.06.2025 und vor dem 01.01.2028 (Investitionssofortprogramm, BGBl. 2025 I Nr. 161)",
  },
  {
    validFrom: "2028-01-01",
    value: { degressive: null, evSpecial: null },
    source: "§ 7 Abs. 1 EStG; Befristung des § 7 Abs. 2 und 2a EStG bis 31.12.2027",
  },
]);

export const lookupAfaRules = (
  date: CalendarDate,
  overrides: readonly RuleOverride<AfaMethodRules>[] = [],
): Result<RuleRow<AfaMethodRules>, RuleMissing> => lookupRule(AFA_RULES, date, overrides);

/**
 * JStG-2026 placeholder (AST-003, EC-175): GWG 1.200 €, no Sammelposten for acquisitions after 2026-12-31.
 * **Disabled** — not part of `asset_thresholds` until enacted; activate by adding it to the table in a data release.
 * LEGAL-OPEN: 01-compliance open item 4 (Jahressteuergesetz 2026 not enacted at the time of writing).
 */
export const JSTG_2026_ASSET_THRESHOLDS_DRAFT: RuleEntry<AssetThresholds> = {
  validFrom: calendarDate("2027-01-01"),
  value: { recordingLimitCents: 25_000, gwgLimitCents: 120_000, poolMaxCents: 100_000, poolAllowed: false },
  source: "Entwurf Jahressteuergesetz 2026 (§ 6 Abs. 2 und 2a EStG): GWG 1.200 €, Sammelposten entfällt — DEAKTIVIERT",
};

export interface UsefulLifeEntry {
  readonly key: string;
  readonly label: string;
  readonly months: number;
  /** Fundstelle (AfA-Tabelle AV Nr. or BMF letter). */
  readonly source: string;
}

/**
 * Excerpt of the BMF AfA-Tabelle für allgemein verwendbare Anlagegüter (AfA-Tabelle AV, BMF 15.12.2000) and the
 * BMF letter on digital assets (22.02.2022). The owner may always enter a custom useful life (AST-001).
 * LEGAL-OPEN: 01-compliance open item 4 — the 1-year life for digital assets is applied as linear monthly pro rata.
 */
export const USEFUL_LIFE_TABLE: readonly UsefulLifeEntry[] = [
  {
    key: "computer",
    label: "Computer, Notebook, Tablet, Peripherie",
    months: 12,
    source: "BMF 22.02.2022 (digitale WG)",
  },
  { key: "software", label: "Betriebs- und Anwendersoftware", months: 12, source: "BMF 22.02.2022 (digitale WG)" },
  { key: "smartphone", label: "Mobiltelefon, Smartphone", months: 60, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
  {
    key: "printer",
    label: "Drucker, Kopierer, Scanner (eigenständig)",
    months: 84,
    source: "AfA-Tabelle AV (BMF 15.12.2000)",
  },
  { key: "camera", label: "Foto-, Film-, Videogeräte", months: 84, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
  { key: "office_furniture", label: "Büromöbel", months: 156, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
  { key: "office_machine", label: "Sonstige Büromaschinen", months: 84, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
  { key: "car", label: "Personenkraftwagen", months: 72, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
  { key: "bicycle", label: "Fahrrad, E-Bike", months: 84, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
  { key: "tools", label: "Werkzeuge", months: 60, source: "AfA-Tabelle AV (BMF 15.12.2000)" },
];
