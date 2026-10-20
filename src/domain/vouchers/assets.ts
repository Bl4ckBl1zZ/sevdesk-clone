/**
 * Asset detection on voucher lines (F06 VOU-065, AO-03; EC-VOU-28/29; golden V5).
 *
 * Thresholds are date-effective rule data (`ASSET_THRESHOLDS`: recording list > 250 €, GWG ≤ 800 € per item,
 * Sammelposten 250,01–1.000 €), evaluated on the acquisition (supply) date. The per-item cost is the net amount if
 * input VAT is deductible, otherwise the gross amount (KU company, `no_input_vat`), divided by the quantity.
 * A line on a fixed-asset account (class 0) or on a goods-type expense account above the recording threshold asks
 * „Anlagegut?“ with GWG / Sammelposten / Anlage / Kein Anlagegut; finalisation is blocked until it is answered.
 * The asset record itself is created by F08 (AST-002) from the decision stored on the line. Pure.
 */
import { formatEuro, roundHalfAway } from "../money";
import { type Issue, issue } from "../result";
import { type Chart, GOODS_EXPENSE_ACCOUNTS } from "../rules/accounting";
import type { RuleOverride } from "../rules/rule-table";
import { type AssetThresholds, lookupAssetThresholds } from "../rules/thresholds";
import type { CalendarDate } from "../time/calendar-date";
import type { AssetDecision } from "./types";

export interface AssetLineInput {
  account: string;
  quantityMilli?: number;
  netCents: number;
  grossCents: number;
  assetDecision?: AssetDecision;
}

export interface AssetPrompt {
  position: number;
  perItemCents: number;
  options: AssetDecision[];
}

export interface AssetContext {
  chart: Chart;
  /** Acquisition (supply) date. */
  date: CalendarDate;
  /** Input VAT deductible → net is the cost; otherwise gross. */
  deductible: boolean;
  /** Owner overrides of the threshold table (SET-121, MISC-09 harness). */
  overrides?: readonly RuleOverride<AssetThresholds>[];
}

export function perItemCost(line: AssetLineInput, deductible: boolean): number {
  const cost = deductible ? line.netCents : line.grossCents;
  const qty = line.quantityMilli && line.quantityMilli > 0 ? line.quantityMilli : 1000;
  return Number(roundHalfAway(BigInt(cost) * 1000n, BigInt(qty)));
}

const isAssetAccount = (account: string) => account.startsWith("0");

function options(perItem: number, t: AssetThresholds): AssetDecision[] {
  const out: AssetDecision[] = [];
  if (perItem <= t.gwgLimitCents) out.push("gwg");
  if (t.poolAllowed !== false && perItem > t.recordingLimitCents && perItem <= t.poolMaxCents) out.push("pool");
  out.push("asset", "none");
  return out;
}

/** The lines (1-based positions) that need the „Anlagegut?“ decision. */
export function assetPrompts(lines: readonly AssetLineInput[], ctx: AssetContext): AssetPrompt[] {
  const t = lookupAssetThresholds(ctx.date, ctx.overrides ?? []);
  if (!t.ok) return [];
  const goods = GOODS_EXPENSE_ACCOUNTS[ctx.chart];
  const out: AssetPrompt[] = [];
  lines.forEach((l, i) => {
    if (l.netCents <= 0) return;
    const perItem = perItemCost(l, ctx.deductible);
    const prompt =
      isAssetAccount(l.account) || (goods.includes(l.account) && perItem > t.value.value.recordingLimitCents);
    if (prompt) out.push({ position: i + 1, perItemCents: perItem, options: options(perItem, t.value.value) });
  });
  return out;
}

export type AssetIssue = Issue<"asset_decision_required" | "asset_gwg_limit" | "asset_decision_invalid">;

/** EC-VOU-28 (no decision) and EC-VOU-29 (GWG above the limit valid on the acquisition date). */
export function checkAssetDecisions(lines: readonly AssetLineInput[], ctx: AssetContext): AssetIssue[] {
  const t = lookupAssetThresholds(ctx.date, ctx.overrides ?? []);
  if (!t.ok) return [];
  const out: AssetIssue[] = [];
  const prompts = new Map(assetPrompts(lines, ctx).map((p) => [p.position, p]));
  lines.forEach((l, i) => {
    const position = i + 1;
    const p = prompts.get(position);
    if (l.assetDecision === "gwg" && perItemCost(l, ctx.deductible) > t.value.value.gwgLimitCents) {
      out.push(
        issue(
          "asset_gwg_limit",
          `Ein GWG darf höchstens ${formatEuro(t.value.value.gwgLimitCents)} netto je Wirtschaftsgut kosten.`,
          { position, limitCents: t.value.value.gwgLimitCents },
        ),
      );
      return;
    }
    if (!p) return;
    if (!l.assetDecision) {
      out.push(
        issue(
          "asset_decision_required",
          `Bitte festlegen, ob Position ${position} ein Anlagegut ist (GWG, Sammelposten, Anlage oder kein Anlagegut).`,
          { position },
        ),
      );
    } else if (!p.options.includes(l.assetDecision)) {
      out.push(
        issue("asset_decision_invalid", `Für Position ${position} ist ein Sammelposten nicht möglich.`, { position }),
      );
    }
  });
  return out;
}
