import { v } from "convex/values";
import { DATEV_MESSAGES } from "../src/domain/datev/mapping";
import { type DatevReport, runDatevExport } from "../src/domain/datev/run";
import { internal } from "./_generated/api";
import { action, mutation, query, systemMutation, systemQuery, vConfirmToken } from "./functions";
import { loadDatevInput } from "./lib/datevLoad";
import { appError } from "./lib/errors";
import { appendAudit } from "./model/audit";
import {
  assignDatevAccounts,
  type DatevStartArgs,
  datevContext,
  datevEntriesPage,
  datevStatus,
  listDatevExports,
  recordDatevAcceptance,
  recordDatevExport,
  setDatevBelegnummer,
  startDatevExport,
} from "./model/datev";
import { advanceJob, failJob, finishJob } from "./model/jobs";

/**
 * F09 EXP-001…016 DATEV export (P3, low priority): dry run, export job (`datev_export`, worker convex/datevJob.ts),
 * history with the stored ZIP, advisor acceptance and the „Testexport" confirmation (EXP-016, E-EXP-18).
 */

export const vDatevScope = v.union(
  v.literal("revenue"),
  v.literal("vouchers"),
  v.literal("payments"),
  v.literal("assets"),
  v.literal("manual"),
  v.literal("master_data"),
  v.literal("documents"),
);
const exportArgs = {
  from: v.string(),
  to: v.string(),
  scope: v.array(vDatevScope),
  mode: v.union(v.literal("new"), v.literal("full")),
  festschreibung: v.optional(v.boolean()),
  confirmReplace: v.optional(v.boolean()),
};

export const status = query({
  permission: "exports.datev.read",
  args: {},
  handler: async (ctx) => datevStatus(ctx),
});

export const list = query({
  permission: "exports.datev.read",
  args: {},
  handler: async (ctx) => listDatevExports(ctx),
});

/** „Prüfen" (EXP-007): the validation report without writing anything (also REST `…/validate`, MCP preview). */
export const validate = action({
  permission: "exports.datev.validate",
  args: { ...exportArgs, lockPeriod: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<DatevReport> => {
    const { input, running } = await loadDatevInput(ctx, args, { withBytes: false, now: Date.now() });
    const { report } = await runDatevExport(input);
    if (running) {
      report.issues.unshift({ level: "error", code: "DATEV_RUNNING", message: DATEV_MESSAGES.running });
      report.blocking = true;
    }
    return report;
  },
});

/** ⚠ „Export erstellen": starts the job (E-EXP-20 one per overlapping range). MCP needs the confirm token. */
export const start = mutation({
  permission: "exports.datev",
  args: { ...exportArgs, confirmToken: vConfirmToken },
  handler: async (ctx, args) => {
    const jobId = await startDatevExport(ctx, args as DatevStartArgs);
    await ctx.scheduler.runAfter(0, internal.datevJob.run, { jobId });
    return { jobId };
  },
});

/**
 * ⚠ EXP-011 „Zeitraum beim Export festschreiben": locks the months of the range first (irreversible, reason
 * `datev_export`, fresh session) and starts the job in the same transaction.
 */
export const startWithLock = mutation({
  permission: "exports.datev.lock",
  args: { ...exportArgs, confirmToken: vConfirmToken },
  handler: async (ctx, args) => {
    const jobId = await startDatevExport(ctx, { ...(args as DatevStartArgs), lockPeriod: true });
    await ctx.scheduler.runAfter(0, internal.datevJob.run, { jobId });
    return { jobId };
  },
});

/**
 * EXP-009: downloads re-serve the stored ZIP (audited). Until the advisor acceptance is recorded every download needs
 * the „Testexport" confirmation and is audited as `export.datev_test_download` (EXP-016, E-EXP-18).
 */
export const download = mutation({
  permission: "exports.datev.read",
  args: { id: v.id("datevExports"), testConfirmed: v.optional(v.boolean()) },
  handler: async (ctx, { id, testConfirmed }) => {
    const row = await ctx.db.get(id);
    if (!row) throw appError("not_found", "Export nicht gefunden.");
    const accepted = (await ctx.db.query("datevAcceptance").first()) !== null;
    if (!accepted && testConfirmed !== true) {
      throw appError("invalid_input", DATEV_MESSAGES.notAccepted, { reason: "DATEV_TEST_CONFIRMATION_REQUIRED" });
    }
    await appendAudit(ctx, {
      action: accepted ? "export.datev_download" : "export.datev_test_download",
      entity: { table: "exports", id: `datev-${id}`, label: row.file.name },
      diff: { after: { sha256: row.file.sha256, from: row.from, to: row.to } },
    });
    return { url: await ctx.storage.getUrl(row.file.storageId), name: row.file.name };
  },
});

/** EXP-016: the advisor's test-import result (append-only; banner and confirmation disappear). */
export const recordAcceptance = mutation({
  permission: "exports.datev.acceptance",
  args: {
    testedOn: v.string(),
    formatVersion: v.union(v.literal(12), v.literal(13)),
    buKeysConfirmed: v.boolean(),
    advisorName: v.optional(v.string()),
    remarks: v.optional(v.string()),
  },
  handler: async (ctx, args) => recordDatevAcceptance(ctx, args),
});

/** E-EXP-10: DATEV-safe alias for a legacy document number (set once, audited). */
export const setBelegnummer = mutation({
  permission: "exports.datev",
  args: { documentId: v.id("salesDocuments"), alias: v.string(), confirmToken: vConfirmToken },
  handler: async (ctx, { documentId, alias }) => setDatevBelegnummer(ctx, { documentId, alias }),
});

// ── worker reads/writes (job "exports.run") ─────────────────────────────────────────────────────────────

export const context = systemQuery({
  job: "exports.run",
  args: { from: v.string(), to: v.string(), lockPeriod: v.optional(v.boolean()) },
  handler: async (ctx, a) => datevContext(ctx, { ...a, now: ctx.now() }),
});

export const entriesPage = systemQuery({
  job: "exports.run",
  args: {
    from: v.string(),
    to: v.string(),
    scope: v.array(vDatevScope),
    cursor: v.union(v.string(), v.null()),
    documents: v.boolean(),
  },
  handler: async (ctx, a) => datevEntriesPage(ctx, a),
});

export const job = systemQuery({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    const j = await ctx.db.get(jobId);
    return j && j.kind === "datev_export" && j.status === "queued" ? (j.params as DatevStartArgs) : null;
  },
});

export const step = systemMutation({
  job: "exports.run",
  args: { jobId: v.id("jobs"), done: v.number() },
  handler: async (ctx, { jobId, done }) => advanceJob(ctx, jobId, { status: "running", done }),
});

const asJobActor = <C extends { actor: unknown; actorContext: unknown }>(ctx: C, by: { actor: string }) => ({
  ...ctx,
  actor: by.actor as C["actor"],
  actorContext: by as unknown as C["actorContext"],
});

/** EXP-006 / E-EXP-13: personal accounts assigned for the export, attributed to the member who started it. */
export const assign = systemMutation({
  job: "exports.run",
  args: {
    jobId: v.id("jobs"),
    needs: v.array(v.object({ contactId: v.string(), kind: v.union(v.literal("debtor"), v.literal("creditor")) })),
  },
  handler: async (ctx, { jobId, needs }) => {
    const j = await ctx.db.get(jobId);
    if (!j) return 0;
    return assignDatevAccounts(asJobActor(ctx, j.by), needs);
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
    files: v.array(v.object({ name: v.string(), sha256: v.string(), rowsSha256: v.optional(v.string()) })),
    lineIds: v.array(v.string()),
    rowCount: v.number(),
    sumUmsatzCents: v.number(),
    festschreibung: v.boolean(),
    isRepeat: v.boolean(),
    doNotReimport: v.boolean(),
    formatVersion: v.union(v.literal(12), v.literal(13)),
    report: v.any(),
  },
  handler: async (ctx, a) => {
    const j = await ctx.db.get(a.jobId);
    if (!j) return false;
    // EXP-009: the ZIP is kept with the history row (not as a 30-day job result).
    const ok = await finishJob(ctx, a.jobId, { name: a.name, sha256: a.sha256, bytes: a.bytes });
    if (!ok) {
      await ctx.storage.delete(a.storageId);
      return false;
    }
    const { jobId: _j, ...rest } = a;
    await recordDatevExport(asJobActor(ctx, j.by), j, rest);
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
