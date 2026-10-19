import { v } from "convex/values";
import { type ExportEntry, exportFiles as exportFileSpecs } from "../src/domain/documents/dispatch";
import { BULK_MAX_DOCUMENTS } from "../src/domain/jobs/jobs";
import { markSentSchema } from "../src/domain/schemas/documents";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { actorMutation, mutation, systemAction, systemMutation, systemQuery, vConfirmToken } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { advanceJob, createJob, failJob, finishJob } from "./model/jobs";
import { markSent as markSentModel } from "./model/salesDocuments";
import type { ActorContext, ReadCtx } from "./model/types";

/**
 * F04 SND-20 bulk operations as jobs (EXP-026): (a) „Sammel-Export" (`bulk_export`, worker in documentArtifacts.ts —
 * Node, it may render the „Kopie"), (b) „Sammel-Markierung" (`bulk_mark_sent`): one sentOn/channel/note for the
 * selection, every document validated individually, failures skipped and listed, one sendLog row per document.
 */

function uniqueIds(ids: readonly string[]): string[] {
  const out = [...new Set(ids)];
  if (out.length === 0) throw appError("invalid_input", "Bitte mindestens ein Dokument auswählen.");
  if (out.length > BULK_MAX_DOCUMENTS) {
    throw appError("invalid_input", `Höchstens ${BULK_MAX_DOCUMENTS.toLocaleString("de-DE")} Dokumente pro Auftrag.`);
  }
  return out;
}

async function labelsOf(ctx: ReadCtx, ids: Id<"salesDocuments">[]) {
  const labels: Record<string, string> = {};
  for (const id of ids) labels[id] = (await ctx.db.get(id))?.number ?? "Entwurf";
  return labels;
}

export const startExport = mutation({
  permission: "documents.export",
  args: { ids: v.array(v.id("salesDocuments")) },
  handler: async (ctx, { ids }) => {
    const unique = uniqueIds(ids) as Id<"salesDocuments">[];
    const jobId = await createJob(ctx, {
      kind: "bulk_export",
      label: `Sammel-Export (${unique.length} Dokumente)`,
      params: { ids: unique, labels: await labelsOf(ctx, unique) },
      total: unique.length,
    });
    await ctx.scheduler.runAfter(0, internal.documentArtifacts.bulkExportJob, { jobId });
    return { jobId };
  },
});

export const startMarkSent = mutation({
  permission: "invoices.send",
  args: { ids: v.array(v.id("salesDocuments")), values: v.any(), confirmToken: vConfirmToken },
  handler: async (ctx, { ids, values }) => {
    const unique = uniqueIds(ids) as Id<"salesDocuments">[];
    const common = parse(markSentSchema, { ...(values as object), artifactIds: [] });
    const jobId = await createJob(ctx, {
      kind: "bulk_mark_sent",
      label: `Sammel-Markierung (${unique.length} Dokumente)`,
      params: {
        ids: unique,
        labels: await labelsOf(ctx, unique),
        values: { sentOn: common.sentOn, channel: common.channel, ...(common.note ? { note: common.note } : {}) },
      },
      total: unique.length,
    });
    await ctx.scheduler.runAfter(0, internal.bulk.markJob, { jobId });
    return { jobId };
  },
});

// ── workers ──────────────────────────────────────────────────────────────────────────────────────────────

export const jobInput = systemQuery({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const j = await ctx.db.get(jobId);
    if (!j || (j.status !== "queued" && j.status !== "running")) return null;
    const p = j.params as { ids: Id<"salesDocuments">[]; labels: Record<string, string>; values?: unknown };
    return { ids: p.ids, labels: p.labels, values: p.values ?? null, by: j.by };
  },
});

export const jobDone = systemMutation({
  job: "exports.run",
  args: {
    jobId: v.id("jobs"),
    storageId: v.optional(v.id("_storage")),
    name: v.optional(v.string()),
    sha256: v.optional(v.string()),
    bytes: v.optional(v.number()),
    skipped: v.array(v.object({ id: v.string(), label: v.string(), reason: v.string() })),
  },
  handler: async (ctx, a) =>
    finishJob(ctx, a.jobId, {
      ...(a.storageId ? { storageId: a.storageId } : {}),
      ...(a.name ? { name: a.name } : {}),
      ...(a.sha256 ? { sha256: a.sha256 } : {}),
      ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
      skipped: a.skipped,
      ...(a.storageId ? { exportAction: "export.bulk" } : {}),
    }),
});

export const jobStep = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), done: v.number() },
  handler: async (ctx, { jobId, done }) => advanceJob(ctx, jobId, { status: "running", done }),
});

export const jobFailed = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), error: v.string() },
  handler: async (ctx, { jobId, error }) => failJob(ctx, jobId, error),
});

/** Files of the default export of one document (SND-20 b validates the mark with them, SND-03/07/17). */
export const markInput = systemQuery({
  job: "exports.run",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc) return { artifactIds: [] as string[] };
    const arts = await ctx.db
      .query("documentArtifacts")
      .withIndex("by_document", (q) => q.eq("documentId", id))
      .collect();
    const specs = exportFileSpecs(doc.einvoice.format ?? "none", "default" as ExportEntry, doc.sentAt !== undefined);
    const ids: string[] = [];
    for (const spec of specs) {
      const a =
        arts.find((x) => x.kind === spec.kind && (x.variant ?? "original") === spec.variant) ??
        arts.find((x) => x.kind === spec.kind && (x.variant ?? "original") === "original");
      if (a) ids.push(a._id);
    }
    return { artifactIds: ids };
  },
});

export const markOne = actorMutation({
  permission: "invoices.send",
  args: { id: v.id("salesDocuments"), values: v.any(), confirmToken: vConfirmToken },
  handler: async (ctx, { id, values }) => {
    const r = await markSentModel(ctx, id, parse(markSentSchema, values));
    return { sendLogId: r.sendLogId };
  },
});

export const markJob = systemAction({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    try {
      const job = await ctx.runQuery(internal.bulk.jobInput, { jobId });
      if (!job) return false;
      const skipped: { id: string; label: string; reason: string }[] = [];
      let done = 0;
      for (const id of job.ids) {
        if (!(await ctx.runMutation(internal.bulk.jobStep, { jobId, done }))) return false;
        done++;
        try {
          const { artifactIds } = await ctx.runQuery(internal.bulk.markInput, { id });
          await ctx.runMutation(internal.bulk.markOne, {
            actorContext: job.by as ActorContext,
            id,
            values: { ...(job.values as object), artifactIds },
          });
        } catch (e) {
          const data = (e as { data?: { message?: string } }).data;
          skipped.push({
            id,
            label: job.labels[id] ?? id,
            reason: data?.message ?? (e instanceof Error ? e.message : String(e)),
          });
        }
      }
      return await ctx.runMutation(internal.bulk.jobDone, { jobId, skipped });
    } catch (e) {
      await ctx.runMutation(internal.bulk.jobFailed, { jobId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
});
