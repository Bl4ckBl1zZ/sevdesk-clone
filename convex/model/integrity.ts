import { encodeId } from "../../src/domain/api/ids";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { notifyKind } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";
import { emitEvent } from "./webhooks";

/** integrityRuns / integrityCheckpoints writes (03 §10, F12 AUD-013/AUD-015/AUD-016). */

export async function recordIntegrityRun(
  ctx: ModelCtx,
  run: {
    scope: "incremental" | "full" | "startup";
    lastVerifiedSeq: number;
    findings: Doc<"integrityRuns">["findings"];
  },
): Promise<Id<"integrityRuns">> {
  const ok = !run.findings.some((f) => f.severity === "error");
  const id = await auditedInsert(
    ctx,
    "integrityRuns",
    { at: ctx.now(), ok, scope: run.scope, lastVerifiedSeq: run.lastVerifiedSeq, findings: run.findings },
    { action: "integrity.run", label: ok ? "ok" : `${run.findings.length} Befund(e)` },
  );
  // NTF-007: the cron raises the critical notification (in-app, e-mail, ntfy; cannot be switched off, NTF-002).
  if (!ok) {
    const first = run.findings.find((f) => f.severity === "error");
    await notifyKind(ctx, "integrity.failed", {
      title: "Integritätsprüfung fehlgeschlagen",
      ...(first ? { body: first.detail } : {}),
      link: "/einstellungen/system/integritaet",
      dedupeKey: `integrity.failed|${berlinCalendarDate(ctx.now())}`,
    });
    // AUD-015 / 05 §5.3: security-relevant, sent to every `*` endpoint (kinds and seq only, no data)
    await emitEvent(ctx, "integrity.check_failed", {
      id: encodeId("integrityRuns", id),
      object: "integrity_run",
      scope: run.scope,
      findings: run.findings
        .filter((f) => f.severity === "error")
        .map((f) => ({
          kind: f.kind,
          ...(f.firstBrokenSeq !== undefined ? { first_broken_seq: f.firstBrokenSeq } : {}),
        })),
      updated_at: new Date(ctx.now()).toISOString(),
    });
  }
  return id;
}

/** AUD-015 / E-AUD-16: acknowledging a failed run needs a note; it never alters data. */
export async function acknowledgeIntegrityRun(ctx: ModelCtx, runId: Id<"integrityRuns">, note: string): Promise<void> {
  const run = await ctx.db.get(runId);
  if (!run) throw appError("not_found");
  if (note.trim().length < 3) throw appError("invalid_input", "Bitte beschreiben Sie Ursache und Maßnahmen.");
  if (run.ok) throw appError("invalid_input", "Dieser Prüflauf war erfolgreich; es gibt nichts zu bestätigen.");
  await auditedPatch(
    ctx,
    "integrityRuns",
    runId,
    { acknowledgedAt: ctx.now(), acknowledgedNote: note.trim(), acknowledgedBy: ctx.actor },
    { action: "integrity.acknowledge", reason: note.trim() },
  );
}

export async function latestRun(ctx: ReadCtx): Promise<Doc<"integrityRuns"> | null> {
  return ctx.db.query("integrityRuns").withIndex("by_at").order("desc").first();
}

/** Finalisation guard (AUD-015): blocked while an ERROR run is unacknowledged. Used by F04 in P1. */
export async function unacknowledgedFailure(ctx: ReadCtx): Promise<Doc<"integrityRuns"> | null> {
  const run = await latestRun(ctx);
  return run && !run.ok && run.acknowledgedAt === undefined ? run : null;
}

export async function latestCheckpoint(ctx: ReadCtx): Promise<Doc<"integrityCheckpoints"> | null> {
  return ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").first();
}

export async function insertCheckpoint(
  ctx: ModelCtx,
  row: Omit<Doc<"integrityCheckpoints">, "_id" | "_creationTime" | "uploadStatus" | "at" | "exportedTo">,
): Promise<Id<"integrityCheckpoints">> {
  return auditedInsert(
    ctx,
    "integrityCheckpoints",
    { ...row, uploadStatus: "pending", at: ctx.now() },
    { action: "integrity.checkpoint", label: row.date },
  );
}

export async function recordCheckpointUpload(
  ctx: ModelCtx,
  id: Id<"integrityCheckpoints">,
  result: { ok: true; exportedTo: string } | { ok: false; detail: string },
): Promise<void> {
  const cp = await ctx.db.get(id);
  if (!cp) throw appError("not_found");
  // F12 §4.8: `checkpoint.upload_failed` after the second failed attempt for the same checkpoint.
  if (!result.ok && cp.uploadStatus === "failed") {
    await notifyKind(ctx, "checkpoint.upload_failed", {
      // E-AUD-10 (F12 §5.1)
      title: `Prüfpunkt konnte nicht extern gespeichert werden (${result.detail.slice(0, 200) || "unbekannter Fehler"}).`,
      body: `Prüfpunkt vom ${cp.date.split("-").reverse().join(".")}`,
      link: "/einstellungen/system/integritaet",
      entity: { table: "integrityCheckpoints", id },
    });
  }
  await auditedPatch(
    ctx,
    "integrityCheckpoints",
    id,
    result.ok ? { uploadStatus: "uploaded", exportedTo: result.exportedTo } : { uploadStatus: "failed" },
    { action: "integrity.checkpoint", label: cp.date, ...(result.ok ? {} : { reason: result.detail.slice(0, 300) }) },
  );
}
