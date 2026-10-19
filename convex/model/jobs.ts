import {
  canTransition,
  isActive,
  JOB_EXPIRED,
  JOB_NOT_CANCELLABLE,
  JOB_RESULT_TTL_MS,
  type JobStatus,
} from "../../src/domain/jobs/jobs";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit, auditedInsert, auditedPatch } from "./audit";
import { notifyKind } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * `jobs` (03 §10, F09 EXP-026): created by the starting mutation (actor = the caller, so API/MCP jobs are attributed),
 * advanced by the worker action through system mutations, cancellable while active, result kept 30 days.
 */

export type JobKind = Doc<"jobs">["kind"];

export async function createJob(
  ctx: ModelCtx,
  input: { kind: JobKind; label: string; params: unknown; total: number },
): Promise<Id<"jobs">> {
  return auditedInsert(
    ctx,
    "jobs",
    {
      kind: input.kind,
      status: "queued",
      progress: { done: 0, total: input.total },
      params: input.params,
      label: input.label,
      actor: ctx.actor,
      by: {
        actor: ctx.actorContext.actor,
        channel: ctx.actorContext.channel,
        ...(ctx.actorContext.role ? { role: ctx.actorContext.role } : {}),
        ...(ctx.actorContext.label ? { label: ctx.actorContext.label } : {}),
        ...(ctx.actorContext.requestId ? { requestId: ctx.actorContext.requestId } : {}),
      },
      createdAt: ctx.now(),
    },
    { action: "job.create", label: input.label },
  );
}

async function requireJob(ctx: ReadCtx, id: Id<"jobs">): Promise<Doc<"jobs">> {
  const j = await ctx.db.get(id);
  if (!j) throw appError("not_found");
  return j;
}

/** Worker step: returns false when the job was cancelled meanwhile (the worker stops). */
export async function advanceJob(
  ctx: ModelCtx,
  id: Id<"jobs">,
  update: { status?: "running"; done?: number; total?: number },
): Promise<boolean> {
  const j = await requireJob(ctx, id);
  if (j.status === "cancelled") return false;
  if (!canTransition(j.status, "running")) return false;
  await auditedPatch(
    ctx,
    "jobs",
    id,
    {
      status: "running",
      progress: { done: update.done ?? j.progress.done, total: update.total ?? j.progress.total },
    },
    { action: j.status === "queued" ? "job.start" : "job.progress", label: j.label },
  );
  return true;
}

export async function finishJob(
  ctx: ModelCtx,
  id: Id<"jobs">,
  result: {
    storageId?: Id<"_storage">;
    name?: string;
    sha256?: string;
    bytes?: number;
    skipped?: Doc<"jobs">["skipped"];
    exportAction?: string;
  },
): Promise<boolean> {
  const j = await requireJob(ctx, id);
  if (!canTransition(j.status, "done")) {
    // cancelled while the worker ran: the file is not kept
    if (result.storageId) await ctx.storage.delete(result.storageId);
    return false;
  }
  const now = ctx.now();
  await auditedPatch(
    ctx,
    "jobs",
    id,
    {
      status: "done",
      progress: { done: j.progress.total, total: j.progress.total },
      ...(result.storageId ? { resultStorageId: result.storageId, expiresAt: now + JOB_RESULT_TTL_MS } : {}),
      ...(result.name ? { resultName: result.name } : {}),
      ...(result.sha256 ? { resultSha256: result.sha256 } : {}),
      ...(result.bytes !== undefined ? { resultBytes: result.bytes } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
      finishedAt: now,
    },
    { action: "job.done", label: j.label },
  );
  // EXP-026: the export event and the file hash are audited, attributed to the job's actor.
  if (result.exportAction && result.sha256) {
    await appendAudit(
      { ...ctx, actor: j.by.actor as ModelCtx["actor"], actorContext: j.by as unknown as ModelCtx["actorContext"] },
      {
        action: result.exportAction,
        entity: { table: "exports", id, label: result.name ?? j.label },
        diff: { after: { sha256: result.sha256, bytes: result.bytes ?? 0, params: j.params } },
      },
    );
  }
  await notifyKind(ctx, "export.ready", {
    title: `${j.label} ist bereit`,
    link: "/export",
    entity: { table: "jobs", id },
  });
  return true;
}

export async function failJob(ctx: ModelCtx, id: Id<"jobs">, error: string): Promise<void> {
  const j = await requireJob(ctx, id);
  if (!canTransition(j.status, "failed")) return;
  await auditedPatch(
    ctx,
    "jobs",
    id,
    { status: "failed", error: error.slice(0, 500), finishedAt: ctx.now() },
    { action: "job.fail", label: j.label, reason: error.slice(0, 300) },
  );
}

/** EXP-026: the creator or the owner can cancel a queued or running job. */
export async function cancelJob(ctx: ModelCtx, id: Id<"jobs">): Promise<void> {
  const j = await requireJob(ctx, id);
  if (j.actor !== ctx.actor && ctx.role !== "owner") throw appError("forbidden_role");
  if (!isActive(j.status as JobStatus)) throw appError("invalid_input", JOB_NOT_CANCELLABLE);
  await auditedPatch(
    ctx,
    "jobs",
    id,
    { status: "cancelled", finishedAt: ctx.now() },
    { action: "job.cancel", label: j.label },
  );
}

/** Jobs of the caller (the owner sees all), newest first. */
export async function listJobs(ctx: ReadCtx & { actor: string; role?: string | undefined }) {
  const rows =
    ctx.role === "owner"
      ? await ctx.db.query("jobs").order("desc").take(200)
      : await ctx.db
          .query("jobs")
          .withIndex("by_actor", (q) => q.eq("actor", ctx.actor as Doc<"jobs">["actor"]))
          .order("desc")
          .take(200);
  return rows.map((j) => ({
    id: j._id,
    kind: j.kind,
    label: j.label,
    status: j.status,
    progress: j.progress,
    resultName: j.resultName ?? null,
    resultSha256: j.resultSha256 ?? null,
    resultBytes: j.resultBytes ?? null,
    hasResult: j.resultStorageId !== undefined,
    skipped: j.skipped ?? [],
    error: j.error ?? null,
    actor: j.actor,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt ?? null,
    expiresAt: j.expiresAt ?? null,
  }));
}

export async function resultUrl(
  ctx: ReadCtx & { actor: string; role?: string | undefined; now: () => number },
  id: Id<"jobs">,
) {
  const j = await requireJob(ctx, id);
  if (j.actor !== ctx.actor && ctx.role !== "owner") throw appError("forbidden_role");
  if (!j.resultStorageId || (j.expiresAt !== undefined && j.expiresAt <= ctx.now())) {
    throw appError("not_found", JOB_EXPIRED);
  }
  return {
    url: await ctx.storage.getUrl(j.resultStorageId),
    name: j.resultName ?? "export",
    sha256: j.resultSha256 ?? null,
  };
}

/** Cron: results older than 30 days are deleted from storage (jobs rows stay as the audit trail). */
export async function expireJobResults(ctx: ModelCtx): Promise<number> {
  let n = 0;
  for (const j of await ctx.db
    .query("jobs")
    .withIndex("by_status", (q) => q.eq("status", "done"))
    .collect()) {
    if (!j.resultStorageId || j.expiresAt === undefined || j.expiresAt > ctx.now()) continue;
    await ctx.storage.delete(j.resultStorageId);
    await auditedPatch(ctx, "jobs", j._id, { resultStorageId: undefined }, { action: "job.expire", label: j.label });
    n++;
  }
  return n;
}
