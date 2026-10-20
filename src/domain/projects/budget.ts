/**
 * Project budget monitoring (F11 PRJ-003, PRJ-016, E-PRJ-20). Pure.
 *
 * Consumption: hours budget = tracked minutes of all entries (billable and non-billable, PRJ-016); amount budget =
 * billable value of the entries (minutes × rate / 60) + invoiced fixed amounts. Notifications at 80 % and 100 %, once
 * per threshold and project; raising the budget below a reached threshold re-arms it.
 */
import { formatCents } from "../money";
import { exactTimeNetCents } from "./invoicing";
import { formatMinutes } from "./time-entries";

export const BUDGET_THRESHOLDS_BP = [8000, 10000] as const;
export type BudgetThresholdBp = (typeof BUDGET_THRESHOLDS_BP)[number];

export interface ProjectBudget {
  readonly kind: "hours" | "amount";
  /** Minutes (hours budget) or cents (amount budget). */
  readonly value: number;
}

export interface BudgetAlert {
  readonly thresholdBp: BudgetThresholdBp;
  readonly notifiedAt?: number | undefined;
}

export interface BudgetEntry {
  readonly durationMinutes: number;
  readonly billable: boolean;
  readonly hourlyRateMicros: number;
}

export interface BudgetStatus {
  readonly kind: "hours" | "amount";
  readonly consumed: number;
  readonly budget: number;
  /** consumed / budget in basis points (floored); 0 for a zero budget. */
  readonly ratioBp: number;
  readonly level: "ok" | "warning" | "exceeded";
  /** „6:00 h von 10:00 h“ / „1.200,00 € von 5.000,00 €“ */
  readonly label: string;
}

export function budgetConsumption(
  budget: ProjectBudget,
  entries: readonly BudgetEntry[],
  invoicedFixedCents = 0,
): number {
  if (budget.kind === "hours") return entries.reduce((s, e) => s + e.durationMinutes, 0);
  return (
    entries
      .filter((e) => e.billable)
      .reduce((s, e) => s + exactTimeNetCents(e.durationMinutes, e.hourlyRateMicros), 0) + invoicedFixedCents
  );
}

const fmt = (kind: ProjectBudget["kind"], v: number) => (kind === "hours" ? formatMinutes(v) : `${formatCents(v)} €`);

export function budgetStatus(budget: ProjectBudget, consumed: number): BudgetStatus {
  const ratioBp = budget.value > 0 ? Math.floor((consumed * 10_000) / budget.value) : 0;
  const level = ratioBp >= 10_000 ? "exceeded" : ratioBp >= 8000 ? "warning" : "ok";
  return {
    kind: budget.kind,
    consumed,
    budget: budget.value,
    ratioBp,
    level,
    label: `${fmt(budget.kind, consumed)} von ${fmt(budget.kind, budget.value)}`,
  };
}

/** Default alert list of a project (both thresholds armed). */
export const armedAlerts = (): BudgetAlert[] => BUDGET_THRESHOLDS_BP.map((thresholdBp) => ({ thresholdBp }));

/**
 * The thresholds to notify now (reached and not yet notified) and the updated alert list. Thresholds no longer
 * reached (budget raised) are re-armed.
 */
export function evaluateBudgetAlerts(
  alerts: readonly BudgetAlert[],
  ratioBp: number,
  now: number,
): { notify: BudgetThresholdBp[]; alerts: BudgetAlert[] } {
  const byThreshold = new Map(alerts.map((a) => [a.thresholdBp, a]));
  const notify: BudgetThresholdBp[] = [];
  const next: BudgetAlert[] = BUDGET_THRESHOLDS_BP.map((t) => {
    const a = byThreshold.get(t);
    if (ratioBp < t) return { thresholdBp: t };
    if (a?.notifiedAt !== undefined) return a;
    notify.push(t);
    return { thresholdBp: t, notifiedAt: now };
  });
  return { notify, alerts: next };
}

/** E-PRJ-20 text. */
export function budgetAlertText(projectName: string, thresholdBp: BudgetThresholdBp, status: BudgetStatus): string {
  return `Projekt ${projectName}: ${thresholdBp / 100} % des Budgets verbraucht (${status.label}).`;
}
