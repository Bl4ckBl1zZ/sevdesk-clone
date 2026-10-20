import { v } from "convex/values";
import { exactTimeNetCents, selectableForInvoicing } from "../src/domain/projects/invoicing";
import {
  buildManualEntry,
  TIMER_AUTO_STOP_MS,
  TIMER_WARN_AFTER_MS,
  type TimeEntrySource,
} from "../src/domain/projects/time-entries";
import { invoiceFromEntriesSchema, rateOverrideMicros, timeEntryFormSchema } from "../src/domain/schemas/projects";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, systemMutation } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import {
  checkRunningTimer,
  createEntry,
  deleteEntry,
  discardTimer,
  reopenCandidates,
  reopenEntries,
  runningTimer,
  setBillable,
  startTimer,
  stopTimer,
  unbilledSummary,
  updateEntry,
  updateTimer,
} from "./model/timeEntries";
import { invoiceFromEntries, planFromEntries } from "./model/timeInvoicing";
import type { ActorFields, ReadCtx } from "./model/types";

/**
 * Zeiterfassung (F11 PRJ-005…016): entries, the cross-device timer and „Zeiten abrechnen“. Writes go through
 * convex/model/timeEntries.ts and convex/model/timeInvoicing.ts.
 */

const vStatus = v.optional(v.union(v.literal("open"), v.literal("in_draft"), v.literal("invoiced")));

const sourceOf = (ctx: ActorFields): TimeEntrySource =>
  ctx.actorContext.channel === "mcp" ? "mcp" : ctx.actorContext.channel === "api" ? "api" : "manual";

async function label(ctx: ReadCtx, e: Doc<"timeEntries">) {
  const project = e.projectId ? await ctx.db.get(e.projectId) : null;
  const contact = e.contactId ? await ctx.db.get(e.contactId) : null;
  const product = e.productId ? await ctx.db.get(e.productId) : null;
  const docId = e.status === "in_draft" ? e.draftDocumentId : e.invoicedDocumentId;
  const doc = docId ? await ctx.db.get(docId) : null;
  return {
    ...e,
    projectName: project?.name ?? null,
    contactName: contact?.displayName ?? null,
    productName: product?.name ?? null,
    valueCents: exactTimeNetCents(e.durationMinutes, e.hourlyRateMicros),
    document: doc ? { _id: doc._id, number: doc.number ?? null } : null,
  };
}

export const list = query({
  permission: "projects.read",
  args: {
    projectId: v.optional(v.id("projects")),
    contactId: v.optional(v.id("contacts")),
    status: vStatus,
    billable: v.optional(v.boolean()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    /** PRJ-016: the invoicing selection (open, billable unless includeNonBillable). */
    forInvoicing: v.optional(v.boolean()),
    includeNonBillable: v.optional(v.boolean()),
  },
  handler: async (ctx, f) => {
    let rows: Doc<"timeEntries">[];
    if (f.projectId) {
      rows = await ctx.db
        .query("timeEntries")
        .withIndex("by_project", (q) => q.eq("projectId", f.projectId))
        .collect();
    } else if (f.contactId) {
      rows = await ctx.db
        .query("timeEntries")
        .withIndex("by_contact", (q) => q.eq("contactId", f.contactId))
        .collect();
    } else if (f.status) {
      const status = f.status;
      rows = await ctx.db
        .query("timeEntries")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
    } else {
      rows = await ctx.db.query("timeEntries").withIndex("by_date").order("desc").take(2000);
    }
    rows = rows.filter(
      (e) =>
        (!f.status || e.status === f.status) &&
        (!f.contactId || e.contactId === f.contactId) &&
        (f.billable === undefined || e.billable === f.billable) &&
        (!f.from || e.date >= f.from) &&
        (!f.to || e.date <= f.to),
    );
    if (f.forInvoicing) rows = selectableForInvoicing(rows, { includeNonBillable: f.includeNonBillable === true });
    rows.sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const out = [];
    for (const e of rows) out.push(await label(ctx, e));
    return out;
  },
});

export const get = query({
  permission: "projects.read",
  args: { id: v.id("timeEntries") },
  handler: async (ctx, { id }) => {
    const e = await ctx.db.get(id);
    return e ? label(ctx, e) : null;
  },
});

function manualFrom(values: unknown, today: CalendarDate) {
  const f = parse(timeEntryFormSchema, values);
  const built = buildManualEntry(
    {
      date: f.date as CalendarDate,
      ...(f.mode === "start_end" ? { startTime: f.startTime, endTime: f.endTime } : { duration: f.duration }),
      description: f.description,
    },
    today,
  );
  if (!built.ok) {
    const first = built.error[0];
    throw appError("invalid_input", first?.message, {
      ...(first ? { reason: first.code, field: first.field } : {}),
      issues: built.error.map((i) => ({ path: i.field, message: i.message })),
    });
  }
  const rate = rateOverrideMicros(f.rate);
  return {
    date: built.value.date,
    durationMinutes: built.value.durationMinutes,
    ...(built.value.startedAt !== undefined ? { startedAt: built.value.startedAt } : {}),
    ...(built.value.endedAt !== undefined ? { endedAt: built.value.endedAt } : {}),
    description: built.value.description,
    ...(f.projectId ? { projectId: f.projectId } : {}),
    ...(f.contactId ? { contactId: f.contactId } : {}),
    ...(f.productId ? { productId: f.productId } : {}),
    billable: f.billable,
    ...(rate !== undefined ? { rateOverrideMicros: rate } : {}),
  };
}

/** PRJ-007 manual entry (UI „Zeit erfassen“, REST `POST /time-entries`). */
export const create = mutation({
  permission: "time.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) =>
    createEntry(ctx, { ...manualFrom(values, berlinCalendarDate(ctx.now())), source: sourceOf(ctx) }),
});

export const update = mutation({
  permission: "time.write",
  args: { id: v.id("timeEntries"), values: v.any() },
  handler: async (ctx, { id, values }) => updateEntry(ctx, id, manualFrom(values, berlinCalendarDate(ctx.now()))),
});

export const remove = mutation({
  permission: "time.write",
  args: { ids: v.array(v.id("timeEntries")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) await deleteEntry(ctx, id);
    return { deleted: ids.length };
  },
});

export const setBillableFlag = mutation({
  permission: "time.write",
  args: { ids: v.array(v.id("timeEntries")), billable: v.boolean() },
  handler: async (ctx, { ids, billable }) => ({ updated: await setBillable(ctx, ids, billable) }),
});

// ── timer (PRJ-005) ──────────────────────────────────────────────────────────────────────────────────────────

const vTimerFields = {
  projectId: v.optional(v.string()),
  contactId: v.optional(v.string()),
  description: v.optional(v.string()),
  productId: v.optional(v.string()),
  billable: v.optional(v.boolean()),
};

/** Live on every device (Convex subscription). */
export const timer = query({
  permission: "projects.read",
  args: {},
  handler: async (ctx) => {
    const t = await runningTimer(ctx);
    if (!t) return null;
    const project = t.projectId ? await ctx.db.get(t.projectId) : null;
    return { ...t, projectName: project?.name ?? null };
  },
});

export const start = mutation({
  permission: "time.write",
  args: { ...vTimerFields, deviceId: v.optional(v.string()), confirmStop: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const r = await startTimer(ctx, args);
    const t = await runningTimer(ctx);
    if (t) {
      // E-PRJ-03: the 10 h warning and the 24 h auto-stop run on time (the daily deadlines job is the fallback).
      await ctx.scheduler.runAfter(TIMER_WARN_AFTER_MS, internal.timeEntries.checkTimer, { timerId: t._id });
      await ctx.scheduler.runAfter(TIMER_AUTO_STOP_MS, internal.timeEntries.checkTimer, { timerId: t._id });
    }
    return r;
  },
});

export const updateRunning = mutation({
  permission: "time.write",
  args: vTimerFields,
  handler: async (ctx, args) => {
    await updateTimer(ctx, args);
    return null;
  },
});

export const stop = mutation({
  permission: "time.write",
  args: { ...vTimerFields, splitAtMidnight: v.optional(v.boolean()) },
  handler: async (ctx, args) => stopTimer(ctx, args),
});

export const discard = mutation({
  permission: "time.write",
  args: {},
  handler: async (ctx) => {
    await discardTimer(ctx);
    return null;
  },
});

/** Scheduled at timer start (10 h / 24 h) and run by `deadlines.notify`. */
export const checkTimer = systemMutation({
  job: "cron.deadlines.notify",
  args: { timerId: v.optional(v.id("runningTimer")) },
  handler: async (ctx, { timerId }) => {
    const t = await runningTimer(ctx);
    if (!t || (timerId && t._id !== timerId)) return "none";
    return checkRunningTimer(ctx);
  },
});

// ── invoicing (PRJ-010…013) ──────────────────────────────────────────────────────────────────────────────────

/** Dialog preview: lines, raw vs rounded minutes, amounts, supply period, notices — or the blocking issue. */
export const previewInvoice = query({
  permission: "projects.read",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const r = await planFromEntries(ctx, parse(invoiceFromEntriesSchema, values));
    return r.plan.ok ? { ok: true as const, plan: r.plan.value } : { ok: false as const, error: r.plan.error };
  },
});

export const createInvoice = mutation({
  permission: "documents.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => invoiceFromEntries(ctx, parse(invoiceFromEntriesSchema, values)),
});

/** Open invoice drafts of a contact („Zu Entwurf hinzufügen“). */
export const draftsOfContact = query({
  permission: "documents.read",
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) =>
    (
      await ctx.db
        .query("salesDocuments")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId).eq("type", "invoice"))
        .collect()
    )
      .filter((d) => d.status === "draft")
      .map((d) => ({ _id: d._id, subject: d.subject ?? null, netCents: d.totals.netCents, version: d.version })),
});

// ── Storno offer (E-PRJ-25) and UST-01 (PRJ-015) ────────────────────────────────────────────────────────────

export const reopenOffers = query({
  permission: "projects.read",
  args: {},
  handler: async (ctx) => reopenCandidates(ctx),
});

export const reopen = mutation({
  permission: "time.write",
  args: { invoiceId: v.id("salesDocuments") },
  handler: async (ctx, { invoiceId }) => ({ reopened: await reopenEntries(ctx, invoiceId) }),
});

export const unbilled = query({
  permission: "projects.read",
  args: {},
  handler: async (ctx) => unbilledSummary(ctx, berlinCalendarDate(ctx.now())),
});

export type TimeEntryRow = Awaited<ReturnType<typeof label>>;
