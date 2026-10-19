/**
 * F01 SET-063 gap report (GOBD-02, UST-06): per range and period the counter values between the start value and the
 * highest issued counter that have no register row. A gap is explained when an audited counter change documented it
 * („Lücke a–b“, SET-059); otherwise it is listed as „unerklärt“.
 */
export interface RegisterCounterRow {
  readonly periodKey?: string | undefined;
  readonly counter?: number | undefined;
}

export interface DocumentedGap {
  readonly periodKey: string;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

export interface GapRow {
  readonly periodKey: string;
  readonly from: number;
  readonly to: number;
  /** Audit reason of the counter change, or null = „unerklärt“. */
  readonly reason: string | null;
}

/** Parses the documented gap of a SET-059 counter change reason („… (Lücke 42–49)“). */
export function parseDocumentedGap(reason: string | undefined): { from: number; to: number; reason: string } | null {
  const m = /\(Lücke (\d+)[–-](\d+)\)\s*$/.exec(reason ?? "");
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]), reason: (reason ?? "").replace(m[0], "").trim() };
}

/** Missing counter values per period, split into explained and unexplained runs. */
export function registerGaps(
  rows: readonly RegisterCounterRow[],
  startValue: number,
  documented: readonly DocumentedGap[],
): GapRow[] {
  const byPeriod = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.counter === undefined) continue;
    const key = r.periodKey ?? "";
    const set = byPeriod.get(key) ?? new Set<number>();
    set.add(r.counter);
    byPeriod.set(key, set);
  }
  const out: GapRow[] = [];
  for (const [periodKey, set] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const max = Math.max(...set);
    const explain = (v: number) =>
      documented.find((d) => d.periodKey === periodKey && v >= d.from && v <= d.to)?.reason ?? null;
    type Run = { from: number; to: number; reason: string | null };
    const runs: Run[] = [];
    for (let v = Math.min(startValue, ...set); v <= max; v++) {
      if (set.has(v)) continue;
      const reason = explain(v);
      const last = runs.at(-1);
      if (last && last.reason === reason && last.to === v - 1) last.to = v;
      else runs.push({ from: v, to: v, reason });
    }
    for (const r of runs) out.push({ periodKey, from: r.from, to: r.to, reason: r.reason });
  }
  return out;
}
