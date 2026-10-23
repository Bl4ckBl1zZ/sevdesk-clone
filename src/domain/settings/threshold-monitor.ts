import { lookupRule } from "../rules/rule-table";
import { BOOKKEEPING_DUTY_LIMITS } from "../rules/thresholds";
import { type EightHundredKInput, eightHundredKMonitor, type MonitorNotice } from "../tax/turnover";

/**
 * F01 SET-040 (AO-01): threshold monitor on the settings page and the dashboard — Gesamtumsatz of the prior and the
 * current year against the § 141 AO / § 241a HGB turnover limit (800 000 €) and the prior-year EÜR profit against the
 * profit limit (80 000 €). Limits come from the date-effective rule table of the year concerned. A warning only —
 * the monitor never blocks anything (`blocking` is always false). The notices are those of F08 TAX-013.
 */
export interface ThresholdBar {
  readonly key: "turnover_prior_year" | "turnover_current_year" | "profit_prior_year";
  readonly year: number;
  /** null = not known yet (no EÜR for the year). */
  readonly amountCents: number | null;
  readonly limitCents: number;
  /** Basis points of the limit (10 000 = 100 %). */
  readonly bp: number;
  readonly level: "ok" | "warn_80" | "exceeded" | "unknown";
}

export interface ThresholdMonitor {
  readonly bars: readonly ThresholdBar[];
  readonly notices: readonly MonitorNotice[];
  readonly blocking: false;
}

const bar = (key: ThresholdBar["key"], year: number, amountCents: number | null, limitCents: number): ThresholdBar => {
  if (amountCents === null) return { key, year, amountCents, limitCents, bp: 0, level: "unknown" };
  const bp = limitCents > 0 ? Math.floor((Math.max(0, amountCents) * 10_000) / limitCents) : 0;
  const level = amountCents > limitCents ? "exceeded" : bp >= 8000 ? "warn_80" : "ok";
  return { key, year, amountCents, limitCents, bp, level };
};

export function thresholdMonitor(i: EightHundredKInput): ThresholdMonitor {
  const year = Number(i.today.slice(0, 4));
  const limits = (y: number) => {
    const r = lookupRule(BOOKKEEPING_DUTY_LIMITS, `${y}-01-01`);
    return r.ok ? r.value.value : null;
  };
  const prior = limits(year - 1);
  const current = limits(year);
  const bars: ThresholdBar[] = [];
  if (prior) bars.push(bar("turnover_prior_year", year - 1, i.priorYearCents, prior.turnoverCents));
  if (current) bars.push(bar("turnover_current_year", year, i.currentYearCents, current.turnoverCents));
  if (prior) bars.push(bar("profit_prior_year", year - 1, i.priorYearProfitCents ?? null, prior.profitCents));
  return { bars, notices: eightHundredKMonitor(i), blocking: false };
}
