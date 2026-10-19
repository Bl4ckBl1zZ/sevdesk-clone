import { v } from "convex/values";
import { DSGVO_CHANNELS, DSGVO_KINDS } from "../src/domain/privacy/dsgvo";
import { internal } from "./_generated/api";
import { mutation, query, systemMutation, systemQuery } from "./functions";
import { isTest } from "./lib/env";
import {
  accessExportData,
  createRequest,
  erasurePreview,
  executeErasure,
  extendRequest,
  listRequests,
  notifyDeadlines,
  recordAccessExport,
  responseLetter,
  setStatus,
  startAccessExport,
  verifyIdentity,
} from "./model/dsgvo";
import { advanceJob, failJob, finishJob } from "./model/jobs";
import { art30 } from "./model/privacy";

/**
 * F12 DSGVO request register and flows (PRV-010…PRV-014; F02 CON-162…CON-165). Every DSGVO act is owner-only in the
 * UI (`dsgvo.manage`/`dsgvo.erase` have `scope: null` → REST/MCP keys can never call them; the REST paths answer 403
 * `owner_only`). The register is readable with `settings:read` (F12 §7 `GET /dsgvo-requests`).
 */

const vKind = v.union(...DSGVO_KINDS.map((k) => v.literal(k)));
const vChannel = v.union(...DSGVO_CHANNELS.map((c) => v.literal(c)));

export const list = query({
  permission: "dsgvo.read",
  args: {},
  handler: async (ctx) => listRequests(ctx),
});

export const create = mutation({
  permission: "dsgvo.manage",
  args: {
    contactId: v.optional(v.id("contacts")),
    subject: v.optional(v.object({ name: v.string(), email: v.optional(v.string()) })),
    kind: vKind,
    channel: vChannel,
    receivedAt: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => createRequest(ctx, args),
});

export const verify = mutation({
  permission: "dsgvo.manage",
  args: { id: v.id("dsgvoRequests"), method: v.string() },
  handler: async (ctx, { id, method }) => verifyIdentity(ctx, id, method),
});

export const setRequestStatus = mutation({
  permission: "dsgvo.manage",
  args: {
    id: v.id("dsgvoRequests"),
    to: v.union(v.literal("in_progress"), v.literal("done"), v.literal("rejected")),
    rejectionReason: v.optional(v.string()),
  },
  handler: async (ctx, { id, to, rejectionReason }) =>
    setStatus(ctx, id, to, rejectionReason !== undefined ? { rejectionReason } : {}),
});

export const extend = mutation({
  permission: "dsgvo.manage",
  args: { id: v.id("dsgvoRequests"), months: v.number(), reason: v.string(), noticeSentOn: v.string() },
  handler: async (ctx, { id, ...x }) => extendRequest(ctx, id, x),
});

export const preview = query({
  permission: "dsgvo.manage",
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => erasurePreview(ctx, contactId),
});

export const execute = mutation({
  permission: "dsgvo.erase",
  args: { id: v.id("dsgvoRequests") },
  handler: async (ctx, { id }) => executeErasure(ctx, id),
});

export const letter = query({
  permission: "dsgvo.manage",
  args: { id: v.id("dsgvoRequests") },
  handler: async (ctx, { id }) => responseLetter(ctx, id),
});

export const startExport = mutation({
  permission: "dsgvo.manage",
  args: { id: v.id("dsgvoRequests") },
  handler: async (ctx, { id }) => {
    const jobId = await startAccessExport(ctx, id);
    await ctx.scheduler.runAfter(0, internal.dsgvoNode.runExport, { jobId, requestId: id });
    return { jobId };
  },
});

export const resultUrl = query({
  permission: "dsgvo.manage",
  args: { id: v.id("dsgvoRequests") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id);
    return r?.resultStorageId ? await ctx.storage.getUrl(r.resultStorageId) : null;
  },
});

// ── cron + worker ──────────────────────────────────────────────────────────────────────────────────────

export const deadlinesCron = systemMutation({
  job: "cron.dsgvo.deadlines",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null; // 02 §7: crons skip with IS_TEST unless invoked explicitly
    return notifyDeadlines(ctx);
  },
});

export const exportInput = systemQuery({
  job: "dsgvo.export",
  args: { requestId: v.id("dsgvoRequests") },
  handler: async (ctx, { requestId }) => {
    const data = await accessExportData(ctx, requestId);
    if (!data) return null;
    return { data, record: await art30(ctx) };
  },
});

export const exportDone = systemMutation({
  job: "dsgvo.export",
  args: {
    jobId: v.id("jobs"),
    requestId: v.id("dsgvoRequests"),
    storageId: v.id("_storage"),
    name: v.string(),
    sha256: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, a) => {
    const job = await ctx.db.get(a.jobId);
    const actorCtx = job
      ? { ...ctx, actor: job.by.actor as typeof ctx.actor, actorContext: job.by as unknown as typeof ctx.actorContext }
      : ctx;
    await advanceJob(ctx, a.jobId, {});
    const ok = await finishJob(ctx, a.jobId, {
      storageId: a.storageId,
      name: a.name,
      sha256: a.sha256,
      bytes: a.bytes,
      exportAction: "export.dsgvo",
    });
    if (ok) await recordAccessExport(actorCtx, a.requestId, a.storageId);
    return ok;
  },
});

export const exportFailed = systemMutation({
  job: "dsgvo.export",
  args: { jobId: v.id("jobs"), error: v.string() },
  handler: async (ctx, { jobId, error }) => {
    await advanceJob(ctx, jobId, {});
    await failJob(ctx, jobId, error);
  },
});
