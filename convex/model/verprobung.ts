import { reportMeta } from "../../src/domain/reports/meta";
import { computeVerprobung, type VerprobungEntry } from "../../src/domain/reports/verprobung";
import { isCalendarDate } from "../../src/domain/time/calendar-date";
import { appError } from "../lib/errors";
import { periodRows } from "./periodLock";
import { sourceHref } from "./taxFilings";
import type { ReadCtx } from "./types";

/**
 * USt-Verprobung read model (F08 RPT-009, GOBD-03): every journal entry of the range by booking date, handed to the
 * pure `computeVerprobung`; documents with a difference get a link to their source. RPT-001 meta like every report.
 */
export async function verprobungView(ctx: ReadCtx, a: { from: string; to: string }, now: number) {
  if (!isCalendarDate(a.from) || !isCalendarDate(a.to) || a.from > a.to) {
    throw appError("invalid_input", "Ungültiger Zeitraum.");
  }
  const rows = await ctx.db.query("journalEntries").withIndex("by_seq").collect();
  const entries: VerprobungEntry[] = rows
    .filter((e) => e.date >= a.from && e.date <= a.to)
    .map((e) => ({
      id: e._id,
      seq: e.seq,
      date: e.date,
      source: e.source,
      text: e.text,
      lines: e.lines.map((l) => ({
        account: l.account,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        ...(l.role ? { role: l.role } : {}),
        ...(l.taxKey ? { taxKey: l.taxKey } : {}),
      })),
    }));
  const result = computeVerprobung(entries, a);
  const lockedMonths = (await periodRows(ctx)).filter((p) => p.status === "locked").map((p) => p.period);
  const meta = reportMeta({
    report: "verprobung",
    params: { from: a.from, to: a.to },
    generatedAt: now,
    ruleVersions: [],
    from: a.from,
    to: a.to,
    lockedMonths,
  });
  return {
    meta,
    ...result,
    documents: result.documents.map((d) => ({ ...d, href: sourceHref(d.source) })),
  };
}
