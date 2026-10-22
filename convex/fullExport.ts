import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import { mutation, systemMutation, systemQuery } from "./functions";
import { SCHEMA_VERSION } from "./integrity";
import { env, instanceName } from "./lib/env";
import { chainHead } from "./model/audit";
import { createJob, finishJob } from "./model/jobs";
import schema from "./schema";

/**
 * F09 EXP-023 Vollexport (`full_export` job, EXP-026): the starting mutation and the paged reads of the Node worker
 * (fullExportJob.ts). Tables are read page by page (query read limits), files are listed from `_storage`.
 */

export const exportTables = (): string[] => Object.keys(schema.tables).sort();

export const start = mutation({
  permission: "exports.full",
  args: {},
  handler: async (ctx) => {
    const jobId = await createJob(ctx, {
      kind: "full_export",
      label: "Vollexport",
      params: {},
      total: exportTables().length + 1,
    });
    await ctx.scheduler.runAfter(0, internal.fullExportJob.run, { jobId });
    return { jobId };
  },
});

export const meta = systemQuery({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const j = await ctx.db.get(jobId);
    if (!j || j.kind !== "full_export" || (j.status !== "queued" && j.status !== "running")) return null;
    const head = await chainHead(ctx);
    const checkpoint = await ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").first();
    return {
      tables: exportTables(),
      appVersion: env("APP_VERSION") ?? "0.0.0",
      schemaVersion: SCHEMA_VERSION,
      instanceName: instanceName(),
      auditHead: head ? { seq: head.seq, hash: head.hash } : null,
      lastCheckpoint: checkpoint
        ? { date: checkpoint.date, lastSeq: checkpoint.lastSeq, lastHash: checkpoint.lastHash }
        : null,
      // Export job results (earlier Vollexporte, CSV and bulk ZIPs) are derived copies, not data: never re-exported.
      jobResults: (await ctx.db.query("jobs").collect()).flatMap((x) =>
        x.resultStorageId ? [x.resultStorageId as string] : [],
      ),
    };
  },
});

/**
 * E-EXP-37: audit entries written after the manifest head while the tables were read, excluding the job's own
 * progress entries — the README and manifest name them (the readable export is not a point-in-time snapshot).
 */
export const writesSince = systemQuery({
  job: "exports.run",
  args: { jobId: v.id("jobs"), afterSeq: v.number() },
  handler: async (ctx, { jobId, afterSeq }) =>
    (
      await ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.gt("seq", afterSeq))
        .take(10_000)
    )
      .filter((e) => !(e.entity.table === "jobs" && e.entity.id === jobId))
      .map((e) => e.seq),
});

export const tablePage = systemQuery({
  job: "exports.run",
  args: { table: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { table, paginationOpts }) => {
    if (!exportTables().includes(table)) throw new Error(`unknown table ${table}`);
    const page = await ctx.db.query(table as TableNames).paginate(paginationOpts);
    return { rows: page.page as unknown[], isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const storagePage = systemQuery({
  job: "exports.run",
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db.system.query("_storage").paginate(paginationOpts);
    return {
      files: page.page.map((f) => ({
        id: f._id as string,
        sha256: f.sha256,
        size: f.size,
        ...(f.contentType ? { contentType: f.contentType } : {}),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const done = systemMutation({
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
      exportAction: "export.full",
    }),
});
