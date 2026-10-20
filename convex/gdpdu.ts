import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query, systemMutation, systemQuery } from "./functions";
import { appError } from "./lib/errors";
import { appendAudit } from "./model/audit";
import {
  GDPDU_SOURCES,
  type GdpduSource,
  gdpduMeta,
  gdpduSourcePage,
  listGdpduExports,
  recordGdpduExport,
  startGdpduExport,
} from "./model/gdpdu";
import { advanceJob, failJob, finishJob } from "./model/jobs";

/**
 * F09 EXP-017…019 GDPdU (Z3) export per fiscal year (`gdpdu_export` job) and the package list for the auditor
 * (F12 AUD-023). The worker is convex/gdpduJob.ts.
 */

const vEncoding = v.union(v.literal("utf8"), v.literal("ansi"));

export const start = mutation({
  permission: "exports.gdpdu",
  args: { year: v.number(), encoding: vEncoding, includeFiles: v.boolean() },
  handler: async (ctx, args) => {
    const jobId = await startGdpduExport(ctx, args);
    await ctx.scheduler.runAfter(0, internal.gdpduJob.run, { jobId });
    return { jobId };
  },
});

/** Generated packages (owner/bookkeeper: all; auditor: the granted fiscal years only). */
export const list = query({
  permission: "exports.gdpdu.read",
  args: {},
  handler: async (ctx) => listGdpduExports(ctx, ctx.role === "auditor" ? (ctx.actorContext.auditorYears ?? []) : null),
});

/** AUD-009: the download of a Z3 package is audited (also for the auditor; not a business write). */
export const download = mutation({
  permission: "exports.gdpdu.read",
  args: { id: v.id("gdpduExports") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    const years = ctx.role === "auditor" ? (ctx.actorContext.auditorYears ?? []) : null;
    if (!row || (years !== null && !years.includes(row.year))) throw appError("not_found", "Export nicht gefunden.");
    await appendAudit(ctx, {
      action: "export.gdpdu_download",
      entity: { table: "exports", id: `gdpdu-${id}`, label: row.name },
      diff: { after: { year: row.year, sha256: row.sha256 } },
    });
    return { url: await ctx.storage.getUrl(row.storageId), name: row.name };
  },
});

// ── worker reads/writes (job "exports.run") ─────────────────────────────────────────────────────────────

export const meta = systemQuery({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => gdpduMeta(ctx, jobId, ctx.now()),
});

export const sourcePage = systemQuery({
  job: "exports.run",
  args: {
    source: v.union(...GDPDU_SOURCES.map((s) => v.literal(s))),
    year: v.number(),
    cursor: v.union(v.string(), v.null()),
    includeFiles: v.boolean(),
  },
  handler: async (ctx, a) => gdpduSourcePage(ctx, { ...a, source: a.source as GdpduSource, now: ctx.now() }),
});

export const step = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), done: v.number() },
  handler: async (ctx, { jobId, done }) => advanceJob(ctx, jobId, { status: "running", done }),
});

export const done = systemMutation({
  job: "exports.run",
  args: {
    jobId: v.id("jobs"),
    storageId: v.id("_storage"),
    name: v.string(),
    sha256: v.string(),
    bytes: v.number(),
    counts: v.record(v.string(), v.number()),
  },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    if (!job) return false;
    // The package is kept with the gdpduExports row (not as a 30-day job result): no storageId on the job.
    const ok = await finishJob(ctx, a.jobId, { name: a.name, sha256: a.sha256, bytes: a.bytes });
    if (!ok) {
      await ctx.storage.delete(a.storageId);
      return false;
    }
    const asOwner = {
      ...ctx,
      actor: job.by.actor as typeof ctx.actor,
      actorContext: job.by as unknown as typeof ctx.actorContext,
    };
    await recordGdpduExport(asOwner, job, a);
    return true;
  },
});

export const failed = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), error: v.string() },
  handler: async (ctx, { jobId, error }) => {
    await advanceJob(ctx, jobId, {});
    await failJob(ctx, jobId, error);
  },
});
