import { v } from "convex/values";
import type { TemplateDraft } from "../src/domain/recurring/generate";
import { RECURRING_INTERVAL_LABELS_DE } from "../src/domain/recurring/schedule";
import { recurringTemplateSchema } from "../src/domain/schemas/recurring";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, actorMutation, mutation, query, systemAction, systemQuery } from "./functions";
import { isTest } from "./lib/env";
import { runFinalizePipeline } from "./lib/finalizePipeline";
import { parse } from "./lib/parse";
import {
  automationEffective,
  callerMayFinalize,
  confirmAutomation as confirmAutomationModel,
  createTemplate,
  dueTemplateIds,
  type GeneratedDraft,
  generatedDocuments,
  generateOccurrences,
  getTemplate,
  listTemplates,
  pauseTemplate,
  previewSourceOf,
  previewTemplate,
  recordFinalizeFailure,
  recordRunFailure,
  removeTemplate,
  resumeTemplate,
  type TemplateDoc,
  templateState,
  updateTemplate,
} from "./model/recurring";
import { displayStatusOf } from "./model/salesDocuments";
import type { ActorContext } from "./model/types";

/**
 * Wiederkehrende Rechnungen (F04 §3.4 REC-01…16, §4.11, §6.5). Templates are configuration (documents.write); the
 * generated invoices are ordinary drafts/invoices. The daily job `recurring.generate` (06:00 Europe/Berlin) runs as
 * `system:cron.recurring.generate`; it never exports or sends anything (owner decision B2, REC-16).
 */

function templateRow(t: TemplateDoc) {
  return {
    _id: t._id,
    name: t.name,
    contactId: t.contactId ?? null,
    contactName: t.contactName ?? null,
    contractReference: t.contractReference ?? null,
    state: templateState(t),
    status: t.status,
    interval: t.schedule.interval,
    intervalLabel: RECURRING_INTERVAL_LABELS_DE[t.schedule.interval],
    schedule: t.schedule,
    nextDate: templateState(t) === "ended" ? null : t.schedule.nextDate,
    amount: t.amount ?? null,
    automation: t.automation,
    automationConfirmed: t.automationConfirmedAt !== undefined,
    automationEffective: automationEffective(t),
    generatedCount: t.generatedCount,
    skippedOccurrences: t.skippedOccurrences.map((s) => s.date),
    archived: t.archivedAt !== undefined,
    version: t.version,
  };
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────

/** „Wiederkehrend“ list (§6.1): Aktiv · Pausiert · Beendet. */
export const list = query({
  permission: "documents.read",
  args: { tab: v.optional(v.union(v.literal("active"), v.literal("paused"), v.literal("ended"))) },
  handler: async (ctx, { tab }) => {
    const rows = (await listTemplates(ctx)).map(templateRow);
    const counts = {
      active: rows.filter((r) => r.state === "active").length,
      paused: rows.filter((r) => r.state === "paused").length,
      ended: rows.filter((r) => r.state === "ended").length,
    };
    return {
      counts,
      rows: rows
        .filter((r) => r.state === (tab ?? "active"))
        .sort((a, b) => (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999") || a.name.localeCompare(b.name)),
    };
  },
});

/** Template detail (§6.5): values for the editor, state, generated documents. */
export const get = query({
  permission: "documents.read",
  args: { id: v.id("recurringTemplates") },
  handler: async (ctx, { id }) => {
    const t = await ctx.db.get(id);
    if (!t) return null;
    const today = berlinCalendarDate(ctx.now());
    const docs = await generatedDocuments(ctx, id);
    return {
      ...templateRow(t),
      draft: t.draft as TemplateDraft,
      documents: docs.map((d) => ({
        _id: d._id,
        type: d.type,
        number: d.number ?? null,
        status: d.status,
        displayStatus: displayStatusOf(d, today),
        occurrence: d.recurringOccurrence?.date ?? null,
        supplyDate: d.supplyDate ?? null,
        documentDate: d.documentDate ?? null,
        grossCents: d.totals.grossCents,
        currency: d.currency,
      })),
    };
  },
});

/**
 * REC-13 „Nächste Termine“: the next `count` occurrences (default 12) of a saved template — or of unsaved editor
 * values — with periods, expected amounts, rates and the ER-03 decision.
 */
export const occurrences = query({
  permission: "documents.read",
  args: { id: v.optional(v.id("recurringTemplates")), values: v.optional(v.any()), count: v.optional(v.number()) },
  handler: async (ctx, { id, values, count }) => {
    const n = Math.max(1, Math.min(60, Math.floor(count ?? 12)));
    if (values !== undefined) {
      const parsed = recurringTemplateSchema.safeParse(values);
      if (!parsed.success) return null;
      const stored = id ? await ctx.db.get(id) : null;
      const p = parsed.data;
      const started = stored && (stored.generatedCount > 0 || stored.skippedOccurrences.length > 0);
      return previewTemplate(
        ctx,
        {
          name: p.name,
          contractReference: p.contractReference,
          draft: p.draft as TemplateDraft,
          schedule: {
            interval: p.schedule.interval,
            firstDate: p.schedule.firstDate as CalendarDate,
            nextDate: (started ? stored.schedule.nextDate : p.schedule.firstDate) as CalendarDate,
            endDate: p.schedule.endDate as CalendarDate | undefined,
            maxCount: p.schedule.maxCount,
            billing: p.schedule.billing,
            periodTextEnabled: p.schedule.periodTextEnabled,
          },
          generatedCount: stored?.generatedCount ?? 0,
        },
        ctx.now(),
        n,
      );
    }
    if (!id) return null;
    return previewTemplate(ctx, previewSourceOf(await getTemplate(ctx, id)), ctx.now(), n);
  },
});

// ── template writes ───────────────────────────────────────────────────────────────────────────────────────

export const create = mutation({
  permission: "documents.write",
  args: { values: v.any(), confirmAutomation: v.optional(v.boolean()) },
  handler: async (ctx, { values, confirmAutomation }) => ({
    id: await createTemplate(ctx, parse(recurringTemplateSchema, values), { confirmAutomation: !!confirmAutomation }),
  }),
});

export const update = mutation({
  permission: "documents.write",
  args: {
    id: v.id("recurringTemplates"),
    version: v.number(),
    values: v.any(),
    confirmAutomation: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, version, values, confirmAutomation }) =>
    updateTemplate(ctx, id, version, parse(recurringTemplateSchema, values), {
      confirmAutomation: !!confirmAutomation,
    }),
});

/** REC-14 UI confirmation of an automation stored via REST/MCP (arms number assignment: fresh session). */
export const confirmAutomation = mutation({
  permission: "invoices.finalize",
  args: { id: v.id("recurringTemplates") },
  handler: async (ctx, { id }) => confirmAutomationModel(ctx, id),
});

export const pause = mutation({
  permission: "documents.write",
  args: { id: v.id("recurringTemplates") },
  handler: async (ctx, { id }) => pauseTemplate(ctx, id),
});

/** REC-10: „nachberechnen“ (catch-up now, REC-06 rules) or „überspringen“ (audited skip). */
export const resume = mutation({
  permission: "documents.write",
  args: { id: v.id("recurringTemplates"), catchUp: v.boolean() },
  handler: async (ctx, { id, catchUp }) => {
    const r = await resumeTemplate(ctx, id, catchUp);
    if (catchUp && r.due > 0) await ctx.scheduler.runAfter(0, internal.recurring.generateTemplate, { id });
    return r;
  },
});

export const remove = mutation({
  permission: "documents.write",
  args: { id: v.id("recurringTemplates") },
  handler: async (ctx, { id }) => removeTemplate(ctx, id),
});

// ── generation ────────────────────────────────────────────────────────────────────────────────────────────

/** One template's run in one transaction (REC-05 idempotency); the caller finalises the returned drafts. */
export const generate = actorMutation({
  permission: "documents.write",
  args: { id: v.id("recurringTemplates"), mode: v.union(v.literal("scheduled"), v.literal("now")) },
  handler: async (ctx, { id, mode }) => generateOccurrences(ctx, id, mode),
});

export const finalizeFailed = actorMutation({
  permission: "documents.write",
  args: { id: v.id("salesDocuments"), code: v.string(), message: v.string(), findings: v.array(v.string()) },
  handler: async (ctx, a) => recordFinalizeFailure(ctx, a.id, a),
});

export const runFailed = actorMutation({
  permission: "documents.write",
  args: { id: v.id("recurringTemplates"), message: v.string() },
  handler: async (ctx, a) => recordRunFailure(ctx, a.id, a.message),
});

export const dueTemplates = systemQuery({
  job: "cron.recurring.generate",
  args: {},
  handler: async (ctx) => dueTemplateIds(ctx, berlinCalendarDate(ctx.now())),
});

type ErrorData = { code?: string; message?: string; findings?: { message?: string }[] };
const errorData = (e: unknown): ErrorData => {
  const data = (e as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as ErrorData) : { code: "error", message: String(e) };
};

/**
 * REC-07: finalise a generated draft through the full pipeline; any blocking error, validator outage or clock
 * problem keeps the draft (with its review to-do) and notifies the owner with the error list.
 */
async function finalizeOrNotify(ctx: ActionCtx, actorContext: ActorContext, d: GeneratedDraft) {
  try {
    await runFinalizePipeline(ctx, actorContext, { id: d.id, version: d.version });
    return true;
  } catch (e) {
    const data = errorData(e);
    await ctx.runMutation(internal.recurring.finalizeFailed, {
      actorContext,
      id: d.id,
      code: data.code ?? "error",
      message: data.message ?? "Fehler beim Fertigstellen",
      findings: (data.findings ?? []).map((f) => f.message ?? "").filter(Boolean),
    });
    return false;
  }
}

async function runTemplate(
  ctx: ActionCtx,
  actorContext: ActorContext,
  id: Id<"recurringTemplates">,
  mode: "scheduled" | "now",
  mayFinalize: boolean,
): Promise<{ created: number; finalized: number; ids: Id<"salesDocuments">[] }> {
  const drafts: GeneratedDraft[] = await ctx.runMutation(internal.recurring.generate, { actorContext, id, mode });
  let finalized = 0;
  for (const d of drafts) {
    if (d.finalize && mayFinalize && (await finalizeOrNotify(ctx, actorContext, d))) finalized++;
  }
  return { created: drafts.length, finalized, ids: drafts.map((d) => d.id) };
}

/** `recurring.generate` — daily 06:00 Europe/Berlin (02 §7, REC-05). One failing template never stops the others. */
export const generateCron = systemAction({
  job: "cron.recurring.generate",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ templates: number; created: number; finalized: number }> => {
    if (isTest() && !force) return { templates: 0, created: 0, finalized: 0 };
    const ids: Id<"recurringTemplates">[] = await ctx.runQuery(internal.recurring.dueTemplates, {});
    let created = 0;
    let finalized = 0;
    for (const id of ids) {
      try {
        const r = await runTemplate(ctx, ctx.actorContext, id, "scheduled", true);
        created += r.created;
        finalized += r.finalized;
      } catch (e) {
        const data = errorData(e);
        await ctx.runMutation(internal.recurring.runFailed, {
          actorContext: ctx.actorContext,
          id,
          message: data.message ?? "Unbekannter Fehler",
        });
      }
    }
    return { templates: ids.length, created, finalized };
  },
});

/** REC-10 „nachberechnen“: the catch-up run of one template right after resuming (same rules as the job). */
export const generateTemplate = systemAction({
  job: "cron.recurring.generate",
  args: { id: v.id("recurringTemplates") },
  handler: async (ctx, { id }): Promise<{ created: number; finalized: number; ids: Id<"salesDocuments">[] }> =>
    runTemplate(ctx, ctx.actorContext, id, "scheduled", true),
});

/**
 * REC-12 „Jetzt erzeugen“: the next occurrence now, advancing the schedule. With effective automation the invoice
 * is finalised as the caller when the caller may finalise (role or `invoices:finalize` scope); otherwise it stays a
 * draft with the review to-do.
 */
export const runNow = action({
  permission: "documents.write",
  args: { id: v.id("recurringTemplates") },
  handler: async (ctx, { id }): Promise<{ created: number; finalized: number; ids: Id<"salesDocuments">[] }> =>
    runTemplate(ctx, ctx.actorContext, id, "now", callerMayFinalize(ctx.actorContext)),
});
