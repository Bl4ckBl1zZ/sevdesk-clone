import { v } from "convex/values";
import { mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { cancelJob, expireJobResults, listJobs, resultUrl as resultUrlModel } from "./model/jobs";

/** Background jobs (F09 EXP-026): list with progress, cancel while active, 30-day result download. */

export const list = query({
  permission: "documents.export",
  args: {},
  handler: async (ctx) => listJobs(ctx),
});

export const cancel = mutation({
  permission: "documents.export",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const jid = ctx.db.normalizeId("jobs", id);
    if (!jid) throw appError("not_found");
    await cancelJob(ctx, jid);
  },
});

export const resultUrl = query({
  permission: "documents.export",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const jid = ctx.db.normalizeId("jobs", id);
    if (!jid) throw appError("not_found");
    return resultUrlModel(ctx, jid);
  },
});

/** Daily: results older than 30 days are removed from storage. */
export const expireCron = systemMutation({
  job: "cron.jobs.expire",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null;
    return expireJobResults(ctx);
  },
});
