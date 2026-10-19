import { v } from "convex/values";
import { ABLAUFHEMMUNG_ITEMS, PURGE_PHRASE } from "../src/domain/privacy/purge";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { actorMutation, mutation, query, systemAction, systemMutation, systemQuery } from "./functions";
import { checkpointStoreFromEnv } from "./lib/checkpointStore";
import { env, isTest } from "./lib/env";
import { loadCheckpointKey, signCheckpoint } from "./lib/jws";
import { advanceJob, failJob, finishJob } from "./model/jobs";
import {
  auditPrefixCandidate,
  createPurgeBatch,
  createReplayBatch,
  endHold,
  finishPurgeBatch,
  insertAnchor,
  PURGE_CLASS_LABEL_DE,
  PURGE_CLASSES,
  PURGE_INDEX_KEY,
  type PurgeClass,
  type PurgeLog,
  purgeAuditPrefixStep,
  purgeHistory,
  purgeLog,
  purgeLogKey,
  purgePreview,
  purgeStep,
  replayChunk,
  replayMessage,
  retentionWorklist,
  scanRetention,
  startHold,
} from "./model/retention";

/**
 * F12 retention engine (PRV-003…PRV-009, GOBD-21). `/einstellungen/datenschutz` › Aufbewahrung / Löschläufe.
 * Purges are owner-only UI acts (scope null → REST/MCP can never reach them, E-PRV-05); the worker writes through
 * actorMutations with the owner's actor context so every tombstone is attributed to the confirming owner.
 */

const vClasses = v.array(
  v.union(
    v.literal("books10"),
    v.literal("vouchers8"),
    v.literal("letters6"),
    v.literal("auditLog"),
    v.literal("contacts"),
  ),
);

export const worklist = query({
  permission: "retention.read",
  args: {},
  handler: async (ctx) => ({
    ...(await retentionWorklist(ctx)),
    classes: PURGE_CLASSES.map((c) => ({ id: c, label: PURGE_CLASS_LABEL_DE[c] })),
    checklist: ABLAUFHEMMUNG_ITEMS,
    phrase: PURGE_PHRASE,
  }),
});

export const history = query({
  permission: "retention.read",
  args: {},
  handler: async (ctx) => purgeHistory(ctx),
});

export const preview = query({
  permission: "retention.purge",
  args: { classes: vClasses, years: v.array(v.number()) },
  handler: async (ctx, args) => purgePreview(ctx, args),
});

export const startPurge = mutation({
  permission: "retention.purge",
  args: {
    classes: vClasses,
    years: v.array(v.number()),
    checklist: v.record(v.string(), v.boolean()),
    phrase: v.string(),
  },
  handler: async (ctx, args) => {
    const { batchId, jobId } = await createPurgeBatch(ctx, args);
    await ctx.scheduler.runAfter(0, internal.retention.runPurge, { batchId, jobId, actorContext: ctx.actorContext });
    return { batchId, jobId };
  },
});

export const startHoldMode = mutation({
  permission: "retention.hold",
  args: { reason: v.string(), fiscalYears: v.array(v.number()) },
  handler: async (ctx, args) => startHold(ctx, args),
});

export const endHoldMode = mutation({
  permission: "retention.hold",
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => endHold(ctx, reason),
});

// ── cron (PRV-003) ─────────────────────────────────────────────────────────────────────────────────────

export const scanCron = systemMutation({
  job: "cron.retention.scan",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null; // 02 §7: crons skip with IS_TEST unless invoked explicitly
    return scanRetention(ctx);
  },
});

// ── worker (PRV-006, PRV-008) ──────────────────────────────────────────────────────────────────────────

const vActorCtx = v.any();

export const purgeStepAs = actorMutation({
  permission: "retention.purge",
  args: { batchId: v.id("purgeBatches"), jobId: v.id("jobs"), done: v.number() },
  handler: async (ctx, { batchId, jobId, done }) => {
    if (!(await advanceJob(ctx, jobId, { status: "running", done })))
      return { done: true, processed: 0, cancelled: true };
    return { ...(await purgeStep(ctx, batchId)), cancelled: false };
  },
});

export const anchorCandidate = systemQuery({
  job: "retention.purge",
  args: { batchId: v.id("purgeBatches") },
  handler: async (ctx, { batchId }) => auditPrefixCandidate(ctx, batchId),
});

export const insertAnchorAs = actorMutation({
  permission: "retention.purge",
  args: {
    batchId: v.id("purgeBatches"),
    seq: v.number(),
    hash: v.string(),
    jws: v.string(),
    entryAt: v.number(),
    exportedTo: v.optional(v.string()),
  },
  handler: async (ctx, a) =>
    insertAnchor(ctx, {
      batchId: a.batchId,
      seq: a.seq,
      hash: a.hash,
      jws: a.jws,
      entryAt: a.entryAt,
      ...(a.exportedTo ? { exportedTo: a.exportedTo } : {}),
    }),
});

export const purgeAuditPrefixAs = actorMutation({
  permission: "retention.purge",
  args: { batchId: v.id("purgeBatches") },
  handler: async (ctx, { batchId }) => purgeAuditPrefixStep(ctx, batchId),
});

export const logOf = systemQuery({
  job: "retention.purge",
  args: { batchId: v.id("purgeBatches") },
  handler: async (ctx, { batchId }) => purgeLog(ctx, batchId),
});

export const finishAs = actorMutation({
  permission: "retention.purge",
  args: {
    batchId: v.id("purgeBatches"),
    jobId: v.id("jobs"),
    ok: v.boolean(),
    offHostLogKey: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await finishPurgeBatch(ctx, a.batchId, {
      ok: a.ok,
      ...(a.offHostLogKey ? { offHostLogKey: a.offHostLogKey } : {}),
      ...(a.error ? { error: a.error } : {}),
    });
    if (a.ok) await finishJob(ctx, a.jobId, {});
    else await failJob(ctx, a.jobId, a.error ?? "Löschlauf fehlgeschlagen");
  },
});

/** Off-host copy of the purge log (`purges/<batch>.json` + `purges/index.json`) in the R2 checkpoint bucket. */
async function uploadLog(log: PurgeLog): Promise<string | undefined> {
  const store = checkpointStoreFromEnv();
  if (!store) return undefined;
  const key = purgeLogKey(log.batch.id);
  const put = await store.put(key, JSON.stringify(log));
  if (!put.ok) throw new Error(`Löschprotokoll konnte nicht extern gespeichert werden (${put.detail}).`);
  const index = JSON.parse((await store.get(PURGE_INDEX_KEY)) ?? "[]") as string[];
  if (!index.includes(key)) index.push(key);
  const res = await store.put(PURGE_INDEX_KEY, JSON.stringify(index));
  if (!res.ok) throw new Error(`Löschprotokoll-Index konnte nicht gespeichert werden (${res.detail}).`);
  return store.location(key);
}

export const runPurge = systemAction({
  job: "retention.purge",
  args: { batchId: v.id("purgeBatches"), jobId: v.id("jobs"), actorContext: vActorCtx },
  handler: async (ctx, { batchId, jobId, actorContext }): Promise<boolean> => {
    try {
      let done = 0;
      for (;;) {
        const step: { done: boolean; processed: number; cancelled: boolean } = await ctx.runMutation(
          internal.retention.purgeStepAs,
          { actorContext, batchId, jobId, done },
        );
        if (step.cancelled) {
          await ctx.runMutation(internal.retention.finishAs, {
            actorContext,
            batchId,
            jobId,
            ok: false,
            error: "Abgebrochen",
          });
          return false;
        }
        done += step.processed;
        if (step.done) break;
      }
      // PRV-008: sign the anchor first (off-host), then purge the prefix behind it.
      const candidate: { seq: number; hash: string; at: number } | null = await ctx.runQuery(
        internal.retention.anchorCandidate,
        { batchId },
      );
      if (candidate) {
        const pem = env("CHECKPOINT_SIGNING_KEY_PEM");
        if (!pem) throw new Error("CHECKPOINT_SIGNING_KEY_PEM fehlt – Ankerpunkt kann nicht signiert werden.");
        const key = await loadCheckpointKey(pem);
        const jws = await signCheckpoint(
          { kind: "chain-anchor", seq: candidate.seq, hash: candidate.hash, batchId, at: Date.now() },
          key,
        );
        const store = checkpointStoreFromEnv();
        let exportedTo: string | undefined;
        if (store) {
          const anchorKey = `anchors/${candidate.seq}.jws`;
          const res = await store.put(anchorKey, jws);
          if (!res.ok) throw new Error(`Ankerpunkt konnte nicht extern gespeichert werden (${res.detail}).`);
          exportedTo = store.location(anchorKey);
        }
        await ctx.runMutation(internal.retention.insertAnchorAs, {
          actorContext,
          batchId,
          seq: candidate.seq,
          hash: candidate.hash,
          jws,
          entryAt: candidate.at,
          ...(exportedTo ? { exportedTo } : {}),
        });
        for (;;) {
          const s: { done: boolean } = await ctx.runMutation(internal.retention.purgeAuditPrefixAs, {
            actorContext,
            batchId,
          });
          if (s.done) break;
        }
      }
      const log: PurgeLog | null = await ctx.runQuery(internal.retention.logOf, { batchId });
      const location = log ? await uploadLog(log) : undefined;
      await ctx.runMutation(internal.retention.finishAs, {
        actorContext,
        batchId,
        jobId,
        ok: true,
        ...(location ? { offHostLogKey: location } : {}),
      });
      return true;
    } catch (e) {
      await ctx.runMutation(internal.retention.finishAs, {
        actorContext,
        batchId,
        jobId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  },
});

// ── replay after restore (PRV-009, E-PRV-08) — ops: `npx convex run retention:replayPurges` ───────────

const REPLAY_ACTOR = { actor: "system:retention.replay", channel: "system" } as const;

export const createReplayAs = actorMutation({
  permission: "retention.purge",
  args: { log: v.any() },
  handler: async (ctx, { log }) => createReplayBatch(ctx, log as PurgeLog),
});

export const replayChunkAs = actorMutation({
  permission: "retention.purge",
  args: { batchId: v.id("purgeBatches"), tombstones: v.any(), anchors: v.any() },
  handler: async (ctx, a) => replayChunk(ctx, a.batchId, a.tombstones, a.anchors),
});

export const replayPurges = systemAction({
  job: "retention.replay",
  args: {},
  handler: async (ctx): Promise<{ batches: number; repurged: number; message: string }> => {
    const store = checkpointStoreFromEnv();
    if (!store) throw new Error("Kein externer Speicher für Löschprotokolle konfiguriert.");
    const keys = JSON.parse((await store.get(PURGE_INDEX_KEY)) ?? "[]") as string[];
    let repurged = 0;
    for (const key of keys) {
      const raw = await store.get(key);
      if (!raw) continue;
      const log = JSON.parse(raw) as PurgeLog;
      const batchId: Id<"purgeBatches"> = await ctx.runMutation(internal.retention.createReplayAs, {
        actorContext: REPLAY_ACTOR,
        log,
      });
      for (let i = 0; i < Math.max(log.tombstones.length, 1); i += 100) {
        repurged += await ctx.runMutation(internal.retention.replayChunkAs, {
          actorContext: REPLAY_ACTOR,
          batchId,
          tombstones: log.tombstones.slice(i, i + 100),
          anchors: i === 0 ? log.anchors : [],
        });
      }
      await ctx.runMutation(internal.retention.finishReplayAs, { actorContext: REPLAY_ACTOR, batchId });
    }
    return { batches: keys.length, repurged, message: replayMessage(repurged) };
  },
});

export const finishReplayAs = actorMutation({
  permission: "retention.purge",
  args: { batchId: v.id("purgeBatches") },
  handler: async (ctx, { batchId }) => finishPurgeBatch(ctx, batchId, { ok: true }),
});

export type { PurgeClass };
