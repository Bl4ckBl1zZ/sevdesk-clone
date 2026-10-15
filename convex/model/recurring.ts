import { canDo, canKeyDo } from "../../src/domain/access/permissions";
import type { DraftDocument } from "../../src/domain/documents/draft";
import { blocking, validateDocument } from "../../src/domain/documents/validate";
import { occurrenceDraft, rateHints, type TemplateDraft } from "../../src/domain/recurring/generate";
import {
  isEnded,
  type Occurrence,
  planRun,
  planRunNow,
  previewOccurrences,
  type ScheduleState,
  skipPast,
} from "../../src/domain/recurring/schedule";
import type { DraftValues } from "../../src/domain/schemas/documents";
import type { RecurringTemplateValues } from "../../src/domain/schemas/recurring";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit, auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import {
  createDraft,
  loadDocumentContext,
  type SalesDocumentDoc,
  upsertNotification,
  withPaymentDefaults,
} from "./salesDocuments";
import type { ActorContext, ModelCtx, ReadCtx } from "./types";

/**
 * Recurring invoices (F04 §3.4 REC-01…16, §4.11) — the only writer of `recurringTemplates`. Generated invoices are
 * created through `createDraft` (salesDocuments.ts) with the occurrence key; finalisation runs the normal pipeline
 * (convex/lib/finalizePipeline.ts) in the calling action. Idempotency (REC-05, EC-DOC-93): one transaction plans the
 * due occurrences, checks the `by_recurringOccurrence` key, creates the drafts with their review to-dos and advances
 * the schedule — a doubled or retried run finds `nextDate` advanced and the keys taken.
 *
 * Owner decision B2: the app never exports or sends a generated invoice. Automation may only finalise (REC-16); every
 * finalised invoice gets the to-do „Exportieren und versenden“ (salesDocuments.ts `afterRecurringFinalize`).
 */

export type TemplateDoc = Doc<"recurringTemplates">;

const AUDIT_TABLE_LABEL = (t: Pick<TemplateDoc, "name">) => `Vorlage ${t.name}`;

export const scheduleOf = (t: Pick<TemplateDoc, "schedule">): ScheduleState => ({
  interval: t.schedule.interval,
  firstDate: t.schedule.firstDate as CalendarDate,
  nextDate: t.schedule.nextDate as CalendarDate,
  ...(t.schedule.endDate ? { endDate: t.schedule.endDate as CalendarDate } : {}),
  ...(t.schedule.maxCount !== undefined ? { maxCount: t.schedule.maxCount } : {}),
  billing: t.schedule.billing,
});

/** REC-14: automation is effective only when switched on and confirmed once in the UI. */
export const automationEffective = (t: Pick<TemplateDoc, "automation" | "automationConfirmedAt">): boolean =>
  t.automation.finalize && t.automationConfirmedAt !== undefined;

export type TemplateState = "active" | "paused" | "ended" | "archived";

/** List tabs Aktiv · Pausiert · Beendet (§6.1, §4.2.10: „Beendet“ is derived). */
export function templateState(t: TemplateDoc): TemplateState {
  if (t.archivedAt !== undefined) return "archived";
  if (isEnded(scheduleOf(t), t.generatedCount)) return "ended";
  return t.status === "active" ? "active" : "paused";
}

export async function getTemplate(ctx: ReadCtx, id: Id<"recurringTemplates">): Promise<TemplateDoc> {
  const t = await ctx.db.get(id);
  if (!t) throw appError("not_found", "Vorlage nicht gefunden.");
  return t;
}

export async function listTemplates(ctx: ReadCtx): Promise<TemplateDoc[]> {
  return (await ctx.db.query("recurringTemplates").collect()).filter((t) => t.archivedAt === undefined);
}

/** Documents generated from a template, newest occurrence first. */
export async function generatedDocuments(ctx: ReadCtx, id: Id<"recurringTemplates">): Promise<SalesDocumentDoc[]> {
  const docs = await ctx.db
    .query("salesDocuments")
    .withIndex("by_recurringOccurrence", (q) => q.eq("recurringOccurrence.templateId", id))
    .collect();
  return docs.sort((a, b) => (b.recurringOccurrence?.date ?? "").localeCompare(a.recurringOccurrence?.date ?? ""));
}

/** Active templates with an occurrence due on `today` (the daily job's work list). */
export async function dueTemplateIds(ctx: ReadCtx, today: CalendarDate): Promise<Id<"recurringTemplates">[]> {
  return (
    await ctx.db
      .query("recurringTemplates")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect()
  )
    .filter((t) => t.archivedAt === undefined && t.schedule.nextDate <= today && templateState(t) === "active")
    .map((t) => t._id);
}

// ── template writes (REC-01, REC-11, REC-14) ──────────────────────────────────────────────────────────────

/**
 * REC-14: switching finalise automation on via REST/MCP needs `invoices:finalize` on the calling key; it stays
 * inactive until confirmed in the UI. In the UI the first activation is confirmed by the dialog (`confirm`).
 */
function automationPatch(
  ctx: ModelCtx,
  values: RecurringTemplateValues,
  current: Pick<TemplateDoc, "automationConfirmedAt" | "automationConfirmedBy"> | null,
  confirm: boolean,
) {
  const a = ctx.actorContext;
  if (values.automation.finalize && (a.channel === "api" || a.channel === "mcp")) {
    if (!canKeyDo(a.scopes ?? [], "invoices.finalize")) {
      throw appError(
        "forbidden_scope",
        "Automatisches Fertigstellen braucht die Berechtigung „invoices:finalize“ am API-Schlüssel.",
        { permission: "invoices.finalize" },
      );
    }
  }
  // REST/MCP: the automation is stored but stays inactive until confirmed in the UI (a confirm flag is ignored).
  if (values.automation.finalize && confirm && current?.automationConfirmedAt === undefined && a.channel === "ui") {
    if (!a.role || !canDo(a.role, "invoices.finalize")) throw appError("forbidden_role");
    return { automationConfirmedAt: ctx.now(), automationConfirmedBy: ctx.actor };
  }
  return {};
}

async function contactNameOf(ctx: ReadCtx, contactId: string | undefined): Promise<string | undefined> {
  if (!contactId) return undefined;
  const c = await ctx.db.get(contactId as Id<"contacts">);
  if (!c) throw appError("invalid_input", "Kontakt nicht gefunden.", { reason: "contact_missing" });
  return c.displayName;
}

function storedSchedule(values: RecurringTemplateValues, nextDate: string): TemplateDoc["schedule"] {
  const s = values.schedule;
  return {
    interval: s.interval,
    firstDate: s.firstDate,
    nextDate,
    ...(s.endDate ? { endDate: s.endDate } : {}),
    ...(s.maxCount !== undefined ? { maxCount: s.maxCount } : {}),
    billing: s.billing,
    periodTextEnabled: s.periodTextEnabled,
  };
}

export async function createTemplate(
  ctx: ModelCtx,
  values: RecurringTemplateValues,
  opts: { confirmAutomation?: boolean } = {},
): Promise<Id<"recurringTemplates">> {
  const contactName = await contactNameOf(ctx, values.draft.contactId);
  const draft = await withPaymentDefaults(ctx, values.draft as unknown as DraftValues);
  const base = {
    name: values.name.trim(),
    status: "active" as const,
    draft,
    ...(values.draft.contactId ? { contactId: values.draft.contactId as Id<"contacts"> } : {}),
    ...(contactName ? { contactName } : {}),
    ...(values.contractReference?.trim() ? { contractReference: values.contractReference.trim() } : {}),
    schedule: storedSchedule(values, values.schedule.firstDate),
    automation: { finalize: values.automation.finalize },
    ...automationPatch(ctx, values, null, opts.confirmAutomation === true),
    skippedOccurrences: [],
    generatedCount: 0,
    createdBy: ctx.actor,
    version: 1,
  };
  const id = await auditedInsert(ctx, "recurringTemplates", base, {
    action: "recurring.create",
    label: AUDIT_TABLE_LABEL(base),
  });
  await refreshAmount(ctx, id);
  return id;
}

/**
 * REC-11: editing affects only future generations (generated drafts/invoices are separate documents). Once an
 * invoice was generated or a period skipped, the anchor (first date, interval, billing) is fixed — changing it
 * would shift or overlap already billed periods; a new template is the way to change the rhythm.
 */
export async function updateTemplate(
  ctx: ModelCtx,
  id: Id<"recurringTemplates">,
  version: number,
  values: RecurringTemplateValues,
  opts: { confirmAutomation?: boolean } = {},
): Promise<{ version: number }> {
  const t = await getTemplate(ctx, id);
  if (t.archivedAt !== undefined) throw appError("conflict", "Die Vorlage ist archiviert.", { reason: "archived" });
  if (t.version !== version) {
    throw appError("version_conflict", "Die Vorlage wurde zwischenzeitlich geändert. Bitte neu laden.");
  }
  const started = t.generatedCount > 0 || t.skippedOccurrences.length > 0;
  const s = values.schedule;
  if (
    started &&
    (s.firstDate !== t.schedule.firstDate || s.interval !== t.schedule.interval || s.billing !== t.schedule.billing)
  ) {
    throw appError(
      "conflict",
      "Erste Rechnung, Intervall und Abrechnung sind nach der ersten erzeugten Rechnung fest – bitte eine neue Vorlage anlegen.",
      { reason: "schedule_locked" },
    );
  }
  const contactName = await contactNameOf(ctx, values.draft.contactId);
  const draft = await withPaymentDefaults(ctx, values.draft as unknown as DraftValues);
  await auditedPatch(
    ctx,
    "recurringTemplates",
    id,
    {
      name: values.name.trim(),
      draft,
      contactId: values.draft.contactId ? (values.draft.contactId as Id<"contacts">) : undefined,
      contactName,
      contractReference: values.contractReference?.trim() || undefined,
      schedule: storedSchedule(values, started ? t.schedule.nextDate : s.firstDate),
      automation: { finalize: values.automation.finalize },
      ...automationPatch(ctx, values, t, opts.confirmAutomation === true),
      version: t.version + 1,
    },
    { action: "recurring.update", label: AUDIT_TABLE_LABEL(t) },
  );
  await refreshAmount(ctx, id);
  return { version: t.version + 1 };
}

/** REC-14: the UI confirmation of the first activation of an automation stored via REST/MCP. */
export async function confirmAutomation(ctx: ModelCtx, id: Id<"recurringTemplates">): Promise<void> {
  const t = await getTemplate(ctx, id);
  if (!t.automation.finalize) {
    throw appError("conflict", "Für diese Vorlage ist kein automatisches Fertigstellen eingestellt.", {
      reason: "automation_off",
    });
  }
  if (t.automationConfirmedAt !== undefined) return;
  if (ctx.actorContext.channel !== "ui") {
    throw appError("invalid_input", "Die Automatik kann nur in der App bestätigt werden.", {
      reason: "automation_confirm_ui_only",
    });
  }
  await auditedPatch(
    ctx,
    "recurringTemplates",
    id,
    { automationConfirmedAt: ctx.now(), automationConfirmedBy: ctx.actor, version: t.version + 1 },
    { action: "recurring.automation_confirm", label: AUDIT_TABLE_LABEL(t) },
  );
}

export async function pauseTemplate(ctx: ModelCtx, id: Id<"recurringTemplates">): Promise<void> {
  const t = await getTemplate(ctx, id);
  if (t.status === "inactive") return;
  await auditedPatch(
    ctx,
    "recurringTemplates",
    id,
    { status: "inactive", version: t.version + 1 },
    { action: "recurring.pause", label: AUDIT_TABLE_LABEL(t) },
  );
}

/**
 * REC-10: resume. With past due occurrences the owner chooses „nachberechnen“ (`catchUp`: the schedule stays, the
 * next run generates them — REC-06 applies) or „überspringen“ (every occurrence before today is recorded in
 * `skippedOccurrences` and audited; `nextDate` moves to the first occurrence on or after today).
 */
export async function resumeTemplate(
  ctx: ModelCtx,
  id: Id<"recurringTemplates">,
  catchUp: boolean,
): Promise<{ due: number; skipped: string[] }> {
  const t = await getTemplate(ctx, id);
  if (t.archivedAt !== undefined) throw appError("conflict", "Die Vorlage ist archiviert.", { reason: "archived" });
  const today = berlinCalendarDate(ctx.now());
  const s = scheduleOf(t);
  const patch: Partial<TemplateDoc> = { status: "active", version: t.version + 1 };
  let skipped: string[] = [];
  if (!catchUp) {
    const r = skipPast(s, t.generatedCount, today);
    skipped = r.skipped.map((o) => o.date);
    if (skipped.length > 0) {
      patch.schedule = { ...t.schedule, nextDate: r.nextDate };
      patch.skippedOccurrences = [
        ...t.skippedOccurrences,
        ...skipped.map((date) => ({ date, at: ctx.now(), actor: ctx.actor })),
      ];
    }
  }
  await auditedPatch(ctx, "recurringTemplates", id, patch, {
    action: "recurring.resume",
    label: AUDIT_TABLE_LABEL(t),
  });
  if (skipped.length > 0) {
    await appendAudit(ctx, {
      action: "recurring.skip",
      entity: { table: "recurringTemplates", id, label: AUDIT_TABLE_LABEL(t) },
      reason: `Übersprungen: ${skipped.map((d) => formatGermanDate(d as CalendarDate)).join(", ")}`,
    });
  }
  const due = catchUp ? previewOccurrences(s, t.generatedCount, 10_000).filter((o) => o.date <= today).length : 0;
  return { due, skipped };
}

/** REC-01: delete only while nothing was generated; afterwards the template is archived (generated invoices link it). */
export async function removeTemplate(
  ctx: ModelCtx,
  id: Id<"recurringTemplates">,
): Promise<{ result: "deleted" | "archived" }> {
  const t = await getTemplate(ctx, id);
  if (t.generatedCount === 0 && (await generatedDocuments(ctx, id)).length === 0) {
    await auditedDelete(ctx, "recurringTemplates", id, { action: "recurring.delete", label: AUDIT_TABLE_LABEL(t) });
    return { result: "deleted" };
  }
  if (t.archivedAt === undefined) {
    await auditedPatch(
      ctx,
      "recurringTemplates",
      id,
      { archivedAt: ctx.now(), status: "inactive", version: t.version + 1 },
      { action: "recurring.archive", label: AUDIT_TABLE_LABEL(t) },
    );
  }
  return { result: "archived" };
}

// ── preview (REC-13) ──────────────────────────────────────────────────────────────────────────────────────

export interface PreviewRow {
  date: string;
  period: { from: string; to: string };
  netCents: number | null;
  grossCents: number | null;
  currency: string;
  rates: { category: string; rateBp: number }[];
  decision: string | null;
  hints: string[];
  blocking: string | null;
}

export interface PreviewSource {
  name: string;
  contractReference?: string | undefined;
  draft: TemplateDraft;
  schedule: ScheduleState & { periodTextEnabled: boolean };
  generatedCount: number;
}

/**
 * REC-13: the next `count` occurrences with period, expected totals and rates (resolved at each occurrence's supply
 * period, EC-040), the ER-03 decision at the occurrence date and the notices (rate change → split draft, KU change,
 * first blocking finding). Nothing is written.
 */
export async function previewTemplate(
  ctx: ReadCtx,
  src: PreviewSource,
  now: number,
  count = 12,
): Promise<PreviewRow[]> {
  const profile = await getCompanyProfile(ctx);
  const occurrences = previewOccurrences(src.schedule, src.generatedCount, count);
  if (occurrences.length === 0) return [];
  const draftValues = await withPaymentDefaults(ctx, src.draft as unknown as DraftValues);
  const probe = {
    _id: "new" as Id<"salesDocuments">,
    type: "invoice",
    status: "draft",
    ...(draftValues.contactId ? { contactId: draftValues.contactId as Id<"contacts"> } : {}),
    ...(draftValues.bankAccountId ? { bankAccountId: draftValues.bankAccountId as Id<"bankAccounts"> } : {}),
    ...(draftValues.paymentMethodId ? { paymentMethodId: draftValues.paymentMethodId as Id<"paymentMethods"> } : {}),
  } as SalesDocumentDoc;
  const loaded = await loadDocumentContext(ctx, probe, now);
  return occurrences.map((o) => {
    const od = occurrenceDraftFor(src, o, profile?.kleinunternehmer ?? []);
    const draft: DraftDocument = {
      ...(od.values as unknown as DraftDocument),
      documentDate: o.date,
      ...(loaded.contact?.context.buyer.address ? { billingAddress: loaded.contact.context.buyer.address } : {}),
    };
    const r = validateDocument(draft, { ...loaded.ctx, today: o.date });
    const t = r.resolved.totals;
    const errors = blocking(r.findings);
    return {
      date: o.date,
      period: o.period,
      netCents: t ? t.taxExclusiveCents : null,
      grossCents: t ? t.grossCents : null,
      currency: draftValues.currency,
      rates: t ? t.groups.map((g) => ({ category: g.vatCategory, rateBp: g.rateBp })) : [],
      decision: r.einvoice.er03.decision ?? null,
      hints: [
        ...rateHints(src.draft, o.period),
        ...(od.kuChange
          ? [`Wechsel der Kleinunternehmerregelung am ${formatGermanDate(od.kuChange)} – Entwurf zur Prüfung`]
          : []),
      ],
      // A split period is reviewed as a draft anyway; its per-line split is applied at generation.
      blocking: od.needsReview ? null : (errors[0]?.message ?? null),
    };
  });
}

const occurrenceDraftFor = (
  src: Pick<PreviewSource, "draft" | "name" | "contractReference" | "schedule">,
  o: Occurrence,
  kleinunternehmer: readonly { validFrom: string; isKU: boolean }[],
) =>
  occurrenceDraft({
    draft: src.draft,
    templateName: src.name,
    contractReference: src.contractReference,
    period: o.period,
    periodTextEnabled: src.schedule.periodTextEnabled,
    kleinunternehmer,
  });

export const previewSourceOf = (t: TemplateDoc): PreviewSource => ({
  name: t.name,
  ...(t.contractReference ? { contractReference: t.contractReference } : {}),
  draft: t.draft as TemplateDraft,
  schedule: { ...scheduleOf(t), periodTextEnabled: t.schedule.periodTextEnabled },
  generatedCount: t.generatedCount,
});

/** List column „Betrag“: the totals of the next occurrence at the last save/run (display cache). */
async function refreshAmount(ctx: ModelCtx, id: Id<"recurringTemplates">): Promise<void> {
  const t = await getTemplate(ctx, id);
  const [next] = await previewTemplate(ctx, previewSourceOf(t), ctx.now(), 1);
  if (!next || next.netCents === null || next.grossCents === null) return;
  const amount = { netCents: next.netCents, grossCents: next.grossCents, currency: next.currency };
  if (
    t.amount?.netCents === amount.netCents &&
    t.amount.grossCents === amount.grossCents &&
    t.amount.currency === amount.currency
  )
    return;
  await auditedPatch(
    ctx,
    "recurringTemplates",
    id,
    { amount },
    { action: "recurring.update", label: AUDIT_TABLE_LABEL(t) },
  );
}

// ── generation (REC-05…07, REC-12, REC-15, REC-16) ────────────────────────────────────────────────────────

export interface GeneratedDraft {
  id: Id<"salesDocuments">;
  version: number;
  date: string;
  /** Finalise now (automation effective, no catch-up overflow, no REC-15 split). */
  finalize: boolean;
}

const periodLabel = (p: { from: string; to: string }) =>
  `${formatGermanDate(p.from as CalendarDate)}–${formatGermanDate(p.to as CalendarDate)}`;

/**
 * One generation run for one template in a single transaction: `scheduled` = all occurrences due today (REC-05/06,
 * REC-10 „nachberechnen“), `now` = the next occurrence (REC-12). Returns the drafts to finalise.
 *
 * A template whose customer is archived or deleted generates nothing (the owner is notified; the schedule is not
 * advanced, so the periods are caught up — under REC-06 — once the customer is reactivated or the template edited).
 */
export async function generateOccurrences(
  ctx: ModelCtx,
  id: Id<"recurringTemplates">,
  mode: "scheduled" | "now",
): Promise<GeneratedDraft[]> {
  const t = await getTemplate(ctx, id);
  if (t.archivedAt !== undefined) {
    if (mode === "now") throw appError("conflict", "Die Vorlage ist archiviert.", { reason: "archived" });
    return [];
  }
  if (mode === "scheduled" && t.status !== "active") return [];
  const contact = t.contactId ? await ctx.db.get(t.contactId) : null;
  if (!contact || contact.status === "archived") {
    const reason = contact ? "Der Kunde ist archiviert." : "Die Vorlage hat keinen (gültigen) Kunden.";
    if (mode === "now") throw appError("conflict", reason, { reason: "contact_unusable" });
    await upsertNotification(ctx, {
      kind: "recurring_blocked",
      severity: "warning",
      title: `Wiederkehrende Rechnung „${t.name}“ nicht erzeugt: ${reason}`,
      body: "Bitte den Kunden reaktivieren oder die Vorlage bearbeiten bzw. pausieren. Verpasste Termine werden danach nachberechnet.",
      link: `/rechnungen/wiederkehrend/${id}`,
      entity: { table: "recurringTemplates", id },
      dedupeKey: `recurring_blocked:${id}`,
    });
    return [];
  }
  await resolveTemplateNotification(ctx, id, "recurring_blocked");
  const profile = await getCompanyProfile(ctx);
  const today = berlinCalendarDate(ctx.now());
  const effective = automationEffective(t);
  const plan =
    mode === "now"
      ? planRunNow({ schedule: scheduleOf(t), generatedCount: t.generatedCount, finalize: effective })
      : planRun({
          schedule: scheduleOf(t),
          generatedCount: t.generatedCount,
          today,
          catchUpAutoMax: profile?.defaults.catchUpAutoMax ?? 3,
          finalize: effective,
        });
  if (plan.occurrences.length === 0) {
    if (mode === "now") throw appError("conflict", "Die Vorlage ist beendet.", { reason: "template_ended" });
    return [];
  }
  const src = previewSourceOf(t);
  const out: GeneratedDraft[] = [];
  let lastId: Id<"salesDocuments"> | undefined;
  for (const o of plan.occurrences) {
    const taken = await ctx.db
      .query("salesDocuments")
      .withIndex("by_recurringOccurrence", (q) =>
        q.eq("recurringOccurrence.templateId", id).eq("recurringOccurrence.date", o.date),
      )
      .first();
    if (taken) continue; // REC-05: one document per (template, occurrence) — never a second one
    const od = occurrenceDraftFor(src, o, profile?.kleinunternehmer ?? []);
    const docId = await createDraft(
      ctx,
      od.values,
      { recurringOccurrence: { templateId: id, date: o.date } },
      { reason: `Erzeugt aus Vorlage „${t.name}“ (Zeitraum ${periodLabel(o.period)})` },
    );
    lastId = docId;
    await upsertNotification(ctx, {
      kind: "review_recurring_draft",
      severity: "info",
      title: `Entwurf prüfen und fertigstellen: ${t.name} (${periodLabel(o.period)})`,
      link: `/rechnungen/${docId}`,
      entity: { table: "salesDocuments", id: docId },
      dedupeKey: `review_recurring_draft:${docId}`,
    });
    if (od.needsReview) {
      const what = od.kuChange
        ? `Der Zeitraum überschreitet den Wechsel der Kleinunternehmerregelung am ${formatGermanDate(od.kuChange)} – bitte die Rechnung aufteilen.`
        : `Der Zeitraum überschreitet eine Steuersatzänderung (${od.rateBoundaries.map((d) => formatGermanDate(d)).join(", ")}); die Positionen wurden anteilig nach Tagen aufgeteilt.`;
      await upsertNotification(ctx, {
        kind: "recurring_review_split",
        severity: "warning",
        title: `Wiederkehrende Rechnung „${t.name}“ (${periodLabel(o.period)}) bitte prüfen`,
        body: `${what} Die Rechnung wurde nicht automatisch fertiggestellt.`,
        link: `/rechnungen/${docId}`,
        entity: { table: "salesDocuments", id: docId },
        dedupeKey: `recurring_review_split:${docId}`,
      });
    }
    out.push({ id: docId, version: 1, date: o.date, finalize: plan.automated && !od.needsReview });
  }
  if (plan.catchUpOverflow) {
    await upsertNotification(ctx, {
      kind: "recurring_catch_up",
      severity: "warning",
      title: `${plan.occurrences.length} verpasste Termine der Vorlage „${t.name}“ als Entwürfe erzeugt`,
      body: `Mehr als ${profile?.defaults.catchUpAutoMax ?? 3} Termine waren offen (z. B. nach einem Ausfall). Die Entwürfe wurden ohne Automatik erzeugt; das Rechnungsdatum ist der Tag der Fertigstellung.`,
      link: `/rechnungen/wiederkehrend/${id}`,
      entity: { table: "recurringTemplates", id },
      dedupeKey: `recurring_catch_up:${id}:${today}`,
    });
  }
  await auditedPatch(
    ctx,
    "recurringTemplates",
    id,
    {
      schedule: { ...t.schedule, nextDate: plan.nextDate },
      generatedCount: t.generatedCount + out.length,
      ...(lastId ? { lastGeneratedId: lastId } : {}),
    },
    {
      action: "recurring.generate",
      label: AUDIT_TABLE_LABEL(t),
      reason: plan.occurrences.map((o) => periodLabel(o.period)).join(", "),
    },
  );
  await refreshAmount(ctx, id);
  return out;
}

/** REC-07: a failed automatic finalisation keeps the draft (with its review to-do) and notifies the owner. */
export async function recordFinalizeFailure(
  ctx: ModelCtx,
  docId: Id<"salesDocuments">,
  error: { code: string; message: string; findings: string[] },
): Promise<void> {
  const doc = await ctx.db.get(docId);
  const t = doc?.recurringOccurrence ? await ctx.db.get(doc.recurringOccurrence.templateId) : null;
  const list = error.findings.length ? error.findings : [error.message];
  await upsertNotification(ctx, {
    kind: "recurring_finalize_failed",
    severity: "warning",
    title: `Wiederkehrende Rechnung „${t?.name ?? "?"}“ nicht automatisch fertiggestellt`,
    body: `Der Entwurf bleibt zur Prüfung (${error.code}): ${list.join(" · ")}`,
    link: `/rechnungen/${docId}`,
    entity: { table: "salesDocuments", id: docId },
    dedupeKey: `recurring_finalize_failed:${docId}`,
  });
}

/** A run of one template failed before any draft was written (e.g. an unexpected error): notify, keep going. */
export async function recordRunFailure(ctx: ModelCtx, id: Id<"recurringTemplates">, message: string): Promise<void> {
  const t = await ctx.db.get(id);
  await upsertNotification(ctx, {
    kind: "recurring_run_failed",
    severity: "error",
    title: `Wiederkehrende Rechnung „${t?.name ?? "?"}“: Erzeugung fehlgeschlagen`,
    body: message,
    link: `/rechnungen/wiederkehrend/${id}`,
    entity: { table: "recurringTemplates", id },
    dedupeKey: `recurring_run_failed:${id}`,
  });
}

async function resolveTemplateNotification(ctx: ModelCtx, id: Id<"recurringTemplates">, kind: string) {
  for (const n of await ctx.db
    .query("notifications")
    .withIndex("by_entity", (q) => q.eq("entity.table", "recurringTemplates").eq("entity.id", id))
    .collect()) {
    if (n.kind === kind && n.resolvedAt === undefined) {
      await auditedPatch(ctx, "notifications", n._id, { resolvedAt: ctx.now() }, { action: "notification.resolve" });
    }
  }
}

/** REC-12: may the caller of „Jetzt erzeugen“ finalise (role or key scope `invoices:finalize`)? */
export function callerMayFinalize(a: ActorContext): boolean {
  if (a.actor.startsWith("system:")) return true;
  if (a.channel === "api" || a.channel === "mcp") return canKeyDo(a.scopes ?? [], "invoices.finalize");
  return a.role !== undefined && canDo(a.role, "invoices.finalize");
}
