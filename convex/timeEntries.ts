import { v } from "convex/values";
import { exactTimeNetCents, selectableForInvoicing } from "../src/domain/projects/invoicing";
import { resolveProjectRef } from "../src/domain/projects/lookup";
import { OFFLINE_CONFLICT_MESSAGE, type OfflineOp, planOfflineSync } from "../src/domain/projects/offline";
import {
  buildManualEntry,
  TIMER_AUTO_STOP_MS,
  TIMER_WARN_AFTER_MS,
  type TimeEntrySource,
} from "../src/domain/projects/time-entries";
import { timeReport } from "../src/domain/projects/time-report";
import { invoiceFromEntriesSchema, rateOverrideMicros, timeEntryFormSchema } from "../src/domain/schemas/projects";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, systemMutation, systemQuery } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { getCompanyProfile } from "./model/companyProfile";
import { projectBudget } from "./model/projects";
import {
  checkRunningTimer,
  createEntry,
  createOfflineRunEntry,
  deleteEntry,
  discardTimer,
  notifyOfflineConflict,
  processedOfflineOps,
  recordTimesheet,
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

/**
 * `time_entry_log` (F11 §7, MCP; REST can reuse it): „2h auf Projekt X: Workshop“. The project is given by ID,
 * number or name (E-PRJ-22: ambiguous / unknown → structured error with up to five candidates; E-PRJ-21: archived →
 * blocked); the date defaults to today (Europe/Berlin). Returns the entry and the project's budget status (PRJ-003).
 */
export const log = mutation({
  permission: "time.write",
  args: {
    project: v.string(),
    duration: v.string(),
    description: v.string(),
    date: v.optional(v.string()),
    billable: v.optional(v.boolean()),
    productId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const projects = await ctx.db.query("projects").collect();
    const ref = resolveProjectRef(
      a.project,
      projects.map((p) => ({ id: p._id as string, number: p.number, name: p.name, status: p.status })),
    );
    if (!ref.ok) {
      throw appError("invalid_input", ref.error.message, {
        reason: ref.error.code,
        field: "project",
        candidates: ref.error.candidates.map((c) => ({ ...c })),
      });
    }
    const project = projects.find((p) => p._id === ref.value.id);
    const today = berlinCalendarDate(ctx.now());
    const values = manualFrom(
      {
        date: a.date ?? today,
        mode: "duration",
        duration: a.duration,
        startTime: "",
        endTime: "",
        description: a.description,
        projectId: ref.value.id,
        contactId: "",
        productId: a.productId ?? "",
        billable: a.billable ?? project?.billingMode !== "non_billable",
        rate: "",
      },
      today,
    );
    const r = await createEntry(ctx, { ...values, source: sourceOf(ctx) });
    const entry = await ctx.db.get(r.id);
    const fresh = project ? await ctx.db.get(project._id) : null;
    return {
      id: r.id,
      warnings: r.warnings,
      entry: entry
        ? {
            date: entry.date,
            durationMinutes: entry.durationMinutes,
            description: entry.description,
            billable: entry.billable,
            hourlyRateMicros: entry.hourlyRateMicros,
            status: entry.status,
            source: entry.source,
          }
        : null,
      project: { id: ref.value.id, number: ref.value.number, name: ref.value.name },
      budget: fresh ? await projectBudget(ctx, fresh) : null,
    };
  },
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
    // PRJ-014: the dialog's „Leistungsnachweis anhängen“ defaults to the project's setting.
    const project = r.projectId ? await ctx.db.get(r.projectId) : null;
    const timesheetDefault = project?.attachTimesheetDefault === true;
    return r.plan.ok
      ? { ok: true as const, plan: r.plan.value, timesheetDefault }
      : { ok: false as const, error: r.plan.error };
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

// ── timesheet / Leistungsnachweis (PRJ-014) ──────────────────────────────────────────────────────────────────

/** Render input of `timesheetsNode.render`: the finalised invoice and its frozen (invoiced) entries. */
export const timesheetInput = systemQuery({
  job: "documents.pipeline",
  args: { documentId: v.id("salesDocuments") },
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.status === "draft" || !doc.number || !doc.attachTimesheet) return null;
    const entries = (
      await ctx.db
        .query("timeEntries")
        .withIndex("by_invoice", (q) => q.eq("invoicedDocumentId", documentId))
        .collect()
    ).filter((e) => e.status === "invoiced");
    if (entries.length === 0) return null;
    const profile = await getCompanyProfile(ctx);
    const project = doc.projectId ? await ctx.db.get(doc.projectId) : null;
    return {
      invoiceNumber: doc.number,
      documentDate: (doc.documentDate ?? berlinCalendarDate(doc.finalizedAt ?? ctx.now())) as CalendarDate,
      sellerName: profile?.name ?? "",
      customerName: doc.billingAddress?.name ?? doc.contactName ?? "",
      ...(project ? { projectLabel: `${project.number} ${project.name}` } : {}),
      createdAt: doc.finalizedAt ?? ctx.now(),
      entries: entries.map((e) => ({
        date: e.date as CalendarDate,
        description: e.description,
        durationMinutes: e.durationMinutes,
        ...(e.roundedMinutes !== undefined ? { roundedMinutes: e.roundedMinutes } : {}),
        hourlyRateMicros: e.hourlyRateMicros,
      })),
    };
  },
});

export const storeTimesheet = systemMutation({
  job: "documents.pipeline",
  args: {
    documentId: v.id("salesDocuments"),
    storageId: v.id("_storage"),
    sha256: v.string(),
    bytes: v.number(),
    name: v.string(),
  },
  handler: async (ctx, { documentId, ...file }) => recordTimesheet(ctx, documentId, file),
});

// ── offline queue (PRJ-018, E-PRJ-29) ─────────────────────────────────────────────────────────────────────────

const vOfflineFields = v.object(vTimerFields);

/**
 * Replays the offline queue of one device (manual entries, timer start/stop) in one transaction; the server assigns
 * the IDs. Two devices with a timer → the later start wins, the earlier run is saved flagged „Konflikt“ (E-PRJ-29).
 * Already applied operations (a replay after a lost response) are skipped.
 */
export const syncOffline = mutation({
  permission: "time.write",
  args: {
    deviceId: v.string(),
    ops: v.array(
      v.union(
        v.object({ id: v.string(), kind: v.literal("manual"), at: v.number(), values: v.any() }),
        v.object({ id: v.string(), kind: v.literal("timer_start"), at: v.number(), fields: vOfflineFields }),
        v.object({
          id: v.string(),
          kind: v.literal("timer_stop"),
          at: v.number(),
          fields: v.optional(vOfflineFields),
        }),
      ),
    ),
  },
  handler: async (ctx, { deviceId, ops }) => {
    if (ops.length > 500) throw appError("invalid_input", "Zu viele Offline-Einträge in einem Abgleich.");
    const done = await processedOfflineOps(
      ctx,
      ops.map((o) => ({
        id: o.id,
        at: o.at,
        ...(o.kind === "manual" && typeof o.values?.date === "string" ? { date: o.values.date } : {}),
      })),
    );
    const fresh = ops.filter((o) => !done.has(o.id)) as OfflineOp[];
    const t = await runningTimer(ctx);
    const plan = planOfflineSync(
      t ? { startedAt: t.startedAt, ...(t.deviceId ? { deviceId: t.deviceId } : {}) } : null,
      deviceId,
      fresh,
      ctx.now(),
    );
    const today = berlinCalendarDate(ctx.now());
    const entryIds: Id<"timeEntries">[] = [];
    const conflictIds: Id<"timeEntries">[] = [];
    const warnings: string[] = [];
    for (const a of plan.actions) {
      if (a.type === "manual") {
        const r = await createEntry(ctx, { ...manualFrom(a.values, today), source: "offline", offlineOpIds: [a.opId] });
        entryIds.push(r.id);
        warnings.push(...r.warnings);
      } else if (a.type === "start_timer") {
        await startTimer(ctx, { ...a.fields, deviceId, startedAt: a.startedAt, offlineOpId: a.opId });
        const started = await runningTimer(ctx);
        if (started) {
          // E-PRJ-03 measured from the offline start instant (the daily deadlines job is the fallback)
          const elapsed = ctx.now() - started.startedAt;
          for (const after of [TIMER_WARN_AFTER_MS, TIMER_AUTO_STOP_MS]) {
            await ctx.scheduler.runAfter(Math.max(0, after - elapsed), internal.timeEntries.checkTimer, {
              timerId: started._id,
            });
          }
        }
      } else if (a.type === "stop_timer") {
        const r = await stopTimer(ctx, {
          ...(a.fields ?? {}),
          endedAt: a.endedAt,
          conflict: a.conflict,
          source: a.conflict ? "timer" : "offline",
          offlineOpIds: [a.opId],
        });
        entryIds.push(...r.entryIds);
        if (a.conflict) conflictIds.push(...r.entryIds);
        warnings.push(...r.warnings);
      } else if (a.type === "entry") {
        const r = await createOfflineRunEntry(ctx, {
          ...a.fields,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          conflict: a.conflict,
          opId: a.opId,
        });
        if (r) {
          entryIds.push(r.id);
          if (a.conflict) conflictIds.push(r.id);
          warnings.push(...r.warnings);
        }
      }
    }
    if (plan.conflict) {
      await notifyOfflineConflict(ctx, conflictIds);
      warnings.push(OFFLINE_CONFLICT_MESSAGE);
    }
    return {
      applied: fresh.map((o) => o.id),
      skipped: ops.filter((o) => done.has(o.id)).map((o) => o.id),
      entryIds,
      conflict: plan.conflict,
      warnings: [...new Set(warnings)],
    };
  },
});

// ── time reports (PRJ-017) ──────────────────────────────────────────────────────────────────────────────────

/** Hours per project/customer/product/month/week, billable vs non-billable, unbilled value, utilisation per week. */
export const report = query({
  permission: "projects.read",
  args: {
    from: v.string(),
    to: v.string(),
    groupBy: v.union(
      v.literal("project"),
      v.literal("customer"),
      v.literal("product"),
      v.literal("month"),
      v.literal("week"),
    ),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, a) => {
    const from = a.from as CalendarDate;
    const to = a.to as CalendarDate;
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
      throw appError("invalid_input", "Bitte einen gültigen Zeitraum wählen.", { field: "from" });
    }
    const projectId = a.projectId;
    const rows = projectId
      ? await ctx.db
          .query("timeEntries")
          .withIndex("by_project", (q) => q.eq("projectId", projectId).gte("date", from).lte("date", to))
          .collect()
      : await ctx.db
          .query("timeEntries")
          .withIndex("by_date", (q) => q.gte("date", from).lte("date", to))
          .collect();
    const names = new Map<string, string | null>();
    const nameOf = async (id: Id<"projects"> | Id<"contacts"> | Id<"products"> | undefined) => {
      if (!id) return undefined;
      if (!names.has(id)) {
        const doc = await ctx.db.get(id);
        names.set(id, doc ? ("displayName" in doc ? doc.displayName : doc.name) : null);
      }
      return names.get(id) ?? null;
    };
    const entries = [];
    for (const e of rows) {
      entries.push({
        date: e.date as CalendarDate,
        durationMinutes: e.durationMinutes,
        billable: e.billable,
        status: e.status,
        hourlyRateMicros: e.hourlyRateMicros,
        ...(e.projectId ? { projectId: e.projectId, projectName: await nameOf(e.projectId) } : {}),
        ...(e.contactId ? { contactId: e.contactId, contactName: await nameOf(e.contactId) } : {}),
        ...(e.productId ? { productId: e.productId, productName: await nameOf(e.productId) } : {}),
      });
    }
    return timeReport(entries, { groupBy: a.groupBy, from, to });
  },
});

export type TimeEntryRow = Awaited<ReturnType<typeof label>>;
