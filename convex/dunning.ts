import { v } from "convex/values";
import { canDo, canKeyDo } from "../src/domain/access/permissions";
import { defaultMarkSelection, effectiveMark } from "../src/domain/documents/dispatch";
import { defaultStartOf } from "../src/domain/dunning/default-start";
import { type DunningAction, SKIP_REASON_LABEL_DE } from "../src/domain/dunning/evaluate";
import { computeInterest } from "../src/domain/dunning/interest";
import { limitationStatus } from "../src/domain/dunning/limitation";
import { paymentTermsWarning, validatePolicy } from "../src/domain/dunning/policy";
import {
  caseActionSchema,
  dunningSettingsSchema,
  interestQuerySchema,
  policySchema,
  reminderCreateSchema,
  reminderWithdrawSchema,
  zugangOverrideSchema,
} from "../src/domain/schemas/dunning";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, systemMutation, vConfirmToken } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { getCompanyProfile } from "./model/companyProfile";
import {
  archivePolicy,
  caseAction as caseActionModel,
  caseOf,
  createPolicy as createPolicyModel,
  createReminderDraft,
  deleteReminderDraft,
  dueSoon,
  dunnableInvoices,
  evaluationContext,
  finalizeReminder,
  listPolicies,
  loadInvoiceState,
  overrideZugang as overrideZugangModel,
  planReminder,
  planRun,
  recentRuns,
  refreshOverdue,
  remindersOf,
  runDunning,
  saveContactDunning,
  saveSettings as saveSettingsModel,
  updatePolicy as updatePolicyModel,
  updateReminderDraft,
  withdrawReminder as withdrawReminderModel,
} from "./model/dunning";
import {
  archivedArtifacts,
  displayStatusOf,
  documentArtifacts,
  lastExportArtifactIds,
  sendLogOf,
  sendLogRows,
  snapshotOf,
} from "./model/salesDocuments";
import type { ReadCtx } from "./model/types";

/**
 * Mahnwesen (F05 §3.7–§3.10, §6.4–§6.6). Thin public functions over convex/model/dunning.ts. The dunning run is ⚠
 * (`dunning.run`, MCP confirm token from `dunning_preview`); reminder drafts are free; finalising a reminder needs
 * `invoices.finalize`, marking it sent uses the generic `invoices.markSent` (F04 §3.5). Nothing is ever sent.
 */

type SalesDoc = Doc<"salesDocuments">;

// ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function reminderView(r: SalesDoc, invoice: SalesDoc | null) {
  const rem = r.reminder;
  return {
    id: r._id,
    number: r.number ?? null,
    status: r.status,
    level: rem?.level ?? 0,
    title: rem?.title ?? "",
    invoiceId: rem?.invoiceId ?? null,
    invoiceNumber: invoice?.number ?? null,
    contactId: r.contactId ?? null,
    contactName: r.contactName ?? null,
    documentDate: r.documentDate ?? null,
    openAmountCents: rem?.openAmountCents ?? 0,
    feeCents: rem?.feeCents ?? 0,
    interestCents: rem?.interestCents ?? 0,
    flatFee40Cents: rem?.flatFee40Cents ?? 0,
    totalCents: rem?.totalCents ?? 0,
    newDueDate: rem?.newDueDate ?? null,
    defaultStartDate: rem?.defaultStartDate ?? null,
    createdByRun: rem?.createdByRun === true,
    finalizedAt: r.finalizedAt ?? null,
    sentOn: r.sentOn ?? null,
    zugang: r.zugang ?? null,
    artifactStatus: r.artifactStatus ?? null,
    cancellation: r.cancellation ? { at: r.cancellation.at, reason: r.cancellation.reason } : null,
    version: r.version,
  };
}

export type ReminderView = ReturnType<typeof reminderView>;

function actionView(a: DunningAction) {
  if (a.kind === "skip") {
    return {
      invoiceId: a.invoiceId,
      number: a.number,
      kind: a.kind,
      level: a.level ?? null,
      reason: a.reason,
      reasonLabel: SKIP_REASON_LABEL_DE[a.reason],
      detail: a.detail ?? null,
      claim: null,
      notes: [],
    };
  }
  if (a.kind === "todo_mark_sent") {
    return {
      invoiceId: a.invoiceId,
      number: a.number,
      kind: a.kind,
      level: null,
      reason: null,
      reasonLabel: `Mahnung ${a.reminderNumber ?? ""} noch nicht als versendet markiert – Erinnerung`,
      detail: null,
      claim: null,
      notes: [],
    };
  }
  return {
    invoiceId: a.invoiceId,
    number: a.number,
    kind: a.kind,
    level: a.level,
    reason: null,
    reasonLabel: a.step.title,
    detail: null,
    claim: {
      title: a.claim.title,
      openAmountCents: a.claim.openAmountCents,
      feeCents: a.claim.feeCents,
      interestCents: a.claim.interestCents,
      flatFee40Cents: a.claim.flatFee40Cents,
      flatFeeAlreadyClaimed: a.claim.flatFeeAlreadyClaimed,
      totalCents: a.claim.totalCents,
      newDueDate: a.claim.newDueDate,
      inDefault: a.claim.inDefault,
      defaultStartDate: a.claim.defaultStartDate ?? null,
    },
    notes: [...a.notes],
  };
}

async function previewOf(ctx: ReadCtx, date: CalendarDate, invoiceIds?: readonly string[]) {
  const plan = await planRun(ctx, date, invoiceIds);
  const contacts = new Map<string, string>();
  for (const inv of await dunnableInvoices(ctx)) contacts.set(inv._id, inv.contactName ?? "");
  return {
    date: plan.date,
    digest: plan.digest,
    bankDataCurrent: plan.bankDataCurrent,
    bankDataNote: plan.bankDataNote ?? null,
    actions: plan.actions.map((a) => ({ ...actionView(a), contactName: contacts.get(a.invoiceId) ?? "" })),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** DUN-031 „Vorschau nächster Lauf“ (dry run; `digest` binds the MCP confirm token, DUN-031). */
export const preview = query({
  permission: "payments.read",
  args: { date: v.optional(v.string()), invoiceIds: v.optional(v.array(v.string())) },
  handler: async (ctx, { date, invoiceIds }) => {
    const today = berlinCalendarDate(ctx.now());
    const d = date && isCalendarDate(date) ? date : today;
    return { ...(await previewOf(ctx, d, invoiceIds)), today };
  },
});

/** §6.4 Mahnungen cockpit: all tabs in one read (one small business — tens of open items). */
export const cockpit = query({
  permission: "payments.read",
  args: {},
  handler: async (ctx) => {
    const today = berlinCalendarDate(ctx.now());
    const reminders = await ctx.db
      .query("salesDocuments")
      .withIndex("by_type_status_date", (q) => q.eq("type", "reminder"))
      .collect();
    const invoices = new Map<string, SalesDoc | null>();
    const invoiceOf = async (id: Id<"salesDocuments"> | undefined) => {
      if (!id) return null;
      if (!invoices.has(id)) invoices.set(id, await ctx.db.get(id));
      return invoices.get(id) ?? null;
    };
    const views = [];
    for (const r of reminders) views.push(reminderView(r, await invoiceOf(r.reminder?.invoiceId)));
    const open = await dunnableInvoices(ctx);
    const caseRows = await ctx.db.query("dunningCases").collect();
    const cases = new Map(caseRows.map((c) => [c.invoiceId as string, c]));
    const invoiceRow = (d: SalesDoc) => {
      const c = cases.get(d._id);
      const lim = d.dueDate ? limitationStatus(d.dueDate as CalendarDate, today) : null;
      return {
        id: d._id,
        number: d.number ?? "",
        contactName: d.contactName ?? "",
        dueDate: d.dueDate ?? null,
        openAmountCents: d.openAmountCents ?? 0,
        displayStatus: displayStatusOf(d, today),
        level: c?.currentLevel ?? 0,
        caseStatus: c?.status ?? null,
        pausedUntil: c?.pausedUntil ?? null,
        pausedReason: c?.pausedReason ?? null,
        disputed: d.disputed ? { reason: d.disputed.reason } : null,
        blocked: d.dunningBlocked ? { reason: d.dunningBlocked.reason } : null,
        firstExportedAt: d.firstExportedAt ?? null,
        limitation: lim ? { date: lim.date, state: lim.state, message: lim.message ?? null } : null,
      };
    };
    const soon = await dueSoon(ctx, today);
    return {
      today,
      dueSoon: soon.map(invoiceRow),
      drafts: views.filter((r) => r.status === "draft"),
      toSend: views.filter((r) => r.status === "finalized"),
      sent: views.filter((r) => r.status === "sent"),
      withdrawn: views.filter((r) => r.status === "cancelled"),
      unmarked: open.filter((d) => !d.zugang && d.dueDate && d.dueDate < today).map(invoiceRow),
      paused: open
        .filter(
          (d) => d.disputed || d.dunningBlocked || ["paused", "handed_over"].includes(cases.get(d._id)?.status ?? ""),
        )
        .map(invoiceRow),
      limitation: open.map(invoiceRow).filter((r) => r.limitation && r.limitation.state !== "ok"),
      runs: await recentRuns(ctx, 30),
      counts: {
        drafts: views.filter((r) => r.status === "draft").length,
        toSend: views.filter((r) => r.status === "finalized").length,
      },
    };
  },
});

/** Reminder detail (§6.5): the claim, invoice, case, artifacts, send log and the mark defaults. */
export const reminder = query({
  permission: "documents.read",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id);
    if (r?.type !== "reminder" || !r.reminder) return null;
    const today = berlinCalendarDate(ctx.now());
    const invoice = await ctx.db.get(r.reminder.invoiceId);
    const c = await caseOf(ctx, r.reminder.invoiceId);
    const artifacts = r.status === "draft" ? [] : await documentArtifacts(ctx, id);
    const log = r.status === "draft" ? [] : await sendLogOf(ctx, id);
    const contact = r.contactId ? await ctx.db.get(r.contactId) : null;
    let findings: { code: string; severity: string; message: string }[] = [];
    let computed = null;
    if (r.status === "draft" && invoice) {
      try {
        const plan = await planReminder(
          ctx,
          invoice._id,
          { level: r.reminder.level, manual: r.reminder.manual ?? {} },
          today,
          { forFinalize: true, excludeReminderId: id },
        );
        findings = plan.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
        computed = {
          feeCents: plan.computed.feeCents,
          interestCents: plan.computed.interestCents,
          flatFee40Cents: plan.computed.flatFee40Cents,
          totalCents: plan.claim.totalCents,
          newDueDate: plan.claim.newDueDate,
          interestSegments: plan.claim.interestSegments,
          inDefault: plan.claim.inDefault,
          defaultStartDate: plan.claim.defaultStartDate ?? null,
          flatFeeAlreadyClaimed: plan.claim.flatFeeAlreadyClaimed,
        };
      } catch (e) {
        findings = [
          {
            code: "claim_error",
            severity: "E",
            message: (e as { data?: { message?: string } }).data?.message ?? String(e),
          },
        ];
      }
    }
    const snapshot = r.status === "draft" ? null : await snapshotOf(ctx, r);
    return {
      reminder: reminderView(r, invoice),
      detail: r.reminder,
      texts: { subject: r.subject ?? "", headText: r.headText ?? "", footText: r.footText ?? "" },
      isConsumer: contact?.isConsumer ?? snapshot?.buyer.isConsumer ?? false,
      invoice: invoice
        ? {
            id: invoice._id,
            number: invoice.number ?? "",
            documentDate: invoice.documentDate ?? null,
            dueDate: invoice.dueDate ?? null,
            openAmountCents: invoice.openAmountCents ?? 0,
            payableCents: invoice.totals.payableCents,
            zugang: invoice.zugang ?? null,
            sentOn: invoice.sentOn ?? null,
          }
        : null,
      case: c
        ? {
            status: c.status,
            currentLevel: c.currentLevel,
            flatFeeCharged: c.flatFeeCharged,
            defaultStartDate: c.defaultStartDate ?? null,
            defaultRoute: c.defaultRoute ?? null,
          }
        : null,
      findings,
      computed,
      snapshot,
      artifacts: artifacts.map((a) => ({
        _id: a._id,
        kind: a.kind,
        variant: a.variant ?? "original",
        name: a.name,
        sha256: a.sha256,
        bytes: a.bytes,
        createdAt: a.createdAt,
      })),
      sendLog: log.map((x) => ({
        _id: x._id,
        kind: x.kind,
        sentOn: x.sentOn,
        channel: x.channel,
        note: x.note ?? null,
        retractsId: x.retractsId ?? null,
        at: x.at,
        actor: x.actor,
      })),
      effectiveMarkId: effectiveMark(sendLogRows(log))?.id ?? null,
      defaultMarkSelection:
        r.status === "draft"
          ? []
          : defaultMarkSelection("none", archivedArtifacts(artifacts), await lastExportArtifactIds(ctx, id)),
      today,
    };
  },
});

/** REST `GET /reminders` (05 §4.4): newest first, filtered by status, invoice or contact. */
export const list = query({
  permission: "documents.read",
  args: {
    status: v.optional(v.union(v.literal("draft"), v.literal("finalized"), v.literal("sent"), v.literal("cancelled"))),
    invoiceId: v.optional(v.id("salesDocuments")),
    contactId: v.optional(v.id("contacts")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const rows = a.invoiceId
      ? await remindersOf(ctx, a.invoiceId)
      : await ctx.db
          .query("salesDocuments")
          .withIndex("by_type_status_date", (q) =>
            a.status ? q.eq("type", "reminder").eq("status", a.status) : q.eq("type", "reminder"),
          )
          .collect();
    const filtered = rows
      .filter((r) => r.type === "reminder" && (!a.status || r.status === a.status))
      .filter((r) => !a.contactId || r.contactId === a.contactId)
      .sort((x, y) => y._creationTime - x._creationTime)
      .slice(0, Math.max(1, Math.min(a.limit ?? 100, 500)));
    const invoices = new Map<string, SalesDoc | null>();
    const out = [];
    for (const r of filtered) {
      const invId = r.reminder?.invoiceId;
      if (invId && !invoices.has(invId)) invoices.set(invId, await ctx.db.get(invId));
      out.push(reminderView(r, invId ? (invoices.get(invId) ?? null) : null));
    }
    return out;
  },
});

/** DUN-010 invoice tab „Mahnungen“: case, reminders, default start, limitation and the next planned action. */
export const forInvoice = query({
  permission: "payments.read",
  args: { invoiceId: v.id("salesDocuments") },
  handler: async (ctx, { invoiceId }) => {
    const inv = await ctx.db.get(invoiceId);
    if (!inv) return null;
    const today = berlinCalendarDate(ctx.now());
    const c = await caseOf(ctx, invoiceId);
    const reminders = await remindersOf(ctx, invoiceId);
    const dunnable = (inv.status === "finalized" || inv.status === "sent") && (inv.openAmountCents ?? 0) > 0;
    let next = null;
    if (dunnable && ["invoice", "advance_invoice", "partial_invoice", "final_invoice"].includes(inv.type)) {
      const plan = await planRun(ctx, today, [invoiceId]);
      const a = plan.actions[0];
      if (a) next = actionView(a);
    }
    const l = await loadInvoiceState(ctx, inv, today);
    const s = await evaluationContext(ctx, today);
    const start = defaultStartOf({
      dueDate: l.state.dueDate,
      invoiceZugang: l.state.zugang,
      isConsumer: l.state.contact.isConsumer,
      hasB2c286Note: l.state.hasB2c286Note,
      calendarDueDateAgreed: l.state.contact.calendarDueDateAgreed,
      reminders: l.state.reminders,
      route: s.ctx.defaultStartViaReminder,
    });
    const lim = inv.dueDate ? limitationStatus(inv.dueDate as CalendarDate, today) : null;
    return {
      dunnable,
      zugang: inv.zugang ?? null,
      sentOn: inv.sentOn ?? null,
      disputed: inv.disputed ? { reason: inv.disputed.reason, at: inv.disputed.at } : null,
      blocked: inv.dunningBlocked ? { reason: inv.dunningBlocked.reason } : null,
      contactBlocked: l.state.contact.blocked,
      isConsumer: l.state.contact.isConsumer,
      case: c
        ? {
            status: c.status,
            currentLevel: c.currentLevel,
            pausedUntil: c.pausedUntil ?? null,
            pausedReason: c.pausedReason ?? null,
            flatFeeCharged: c.flatFeeCharged,
            handedOver: c.handedOver ?? null,
            graceUntil: c.graceUntil ?? null,
          }
        : null,
      defaultStart: start ? { date: start.date, route: start.route, label: start.label } : null,
      limitation: lim ? { date: lim.date, state: lim.state, message: lim.message ?? null } : null,
      reminders: reminders.map((r) => reminderView(r, inv)),
      next,
    };
  },
});

/** Einstellungen › Mahnwesen: policies, global switches and their warnings (§6.6). */
export const settings = query({
  permission: "payments.read",
  args: {},
  handler: async (ctx) => {
    const profile = await getCompanyProfile(ctx);
    const policies = await listPolicies(ctx);
    return {
      policies: policies.map((p) => ({
        ...p,
        warnings: validatePolicy(p).map((f) => ({
          code: f.code,
          severity: f.severity,
          message: f.message,
          field: f.field ?? null,
        })),
      })),
      receivables: profile?.receivables ?? null,
      textTemplates: (await ctx.db.query("textTemplates").collect())
        .filter((t) => t.docTypes.includes("reminder"))
        .map((t) => ({ id: t._id, name: t.name, kind: t.kind, level: t.level ?? null, language: t.language })),
    };
  },
});

/** DUN-022 Verzugszinsrechner (also REST `GET /dunning/interest`). */
export const interest = query({
  permission: "payments.read",
  args: { values: v.any() },
  handler: async (_ctx, { values }) => {
    const q = parse(interestQuerySchema, values);
    if (q.to < q.from) throw appError("invalid_input", "Das Enddatum liegt vor dem Beginn.", { field: "to" });
    const r = computeInterest({
      principalCents: q.amountCents,
      changes: (q.payments ?? []).map((p) => ({ date: p.date as CalendarDate, deltaCents: -p.amountCents })),
      from: q.from as CalendarDate,
      to: q.to as CalendarDate,
      margin: typeof q.margin === "number" ? { customBp: q.margin } : q.margin,
    });
    if (!r.ok) throw appError("invalid_input", r.error.message, { reason: r.error.code });
    return r.value;
  },
});

/** PAY-054 / EC-DUE-05 on a contact's payment terms (warning only). */
export const termsWarning = query({
  permission: "contacts.read",
  args: { dueDays: v.number(), isConsumer: v.boolean(), isPublicAuthority: v.boolean() },
  handler: async (_ctx, a) => paymentTermsWarning(a.dueDays, a)?.message ?? null,
});

// ── reminder writes ─────────────────────────────────────────────────────────────────────────────────────────────

/** DUN-008 „Mahnung erstellen“ (draft). */
export const createReminder = mutation({
  permission: "dunning.write",
  args: { invoiceId: v.id("salesDocuments"), values: v.any() },
  handler: async (ctx, { invoiceId, values }) => ({
    id: await createReminderDraft(ctx, invoiceId, parse(reminderCreateSchema, values ?? {})),
  }),
});

export const updateReminder = mutation({
  permission: "dunning.write",
  args: { id: v.id("salesDocuments"), version: v.number(), values: v.any() },
  handler: async (ctx, { id, version, values }) =>
    updateReminderDraft(ctx, id, version, parse(reminderCreateSchema, values)),
});

export const deleteReminder = mutation({
  permission: "dunning.write",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => deleteReminderDraft(ctx, id),
});

/** DUN-004 „Fertigstellen“ (number, PDF/A, hash; never sent). */
export const finalize = mutation({
  permission: "invoices.finalize",
  args: {
    id: v.id("salesDocuments"),
    version: v.optional(v.number()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    const r = await finalizeReminder(ctx, a.id, {
      ...(a.version !== undefined ? { version: a.version } : {}),
      ...(a.acknowledgeWarnings ? { acknowledgeWarnings: a.acknowledgeWarnings } : {}),
    });
    await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id: a.id });
    return r;
  },
});

/** DUN-009 „Mahnung gegenstandslos“. */
export const withdraw = mutation({
  permission: "dunning.write",
  args: { id: v.id("salesDocuments"), values: v.any() },
  handler: async (ctx, { id, values }) => {
    const w = parse(reminderWithdrawSchema, values);
    await withdrawReminderModel(ctx, id, w.reason);
  },
});

// ── run (DUN-030/031/036) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * „Ausgewählte jetzt ausführen“ / bulk „Mahnen“ / REST `POST /dunning/run` / MCP `dunning_run` (⚠). `expectedDigest`
 * is the preview's digest: the act fails with `preview_outdated` if the evaluation changed since (DUN-031).
 */
export const run = mutation({
  permission: "dunning.run",
  args: {
    mode: v.union(v.literal("drafts"), v.literal("finalize")),
    invoiceIds: v.optional(v.array(v.id("salesDocuments"))),
    expectedDigest: v.optional(v.string()),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, a) => {
    if (a.mode === "finalize") {
      // 05 §4.4: `mode: "finalize"` additionally needs invoices:finalize (keys) / the finalising role (members).
      const scopes = ctx.actorContext.scopes;
      if (scopes && !canKeyDo(scopes, "invoices.finalize")) {
        throw appError("forbidden_scope", undefined, { permission: "invoices.finalize" });
      }
      if (ctx.role && !canDo(ctx.role, "invoices.finalize")) throw appError("forbidden_role");
    }
    const r = await runDunning(ctx, {
      mode: "manual",
      allowFinalize: a.mode === "finalize",
      ...(a.invoiceIds ? { invoiceIds: a.invoiceIds } : {}),
      ...(a.expectedDigest ? { expectedDigest: a.expectedDigest } : {}),
    });
    for (const id of r.finalized) await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id });
    return r;
  },
});

/** `dunning.run` — daily 07:00 Europe/Berlin (02 §7); idempotent per day (one automatic run). */
export const runCron = systemMutation({
  job: "cron.dunning.run",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null;
    const today = berlinCalendarDate(ctx.now());
    const hour = Number(
      new Intl.DateTimeFormat("de-DE", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }).format(
        new Date(ctx.now()),
      ),
    );
    if (!force && hour !== 7) return null;
    const done = await ctx.db
      .query("dunningRuns")
      .withIndex("by_date", (q) => q.eq("date", today))
      .collect();
    if (!force && done.some((r) => r.mode === "auto")) return null;
    const r = await runDunning(ctx, { mode: "auto", allowFinalize: true });
    for (const id of r.finalized) await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id });
    return r;
  },
});

/** `receivables.refreshOverdue` — daily 00:15 Europe/Berlin (PAY-044, DUN-053). */
export const refreshOverdueCron = systemMutation({
  job: "cron.receivables.refreshOverdue",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null;
    return refreshOverdue(ctx);
  },
});

// ── case, Zugang, contact ───────────────────────────────────────────────────────────────────────────────────────

/** „Pausieren“, „Fortsetzen“, „Bestritten“, „Nicht mahnen“, „An Inkasso übergeben“ (DUN-002/034/042/043). */
export const caseAction = mutation({
  permission: "dunning.write",
  args: { invoiceId: v.id("salesDocuments"), values: v.any() },
  handler: async (ctx, { invoiceId, values }) => {
    const a = parse(caseActionSchema, values);
    await caseActionModel(ctx, invoiceId, {
      action: a.action,
      ...(a.reason ? { reason: a.reason } : {}),
      ...(a.until ? { until: a.until } : {}),
      ...(a.partner ? { partner: a.partner } : {}),
      ...(a.acknowledgeWarnings ? { acknowledgeWarnings: a.acknowledgeWarnings } : {}),
    });
  },
});

/** PAY-052 manual Zugang override (invoice or reminder). */
export const overrideZugang = mutation({
  permission: "dunning.write",
  args: { id: v.id("salesDocuments"), values: v.any() },
  handler: async (ctx, { id, values }) => overrideZugangModel(ctx, id, parse(zugangOverrideSchema, values)),
});

export const contactDunning = query({
  permission: "contacts.read",
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const c = await ctx.db.get(contactId);
    return {
      dunning: c?.dunning ?? null,
      policies: (await listPolicies(ctx)).map((p) => ({ id: p.id, name: p.name, seeded: p.seeded })),
    };
  },
});

export const saveContact = mutation({
  permission: "contacts.write",
  args: {
    contactId: v.id("contacts"),
    policyId: v.optional(v.string()),
    blocked: v.optional(v.boolean()),
    blockedReason: v.optional(v.string()),
    calendarDueDateAgreed: v.optional(v.boolean()),
  },
  handler: async (ctx, { contactId, ...rest }) => saveContactDunning(ctx, contactId, rest),
});

// ── policies and settings (DUN-001, §6.6) ───────────────────────────────────────────────────────────────────────

export const createPolicy = mutation({
  permission: "dunning.manage",
  args: { values: v.any() },
  handler: async (ctx, { values }) => createPolicyModel(ctx, parse(policySchema, values)),
});

export const updatePolicy = mutation({
  permission: "dunning.manage",
  args: { id: v.id("dunningPolicies"), version: v.number(), values: v.any() },
  handler: async (ctx, { id, version, values }) => updatePolicyModel(ctx, id, version, parse(policySchema, values)),
});

export const archive = mutation({
  permission: "dunning.manage",
  args: { id: v.id("dunningPolicies") },
  handler: async (ctx, { id }) => archivePolicy(ctx, id),
});

export const saveSettings = mutation({
  permission: "dunning.manage",
  args: { values: v.any() },
  handler: async (ctx, { values }) => saveSettingsModel(ctx, parse(dunningSettingsSchema, values)),
});
