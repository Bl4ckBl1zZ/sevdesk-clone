/**
 * Asset disposal (F08 AST-010, EC-176; E-AST-06…09; posting matrix D4–D8). Pure.
 *
 * AfA runs up to and including the disposal month (catch-up of unposted plan months), then the remaining book value
 * (RBW) leaves the asset account. A Sammelposten item changes nothing (§ 6 Abs. 2a EStG, E-AST-07): the pool keeps
 * its 20 % rate, proceeds are revenue on the separate sales invoice.
 */
import { err, issue, ok, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import type { AssetIssue, AssetMethod } from "./methods";
import { type PlanRow, sumThrough } from "./schedule";

export type DisposalKind = "sale" | "scrap" | "withdrawal";

export const DISPOSAL_KIND_LABEL: Readonly<Record<DisposalKind, string>> = {
  sale: "Verkauf",
  scrap: "Verschrottung",
  withdrawal: "Entnahme",
};

export const POOL_DISPOSAL_INFO = "Der Sammelposten wird unverändert fortgeführt (§ 6 Abs. 2a EStG).";

export interface DisposalInput {
  method: AssetMethod;
  costCents: number;
  plan: readonly PlanRow[];
  /** Periods (`YYYY-MM`) with a posted AfA entry. */
  postedPeriods: readonly string[];
  /**
   * Acquisition date of the asset. A Sammelposten's plan starts at the fiscal year end (E-AST-07), so its first plan
   * row is not the acquisition month; without the date the first plan period is used.
   */
  acquisitionDate?: CalendarDate;
  disposal: {
    date: CalendarDate;
    kind: DisposalKind;
    /** Sale: net proceeds of the linked invoice. */
    proceedsNetCents?: number;
    /** Withdrawal: Teilwert (net). */
    teilwertCents?: number;
  };
}

export type DisposalPlan =
  | { kind: "pool_unchanged"; info: string }
  | {
      kind: "rbw";
      /** Unposted plan rows through the disposal month (E-AST-06). */
      catchUp: PlanRow[];
      afaThroughDisposalCents: number;
      rbwCents: number;
      /** Sale/withdrawal: proceeds (Teilwert) vs RBW; scrap: loss of the RBW. Equal → `loss` with 0 (D5 accounts). */
      result: { kind: "gain" | "loss"; gainCents: number; lossCents: number };
    };

const mmYyyy = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

export function planDisposal(input: DisposalInput): Result<DisposalPlan, AssetIssue> {
  const { disposal } = input;
  const month = disposal.date.slice(0, 7);
  const acquired = input.plan[0]?.period;
  if (input.acquisitionDate ? disposal.date < input.acquisitionDate : acquired && month < acquired) {
    return err(issue("asset_invalid", "Das Abgangsdatum liegt vor der Anschaffung."));
  }
  if (disposal.kind === "sale") {
    const p = disposal.proceedsNetCents;
    if (p === undefined || !Number.isSafeInteger(p) || p < 0) {
      return err(issue("asset_invalid", "Bitte den Nettoerlös aus der Verkaufsrechnung angeben."));
    }
  }
  if (disposal.kind === "withdrawal") {
    const tw = disposal.teilwertCents;
    if (tw === undefined || !Number.isSafeInteger(tw) || tw < 0) {
      return err(issue("asset_invalid", "Bitte den Teilwert (netto) der Entnahme angeben."));
    }
  }
  if (input.method === "pool") return ok({ kind: "pool_unchanged", info: POOL_DISPOSAL_INFO });

  const lastPosted = [...input.postedPeriods].sort().at(-1);
  if (lastPosted && month < lastPosted) {
    return err(issue("E-AST-08", `Abgangsdatum liegt vor der letzten gebuchten AfA (${mmYyyy(lastPosted)}).`));
  }
  const posted = new Set(input.postedPeriods);
  const catchUp = input.plan.filter((r) => r.period <= month && !posted.has(r.period));
  const afa = sumThrough(input.plan, month);
  const rbw = input.costCents - afa;
  const value =
    disposal.kind === "sale"
      ? (disposal.proceedsNetCents ?? 0)
      : disposal.kind === "withdrawal"
        ? (disposal.teilwertCents ?? 0)
        : 0;
  const result =
    value > rbw
      ? { kind: "gain" as const, gainCents: value - rbw, lossCents: 0 }
      : { kind: "loss" as const, gainCents: 0, lossCents: rbw - value };
  return ok({ kind: "rbw", catchUp, afaThroughDisposalCents: afa, rbwCents: rbw, result });
}
