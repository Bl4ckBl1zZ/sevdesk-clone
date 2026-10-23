/**
 * RI-03 (10-edge-cases §2, GOBD-02): within a counter (range + period) the issued values are strictly increasing in
 * finalisation (= register insertion) order, and gaps exist only where an audited counter change documented them
 * (SET-059 „Lücke a–b“; none expected, numbers are assigned only at commit). Pure; convex/model/invariants.ts feeds
 * it the register. Imported numbers (F09) and rows without a counter are not part of a counter sequence.
 */
import { type DocumentedGap, registerGaps } from "./gaps";

export interface CounterRegisterRow {
  readonly number: string;
  readonly rangeId?: string | undefined;
  readonly periodKey?: string | undefined;
  readonly counter?: number | undefined;
  /** Insertion order of the register row (Convex `_creationTime`): the finalisation order. */
  readonly order: number;
  readonly imported?: boolean | undefined;
}

export interface CounterFinding {
  readonly id: "RI-03";
  readonly severity: "WARN";
  readonly message: string;
}

export function checkCounterSequences(
  rows: readonly CounterRegisterRow[],
  ranges: ReadonlyMap<string, { readonly name: string; readonly startValue: number }>,
  documented: ReadonlyMap<string, readonly DocumentedGap[]>,
): CounterFinding[] {
  const warn = (message: string): CounterFinding => ({ id: "RI-03", severity: "WARN", message });
  const byRange = new Map<string, CounterRegisterRow[]>();
  for (const r of rows) {
    if (r.imported || r.rangeId === undefined || r.counter === undefined) continue;
    const list = byRange.get(r.rangeId) ?? [];
    list.push(r);
    byRange.set(r.rangeId, list);
  }
  const out: CounterFinding[] = [];
  for (const [rangeId, list] of byRange) {
    const range = ranges.get(rangeId);
    const name = range?.name ?? rangeId;
    const byPeriod = new Map<string, CounterRegisterRow[]>();
    for (const r of list) {
      const key = r.periodKey ?? "";
      byPeriod.set(key, [...(byPeriod.get(key) ?? []), r]);
    }
    for (const [period, inPeriod] of byPeriod) {
      const ordered = [...inPeriod].sort((a, b) => a.order - b.order);
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const cur = ordered[i];
        if (prev && cur && (cur.counter ?? 0) <= (prev.counter ?? 0)) {
          out.push(
            warn(
              `Nummernkreis „${name}“${period ? ` (${period})` : ""}: ${cur.number} wurde nach ${prev.number} vergeben, der Zähler steigt nicht.`,
            ),
          );
        }
      }
    }
    if (!range) continue;
    for (const gap of registerGaps(list, range.startValue, documented.get(rangeId) ?? [])) {
      if (gap.reason !== null) continue;
      const span = gap.from === gap.to ? `${gap.from}` : `${gap.from}–${gap.to}`;
      out.push(
        warn(
          `Nummernkreis „${name}“${gap.periodKey ? ` (${gap.periodKey})` : ""}: unerklärte Lücke im Zähler (${span}).`,
        ),
      );
    }
  }
  return out;
}
