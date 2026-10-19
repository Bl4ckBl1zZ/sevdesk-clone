/**
 * Asset register rules (F08 AST-001, AST-003, AST-006…AST-008; AO-03; E-AST-01…05, 11, 15, 16). Pure.
 *
 * Methods are offered by the **acquisition date** from the date-effective tables `afa_rules` (degressive /
 * e-vehicle windows) and `asset_thresholds` (GWG / Sammelposten); the chosen row IDs become the asset's
 * `ruleVersion`. The GWG/Sammelposten choice for items 250,01–1.000 € is one choice per fiscal year (§ 6 Abs. 2a
 * S. 5 EStG), passed in as `yearPolicy` (companyProfile.assetPolicy).
 */
import type { AccountRole } from "../accounting/roles";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { Chart } from "../rules/accounting";
import { type AfaMethodRules, lookupAfaRules } from "../rules/afa";
import type { RuleOverride } from "../rules/rule-table";
import { type AssetThresholds, lookupAssetThresholds } from "../rules/thresholds";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export const ASSET_METHODS = ["linear", "degressive", "gwg", "pool", "ev_special"] as const;
export type AssetMethod = (typeof ASSET_METHODS)[number];
export type AssetClass = "movable" | "immovable" | "intangible";
export type YearChoice = "gwg" | "pool";

export const ASSET_METHOD_LABEL: Readonly<Record<AssetMethod, string>> = {
  linear: "Linear",
  degressive: "Degressiv",
  gwg: "GWG-Sofortabschreibung",
  pool: "Sammelposten",
  ev_special: "Sonder-AfA E-Fahrzeug",
};

export type AssetIssueCode =
  | "E-AST-01"
  | "E-AST-02"
  | "E-AST-03"
  | "E-AST-04"
  | "E-AST-05"
  | "E-AST-08"
  | "E-AST-10"
  | "E-AST-11"
  | "E-AST-15"
  | "asset_invalid"
  | "rule_missing";
export type AssetIssue = Issue<AssetIssueCode>;

/** Whole euros with German thousands separator („1.200“). */
const euros = (cents: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(cents / 100);
const de = (date: string) => formatGermanDate(date as CalendarDate);

export const ASSET_MESSAGES = {
  degressiveDate: (date: string) => `Degressive AfA ist für Anschaffungen am ${de(date)} nicht zulässig.`,
  degressiveClass: "Degressive AfA gilt nur für bewegliche Wirtschaftsgüter.",
  gwgLimit: (date: string, limitCents: number) =>
    `GWG-Grenze am ${de(date)}: ${euros(limitCents)} € netto. Dieses Wirtschaftsgut muss aktiviert werden.`,
  yearChoice: (year: number, choice: YearChoice) =>
    `Für ${year} wurde bereits ${choice === "pool" ? "Sammelposten" : "GWG"} gewählt. Die Wahl gilt einheitlich für alle Wirtschaftsgüter von 250,01 € bis 1.000 €.`,
  poolAbolished: (from: string) => `Sammelposten ist für Anschaffungen ab ${de(from)} nicht mehr zulässig.`,
  poolRange: "Ein Sammelposten ist nur für Wirtschaftsgüter von 250,01 € bis 1.000 € netto möglich.",
  usefulLife: "Bitte Nutzungsdauer angeben (AfA-Tabelle).",
  evQualified: "Die Sonder-AfA gilt nur für neue, rein elektrische Fahrzeuge.",
  evDate: (date: string) => `Die Sonder-AfA für E-Fahrzeuge ist für Anschaffungen am ${de(date)} nicht zulässig.`,
  evClass: "Die Sonder-AfA gilt nur für Fahrzeuge (bewegliche Wirtschaftsgüter).",
  costAfterAfa: "Anschaffungskosten können nach der ersten AfA nicht mehr geändert werden.",
  notDepreciable: "Dieses Konto ist kein abnutzbares Anlagekonto.",
  movableOnly: "GWG und Sammelposten gelten nur für bewegliche Wirtschaftsgüter.",
} as const;

// ── accounts → asset class and AfA role ─────────────────────────────────────────────────────────────────

const num = (account: string) => (/^\d{4}$/.test(account) ? Number(account) : Number.NaN);

/**
 * SKR03: 0001–0049 immaterielle WG, 0050–0199 Grundstücke/Gebäude, 0200–0499 technische Anlagen, Fuhrpark,
 * BGA (incl. GWG 0480 / Sammelposten 0485). SKR04: 0001–0199 immaterielle WG, 0200–0399 Grundstücke/Gebäude,
 * 0400–0799 Sachanlagen. Finanzanlagen and other accounts are not depreciable (null).
 */
export function assetClassOf(chart: Chart, account: string): AssetClass | null {
  const n = num(account);
  if (Number.isNaN(n) || n < 1) return null;
  if (chart === "SKR03") {
    if (n <= 49) return "intangible";
    if (n <= 199) return "immovable";
    if (n <= 499) return "movable";
    return null;
  }
  if (n <= 199) return "intangible";
  if (n <= 399) return "immovable";
  if (n <= 799) return "movable";
  return null;
}

const isVehicleAccount = (chart: Chart, account: string) => {
  const n = num(account);
  return chart === "SKR03" ? n >= 300 && n <= 399 : n >= 500 && n <= 599;
};

/** D1–D3: the expense role of the yearly AfA by method and asset account. */
export function afaRoleFor(method: AssetMethod, chart: Chart, account: string): AccountRole {
  if (method === "gwg") return "afa.gwg";
  if (method === "pool") return "afa.pool";
  if (assetClassOf(chart, account) === "intangible") return "afa.intangible";
  if (method === "ev_special" || isVehicleAccount(chart, account)) return "afa.vehicle";
  return "afa.tangible";
}

// ── methods valid on the acquisition date ───────────────────────────────────────────────────────────────

export interface MethodInput {
  acquisitionDate: CalendarDate;
  /** Acquisition cost of the item (net if input VAT deductible, else gross, E-AST-12). */
  costCents: number;
  assetClass: AssetClass;
  thresholdOverrides?: readonly RuleOverride<AssetThresholds>[];
  afaOverrides?: readonly RuleOverride<AfaMethodRules>[];
}

export interface MethodOption {
  method: AssetMethod;
  allowed: boolean;
  message?: string;
}

interface Rules {
  thresholds: AssetThresholds;
  thresholdRow: string;
  thresholdFrom: string;
  afa: AfaMethodRules;
  afaRow: string;
}

function rulesAt(input: MethodInput): Result<Rules, AssetIssue> {
  const t = lookupAssetThresholds(input.acquisitionDate, input.thresholdOverrides ?? []);
  if (!t.ok) return err(issue("rule_missing", t.error.message));
  const a = lookupAfaRules(input.acquisitionDate, input.afaOverrides ?? []);
  if (!a.ok) return err(issue("rule_missing", a.error.message));
  return ok({
    thresholds: t.value.value,
    thresholdRow: t.value.rowId,
    thresholdFrom: t.value.validFrom,
    afa: a.value.value,
    afaRow: a.value.rowId,
  });
}

function methodCheck(method: AssetMethod, input: MethodInput, r: Rules): AssetIssue | null {
  const date = input.acquisitionDate;
  switch (method) {
    case "linear":
      return null;
    case "degressive":
      if (!r.afa.degressive) return issue("E-AST-01", ASSET_MESSAGES.degressiveDate(date), { date });
      if (input.assetClass !== "movable") return issue("E-AST-02", ASSET_MESSAGES.degressiveClass);
      return null;
    case "gwg":
      if (input.costCents > r.thresholds.gwgLimitCents) {
        return issue("E-AST-03", ASSET_MESSAGES.gwgLimit(date, r.thresholds.gwgLimitCents), {
          limitCents: r.thresholds.gwgLimitCents,
        });
      }
      if (input.assetClass === "immovable") return issue("asset_invalid", ASSET_MESSAGES.movableOnly);
      return null;
    case "pool":
      if (input.assetClass === "immovable") return issue("asset_invalid", ASSET_MESSAGES.movableOnly);
      if (r.thresholds.poolAllowed === false) {
        return issue("E-AST-05", ASSET_MESSAGES.poolAbolished(r.thresholdFrom), { from: r.thresholdFrom });
      }
      if (input.costCents <= r.thresholds.recordingLimitCents || input.costCents > r.thresholds.poolMaxCents) {
        return issue("asset_invalid", ASSET_MESSAGES.poolRange);
      }
      return null;
    case "ev_special":
      if (!r.afa.evSpecial) return issue("E-AST-15", ASSET_MESSAGES.evDate(date), { date });
      if (input.assetClass !== "movable") return issue("E-AST-15", ASSET_MESSAGES.evClass);
      return null;
  }
}

/** AST-003: the methods for the form, each with the reason when not offered. */
export function allowedMethods(input: MethodInput): MethodOption[] {
  const r = rulesAt(input);
  if (!r.ok) return ASSET_METHODS.map((method) => ({ method, allowed: false, message: r.error.message }));
  return ASSET_METHODS.map((method) => {
    const problem = methodCheck(method, input, r.value);
    return problem ? { method, allowed: false, message: problem.message } : { method, allowed: true };
  });
}

/** The yearly choice an item implies (only items in the 250,01–1.000 € band take part, § 6 Abs. 2a S. 5 EStG). */
export function yearChoiceOf(method: AssetMethod, costCents: number, t: AssetThresholds): YearChoice | null {
  if (t.poolAllowed === false) return null;
  if (costCents <= t.recordingLimitCents || costCents > t.poolMaxCents) return null;
  return method === "pool" ? "pool" : "gwg";
}

export interface SetupInput extends MethodInput {
  method: AssetMethod;
  usefulLifeMonths?: number;
  /** E-AST-15 checkbox „rein elektrisch, Neufahrzeug, betrieblich“. */
  evQualified?: boolean;
  /** The fiscal year's GWG/Sammelposten choice if already made (companyProfile.assetPolicy). */
  yearPolicy?: YearChoice;
  /** Fiscal year of the acquisition (for the E-AST-04 text); default = calendar year. */
  fiscalYear?: number;
}

export interface SetupDecision {
  degressiveRateBp?: number;
  evScheduleBp?: number[];
  /** Rule rows used (`asset_thresholds@…,afa_rules@…`). */
  ruleVersion: string;
  /** The yearly choice this item implies; the model stores it when the year has none yet. */
  yearChoice: YearChoice | null;
}

const MAX_LIFE_MONTHS = 1200;

/** AST-001/AST-003 validation of an asset setup; returns the method parameters to store. */
export function validateAssetSetup(input: SetupInput): Result<SetupDecision, AssetIssue> {
  if (!Number.isSafeInteger(input.costCents) || input.costCents <= 0) {
    return err(issue("asset_invalid", "Die Anschaffungskosten müssen größer als 0 sein."));
  }
  const rules = rulesAt(input);
  if (!rules.ok) return rules;
  const r = rules.value;
  const problem = methodCheck(input.method, input, r);
  if (problem) return err(problem);
  const needsLife = input.method === "linear" || input.method === "degressive";
  if (needsLife) {
    const n = input.usefulLifeMonths;
    if (n === undefined || !Number.isSafeInteger(n) || n <= 0) return err(issue("E-AST-11", ASSET_MESSAGES.usefulLife));
    if (n > MAX_LIFE_MONTHS) return err(issue("asset_invalid", "Die Nutzungsdauer ist unplausibel lang."));
  }
  if (input.method === "ev_special" && !input.evQualified) return err(issue("E-AST-15", ASSET_MESSAGES.evQualified));
  const yearChoice = yearChoiceOf(input.method, input.costCents, r.thresholds);
  if (yearChoice && input.yearPolicy && yearChoice !== input.yearPolicy) {
    const year = input.fiscalYear ?? Number(input.acquisitionDate.slice(0, 4));
    return err(issue("E-AST-04", ASSET_MESSAGES.yearChoice(year, input.yearPolicy), { year }));
  }
  const decision: SetupDecision = { ruleVersion: `${r.thresholdRow},${r.afaRow}`, yearChoice };
  if (input.method === "degressive" && r.afa.degressive && input.usefulLifeMonths) {
    const linearBp = Math.floor((r.afa.degressive.maxMultipleOfLinear * 120_000) / input.usefulLifeMonths);
    decision.degressiveRateBp = Math.min(r.afa.degressive.maxRateBp, linearBp);
  }
  if (input.method === "ev_special" && r.afa.evSpecial) decision.evScheduleBp = [...r.afa.evSpecial.scheduleBp];
  return ok(decision);
}
