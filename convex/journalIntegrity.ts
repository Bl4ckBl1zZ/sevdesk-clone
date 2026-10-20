import { v } from "convex/values";
import { type JournalCursor, verifyJournalPage } from "../src/domain/accounting/journal-integrity";
import type { IntegrityFinding } from "../src/domain/audit/chain";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { systemQuery } from "./functions";

/**
 * F08 ACC-020 (GOBD-05, SEC-04, RI-13): the integrity run walks the journal by `seq` — gapless, balanced, nothing
 * recorded into a locked period after its lock. Findings are `error` (banner, finalisation block via F12).
 */

const PAGE = 200;

export const journalPage = systemQuery({
  job: "cron.integrity.verify",
  args: { fromSeq: v.number() },
  handler: async (ctx, { fromSeq }) => {
    const entries = await ctx.db
      .query("journalEntries")
      .withIndex("by_seq", (q) => q.gte("seq", fromSeq))
      .take(PAGE);
    return entries.map((e) => ({
      id: e._id as string,
      seq: e.seq,
      period: e.period,
      recordedAt: e.recordedAt,
      lines: e.lines.map((l) => ({ debitCents: l.debitCents, creditCents: l.creditCents })),
    }));
  },
});

export const lockedPeriods = systemQuery({
  job: "cron.integrity.verify",
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("periods").collect())
      .filter((p) => p.status === "locked" && p.lockedAt !== undefined)
      .map((p) => ({ period: p.period, lockedAt: p.lockedAt as number })),
});

/** Called by `runVerify` (integrity.ts). */
export async function verifyJournal(
  ctx: Pick<ActionCtx, "runQuery">,
): Promise<{ checked: number; findings: IntegrityFinding[] }> {
  const locks = new Map(
    (await ctx.runQuery(internal.journalIntegrity.lockedPeriods, {})).map((p) => [p.period, p.lockedAt] as const),
  );
  let cursor: JournalCursor = { nextSeq: 1 };
  const findings: IntegrityFinding[] = [];
  let checked = 0;
  for (;;) {
    const page = await ctx.runQuery(internal.journalIntegrity.journalPage, { fromSeq: cursor.nextSeq });
    if (page.length === 0) break;
    const r = verifyJournalPage(page, cursor, locks);
    findings.push(...r.findings);
    checked += page.length;
    cursor = r.cursor;
    if (page.length < PAGE || findings.length >= 100) break;
  }
  return { checked, findings };
}
