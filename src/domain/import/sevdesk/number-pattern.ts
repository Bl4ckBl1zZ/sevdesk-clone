/**
 * Number range continuation (F09 IMP-005, §4.3.6, EC-014; E-IMP-11, E-IMP-32): per range the imported numbers are
 * grouped by pattern (literal prefix, optional `YYYY`/`YY` token, counter of width n, suffix); the dominant pattern
 * of the most recent year is proposed with `next = max(counter in the current period) + 1`. The owner confirms per
 * range at commit; uniqueness against the register is re-checked there (E-IMP-12).
 */
import { type ResetPolicy, render, validateFormat } from "../../numbering/format";
import type { CalendarDate } from "../../time/calendar-date";
import type { ImportedDocType } from "./types";

export type ContinuationRangeKey = "invoice" | "correction";

/** Seeded ranges (src/domain/numbering/format.ts): corrections have their own range, all other invoices share one. */
export const rangeKeyFor = (type: ImportedDocType): ContinuationRangeKey =>
  type === "correction" ? "correction" : "invoice";

export interface ParsedNumber {
  readonly skeleton: string;
  readonly format: string;
  readonly resetPolicy: ResetPolicy;
  readonly counter: number;
  readonly width: number;
  readonly year: number;
  readonly hasYear: boolean;
}

/** Splits a number into its pattern; `null` when it carries no counter digits. */
export function parseNumberPattern(number: string, documentDate: CalendarDate): ParsedNumber | null {
  const runs = [...number.matchAll(/\d+/g)].map((m) => ({ text: m[0], index: m.index ?? 0 }));
  const last = runs.at(-1);
  if (!last) return null;
  const year = Number(documentDate.slice(0, 4));
  const yyyy = String(year);
  const yy = yyyy.slice(2);
  let prefix: string;
  let token = "";
  let mid = "";
  let counterText = last.text;
  const before = runs.at(-2);
  if (before && (before.text === yyyy || before.text === yy)) {
    prefix = number.slice(0, before.index);
    token = before.text.length === 4 ? "{YYYY}" : "{YY}";
    mid = number.slice(before.index + before.text.length, last.index);
  } else if (last.text.length >= 6 && last.text.startsWith(yyyy)) {
    prefix = number.slice(0, last.index);
    token = "{YYYY}";
    counterText = last.text.slice(4);
  } else {
    prefix = number.slice(0, last.index);
  }
  const suffix = number.slice(last.index + last.text.length);
  const width = counterText.length;
  return {
    skeleton: [prefix, token, mid, suffix].join("\u0000"),
    format: `${prefix}${token}${mid}{${"#".repeat(width)}}${suffix}`,
    resetPolicy: token ? "yearly" : "never",
    counter: Number(counterText),
    width,
    year,
    hasYear: token !== "",
  };
}

export interface PatternCandidate {
  readonly format: string;
  readonly resetPolicy: ResetPolicy;
  readonly count: number;
  readonly countLatestYear: number;
  readonly lastImported: string;
  /** Proposed next counter value for the current period (≥ the local counter). */
  readonly next: number;
  readonly formatValid: boolean;
  readonly formatMessage?: string;
}

export interface RangeProposal {
  readonly rangeKey: ContinuationRangeKey;
  readonly candidates: PatternCandidate[];
  /** E-IMP-11: several patterns in the most recent year — the owner must choose. */
  readonly ambiguous: boolean;
  /** E-IMP-32 (information only): missing numbers inside the imported sequences (capped). */
  readonly gaps: string[];
  readonly gapCount: number;
}

export interface LocalRange {
  readonly rangeKey: ContinuationRangeKey;
  readonly format: string;
  readonly resetPolicy: ResetPolicy;
  /** Next counter value of the current period (counter row or start value). */
  readonly next: number;
}

const GAP_LIMIT = 50;

export function proposeContinuation(
  samples: readonly { type: ImportedDocType; number: string; documentDate: CalendarDate }[],
  today: CalendarDate,
  local: readonly LocalRange[] = [],
): RangeProposal[] {
  const out: RangeProposal[] = [];
  const currentYear = Number(today.slice(0, 4));
  for (const rangeKey of ["invoice", "correction"] as const) {
    const parsed = samples
      .filter((s) => rangeKeyFor(s.type) === rangeKey)
      .map((s) => ({ s, p: parseNumberPattern(s.number, s.documentDate) }))
      .filter((x): x is { s: (typeof samples)[number]; p: ParsedNumber } => x.p !== null);
    if (parsed.length === 0) continue;
    const latestYear = Math.max(...parsed.map((x) => x.p.year));
    const groups = new Map<string, typeof parsed>();
    for (const x of parsed) groups.set(x.p.skeleton, [...(groups.get(x.p.skeleton) ?? []), x]);
    const localRange = local.find((l) => l.rangeKey === rangeKey);
    const candidates: PatternCandidate[] = [];
    const gaps: string[] = [];
    let gapCount = 0;
    for (const members of groups.values()) {
      const first = members[0] as (typeof parsed)[number];
      const width = Math.min(...members.map((m) => m.p.width));
      const format = first.p.format.replace(/\{#+\}/, `{${"#".repeat(width)}}`);
      const resetPolicy = first.p.resetPolicy;
      const inPeriod = members.filter((m) => resetPolicy === "never" || m.p.year === currentYear);
      const importNext = inPeriod.length ? Math.max(...inPeriod.map((m) => m.p.counter)) + 1 : 1;
      const latest = [...members].sort((a, b) =>
        a.p.year !== b.p.year ? a.p.year - b.p.year : a.p.counter - b.p.counter,
      );
      const check = validateFormat(format, resetPolicy);
      candidates.push({
        format,
        resetPolicy,
        count: members.length,
        countLatestYear: members.filter((m) => m.p.year === latestYear).length,
        lastImported: latest.at(-1)?.s.number ?? "",
        next: Math.max(importNext, localRange?.next ?? 1),
        formatValid: check.ok,
        ...(check.ok ? {} : { formatMessage: check.error.message }),
      });
      // Gaps per period (E-IMP-32).
      const periods = new Map<number, number[]>();
      for (const m of members) {
        const key = resetPolicy === "yearly" ? m.p.year : 0;
        periods.set(key, [...(periods.get(key) ?? []), m.p.counter]);
      }
      for (const [year, counters] of periods) {
        const set = new Set(counters);
        for (let c = Math.min(...counters) + 1; c < Math.max(...counters); c++) {
          if (set.has(c)) continue;
          gapCount++;
          if (gaps.length < GAP_LIMIT) gaps.push(render(format, { year: year || currentYear, month: 1 }, c));
        }
      }
    }
    candidates.sort((a, b) => b.countLatestYear - a.countLatestYear || b.count - a.count);
    out.push({
      rangeKey,
      candidates,
      ambiguous: candidates.filter((c) => c.countLatestYear > 0).length > 1,
      gaps,
      gapCount,
    });
  }
  return out;
}
