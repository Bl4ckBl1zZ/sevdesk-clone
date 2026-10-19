import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, systemAction, systemMutation, systemQuery } from "./functions";
import { buildCsv, type CsvParams, SERVER_CSV_LISTS, startCsvExport } from "./model/csvExports";
import { advanceJob, failJob, finishJob } from "./model/jobs";

/**
 * List CSV exports (F09 EXP-021/022) with the job path for large exports (EXP-026). The direct path returns the file
 * content; the job path stores it for 30 days (download via `jobs.resultUrl`).
 */

export const vCsvParams = {
  list: v.union(...SERVER_CSV_LISTS.map((l) => v.literal(l))),
  variant: v.union(v.literal("excel"), v.literal("technical")),
  type: v.optional(v.string()),
  accountId: v.optional(v.string()),
  dateFrom: v.optional(v.string()),
  dateTo: v.optional(v.string()),
};

/** „Export ▾" on a list: a mutation because every export is audited (EXP-026, AUD-009). */
export const csv = mutation({
  permission: "documents.export",
  args: vCsvParams,
  handler: async (ctx, args) => startCsvExport(ctx, args),
});

// ── job worker ───────────────────────────────────────────────────────────────────────────────────────────

export const jobInput = systemQuery({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const j = await ctx.db.get(jobId);
    if (!j || (j.status !== "queued" && j.status !== "running")) return null;
    const built = await buildCsv(ctx, j.params as CsvParams);
    return built;
  },
});

export const jobStep = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), done: v.optional(v.number()) },
  handler: async (ctx, { jobId, done }) =>
    advanceJob(ctx, jobId, { status: "running", ...(done !== undefined ? { done } : {}) }),
});

export const jobDone = systemMutation({
  job: "exports.run",
  args: {
    jobId: v.id("jobs"),
    storageId: v.id("_storage"),
    name: v.string(),
    sha256: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, a) =>
    finishJob(ctx, a.jobId, {
      storageId: a.storageId,
      name: a.name,
      sha256: a.sha256,
      bytes: a.bytes,
      exportAction: "export.csv",
    }),
});

export const jobFailed = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), error: v.string() },
  handler: async (ctx, { jobId, error }) => failJob(ctx, jobId, error),
});

export const runCsvJob = systemAction({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    try {
      if (!(await ctx.runMutation(internal.exports.jobStep, { jobId }))) return false;
      const built = await ctx.runQuery(internal.exports.jobInput, { jobId });
      if (!built) return false;
      if (!(await ctx.runMutation(internal.exports.jobStep, { jobId, done: built.rows }))) return false;
      const bytes = new TextEncoder().encode(built.content);
      const storageId: Id<"_storage"> = await ctx.storage.store(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
      return await ctx.runMutation(internal.exports.jobDone, {
        jobId,
        storageId,
        name: built.name,
        sha256: await sha256Hex(bytes),
        bytes: bytes.length,
      });
    } catch (e) {
      await ctx.runMutation(internal.exports.jobFailed, { jobId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
});
