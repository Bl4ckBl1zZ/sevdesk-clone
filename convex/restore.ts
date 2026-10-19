import { v } from "convex/values";
import {
  checkpointPayload,
  RESTORE_NOT_EMPTY,
  restoreCheckpointWarning,
  restoreHeadIssue,
} from "../src/domain/exports/full-export";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import { systemAction, systemMutation, systemQuery } from "./functions";
import { runVerify } from "./integrity";
import { checkpointKey, checkpointStoreFromEnv } from "./lib/checkpointStore";
import { instanceName } from "./lib/env";
import { chainHead } from "./model/audit";
import { recordIntegrityRun } from "./model/integrity";
import { recordRestoreDrill } from "./model/system";

/**
 * F09 EXP-024 / 08 §7 restore, ops only (`npx convex run`, admin key; never public):
 *   1. `restore:preflight` before the import — the target must be empty (E-EXP-38).
 *   2. the import itself (`npx convex import --replace-all …` or the Dokploy Postgres/volume restore, runbook).
 *   3. `restore:complete` — full chain verification, the head must equal the expected head (manifest.json of a
 *      Vollexport or the checkpoint of the backup day; E-EXP-40 blocks and raises the integrity alert), a newer
 *      off-host checkpoint warns (E-EXP-41); then `system.restore` is the first audit entry after the imported head
 *      and the verification run is recorded after it.
 */

const LOOKBACK_DAYS = 62;
const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

export const preflight = systemQuery({
  job: "system.restore",
  args: {},
  handler: async (ctx) => {
    const audit = await ctx.db.query("auditLog").first();
    const profile = await ctx.db.query("companyProfile").first();
    return audit || profile ? { ok: false as const, error: RESTORE_NOT_EMPTY } : { ok: true as const };
  },
});

export const headState = systemQuery({
  job: "system.restore",
  args: {},
  handler: async (ctx) => {
    const head = await chainHead(ctx);
    const checkpoint = await ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").first();
    return {
      head: head ? { seq: head.seq, hash: head.hash, at: head.at } : null,
      checkpointDate: checkpoint?.date ?? null,
    };
  },
});

export const recordFailure = systemMutation({
  job: "system.restore",
  args: { lastVerifiedSeq: v.number(), detail: v.string() },
  handler: async (ctx, { lastVerifiedSeq, detail }) => {
    await recordIntegrityRun(ctx, {
      scope: "full",
      lastVerifiedSeq,
      findings: [{ kind: "restore_head_mismatch", severity: "error", detail }],
    });
  },
});

export const recordRestore = systemMutation({
  job: "system.restore",
  args: {
    source: v.string(),
    headMatches: v.boolean(),
    notes: v.optional(v.string()),
    restoredHeadSeq: v.number(),
    gapToCheckpoint: v.optional(v.number()),
  },
  handler: async (ctx, { source, headMatches, notes, restoredHeadSeq, gapToCheckpoint }) =>
    recordRestoreDrill(ctx, {
      kind: "production_restore",
      restoredHeadSeq,
      ...(gapToCheckpoint !== undefined ? { gapToCheckpoint } : {}),
      date: berlinCalendarDate(ctx.now()),
      backupObject: source,
      targetEnvironment: instanceName(),
      integrityOk: true,
      headMatchesCheckpoint: headMatches,
      ...(notes ? { notes } : {}),
    }),
});

/** The newest checkpoint in the off-host bucket after `from` (looks back at most LOOKBACK_DAYS). */
async function newestOffHostCheckpoint(today: CalendarDate, from: string | null) {
  const store = checkpointStoreFromEnv();
  if (!store) return null;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const date = addDays(today, -i);
    if (from && date <= from) return null;
    const jws = await store.get(checkpointKey(date));
    if (jws) return checkpointPayload(jws);
  }
  return null;
}

type HeadState = { head: { seq: number; hash: string; at: number } | null; checkpointDate: string | null };
type CompleteResult = { ok: true; head: HeadState["head"]; warnings: string[] } | { ok: false; error: string };

export const complete = systemAction({
  job: "system.restore",
  args: {
    source: v.string(),
    expected: v.optional(v.object({ seq: v.number(), hash: v.string() })),
  },
  handler: async (ctx, { source, expected }): Promise<CompleteResult> => {
    const verify = await runVerify(ctx, "full", { record: false });
    const st: HeadState = await ctx.runQuery(internal.restore.headState, {});
    if (!verify.ok) {
      await ctx.runMutation(internal.integrity.recordRun, {
        scope: "full",
        lastVerifiedSeq: verify.lastVerifiedSeq,
        findings: verify.findings.slice(0, 100),
      });
      return { ok: false as const, error: verify.findings.find((f) => f.severity === "error")?.detail ?? "" };
    }
    const mismatch = expected ? restoreHeadIssue(expected, st.head) : null;
    if (mismatch) {
      await ctx.runMutation(internal.restore.recordFailure, {
        lastVerifiedSeq: verify.lastVerifiedSeq,
        detail: mismatch.message,
      });
      return { ok: false as const, error: mismatch.message };
    }
    const today = berlinCalendarDate(Date.now());
    const offHost = await newestOffHostCheckpoint(today, st.checkpointDate);
    const newer = restoreCheckpointWarning(st.head, offHost, (ms) => DATE_TIME.format(ms));
    await ctx.runMutation(internal.restore.recordRestore, {
      source,
      headMatches: expected !== undefined,
      restoredHeadSeq: st.head?.seq ?? 0,
      ...(newer && offHost ? { notes: newer.message, gapToCheckpoint: offHost.lastSeq - (st.head?.seq ?? 0) } : {}),
    });
    await ctx.runMutation(internal.integrity.recordRun, {
      scope: "full",
      lastVerifiedSeq: verify.lastVerifiedSeq,
      findings: verify.findings.slice(0, 100),
    });
    return { ok: true as const, head: st.head, warnings: newer ? [newer.message] : [] };
  },
});
