/**
 * Depreciation plans (F08 AST-004…AST-008, AO-03; posting matrix D1–D3). Pure, integer cents, EN 16931 half-up.
 *
 *  - linear: monthly pro rata from the acquisition month (that month counts fully); cost − Erinnerungswert over the
 *    useful life, rounded per month, the last month absorbs the remainder (AST-004).
 *  - degressive: per fiscal year book value × rate × months/12 (pro rata temporis in the first year), switch to
 *    linear (remaining book value / remaining life) in the first year where linear ≥ degressive (§ 7 Abs. 3 EStG);
 *    the yearly amount is spread over the months of the year (AST-005).
 *  - ev_special: share of cost per fiscal year from the rule row (75/10/5/5/3/2 %), no pro rata in year 1 (AST-006).
 *  - gwg: full write-off in the acquisition month (AST-007, D2).
 *  - pool: 20 % per fiscal year for 5 years, posted in the last month of each fiscal year (AST-008, D3).
 */
import { fiscalYearOf } from "../accounting/period";
import { roundHalfAway } from "../money";
import { err, issue, ok, type Result } from "../result";
import { ASSET_MESSAGES, type AssetIssue, type AssetMethod } from "./methods";

export interface PlanInput {
  acquisitionDate: string;
  costCents: number;
  method: AssetMethod;
  usefulLifeMonths?: number;
  degressiveRateBp?: number;
  evScheduleBp?: readonly number[];
  /** 1 € Erinnerungswert stays on the account (AST-004; default off for EÜR). */
  erinnerungswert?: boolean;
  /** Default 1 (calendar year). */
  fiscalYearStartMonth?: number;
}

export interface PlanRow {
  /** `YYYY-MM` the amount belongs to. */
  period: string;
  amountCents: number;
  bookValueAfterCents: number;
  fiscalYear: number;
  /** Degressive: first year on linear (AST-005). */
  switchedToLinear?: true;
}

export const ERINNERUNGSWERT_CENTS = 100;
const POOL_YEARS = 5;

const round = (n: bigint, d: bigint) => Number(roundHalfAway(n, d));

function addMonth(period: string, k: number): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7)) - 1 + k;
  const yy = y + Math.floor(m / 12);
  const mm = (((m % 12) + 12) % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}`;
}

/** Splits `amount` evenly over `months` (rounded), the last month absorbs the remainder. */
function spread(amount: number, months: readonly string[]): { period: string; amountCents: number }[] {
  if (months.length === 0) return [];
  const per = round(BigInt(amount), BigInt(months.length));
  return months.map((period, i) => ({
    period,
    amountCents: i === months.length - 1 ? amount - per * (months.length - 1) : per,
  }));
}

/** Months from `start` grouped by fiscal year (in order). */
function groupByFiscalYear(start: string, count: number, fyStart: number): string[][] {
  const groups: string[][] = [];
  let currentFy: number | null = null;
  for (let i = 0; i < count; i++) {
    const p = addMonth(start, i);
    const fy = fiscalYearOf(`${p}-01`, fyStart);
    if (fy !== currentFy) {
      groups.push([]);
      currentFy = fy;
    }
    groups[groups.length - 1]?.push(p);
  }
  return groups;
}

/** Months of the fiscal year containing `period`, starting at `period`. */
function restOfFiscalYear(period: string, fyStart: number): string[] {
  const out = [period];
  const fy = fiscalYearOf(`${period}-01`, fyStart);
  for (let p = addMonth(period, 1); fiscalYearOf(`${p}-01`, fyStart) === fy; p = addMonth(p, 1)) out.push(p);
  return out;
}

function withBookValues(
  cost: number,
  rows: { period: string; amountCents: number; switchedToLinear?: true }[],
  fyStart: number,
): PlanRow[] {
  let bv = cost;
  return rows.map((r) => {
    bv -= r.amountCents;
    return {
      period: r.period,
      amountCents: r.amountCents,
      bookValueAfterCents: bv,
      fiscalYear: fiscalYearOf(`${r.period}-01`, fyStart),
      ...(r.switchedToLinear ? { switchedToLinear: true as const } : {}),
    };
  });
}

/** The depreciation plan of an asset (planned AfA per month; AST-013 compares it with the posted entries). */
export function depreciationPlan(input: PlanInput): Result<PlanRow[], AssetIssue> {
  const cost = input.costCents;
  if (!Number.isSafeInteger(cost) || cost <= 0) {
    return err(issue("asset_invalid", "Die Anschaffungskosten müssen größer als 0 sein."));
  }
  const fyStart = input.fiscalYearStartMonth ?? 1;
  const start = input.acquisitionDate.slice(0, 7);
  const residual = input.erinnerungswert ? Math.min(ERINNERUNGSWERT_CENTS, cost) : 0;

  switch (input.method) {
    case "gwg":
      return ok(withBookValues(cost, [{ period: start, amountCents: cost }], fyStart));

    case "pool": {
      const firstYearEnd = restOfFiscalYear(start, fyStart).at(-1) as string;
      const per = round(BigInt(cost) * 2000n, 10_000n);
      const rows = Array.from({ length: POOL_YEARS }, (_, i) => ({
        period: addMonth(firstYearEnd, 12 * i),
        amountCents: i === POOL_YEARS - 1 ? cost - per * (POOL_YEARS - 1) : per,
      }));
      return ok(withBookValues(cost, rows, fyStart));
    }

    case "linear": {
      const n = input.usefulLifeMonths;
      if (!n || n <= 0) return err(issue("E-AST-11", ASSET_MESSAGES.usefulLife));
      const months = Array.from({ length: n }, (_, i) => addMonth(start, i));
      return ok(withBookValues(cost, spread(cost - residual, months), fyStart));
    }

    case "degressive": {
      const n = input.usefulLifeMonths;
      if (!n || n <= 0) return err(issue("E-AST-11", ASSET_MESSAGES.usefulLife));
      const rate = input.degressiveRateBp;
      if (!rate || rate <= 0) return err(issue("asset_invalid", "Der degressive AfA-Satz fehlt."));
      const groups = groupByFiscalYear(start, n, fyStart);
      const rows: { period: string; amountCents: number; switchedToLinear?: true }[] = [];
      let bv = cost;
      let remaining = n;
      let switched = false;
      groups.forEach((months, i) => {
        const m = months.length;
        let amount: number;
        let switchedNow = false;
        if (i === groups.length - 1) {
          amount = bv - residual;
        } else {
          const degressive = round(BigInt(bv) * BigInt(rate) * BigInt(m), 120_000n);
          const linear = round(BigInt(bv - residual) * BigInt(m), BigInt(remaining));
          if (!switched && linear >= degressive) {
            switched = true;
            switchedNow = true;
          }
          amount = Math.min(switched ? linear : degressive, bv - residual);
        }
        const split = spread(amount, months);
        if (switchedNow && split[0]) rows.push({ ...split[0], switchedToLinear: true }, ...split.slice(1));
        else rows.push(...split);
        bv -= amount;
        remaining -= m;
      });
      return ok(withBookValues(cost, rows, fyStart));
    }

    case "ev_special": {
      const schedule = input.evScheduleBp;
      if (!schedule?.length) return err(issue("asset_invalid", "Der AfA-Plan der Sonder-AfA fehlt."));
      const rows: { period: string; amountCents: number }[] = [];
      let bv = cost;
      let yearStart = start;
      schedule.forEach((bp, i) => {
        const months = restOfFiscalYear(yearStart, fyStart);
        const amount =
          i === schedule.length - 1
            ? bv - residual
            : Math.min(round(BigInt(cost) * BigInt(bp), 10_000n), bv - residual);
        rows.push(...spread(amount, months));
        bv -= amount;
        yearStart = addMonth(months.at(-1) as string, 1);
      });
      return ok(withBookValues(cost, rows, fyStart));
    }
  }
}

/** Σ planned AfA up to and including `period`. */
export function sumThrough(plan: readonly PlanRow[], period: string): number {
  return plan.filter((r) => r.period <= period).reduce((s, r) => s + r.amountCents, 0);
}

// ── AST-013: planned vs posted, AfA forecast ──────────────────────────────────────────────────────────

export interface DepreciationTableRow extends PlanRow {
  status: "posted" | "planned";
}

/** AST-013: the plan of one asset with each month marked as posted (journal) or still planned. */
export function depreciationTable(
  plan: readonly PlanRow[],
  postedPeriods: ReadonlySet<string>,
): DepreciationTableRow[] {
  return plan.map((r) => ({ ...r, status: postedPeriods.has(r.period) ? "posted" : "planned" }));
}

export interface AfaForecast {
  year: number;
  /** AfA of the year already posted. */
  postedCents: number;
  /** Planned AfA of the whole year (posted + still planned). */
  plannedYearCents: number;
  /** Planned AfA of the year not posted yet. */
  remainingCents: number;
  /** Planned AfA per month of the year (all 12 months). */
  byMonth: { period: string; cents: number }[];
}

/**
 * AST-013: AfA forecast of a calendar year over all assets (feeds the tax reserve, RPT-010). Uses the plan rows,
 * so one-off write-offs (GWG, e-vehicle year 1) land in their month instead of being spread.
 */
export function afaForecast(
  assets: readonly { plan: readonly PlanRow[]; postedPeriods: ReadonlySet<string> }[],
  year: number,
): AfaForecast {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const byMonth = new Map(months.map((m) => [m, 0]));
  let posted = 0;
  let remaining = 0;
  for (const a of assets) {
    for (const r of a.plan) {
      if (!byMonth.has(r.period)) continue;
      byMonth.set(r.period, (byMonth.get(r.period) ?? 0) + r.amountCents);
      if (a.postedPeriods.has(r.period)) posted += r.amountCents;
      else remaining += r.amountCents;
    }
  }
  return {
    year,
    postedCents: posted,
    plannedYearCents: posted + remaining,
    remainingCents: remaining,
    byMonth: months.map((m) => ({ period: m, cents: byMonth.get(m) ?? 0 })),
  };
}
