import type { DeadlineCustomer } from "../../src/domain/documents/uninvoiced-supplies";
import { applicableCustomerPrice, basePriceOn, convertPriceMode, resolveRate } from "../../src/domain/products/pricing";
import { checkSupplyCoversEntries, exactTimeNetCents } from "../../src/domain/projects/invoicing";
import { OFFLINE_CONFLICT_MESSAGE } from "../../src/domain/projects/offline";
import { hourlyFromUnitPrice, resolveHourlyRate } from "../../src/domain/projects/rates";
import {
  checkDurationRange,
  entryLock,
  isGenericDescription,
  isIncomplete,
  overlapCount,
  overlapWarning,
  spansFromInstants,
  TIME_MESSAGES,
  TIMER_AUTO_STOP_MS,
  type TimeEntrySource,
  timerAlert,
  timerRunningConfirm,
} from "../../src/domain/projects/time-entries";
import {
  type UnbilledLevel,
  unbilledEntryLevel,
  unbilledEscalationText,
  unbilledWarningText,
} from "../../src/domain/projects/unbilled";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { notify, notifyKind } from "./notifications";
import { checkBudget, getProject, PROJECT_MESSAGES } from "./projects";
import { recordArtifacts } from "./salesDocuments";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Time entries and the timer (F11 PRJ-005…009, PRJ-012, PRJ-015, PRJ-019; 03 §9). The only writer of `timeEntries`
 * and `runningTimer`. Open entries are freely editable (audited); entries in an invoice draft are locked until the
 * line is removed or the draft deleted (PRJ-012); invoiced entries are frozen (immutability matrix) and get the
 * invoice's retention (PRJ-019). Open entries have no statutory retention and may be deleted (audited with content).
 */

export type TimeEntryDoc = Doc<"timeEntries">;

export interface EntryInput {
  date: string;
  durationMinutes: number;
  startedAt?: number;
  endedAt?: number;
  description: string;
  projectId?: string;
  contactId?: string;
  productId?: string;
  billable?: boolean;
  rateOverrideMicros?: number;
  source: TimeEntrySource;
  flaggedForReview?: boolean;
  /** The duration comes from instants (timer, offline timer run): the manual-entry checks do not apply. */
  fromInstants?: boolean;
  /** E-PRJ-29: the earlier of two timers started on two devices. */
  conflict?: boolean;
  /** PRJ-018: queued offline operations that produced the entry. */
  offlineOpIds?: string[];
}

export async function getEntry(ctx: ReadCtx, id: Id<"timeEntries">): Promise<TimeEntryDoc> {
  const e = await ctx.db.get(id);
  if (!e) throw appError("not_found", "Zeiteintrag nicht gefunden.");
  return e;
}

/** Label of the document that locks an entry (E-PRJ-10/11). */
async function lockLabel(ctx: ReadCtx, e: TimeEntryDoc): Promise<string | undefined> {
  const docId = e.status === "in_draft" ? e.draftDocumentId : e.invoicedDocumentId;
  const d = docId ? await ctx.db.get(docId) : null;
  return d ? (d.number ?? "Entwurf") : undefined;
}

export async function assertEditable(ctx: ReadCtx, e: TimeEntryDoc): Promise<void> {
  const lock = entryLock({ status: e.status, documentLabel: await lockLabel(ctx, e) });
  if (lock) throw appError("conflict", lock.message, { reason: lock.code });
}

// ── references and rate resolution (PRJ-008) ────────────────────────────────────────────────────────────────

interface Refs {
  project: Doc<"projects"> | null;
  contactId?: Id<"contacts">;
  productId?: Id<"products">;
  currency: string;
}

async function resolveRefs(
  ctx: ReadCtx,
  input: { projectId?: string; contactId?: string; productId?: string },
  opts: { allowArchived?: boolean } = {},
): Promise<Refs> {
  const projectId = input.projectId ? ctx.db.normalizeId("projects", input.projectId) : null;
  const project = projectId ? await ctx.db.get(projectId) : null;
  if (input.projectId && !project) throw appError("invalid_input", PROJECT_MESSAGES.notFound, { field: "projectId" });
  if (project?.status === "archived" && !opts.allowArchived) {
    throw appError("conflict", PROJECT_MESSAGES.archived(project.name), { reason: "PROJECT_ARCHIVED" });
  }
  const contactId = input.contactId ? ctx.db.normalizeId("contacts", input.contactId) : (project?.contactId ?? null);
  const contact = contactId ? await ctx.db.get(contactId) : null;
  if (input.contactId && !contact) throw appError("invalid_input", "Unbekannter Kontakt.", { field: "contactId" });
  const productId = input.productId
    ? ctx.db.normalizeId("products", input.productId)
    : (project?.defaultProductId ?? null);
  if (input.productId && !(productId && (await ctx.db.get(productId)))) {
    throw appError("invalid_input", "Unbekanntes Produkt.", { field: "productId" });
  }
  return {
    project,
    ...(contact ? { contactId: contact._id } : {}),
    ...(productId ? { productId } : {}),
    currency: project?.currency ?? contact?.currency ?? "EUR",
  };
}

/** PRJ-008: override → project → customer price of the product → product price → default hourly rate (settings). */
export async function resolveEntryRate(
  ctx: ReadCtx,
  refs: Refs,
  date: string,
  overrideMicros?: number,
): Promise<{ hourlyRateMicros: number; source: string | null }> {
  let customerPriceMicros: number | undefined;
  let productMicros: number | undefined;
  if (refs.productId) {
    const p = await ctx.db.get(refs.productId);
    if (p) {
      const rate = resolveRate(p.vatRateKey, date as CalendarDate);
      const rateBp = rate.ok ? rate.value.value.rateBp : 0;
      const toNet = (mode: "net" | "gross", micros: number) => convertPriceMode(micros, mode, "net", rateBp);
      const prices = await ctx.db
        .query("customerPrices")
        .withIndex("by_product_contact_validFrom", (q) => q.eq("productId", p._id))
        .collect();
      const cp = applicableCustomerPrice(prices, refs.contactId, date);
      if (cp) customerPriceMicros = hourlyFromUnitPrice(p.unitCode, toNet(cp.priceMode, cp.unitPriceMicros));
      const base = basePriceOn({ ...p, id: p._id }, date);
      productMicros = hourlyFromUnitPrice(p.unitCode, toNet(base.priceMode, base.unitPriceMicros));
    }
  }
  const profile = await getCompanyProfile(ctx);
  const r = resolveHourlyRate({
    overrideMicros,
    projectMicros: refs.project?.hourlyRateMicros,
    customerPriceMicros,
    productMicros,
    defaultMicros: profile?.defaults.time?.hourlyRateMicros,
  });
  return { hourlyRateMicros: r?.hourlyRateMicros ?? 0, source: r?.source ?? null };
}

function checkEntryValues(input: EntryInput, today: CalendarDate) {
  if (!isCalendarDate(input.date)) throw appError("invalid_input", "Ungültiges Datum.", { field: "date" });
  if (input.date > today)
    throw appError("invalid_input", TIME_MESSAGES.future, { reason: "date_future", field: "date" });
  const range = checkDurationRange(input.durationMinutes);
  if (range) throw appError("invalid_input", range.message, { reason: range.code, field: "duration" });
  if (input.endedAt !== undefined && input.startedAt !== undefined && input.endedAt < input.startedAt) {
    throw appError("invalid_input", TIME_MESSAGES.endBeforeStart, { reason: "end_before_start", field: "endTime" });
  }
}

async function warningsFor(ctx: ReadCtx, input: EntryInput, self?: Id<"timeEntries">): Promise<string[]> {
  const out: string[] = [];
  if (isGenericDescription(input.description)) out.push(TIME_MESSAGES.generic);
  if (input.startedAt !== undefined && input.endedAt !== undefined) {
    const sameDay = (
      await ctx.db
        .query("timeEntries")
        .withIndex("by_date", (q) => q.eq("date", input.date))
        .collect()
    ).filter((e) => e._id !== self);
    const n = overlapCount(input, sameDay);
    if (n > 0) out.push(overlapWarning(n));
  }
  return out;
}

async function afterChange(ctx: ModelCtx, projectIds: (Id<"projects"> | undefined)[]) {
  for (const id of new Set(projectIds.filter((x): x is Id<"projects"> => x !== undefined))) {
    await checkBudget(ctx, id);
  }
}

/** PRJ-007 manual entry (and MCP/API/timer entries): validates, resolves the rate, flags incomplete entries. */
export async function createEntry(
  ctx: ModelCtx,
  input: EntryInput,
): Promise<{ id: Id<"timeEntries">; warnings: string[] }> {
  const today = berlinCalendarDate(ctx.now());
  if (input.source !== "timer" && !input.fromInstants) checkEntryValues(input, today);
  const refs = await resolveRefs(ctx, input);
  const rate = await resolveEntryRate(ctx, refs, input.date, input.rateOverrideMicros);
  const description = input.description.trim();
  const billable = input.billable ?? refs.project?.billingMode !== "non_billable";
  const incomplete = isIncomplete({
    description,
    ...(refs.project ? { projectId: refs.project._id } : {}),
    ...(refs.contactId ? { contactId: refs.contactId } : {}),
  });
  const warnings = await warningsFor(ctx, input);
  const id = await auditedInsert(
    ctx,
    "timeEntries",
    {
      ...(refs.project ? { projectId: refs.project._id } : {}),
      ...(refs.contactId ? { contactId: refs.contactId } : {}),
      date: input.date,
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      durationMinutes: input.durationMinutes,
      description,
      ...(refs.productId ? { productId: refs.productId } : {}),
      hourlyRateMicros: rate.hourlyRateMicros,
      currency: refs.currency,
      billable,
      status: "open",
      invoicedLineHistory: [],
      source: input.source,
      ...(incomplete ? { incomplete: true } : {}),
      ...(input.flaggedForReview ? { flaggedForReview: true } : {}),
      ...(input.conflict ? { conflict: true } : {}),
      ...(input.offlineOpIds?.length ? { offlineOpIds: input.offlineOpIds } : {}),
      retentionClass: "none",
      actor: ctx.actor,
    },
    { action: "time_entry.create", label: description || "Zeiteintrag" },
  );
  if (incomplete) warnings.push(TIME_MESSAGES.incomplete);
  await afterChange(ctx, [refs.project?._id]);
  return { id, warnings };
}

/** Edit an open entry (E-PRJ-10/11 otherwise); the rate is re-resolved when project/product change (PRJ-008). */
export async function updateEntry(
  ctx: ModelCtx,
  id: Id<"timeEntries">,
  input: Omit<EntryInput, "source">,
): Promise<{ warnings: string[] }> {
  const e = await getEntry(ctx, id);
  await assertEditable(ctx, e);
  const full: EntryInput = { ...input, source: e.source };
  checkEntryValues(full, berlinCalendarDate(ctx.now()));
  const refs = await resolveRefs(ctx, input, { allowArchived: input.projectId === e.projectId });
  const refsChanged =
    refs.project?._id !== e.projectId || refs.productId !== e.productId || refs.contactId !== e.contactId;
  const hourlyRateMicros =
    input.rateOverrideMicros !== undefined
      ? input.rateOverrideMicros
      : refsChanged
        ? (await resolveEntryRate(ctx, refs, input.date)).hourlyRateMicros
        : e.hourlyRateMicros;
  const description = input.description.trim();
  const incomplete = isIncomplete({
    description,
    ...(refs.project ? { projectId: refs.project._id } : {}),
    ...(refs.contactId ? { contactId: refs.contactId } : {}),
  });
  await auditedPatch(
    ctx,
    "timeEntries",
    id,
    {
      projectId: refs.project?._id,
      contactId: refs.contactId,
      productId: refs.productId,
      date: input.date,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMinutes: input.durationMinutes,
      description,
      hourlyRateMicros,
      currency: refs.currency,
      billable: input.billable ?? e.billable,
      incomplete: incomplete ? true : undefined,
      flaggedForReview: undefined,
      conflict: undefined,
    },
    { action: "time_entry.update", label: description },
  );
  await afterChange(ctx, [e.projectId, refs.project?._id]);
  return { warnings: await warningsFor(ctx, full, id) };
}

/** Bulk „Als (nicht) abrechenbar markieren“ for open entries. */
export async function setBillable(ctx: ModelCtx, ids: Id<"timeEntries">[], billable: boolean): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const e = await getEntry(ctx, id);
    await assertEditable(ctx, e);
    if (e.billable === billable) continue;
    await auditedPatch(ctx, "timeEntries", id, { billable }, { action: "time_entry.update", label: e.description });
    n++;
  }
  return n;
}

/** PRJ-019: open entries have no statutory retention — deletion is audited with the full content. */
export async function deleteEntry(ctx: ModelCtx, id: Id<"timeEntries">): Promise<void> {
  const e = await getEntry(ctx, id);
  await assertEditable(ctx, e);
  await auditedDelete(ctx, "timeEntries", id, { action: "time_entry.delete", label: e.description });
  await afterChange(ctx, [e.projectId]);
}

/** E-PRJ-19: set the project rate on the project's open entries (in_draft/invoiced untouched). */
export async function updateOpenEntryRates(ctx: ModelCtx, projectId: Id<"projects">): Promise<number> {
  const p = await getProject(ctx, projectId);
  if (p.hourlyRateMicros === undefined) return 0;
  let n = 0;
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect()) {
    if (e.status !== "open" || e.hourlyRateMicros === p.hourlyRateMicros) continue;
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      { hourlyRateMicros: p.hourlyRateMicros },
      {
        action: "time_entry.update",
        label: e.description,
        reason: "Stundensatz des Projekts geändert",
      },
    );
    n++;
  }
  return n;
}

// ── timer (PRJ-005, E-PRJ-01…03) ────────────────────────────────────────────────────────────────────────────

export async function runningTimer(ctx: ReadCtx): Promise<Doc<"runningTimer"> | null> {
  return ctx.db.query("runningTimer").first();
}

export interface TimerFields {
  projectId?: string;
  contactId?: string;
  description?: string;
  productId?: string;
  billable?: boolean;
}

export async function startTimer(
  ctx: ModelCtx,
  input: TimerFields & { deviceId?: string; confirmStop?: boolean; startedAt?: number; offlineOpId?: string },
): Promise<{ stoppedEntryIds: Id<"timeEntries">[] }> {
  const running = await runningTimer(ctx);
  let stoppedEntryIds: Id<"timeEntries">[] = [];
  if (running) {
    if (!input.confirmStop) {
      const project = running.projectId ? await ctx.db.get(running.projectId) : null;
      throw appError(
        "conflict",
        timerRunningConfirm(project?.name, Math.floor((ctx.now() - running.startedAt) / 60_000)),
        { reason: "TIMER_RUNNING" },
      );
    }
    stoppedEntryIds = (await stopTimer(ctx, {})).entryIds;
  }
  const refs = await resolveRefs(ctx, input);
  await auditedInsert(
    ctx,
    "runningTimer",
    {
      startedAt: input.startedAt !== undefined ? Math.min(input.startedAt, ctx.now()) : ctx.now(),
      ...(refs.project ? { projectId: refs.project._id } : {}),
      ...(input.contactId && refs.contactId ? { contactId: refs.contactId } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.productId && refs.productId ? { productId: refs.productId } : {}),
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
      startedVia: ctx.actorContext.channel,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.offlineOpId ? { offlineOpId: input.offlineOpId } : {}),
    },
    { action: "timer.start", label: input.description?.trim() || "Timer" },
  );
  return { stoppedEntryIds };
}

/** Edit the running timer (description/project while running, PRJ-005). */
export async function updateTimer(ctx: ModelCtx, input: TimerFields): Promise<void> {
  const t = await runningTimer(ctx);
  if (!t) throw appError("conflict", "Es läuft kein Timer.", { reason: "TIMER_NOT_RUNNING" });
  const refs = await resolveRefs(ctx, input);
  await auditedPatch(
    ctx,
    "runningTimer",
    t._id,
    {
      projectId: refs.project?._id,
      contactId: input.contactId ? refs.contactId : undefined,
      productId: input.productId ? refs.productId : undefined,
      description: input.description?.trim() || undefined,
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
    },
    { action: "timer.update", label: input.description?.trim() || "Timer" },
  );
}

/**
 * Stops the timer: one entry from the instants (PRJ-006) — or one per Berlin day with „an Mitternacht teilen“;
 * missing description/project/contact → saved with the „unvollständig“ flag (E-PRJ-02).
 */
export async function stopTimer(
  ctx: ModelCtx,
  input: TimerFields & {
    splitAtMidnight?: boolean;
    endedAt?: number;
    flaggedForReview?: boolean;
    /** E-PRJ-29 / PRJ-018 (offline replay). */
    conflict?: boolean;
    source?: TimeEntrySource;
    offlineOpIds?: string[];
  },
): Promise<{ entryIds: Id<"timeEntries">[]; warnings: string[] }> {
  const t = await runningTimer(ctx);
  if (!t) throw appError("conflict", "Es läuft kein Timer.", { reason: "TIMER_NOT_RUNNING" });
  // E-PRJ-03: a run longer than 24 h is cut at 24 h and flagged for review.
  const requested = Math.max(t.startedAt, Math.min(input.endedAt ?? ctx.now(), ctx.now()));
  const offlineOpIds = [...(t.offlineOpId ? [t.offlineOpId] : []), ...(input.offlineOpIds ?? [])];
  const capped = requested - t.startedAt > TIMER_AUTO_STOP_MS;
  const endedAt = capped ? t.startedAt + TIMER_AUTO_STOP_MS : requested;
  const flaggedForReview = input.flaggedForReview === true || capped;
  const fields = {
    description: input.description ?? t.description ?? "",
    projectId: input.projectId ?? t.projectId,
    contactId: input.contactId ?? t.contactId,
    productId: input.productId ?? t.productId,
    billable: input.billable ?? t.billable,
  };
  await auditedDelete(ctx, "runningTimer", t._id, { action: "timer.stop", label: fields.description || "Timer" });
  const entryIds: Id<"timeEntries">[] = [];
  const warnings: string[] = [];
  for (const span of spansFromInstants(t.startedAt, endedAt, { splitAtMidnight: input.splitAtMidnight === true })) {
    if (span.durationMinutes < 1) continue;
    const r = await createEntry(ctx, {
      date: span.date,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      durationMinutes: span.durationMinutes,
      description: fields.description,
      ...(fields.projectId ? { projectId: fields.projectId } : {}),
      ...(fields.contactId ? { contactId: fields.contactId } : {}),
      ...(fields.productId ? { productId: fields.productId } : {}),
      ...(fields.billable !== undefined ? { billable: fields.billable } : {}),
      source: input.source ?? "timer",
      fromInstants: true,
      ...(flaggedForReview ? { flaggedForReview: true } : {}),
      ...(input.conflict ? { conflict: true } : {}),
      ...(offlineOpIds.length ? { offlineOpIds } : {}),
    });
    entryIds.push(r.id);
    warnings.push(...r.warnings);
  }
  if (capped) warnings.push(TIME_MESSAGES.autoStopped);
  return { entryIds, warnings: [...new Set(warnings)] };
}

export async function discardTimer(ctx: ModelCtx): Promise<void> {
  const t = await runningTimer(ctx);
  if (!t) return;
  await auditedDelete(ctx, "runningTimer", t._id, { action: "timer.discard", label: t.description ?? "Timer" });
}

/** `deadlines.notify`: 10 h warning (once), auto-stop after 24 h with the entry flagged for review (E-PRJ-03). */
export async function checkRunningTimer(ctx: ModelCtx): Promise<"none" | "warned" | "stopped"> {
  const t = await runningTimer(ctx);
  if (!t) return "none";
  const alert = timerAlert(t, ctx.now());
  if (alert === "auto_stop_24h") {
    const r = await stopTimer(ctx, { endedAt: t.startedAt + TIMER_AUTO_STOP_MS, flaggedForReview: true });
    await notifyKind(ctx, "timer.long", {
      title: TIME_MESSAGES.autoStopped,
      link: "/zeiten",
      ...(r.entryIds[0] ? { entity: { table: "timeEntries", id: r.entryIds[0] } } : {}),
      dedupeKey: `timer.long|stopped|${t._id}`,
    });
    return "stopped";
  }
  if (alert === "warn_10h" && t.warnedAt === undefined) {
    await auditedPatch(ctx, "runningTimer", t._id, { warnedAt: ctx.now() }, { action: "timer.warn" });
    await notifyKind(ctx, "timer.long", {
      title: "Timer läuft seit 10 Stunden",
      link: "/zeiten",
      dedupeKey: `timer.long|10h|${t._id}`,
    });
    return "warned";
  }
  return "none";
}

// ── entry locking with invoice drafts (PRJ-012) ─────────────────────────────────────────────────────────────

/** The entry ids referenced by the lines of a document. */
async function referencedIds(ctx: ReadCtx, docId: Id<"salesDocuments">): Promise<Map<string, Id<"documentLines">>> {
  const out = new Map<string, Id<"documentLines">>();
  for (const l of await ctx.db
    .query("documentLines")
    .withIndex("by_document", (q) => q.eq("documentId", docId))
    .collect()) {
    for (const t of l.timeEntryIds ?? []) out.set(t, l._id);
  }
  return out;
}

/**
 * After every draft save: entries referenced by the draft's lines → `in_draft` (only open entries, or entries already
 * in this draft); entries of this draft no longer referenced → `open` (audited). Diffing the whole set catches lines
 * removed anywhere (the editor patches lines by position).
 */
export async function syncDraftLocks(ctx: ModelCtx, docId: Id<"salesDocuments">): Promise<void> {
  const refs = await referencedIds(ctx, docId);
  const doc = await ctx.db.get(docId);
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_draft", (q) => q.eq("draftDocumentId", docId))
    .collect()) {
    if (e.status === "in_draft" && !refs.has(e._id)) {
      await auditedPatch(
        ctx,
        "timeEntries",
        e._id,
        { status: "open", draftDocumentId: undefined, roundedMinutes: undefined },
        {
          action: "time_entry.release",
          label: e.description,
          reason: "Aus dem Rechnungsentwurf entfernt",
        },
      );
    }
  }
  for (const entryId of refs.keys()) {
    const id = ctx.db.normalizeId("timeEntries", entryId);
    const e = id ? await ctx.db.get(id) : null;
    if (!e)
      throw appError("invalid_input", "Ein Zeiteintrag der Position existiert nicht mehr.", {
        reason: "TIME_ENTRY_UNKNOWN",
      });
    if (e.status === "in_draft" && e.draftDocumentId === docId) continue;
    await assertEditable(ctx, e);
    if (doc?.contactId && e.contactId && e.contactId !== doc.contactId) {
      throw appError("conflict", "Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden.", {
        reason: "time_entries_contacts",
      });
    }
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      { status: "in_draft", draftDocumentId: docId },
      {
        action: "time_entry.lock_draft",
        label: e.description,
      },
    );
  }
  // PRJ-013 / UST-08 / E-PRJ-18: the supply period may be widened, never narrowed below the billed entries.
  if (refs.size > 0 && doc) {
    const dates: CalendarDate[] = [];
    for (const entryId of refs.keys()) {
      const e = await ctx.db.get(entryId as Id<"timeEntries">);
      if (e) dates.push(e.date as CalendarDate);
    }
    const supply = doc.supplyDateMode === "explicit" ? doc.supplyDate : undefined;
    const narrow = checkSupplyCoversEntries(supply, dates);
    if (narrow) throw appError("invalid_input", narrow.message, { reason: narrow.code, field: "supplyDate" });
  }
}

/** Draft deleted (DOC-03): its entries return to `open` (audited). */
export async function releaseDraftEntries(ctx: ModelCtx, docId: Id<"salesDocuments">): Promise<number> {
  let n = 0;
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_draft", (q) => q.eq("draftDocumentId", docId))
    .collect()) {
    if (e.status !== "in_draft") continue;
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      { status: "open", draftDocumentId: undefined, roundedMinutes: undefined },
      {
        action: "time_entry.release",
        label: e.description,
        reason: "Rechnungsentwurf gelöscht",
      },
    );
    n++;
  }
  return n;
}

/**
 * Finalisation (PRJ-012, PRJ-019): the draft's entries → `invoiced` with the billing line, `lockedAt` and the
 * invoice's retention (`vouchers8`, `retentionUntil`). Frozen from here on (GOBD-06).
 */
export async function lockInvoicedEntries(ctx: ModelCtx, doc: Doc<"salesDocuments">): Promise<number> {
  const refs = await referencedIds(ctx, doc._id);
  let n = 0;
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_draft", (q) => q.eq("draftDocumentId", doc._id))
    .collect()) {
    const lineId = refs.get(e._id);
    if (e.status !== "in_draft" || !lineId) continue;
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      {
        status: "invoiced",
        draftDocumentId: undefined,
        invoicedLineId: lineId,
        invoicedDocumentId: doc._id,
        lockedAt: ctx.now(),
        retentionClass: "vouchers8",
        ...(doc.retentionUntil ? { retentionUntil: doc.retentionUntil } : {}),
      },
      { action: "time_entry.invoice", label: `${e.description} · ${doc.number ?? ""}` },
    );
    n++;
  }
  return n;
}

/**
 * PRJ-014: once the invoice PDF/XML is archived, the Leistungsnachweis is rendered from the frozen entries (Node
 * action, archived as `timesheet_pdf`). Not earlier: the invoice pipeline skips documents that already have an
 * artifact, so a timesheet archived first would block the invoice PDF.
 */
export async function afterInvoiceArtifacts(ctx: ModelCtx, doc: Doc<"salesDocuments">) {
  if (doc.attachTimesheet) await ctx.scheduler.runAfter(0, internal.timesheetsNode.render, { documentId: doc._id });
}

/**
 * PRJ-014: archives the rendered Leistungsnachweis as `documentArtifacts.kind = "timesheet_pdf"` (SHA-256, the
 * invoice's retention). Once per invoice; a second render's file is dropped.
 */
export async function recordTimesheet(
  ctx: ModelCtx,
  documentId: Id<"salesDocuments">,
  file: { storageId: Id<"_storage">; sha256: string; bytes: number; name: string },
): Promise<Id<"documentArtifacts"> | null> {
  const existing = await ctx.db
    .query("documentArtifacts")
    .withIndex("by_document", (q) => q.eq("documentId", documentId).eq("kind", "timesheet_pdf"))
    .first();
  if (existing) {
    await ctx.storage.delete(file.storageId);
    return null;
  }
  const [id] = await recordArtifacts(
    ctx,
    documentId,
    [
      {
        kind: "timesheet_pdf",
        storageId: file.storageId,
        sha256: file.sha256,
        bytes: file.bytes,
        mime: "application/pdf",
        name: file.name,
      },
    ],
    { initial: false },
  );
  return id ?? null;
}

/** E-PRJ-25: after the Storno of an invoice with time entries, offer them as „wieder abrechenbar“. */
export async function offerReopenAfterStorno(ctx: ModelCtx, invoice: Doc<"salesDocuments">): Promise<number> {
  const entries = (
    await ctx.db
      .query("timeEntries")
      .withIndex("by_invoice", (q) => q.eq("invoicedDocumentId", invoice._id))
      .collect()
  ).filter((e) => e.status === "invoiced");
  if (entries.length === 0) return 0;
  await notify(ctx, {
    kind: "time_reopen_offer",
    severity: "info",
    title: `Die Rechnung ${invoice.number ?? ""} wurde storniert. ${entries.length} Zeiteinträge wieder als abrechenbar markieren?`,
    link: "/zeiten",
    entity: { table: "salesDocuments", id: invoice._id },
    dedupeKey: `time_reopen_offer:${invoice._id}`,
  });
  return entries.length;
}

/** Invoices that were cancelled while their time entries are still `invoiced` (the „wieder abrechenbar“ offer). */
export async function reopenCandidates(ctx: ReadCtx) {
  const byInvoice = new Map<Id<"salesDocuments">, number>();
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_status", (q) => q.eq("status", "invoiced"))
    .collect()) {
    if (e.invoicedDocumentId) byInvoice.set(e.invoicedDocumentId, (byInvoice.get(e.invoicedDocumentId) ?? 0) + 1);
  }
  const out = [];
  for (const [id, count] of byInvoice) {
    const d = await ctx.db.get(id);
    if (d?.status === "cancelled") out.push({ invoiceId: id, number: d.number ?? "", count });
  }
  return out;
}

/**
 * E-PRJ-25 / PRJ-012: the owner marks the entries of a cancelled invoice as billable again — `open`, the old line
 * kept in `invoicedLineHistory`; the invoice's retention stays on the entry (it was part of a finalised invoice).
 */
export async function reopenEntries(ctx: ModelCtx, invoiceId: Id<"salesDocuments">): Promise<number> {
  const invoice = await ctx.db.get(invoiceId);
  if (invoice?.status !== "cancelled") {
    throw appError("conflict", "Nur Zeiten stornierter Rechnungen können wieder abrechenbar werden.", {
      reason: "invoice_not_cancelled",
    });
  }
  let n = 0;
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_invoice", (q) => q.eq("invoicedDocumentId", invoiceId))
    .collect()) {
    if (e.status !== "invoiced" || !e.invoicedLineId) continue;
    const audit = { action: "time_entry.reopen", label: e.description, reason: `Storno von ${invoice.number ?? ""}` };
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      { status: "open", invoicedLineHistory: [...e.invoicedLineHistory, e.invoicedLineId] },
      audit,
    );
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      { invoicedLineId: undefined, invoicedDocumentId: undefined, lockedAt: undefined, roundedMinutes: undefined },
      audit,
    );
    n++;
  }
  const offer = await ctx.db
    .query("notifications")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `time_reopen_offer:${invoiceId}`))
    .first();
  if (offer && offer.resolvedAt === undefined) {
    await auditedPatch(ctx, "notifications", offer._id, { resolvedAt: ctx.now() }, { action: "notification.resolve" });
  }
  return n;
}

// ── UST-01 monitor (PRJ-015) ────────────────────────────────────────────────────────────────────────────────

async function customerOf(ctx: ReadCtx, e: TimeEntryDoc): Promise<DeadlineCustomer | null> {
  const c = e.contactId ? await ctx.db.get(e.contactId) : null;
  return c ? { isConsumer: c.isConsumer, kind: c.kind } : null;
}

export async function unbilledEntries(ctx: ReadCtx, today: CalendarDate) {
  const out: { entry: TimeEntryDoc; level: UnbilledLevel; daysSince: number }[] = [];
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_status", (q) => q.eq("status", "open"))
    .collect()) {
    const row = { date: e.date as CalendarDate, billable: e.billable, status: e.status };
    const l = unbilledEntryLevel(row, await customerOf(ctx, e), today);
    if (l) out.push({ entry: e, ...l });
  }
  return out;
}

/** Dashboard widget / `time_unbilled_list` totals (PRJ-015). */
export async function unbilledSummary(ctx: ReadCtx, today: CalendarDate) {
  const rows = await unbilledEntries(ctx, today);
  const open = (
    await ctx.db
      .query("timeEntries")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect()
  ).filter((e) => e.billable);
  return {
    openCount: open.length,
    openMinutes: open.reduce((s, e) => s + e.durationMinutes, 0),
    openValueCents: open.reduce((s, e) => s + exactTimeNetCents(e.durationMinutes, e.hourlyRateMicros), 0),
    warning: rows.filter((r) => r.level === "warning").length,
    escalation: rows.filter((r) => r.level === "escalation").length,
  };
}

export const TIME_UST01_KINDS = { warning: "time_ust01_warning", escalation: "time_ust01_escalation" } as const;

/** `deadlines.notify` (02 §7): one warning and one escalation to-do over all unbilled entries; resolved when none. */
export async function runUnbilledTimeDeadlines(ctx: ModelCtx): Promise<{ warning: number; escalation: number }> {
  const rows = await unbilledEntries(ctx, berlinCalendarDate(ctx.now()));
  const counts = {
    warning: rows.filter((r) => r.level === "warning").length,
    escalation: rows.filter((r) => r.level === "escalation").length,
  };
  for (const level of ["warning", "escalation"] as const) {
    const kind = TIME_UST01_KINDS[level];
    const n = counts[level];
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", kind))
      .first();
    if (n === 0) {
      if (existing && existing.resolvedAt === undefined) {
        await auditedPatch(
          ctx,
          "notifications",
          existing._id,
          { resolvedAt: ctx.now() },
          { action: "notification.resolve" },
        );
      }
      continue;
    }
    const title = level === "warning" ? unbilledWarningText(n) : unbilledEscalationText(n);
    if (existing && existing.resolvedAt === undefined && existing.title === title) continue;
    await notify(ctx, {
      kind,
      severity: level === "warning" ? "warning" : "error",
      title,
      link: "/zeiten",
      dedupeKey: kind,
    });
  }
  return counts;
}

// ── offline replay (PRJ-018, E-PRJ-29) ──────────────────────────────────────────────────────────────────────

/**
 * IDs of queued offline operations that were already applied (a replay after a lost response must not apply them
 * twice): the running timer's start op and the ops recorded on entries dated around the ops' instants.
 */
export async function processedOfflineOps(
  ctx: ReadCtx,
  ops: readonly { id: string; at: number; date?: string }[],
): Promise<Set<string>> {
  const done = new Set<string>();
  if (ops.length === 0) return done;
  const t = await runningTimer(ctx);
  if (t?.offlineOpId) done.add(t.offlineOpId);
  const dates = new Set<string>();
  for (const o of ops) {
    const d = berlinCalendarDate(o.at);
    dates.add(d);
    dates.add(addDays(d, -1));
    if (o.date && isCalendarDate(o.date)) dates.add(o.date);
  }
  for (const date of dates) {
    for (const e of await ctx.db
      .query("timeEntries")
      .withIndex("by_date", (q) => q.eq("date", date))
      .collect()) {
      for (const id of e.offlineOpIds ?? []) done.add(id);
    }
  }
  return done;
}

/**
 * An offline timer run that never became the running timer (E-PRJ-29) saved as an entry from its instants; capped
 * at 24 h and flagged for review like the timer (E-PRJ-03).
 */
export async function createOfflineRunEntry(
  ctx: ModelCtx,
  run: TimerFields & { startedAt: number; endedAt: number; conflict: boolean; opId: string },
): Promise<{ id: Id<"timeEntries">; warnings: string[] } | null> {
  const capped = run.endedAt - run.startedAt > TIMER_AUTO_STOP_MS;
  const endedAt = capped ? run.startedAt + TIMER_AUTO_STOP_MS : run.endedAt;
  const [span] = spansFromInstants(run.startedAt, endedAt);
  if (!span || span.durationMinutes < 1) return null;
  return createEntry(ctx, {
    date: span.date,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    durationMinutes: span.durationMinutes,
    description: run.description ?? "",
    ...(run.projectId ? { projectId: run.projectId } : {}),
    ...(run.contactId ? { contactId: run.contactId } : {}),
    ...(run.productId ? { productId: run.productId } : {}),
    ...(run.billable !== undefined ? { billable: run.billable } : {}),
    source: "offline",
    fromInstants: true,
    ...(capped ? { flaggedForReview: true } : {}),
    ...(run.conflict ? { conflict: true } : {}),
    offlineOpIds: [run.opId],
  });
}

/** E-PRJ-29 notification. */
export async function notifyOfflineConflict(ctx: ModelCtx, entryIds: readonly Id<"timeEntries">[]): Promise<void> {
  await notify(ctx, {
    kind: "time_offline_conflict",
    severity: "warning",
    title: OFFLINE_CONFLICT_MESSAGE,
    link: "/zeiten",
    ...(entryIds[0] ? { entity: { table: "timeEntries", id: entryIds[0] } } : {}),
    dedupeKey: `time_offline_conflict:${entryIds[0] ?? ctx.now()}`,
  });
}

/** PRD-073 / E-PRJ-31 helper: entries using a product. */
export async function entriesUsingProduct(ctx: ReadCtx, productId: Id<"products">): Promise<number> {
  return (
    await ctx.db
      .query("timeEntries")
      .withIndex("by_product", (q) => q.eq("productId", productId))
      .collect()
  ).length;
}
