import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  type ChainCursor,
  genesisHash,
  type IntegrityFinding,
  sha256Hex,
  verifyChainPage,
} from "../src/domain/audit/chain";
import { PROTECTED_TABLES } from "../src/domain/audit/immutability";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { mutation, query, systemAction, systemMutation, systemQuery } from "./functions";
import { verifyJournal } from "./journalIntegrity";
import { checkpointKey, checkpointStoreFromEnv } from "./lib/checkpointStore";
import { env, instanceName, isTest } from "./lib/env";
import { loadCheckpointKey, signCheckpoint, verifyCheckpoint } from "./lib/jws";
import { berlinParts } from "./lib/time";
import { chainHead } from "./model/audit";
import {
  acknowledgeIntegrityRun,
  insertCheckpoint,
  latestCheckpoint,
  latestRun,
  recordCheckpointUpload,
  recordIntegrityRun,
} from "./model/integrity";
import { journalHead } from "./model/journal";
import schema from "./schema";
import { vIntegrityFinding } from "./validators";
import { rehashVoucherFiles } from "./voucherIntegrity";

/**
 * Integrity (02 §4.6, §7; F12 AUD-013, AUD-016; RI-14):
 *  - `verify` recomputes the audit hash chain (incremental from the last verified seq, full on Sundays or on
 *    request) and checks the latest signed checkpoint (signature, chain contains its lastSeq/lastHash, R2 copy
 *    identical, append-only counts not decreased). Results → `integrityRuns`.
 *  - `checkpoint` signs `{instance, date, lastSeq, lastHash, counts, …}` with CHECKPOINT_SIGNING_KEY_PEM (ES256 JWS)
 *    → `integrityCheckpoints` → R2 checkpoint bucket `checkpoints/YYYY/MM/DD.jws`; failed uploads are retried
 *    on every hourly run.
 * Artifact/snapshot re-hashing (AUD-013 c/d) joins with the document pipeline in P1.
 */

const PAGE = 500;
const COUNT_PAGE = 2000;
export const SCHEMA_VERSION = "p0-1";

const scopeValidator = v.union(v.literal("incremental"), v.literal("full"), v.literal("startup"));

/** Protected (append-only / guarded) tables that exist in the schema — the checkpoint `counts`. */
export function countedTables(): string[] {
  const existing = new Set(Object.keys(schema.tables));
  return PROTECTED_TABLES.filter((t) => existing.has(t)).sort();
}

// ── internal reads ────────────────────────────────────────────────────────────────────────────────────
export const chainPage = systemQuery({
  job: "cron.integrity.verify",
  args: { fromSeq: v.number(), limit: v.number() },
  handler: async (ctx, { fromSeq, limit }): Promise<Doc<"auditLog">[]> =>
    ctx.db
      .query("auditLog")
      .withIndex("by_seq", (q) => q.gte("seq", fromSeq))
      .take(Math.min(limit, PAGE)),
});

export const entryAt = systemQuery({
  job: "cron.integrity.verify",
  args: { seq: v.number() },
  handler: async (ctx, { seq }) =>
    ctx.db
      .query("auditLog")
      .withIndex("by_seq", (q) => q.eq("seq", seq))
      .first(),
});

export const state = systemQuery({
  job: "cron.integrity.verify",
  args: {},
  handler: async (ctx) => {
    const head = await chainHead(ctx);
    return {
      head: head ? { seq: head.seq, hash: head.hash } : null,
      journalSeq: (await journalHead(ctx))?.seq ?? 0,
      lastRun: await latestRun(ctx),
      checkpoint: await latestCheckpoint(ctx),
    };
  },
});

export const countTable = systemQuery({
  job: "cron.integrity.checkpoint",
  args: { table: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { table, paginationOpts }) => {
    if (!countedTables().includes(table)) throw new Error(`not a counted table: ${table}`);
    const page = await ctx.db.query(table as TableNames).paginate(paginationOpts);
    return { n: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const checkpointsWithFailedUpload = systemQuery({
  job: "cron.integrity.checkpoint",
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").take(30)).filter(
      (c) => c.uploadStatus !== "uploaded",
    ),
});

export const checkpointForDate = systemQuery({
  job: "cron.integrity.checkpoint",
  args: { date: v.string() },
  handler: async (ctx, { date }) =>
    ctx.db
      .query("integrityCheckpoints")
      .withIndex("by_date", (q) => q.eq("date", date))
      .first(),
});

// ── internal writes ───────────────────────────────────────────────────────────────────────────────────
export const recordRun = systemMutation({
  job: "cron.integrity.verify",
  args: { scope: scopeValidator, lastVerifiedSeq: v.number(), findings: v.array(vIntegrityFinding) },
  handler: async (ctx, args) => recordIntegrityRun(ctx, args),
});

export const storeCheckpoint = systemMutation({
  job: "cron.integrity.checkpoint",
  args: {
    date: v.string(),
    lastSeq: v.number(),
    lastHash: v.string(),
    counts: v.record(v.string(), v.number()),
    artifactsCount: v.number(),
    journalSeq: v.number(),
    appVersion: v.string(),
    schemaVersion: v.string(),
    prevCheckpointHash: v.string(),
    jws: v.string(),
    kid: v.string(),
  },
  handler: async (ctx, row) => insertCheckpoint(ctx, row),
});

export const recordUpload = systemMutation({
  job: "cron.integrity.checkpoint",
  args: {
    id: v.id("integrityCheckpoints"),
    result: v.union(
      v.object({ ok: v.literal(true), exportedTo: v.string() }),
      v.object({ ok: v.literal(false), detail: v.string() }),
    ),
  },
  handler: async (ctx, { id, result }) => recordCheckpointUpload(ctx, id, result),
});

// ── jobs ──────────────────────────────────────────────────────────────────────────────────────────────
type RunCtx = {
  runQuery: import("./_generated/server").ActionCtx["runQuery"];
  runMutation: import("./_generated/server").ActionCtx["runMutation"];
  /** Present in actions: voucher files are re-hashed (F06 VOU-126). */
  storage?: import("./_generated/server").ActionCtx["storage"];
};

async function countAll(ctx: RunCtx): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of countedTables()) {
    let n = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { n: number; isDone: boolean; continueCursor: string } = await ctx.runQuery(
        internal.integrity.countTable,
        { table, paginationOpts: { numItems: COUNT_PAGE, cursor } },
      );
      n += page.n;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    counts[table] = n;
  }
  return counts;
}

async function checkCheckpoint(
  ctx: RunCtx,
  cp: Doc<"integrityCheckpoints">,
  findings: IntegrityFinding[],
  opts: { counts?: boolean; remote?: boolean } = {},
) {
  const date = cp.date.split("-").reverse().join(".");
  const fail = (kind: IntegrityFinding["kind"], detail: string) =>
    findings.push({ kind, severity: "error", detail, entity: { table: "integrityCheckpoints", id: cp._id } });

  const pem = env("CHECKPOINT_SIGNING_KEY_PEM");
  if (pem) {
    const key = await loadCheckpointKey(pem);
    if (cp.kid === key.kid) {
      const res = await verifyCheckpoint(cp.jws, key.publicJwk);
      if (!res.ok || res.payload.lastSeq !== cp.lastSeq || res.payload.lastHash !== cp.lastHash) {
        fail("checkpoint_signature", `Prüfpunkt vom ${date} ist ungültig oder weicht von der externen Kopie ab.`);
      }
    } else {
      // TODO(P1, AUD-017): keep retired public keys (kid → JWK) to verify checkpoints after a key rotation.
      findings.push({
        kind: "checkpoint_signature",
        severity: "warning",
        detail: `Prüfpunkt vom ${date} wurde mit einem anderen Schlüssel (${cp.kid}) signiert.`,
        entity: { table: "integrityCheckpoints", id: cp._id },
      });
    }
  }

  const entry: Doc<"auditLog"> | null = await ctx.runQuery(internal.integrity.entryAt, { seq: cp.lastSeq });
  if (!entry) {
    const st = await ctx.runQuery(internal.integrity.state, {});
    fail(
      "checkpoint_mismatch",
      `Der aktuelle Datenstand endet vor dem Prüfpunkt vom ${date} (seq ${st.head?.seq ?? 0} < ${cp.lastSeq}).`,
    );
  } else if (entry.hash !== cp.lastHash) {
    fail(
      "checkpoint_mismatch",
      `Protokolleintrag seq ${cp.lastSeq} stimmt nicht mit dem Prüfpunkt vom ${date} überein.`,
    );
  }

  if (opts.remote === false && opts.counts === false) return;
  const store = checkpointStoreFromEnv();
  if (store && cp.uploadStatus === "uploaded") {
    const remote = await store.get(checkpointKey(cp.date)).catch(() => undefined);
    if (remote !== undefined && remote !== cp.jws) {
      fail("checkpoint_signature", `Prüfpunkt vom ${date} ist ungültig oder weicht von der externen Kopie ab.`);
    }
  }

  const counts = await countAll(ctx);
  for (const [table, before] of Object.entries(cp.counts)) {
    const now = counts[table] ?? 0;
    if (now < before) {
      fail("checkpoint_mismatch", `In ${table} fehlen ${before - now} Datensätze gegenüber dem Prüfpunkt vom ${date}.`);
    }
  }
}

export async function runVerify(
  ctx: RunCtx,
  scope: "incremental" | "full" | "startup",
  opts: { record?: boolean } = {},
): Promise<{ ok: boolean; lastVerifiedSeq: number; findings: IntegrityFinding[] }> {
  const st = await ctx.runQuery(internal.integrity.state, {});
  const genesis = await genesisHash(instanceName());
  let cursor: ChainCursor = { nextSeq: 1, prevHash: genesis };
  let lastVerifiedSeq = 0;

  const last = st.lastRun;
  if (scope === "incremental" && last?.ok && last.lastVerifiedSeq > 0) {
    const anchor: Doc<"auditLog"> | null = await ctx.runQuery(internal.integrity.entryAt, {
      seq: last.lastVerifiedSeq,
    });
    if (anchor) {
      cursor = { nextSeq: anchor.seq + 1, prevHash: anchor.hash };
      lastVerifiedSeq = anchor.seq;
    }
  }

  const findings: IntegrityFinding[] = [];
  for (;;) {
    const page: Doc<"auditLog">[] = await ctx.runQuery(internal.integrity.chainPage, {
      fromSeq: cursor.nextSeq,
      limit: PAGE,
    });
    if (page.length === 0) break;
    const res = await verifyChainPage(page, cursor);
    if (findings.length === 0) lastVerifiedSeq = res.lastVerifiedSeq;
    findings.push(...res.findings);
    cursor = res.cursor;
    if (page.length < PAGE) break;
  }
  if (st.checkpoint) await checkCheckpoint(ctx, st.checkpoint, findings);
  if (ctx.storage)
    findings.push(...(await rehashVoucherFiles({ runQuery: ctx.runQuery, storage: ctx.storage })).findings);
  // F08 ACC-020: gapless seq, balanced entries, nothing recorded into a locked period after its lock (RI-13)
  findings.push(...(await verifyJournal({ runQuery: ctx.runQuery })).findings);

  // EXP-024: the restore verifies first and records the run after its `system.restore` entry (record: false).
  if (opts.record !== false) {
    await ctx.runMutation(internal.integrity.recordRun, { scope, lastVerifiedSeq, findings: findings.slice(0, 100) });
  }
  return { ok: !findings.some((f) => f.severity === "error"), lastVerifiedSeq, findings };
}

/**
 * AUD-014 startup check (fast): the latest checkpoint's signature and its lastSeq/lastHash in the chain, then the
 * head continuity from the checkpoint to the current head — no full-chain walk, no table counts, no R2 read.
 * Failures alert like AUD-015 (recordIntegrityRun → integrity.failed notification, banner, finalisation block).
 */
export async function runStartupCheck(
  ctx: RunCtx,
): Promise<{ ok: boolean; lastVerifiedSeq: number; findings: IntegrityFinding[] }> {
  const st = await ctx.runQuery(internal.integrity.state, {});
  const findings: IntegrityFinding[] = [];
  let cursor: ChainCursor = { nextSeq: 1, prevHash: await genesisHash(instanceName()) };
  let lastVerifiedSeq = 0;
  if (st.checkpoint) {
    await checkCheckpoint(ctx, st.checkpoint, findings, { counts: false, remote: false });
    cursor = { nextSeq: st.checkpoint.lastSeq + 1, prevHash: st.checkpoint.lastHash };
    lastVerifiedSeq = st.checkpoint.lastSeq;
  } else if (st.lastRun?.ok && st.lastRun.lastVerifiedSeq > 0) {
    const anchor: Doc<"auditLog"> | null = await ctx.runQuery(internal.integrity.entryAt, {
      seq: st.lastRun.lastVerifiedSeq,
    });
    if (anchor) {
      cursor = { nextSeq: anchor.seq + 1, prevHash: anchor.hash };
      lastVerifiedSeq = anchor.seq;
    }
  }
  if (findings.some((f) => f.severity === "error")) lastVerifiedSeq = 0;
  for (;;) {
    const page: Doc<"auditLog">[] = await ctx.runQuery(internal.integrity.chainPage, {
      fromSeq: cursor.nextSeq,
      limit: PAGE,
    });
    if (page.length === 0) break;
    const res = await verifyChainPage(page, cursor);
    if (findings.length === 0) lastVerifiedSeq = res.lastVerifiedSeq;
    findings.push(...res.findings);
    cursor = res.cursor;
    if (page.length < PAGE) break;
  }
  await ctx.runMutation(internal.integrity.recordRun, {
    scope: "startup",
    lastVerifiedSeq,
    findings: findings.slice(0, 100),
  });
  return { ok: !findings.some((f) => f.severity === "error"), lastVerifiedSeq, findings };
}

/**
 * AUD-014 every 6 h (and after each deployment's first cron tick). 02 §7 places this timer in `web`; `web` has no
 * system identity for Convex, so it runs as a Convex cron with the same check (P1 decision, see the report).
 */
export const startupCron = systemAction({
  job: "cron.integrity.verify",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null;
    return runStartupCheck(ctx);
  },
});

/** Manual / test entry point (and the startup check, AUD-014, from `web` in P1). */
export const verify = systemAction({
  job: "cron.integrity.verify",
  args: { scope: v.optional(scopeValidator) },
  handler: async (ctx, { scope }) => runVerify(ctx, scope ?? "full"),
});

/** Cron (registered at 00:00 and 01:00 UTC): runs at 02:xx Europe/Berlin; full chain on Sundays. */
export const verifyCron = systemAction({
  job: "cron.integrity.verify",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null; // 02 §7: crons skip with IS_TEST unless invoked explicitly
    const p = berlinParts(Date.now());
    if (p.hour !== 2 && !force) return null;
    return runVerify(ctx, p.weekday === 0 ? "full" : "incremental");
  },
});

export async function runCheckpoint(
  ctx: RunCtx,
  now: number,
): Promise<{ id: Id<"integrityCheckpoints">; jws: string; uploaded: boolean } | { skipped: string }> {
  const pem = env("CHECKPOINT_SIGNING_KEY_PEM");
  if (!pem) return { skipped: "CHECKPOINT_SIGNING_KEY_PEM fehlt" };
  const date = berlinParts(now).date;
  const existing: Doc<"integrityCheckpoints"> | null = await ctx.runQuery(internal.integrity.checkpointForDate, {
    date,
  });
  if (existing) return { skipped: `Prüfpunkt für ${date} existiert bereits` };

  const st = await ctx.runQuery(internal.integrity.state, {});
  const key = await loadCheckpointKey(pem);
  const counts = await countAll(ctx);
  const payload = {
    instance: instanceName(),
    date,
    lastSeq: st.head?.seq ?? 0,
    lastHash: st.head?.hash ?? (await genesisHash(instanceName())),
    counts,
    artifactsCount: counts.documentArtifacts ?? 0,
    journalSeq: st.journalSeq,
    appVersion: env("APP_VERSION") ?? "0.0.0",
    schemaVersion: SCHEMA_VERSION,
    prevCheckpointHash: st.checkpoint ? await sha256Hex(st.checkpoint.jws) : "0".repeat(64),
  };
  const jws = await signCheckpoint(payload, key);
  const { instance: _instance, ...row } = payload;
  const id: Id<"integrityCheckpoints"> = await ctx.runMutation(internal.integrity.storeCheckpoint, {
    ...row,
    jws,
    kid: key.kid,
  });
  const uploaded = await upload(ctx, id, date, jws);
  return { id, jws, uploaded };
}

async function upload(ctx: RunCtx, id: Id<"integrityCheckpoints">, date: string, jws: string): Promise<boolean> {
  const store = checkpointStoreFromEnv();
  const key = checkpointKey(date);
  const res = store
    ? await store.put(key, jws)
    : { ok: false as const, detail: "R2-Prüfpunkt-Bucket ist nicht eingerichtet" };
  await ctx.runMutation(internal.integrity.recordUpload, {
    id,
    result:
      res.ok && store
        ? { ok: true, exportedTo: store.location(key) }
        : { ok: false, detail: "detail" in res ? res.detail : "" },
  });
  return res.ok;
}

/** Manual / test entry point. */
export const checkpoint = systemAction({
  job: "cron.integrity.checkpoint",
  args: {},
  handler: async (ctx) => runCheckpoint(ctx, Date.now()),
});

/** Cron (hourly): creates the day's checkpoint at 02:xx Europe/Berlin, retries failed uploads every hour. */
export const checkpointCron = systemAction({
  job: "cron.integrity.checkpoint",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null;
    for (const cp of await ctx.runQuery(internal.integrity.checkpointsWithFailedUpload, {})) {
      await upload(ctx, cp._id, cp.date, cp.jws);
    }
    if (berlinParts(Date.now()).hour !== 2 && !force) return null;
    return runCheckpoint(ctx, Date.now());
  },
});

// ── public ────────────────────────────────────────────────────────────────────────────────────────────
/** Status for the integrity page and the global banner (F12 §6). */
export const status = query({
  permission: "integrity.read",
  args: {},
  handler: async (ctx) => {
    const head = await chainHead(ctx);
    const run = await latestRun(ctx);
    const cp = await latestCheckpoint(ctx);
    return {
      head: head ? { seq: head.seq, hash: head.hash, at: head.at } : null,
      lastRun: run
        ? {
            id: run._id,
            at: run.at,
            ok: run.ok,
            scope: run.scope,
            lastVerifiedSeq: run.lastVerifiedSeq,
            findings: run.findings,
            acknowledgedAt: run.acknowledgedAt ?? null,
          }
        : null,
      latestCheckpoint: cp
        ? {
            date: cp.date,
            lastSeq: cp.lastSeq,
            uploadStatus: cp.uploadStatus,
            exportedTo: cp.exportedTo ?? null,
            kid: cp.kid,
          }
        : null,
      finalisationBlocked: Boolean(run && !run.ok && run.acknowledgedAt === undefined),
    };
  },
});

/** AUD-015: the owner acknowledges a failed run with a note (does not alter data). */
export const acknowledge = mutation({
  permission: "integrity.acknowledge",
  args: { runId: v.id("integrityRuns"), note: v.string() },
  handler: async (ctx, { runId, note }) => acknowledgeIntegrityRun(ctx, runId, note),
});
