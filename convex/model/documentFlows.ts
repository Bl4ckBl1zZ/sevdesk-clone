import {
  type CollectiveSource,
  checkAcceptance,
  checkCollective,
  checkConversion,
  checkRevision,
  collectiveInvoice,
  convertDocument,
  quoteDeadlines,
  reviseQuote,
  type SourceLine,
} from "../../src/domain/documents/conversion";
import { DOC_TYPE_LABEL_DE, documentPath, isLetterType } from "../../src/domain/documents/doc-types";
import type { DraftDocument } from "../../src/domain/documents/draft";
import { type LifecycleEvent, transition } from "../../src/domain/documents/lifecycle";
import { QUOTE_FOLLOW_UP_POLICY, quoteFollowUps } from "../../src/domain/documents/quote-follow-up";
import type { SalesDocType } from "../../src/domain/documents/snapshot";
import type { Issue } from "../../src/domain/result";
import {
  type AcceptQuoteValues,
  type ConvertValues,
  draftSchema,
  type RejectQuoteValues,
} from "../../src/domain/schemas/documents";
import { TAX_CASE_LABELS } from "../../src/domain/tax/tax-case";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { parse } from "../lib/parse";
import { auditedPatch } from "./audit";
import { inChain, progressOf, recomputeChainOf, remainingOf, rootOf } from "./documentChains";
import {
  createDraft,
  documentLines,
  draftFromDoc,
  getDocument,
  resolveNotifications,
  upsertNotification,
} from "./salesDocuments";
import { reverseDeliveryNote } from "./stock";
import type { ModelCtx, ReadCtx } from "./types";
import { emitDocumentEvent } from "./webhooks";

/**
 * Quotes, order confirmations, delivery notes and proforma after finalisation (F04 §4.2.1–4.2.4, §4.3): acceptance,
 * rejection, reopening, expiry (`deadlines.notify`), withdrawal, „Erhalten“, quote revisions, conversions and the
 * collective invoice. Pure rules live in src/domain/documents/conversion.ts and progress.ts; this module reads the
 * documents, checks every status change against the lifecycle table and writes through the audited helpers.
 */

type SalesDoc = Doc<"salesDocuments">;

const label = (d: Pick<SalesDoc, "number" | "type">) => d.number ?? DOC_TYPE_LABEL_DE[d.type];

/** A domain issue as a Convex error: guard conflicts are 409 with the spec code as `reason`. */
function issueError(i: Issue) {
  const conflicts = [
    "source_not_finalized",
    "conversion_not_allowed",
    "source_already_invoiced",
    "quote_accepted_frozen",
    "quote_expired_notice",
    "collective_mismatch",
  ];
  return appError(conflicts.includes(i.code) ? "conflict" : "invalid_input", i.message, { reason: i.code });
}

function nextOf(doc: SalesDoc, event: LifecycleEvent) {
  const t = transition(doc.type, doc.status, event);
  if (!t.ok || t.value === null) {
    throw appError("illegal_transition", t.ok ? undefined : t.error.message, { reason: "illegal_transition" });
  }
  return t.value;
}

function assertType(doc: SalesDoc, types: readonly SalesDocType[]) {
  if (!types.includes(doc.type)) {
    throw appError("illegal_transition", `Diese Aktion ist für ${DOC_TYPE_LABEL_DE[doc.type]} nicht möglich.`, {
      reason: "illegal_transition",
    });
  }
}

async function snapshotHashOf(ctx: ReadCtx, doc: SalesDoc): Promise<string> {
  const s = doc.snapshotId ? await ctx.db.get(doc.snapshotId) : null;
  if (!s) throw appError("conflict", "Der Beleg hat keinen Snapshot.", { reason: "snapshot_missing" });
  return s.snapshotHash;
}

const QUOTE_TODOS = ["quote_expiring", "quote_expired", "quote_follow_up"] as const;

async function closeQuoteTodos(ctx: ModelCtx, id: Id<"salesDocuments">) {
  for (const k of QUOTE_TODOS) await resolveNotifications(ctx, id, k);
}

// ── acceptance, rejection, reopening (QUO-05, §4.2.1) ─────────────────────────────────────────────────────────

/** „Als angenommen markieren“: stores who/when/how and the hash of the accepted version (T-QUO-003, EC-079). */
export async function acceptQuote(ctx: ModelCtx, id: Id<"salesDocuments">, values: AcceptQuoteValues): Promise<void> {
  const doc = await getDocument(ctx, id);
  assertType(doc, ["quote"]);
  const today = berlinCalendarDate(ctx.now());
  const checked = checkAcceptance(doc, values, today);
  if (!checked.ok) throw issueError(checked.error);
  const status = nextOf(doc, checked.value);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      status,
      acceptance: {
        at: ctx.now(),
        date: values.date,
        byName: values.byName.trim(),
        channel: values.channel,
        ...(values.note?.trim() ? { note: values.note.trim() } : {}),
        snapshotHash: await snapshotHashOf(ctx, doc),
      },
    },
    {
      action: "document.accept",
      label: label(doc),
      ...(checked.value === "accept_late" ? { reason: "abgelaufen" } : {}),
    },
  );
  await closeQuoteTodos(ctx, id);
  const after = await getDocument(ctx, id);
  if (await inChain(ctx, after)) await recomputeChainOf(ctx, after, "document.progress");
  if (status !== doc.status) await emitDocumentEvent(ctx, id, "accepted", { status: doc.status }); // 05 §5.3
}

/** „Als abgelehnt markieren“ (date, reason). `rejection` is set once; a repeated rejection is audited only. */
export async function rejectQuote(ctx: ModelCtx, id: Id<"salesDocuments">, values: RejectQuoteValues): Promise<void> {
  const doc = await getDocument(ctx, id);
  assertType(doc, ["quote"]);
  const today = berlinCalendarDate(ctx.now());
  if (values.date > today) {
    throw appError("invalid_input", "Das Datum darf nicht in der Zukunft liegen.", { reason: "date_future" });
  }
  const status = nextOf(doc, "reject");
  const reason = values.reason?.trim();
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      status,
      ...(doc.rejection
        ? {}
        : {
            rejection: { at: ctx.now(), date: values.date, ...(reason ? { reason } : {}), channel: "manual" as const },
          }),
    },
    { action: "document.reject", label: label(doc), ...(reason ? { reason } : {}) },
  );
  await closeQuoteTodos(ctx, id);
  if (status !== doc.status) await emitDocumentEvent(ctx, id, "rejected", { status: doc.status }); // 05 §5.3
}

/** „Wieder öffnen“ of a rejected quote (§4.2.1: `rejected → sent`, reason). */
export async function reopenQuote(ctx: ModelCtx, id: Id<"salesDocuments">, reason: string): Promise<void> {
  const doc = await getDocument(ctx, id);
  assertType(doc, ["quote"]);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { status: nextOf(doc, "reopen") },
    { action: "document.reopen", label: label(doc), reason: reason.trim() },
  );
}

// ── withdrawal and „Erhalten“ (QUO-15, QUO-09) ────────────────────────────────────────────────────────────────

/**
 * Owner withdrawal (`withdraw` → `cancelled`, number stays used) of a quote, order confirmation, delivery note or
 * proforma — only while no finalised, non-cancelled invoice derives from it (`withdraw_has_invoices`, T-QUO-011).
 * The consumer Widerruf (`withdrawn`, F10 POR-013) is a different act and not offered while F10 is deferred.
 */
export async function withdrawDocument(ctx: ModelCtx, id: Id<"salesDocuments">, reason: string): Promise<void> {
  const doc = await getDocument(ctx, id);
  if (!isLetterType(doc.type)) {
    throw appError("illegal_transition", "Rechnungen werden storniert, nicht zurückgezogen.", {
      reason: "illegal_transition",
    });
  }
  if (doc.status !== "draft") {
    const { progress } = await progressOf(ctx, doc);
    if ((progress.get(doc._id)?.invoicedBy.length ?? 0) > 0) {
      throw appError(
        "conflict",
        `${label(doc)} kann nicht zurückgezogen werden, weil bereits Rechnungen daraus erstellt wurden.`,
        { reason: "withdraw_has_invoices" },
      );
    }
  }
  const status = nextOf(doc, "withdraw");
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { status, cancellation: { at: ctx.now(), reason: reason.trim() } },
    { action: "document.withdraw", label: label(doc), reason: reason.trim() },
  );
  if (doc.type === "quote") await closeQuoteTodos(ctx, id);
  if (doc.type === "delivery_note" && doc.status !== "draft") await reverseDeliveryNote(ctx, doc); // F03 PRD-092
  const after = await getDocument(ctx, id);
  if (await inChain(ctx, after)) await recomputeChainOf(ctx, after, "document.progress");
}

/** Delivery note „Erhalten“ (§4.2.3, QUO-09): date and recipient name, set once. */
export async function markReceived(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  values: { date: string; byName: string },
): Promise<void> {
  const doc = await getDocument(ctx, id);
  assertType(doc, ["delivery_note"]);
  if (values.date > berlinCalendarDate(ctx.now())) {
    throw appError("invalid_input", "Das Datum darf nicht in der Zukunft liegen.", { reason: "date_future" });
  }
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { status: nextOf(doc, "mark_received"), received: { date: values.date, byName: values.byName.trim() } },
    { action: "document.mark_received", label: label(doc) },
  );
}

// ── source documents as domain drafts ────────────────────────────────────────────────────────────────────────

interface SourceDraft {
  doc: SalesDoc;
  draft: Omit<DraftDocument, "lines"> & { readonly lines: readonly SourceLine[] };
}

async function sourceDraft(ctx: ReadCtx, doc: SalesDoc): Promise<SourceDraft> {
  const rows = (await documentLines(ctx, doc._id)).sort((a, b) => a.position - b.position);
  const d = draftFromDoc(doc, rows);
  return {
    doc,
    draft: {
      ...d,
      ...(doc.paymentMethodId ? { paymentMethodId: doc.paymentMethodId } : {}),
      ...(doc.bankAccountId ? { bankAccountId: doc.bankAccountId } : {}),
      ...(doc.internalNote ? { internalNote: doc.internalNote } : {}),
      lines: d.lines.map((l, i) => ({ ...l, id: (rows[i] as (typeof rows)[number])._id })),
    },
  };
}

/** Draft body for `createDraft`, re-validated with the shared schema (unknown keys dropped). */
const toValues = (d: object) => parse(draftSchema, d);

/** The quantity proposal of the conversion dialog (QUO-10, INV-05): what is not yet delivered / invoiced. */
async function remainingFor(ctx: ReadCtx, source: SalesDoc, to: SalesDocType) {
  if (to === "delivery_note") return remainingOf(ctx, source, "delivered");
  if (to === "invoice" && (source.type === "quote" || source.type === "order_confirmation")) {
    return remainingOf(ctx, source, "invoiced");
  }
  return undefined;
}

/** A delivery note may be billed once (EC-DOC-72, `delivery_note_already_invoiced`). */
async function assertNoteNotInvoiced(ctx: ReadCtx, note: SalesDoc) {
  const { progress } = await progressOf(ctx, note);
  const by = progress.get(note._id)?.invoicedBy ?? [];
  if (by.length > 0) {
    throw appError("conflict", `Lieferschein ${label(note)} ist bereits in Rechnung ${by[0]} enthalten.`, {
      reason: "delivery_note_already_invoiced",
    });
  }
}

async function noticesFor(ctx: ReadCtx, source: SalesDoc, id: Id<"salesDocuments">): Promise<string[]> {
  const created = await getDocument(ctx, id);
  const notices: string[] = [];
  if (created.taxCase !== source.taxCase) {
    notices.push(
      `Steuerfall geändert: ${TAX_CASE_LABELS[source.taxCase]} → ${TAX_CASE_LABELS[created.taxCase]} (Kundendaten geändert)`,
    );
  }
  const before = (await documentLines(ctx, source._id)).filter((l) => l.kind === "item");
  for (const l of await documentLines(ctx, id)) {
    const src = before.find((b) => b._id === l.sourceLineId);
    if (src && src.vatRateBp !== undefined && l.vatRateBp !== undefined && src.vatRateBp !== l.vatRateBp) {
      notices.push(
        `Steuersatz geändert: ${src.vatRateBp / 100} % → ${l.vatRateBp / 100} % (Leistungsdatum, ${l.name ?? ""})`,
      );
    }
  }
  return notices;
}

// ── revisions (QUO-06, QUO-07) ────────────────────────────────────────────────────────────────────────────────

/** „Neue Version“: a draft with the full content, `revision = n + 1`, `originId` = the previous version. */
export async function createRevision(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  reason?: string,
): Promise<Id<"salesDocuments">> {
  const prev = await getDocument(ctx, id);
  const checked = checkRevision(prev);
  if (!checked.ok) throw issueError(checked.error);
  const root = rootOf(prev);
  const pending = await ctx.db
    .query("salesDocuments")
    .withIndex("by_chainRoot", (q) => q.eq("chainRootId", root))
    .collect();
  if (pending.some((d) => d.type === "quote" && d.status === "draft" && d.originId === prev._id)) {
    throw appError("conflict", `Für ${label(prev)} gibt es bereits einen Entwurf der neuen Version.`, {
      reason: "revision_draft_exists",
    });
  }
  const { draft } = await sourceDraft(ctx, prev);
  return createDraft(
    ctx,
    toValues(reviseQuote(draft)),
    { originId: prev._id, chainRootId: root, revision: (prev.revision ?? 1) + 1 },
    {
      action: "document.revise",
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      ...(prev.billingAddressId ? { billingAddressId: prev.billingAddressId } : {}),
    },
  );
}

// ── conversions (DOC-33, §4.3) ────────────────────────────────────────────────────────────────────────────────

/** Read model of the „Umwandeln“ dialog: lines with proposed quantities, whether the quote acceptance is needed. */
export async function conversionProposal(ctx: ReadCtx, id: Id<"salesDocuments">, to: SalesDocType) {
  const source = await getDocument(ctx, id);
  const checked = checkConversion(source, to);
  const remaining = checked.ok ? await remainingFor(ctx, source, to) : undefined;
  const rows = (await documentLines(ctx, id)).sort((a, b) => a.position - b.position);
  return {
    allowed: checked.ok,
    ...(checked.ok ? {} : { error: { code: checked.error.code, message: checked.error.message } }),
    acceptRequired: checked.ok && checked.value.acceptEvent !== undefined,
    expired: checked.ok && checked.value.acceptEvent === "accept_late",
    lines: rows
      .filter((l) => l.kind === "item")
      .map((l) => ({
        id: l._id,
        name: l.name ?? "",
        quantityMilli: l.quantityMilli ?? 0,
        unitCode: l.unitCode ?? "",
        optional: l.optional === true,
        proposedMilli: remaining?.[l._id] ?? l.quantityMilli ?? 0,
      })),
  };
}

/**
 * „Umwandeln“: a new draft of the target type from a finalised source (copy rules §4.3.2, tax case and rates
 * re-derived on save, EC-040/080). A finalised/sent/expired quote converted into an order or invoice is first marked
 * as accepted (`acceptSource`, §4.2.1).
 */
export async function convert(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  values: ConvertValues,
): Promise<{ id: Id<"salesDocuments">; notices: string[] }> {
  let source = await getDocument(ctx, id);
  const checked = checkConversion(source, values.to);
  if (!checked.ok) throw issueError(checked.error);
  if (checked.value.acceptEvent) {
    if (!values.acceptSource) {
      throw appError(
        "conflict",
        "Das Angebot ist noch nicht angenommen. Bitte beim Umwandeln „Angebot als angenommen markieren“ wählen.",
        { reason: "quote_not_accepted" },
      );
    }
    await acceptQuote(ctx, id, {
      date: berlinCalendarDate(ctx.now()),
      byName: source.contactName ?? "Kunde",
      channel: "manual",
      note: `Beim Umwandeln in ${DOC_TYPE_LABEL_DE[values.to]} angenommen`,
      late: checked.value.acceptEvent === "accept_late",
    });
    source = await getDocument(ctx, id);
  }
  if (source.type === "delivery_note") await assertNoteNotInvoiced(ctx, source);
  const remaining = await remainingFor(ctx, source, values.to);
  const { draft } = await sourceDraft(ctx, source);
  const converted = convertDocument(draft, values.to, {
    ...(values.mode ? { mode: values.mode } : {}),
    ...(values.quantities ? { quantities: values.quantities } : {}),
    ...(values.optionalLineIds ? { optionalLineIds: values.optionalLineIds } : {}),
    ...(remaining ? { remaining } : {}),
  });
  if (!converted.lines.some((l) => l.kind === "item")) {
    throw appError("invalid_input", `Aus ${label(source)} ist nichts mehr offen, das übernommen werden kann.`, {
      reason: "nothing_remaining",
    });
  }
  const newId = await createDraft(
    ctx,
    toValues(converted),
    { originId: source._id, chainRootId: rootOf(source) },
    {
      action: "document.convert",
      reason: `${DOC_TYPE_LABEL_DE[source.type]} ${label(source)} → ${DOC_TYPE_LABEL_DE[values.to]}`,
      ...(source.billingAddressId ? { billingAddressId: source.billingAddressId } : {}),
    },
  );
  return { id: newId, notices: await noticesFor(ctx, source, newId) };
}

/** QUO-11 collective invoice from finalised delivery notes of one contact (same currency, tax case, price mode). */
export async function createCollectiveInvoice(
  ctx: ModelCtx,
  ids: readonly Id<"salesDocuments">[],
): Promise<{ id: Id<"salesDocuments">; notices: string[] }> {
  const unique = [...new Set(ids)];
  const sources: CollectiveSource[] = [];
  const docs: SalesDoc[] = [];
  for (const nid of unique) {
    const note = await getDocument(ctx, nid);
    if (note.type === "delivery_note" && note.status !== "draft") await assertNoteNotInvoiced(ctx, note);
    const { draft } = await sourceDraft(ctx, note);
    const s = note.supplyDate;
    const deliveryDate = s?.kind === "date" ? s.date : s?.kind === "period" ? s.to : (note.documentDate ?? "");
    docs.push(note);
    sources.push({
      ...draft,
      id: note._id,
      type: note.type,
      status: note.status,
      number: note.number ?? "",
      taxCase: note.taxCase,
      deliveryDate,
    });
  }
  const checked = checkCollective(sources);
  if (!checked.ok) throw issueError(checked.error);
  const first = docs[0] as SalesDoc;
  const newId = await createDraft(
    ctx,
    toValues(collectiveInvoice(sources)),
    { sourceDocumentIds: docs.map((d) => d._id), chainRootId: rootOf(first) },
    {
      action: "document.convert",
      reason: `Sammelrechnung aus ${docs.map((d) => label(d)).join(", ")}`,
      ...(first.billingAddressId ? { billingAddressId: first.billingAddressId } : {}),
    },
  );
  return { id: newId, notices: await noticesFor(ctx, first, newId) };
}

/** Uninvoiced finalised delivery notes of a contact („+ Lieferscheine übernehmen“, §4.4 item 2). */
export async function uninvoicedDeliveryNotes(ctx: ReadCtx, contactId: Id<"contacts">) {
  const notes = (
    await ctx.db
      .query("salesDocuments")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId).eq("type", "delivery_note"))
      .collect()
  ).filter((d) => d.status === "finalized" || d.status === "sent" || d.status === "accepted");
  return notes.map((d) => ({
    _id: d._id,
    number: d.number ?? "",
    supplyDate: d.supplyDate ?? null,
    grossCents: d.totals.grossCents,
    currency: d.currency,
  }));
}

// ── expiry and reminders (QUO-04, `deadlines.notify`) ─────────────────────────────────────────────────────────

/** Expires `finalized`/`sent` quotes past `validUntil`; reminds 3 days before (one to-do per quote). */
export async function runQuoteDeadlines(ctx: ModelCtx): Promise<{ expired: number; reminded: number }> {
  const today = berlinCalendarDate(ctx.now());
  const quotes: SalesDoc[] = [];
  for (const status of ["finalized", "sent"] as const) {
    quotes.push(
      ...(await ctx.db
        .query("salesDocuments")
        .withIndex("by_type_status_date", (q) => q.eq("type", "quote").eq("status", status))
        .collect()),
    );
  }
  const due = quoteDeadlines(
    quotes.map((q) => ({ id: q._id, status: q.status, validUntil: q.validUntil })),
    today,
  );
  const byId = new Map(quotes.map((q) => [q._id as string, q]));
  for (const qid of due.expire) {
    const q = byId.get(qid) as SalesDoc;
    await auditedPatch(
      ctx,
      "salesDocuments",
      q._id,
      { status: nextOf(q, "expire") },
      { action: "document.expire", label: label(q) },
    );
    await emitDocumentEvent(ctx, q._id, "expired", { status: q.status }); // 05 §5.3 quote.expired
    await resolveNotifications(ctx, q._id, "quote_expiring");
    await resolveNotifications(ctx, q._id, "quote_follow_up");
    await upsertNotification(ctx, {
      kind: "quote_expired",
      severity: "info",
      title: `Angebot ${label(q)} ist abgelaufen (gültig bis ${formatGermanDate(q.validUntil as CalendarDate)})`,
      link: documentPath(q.type, q._id),
      entity: { table: "salesDocuments", id: q._id },
      dedupeKey: `quote_expired:${q._id}`,
    });
  }
  let reminded = 0;
  for (const qid of due.remind) {
    const q = byId.get(qid) as SalesDoc;
    const key = `quote_expiring:${q._id}`;
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_dedupe", (x) => x.eq("dedupeKey", key))
      .first();
    if (existing) continue;
    await upsertNotification(ctx, {
      kind: "quote_expiring",
      severity: "warning",
      title: `Angebot ${label(q)} läuft am ${formatGermanDate(q.validUntil as CalendarDate)} ab`,
      link: documentPath(q.type, q._id),
      entity: { table: "salesDocuments", id: q._id },
      dedupeKey: key,
    });
    reminded++;
  }
  const followedUp = await runQuoteFollowUps(ctx, quotes, today);
  return { expired: due.expire.length, reminded: reminded + followedUp };
}

const followUpKey = (id: Id<"salesDocuments">, level: number) => `quote_follow_up:${id}:${level}`;

/**
 * QUO-16: „Angebot nachfassen“ to-dos +5/+12 days after the quote was marked as sent without a reaction (dunning
 * step model, one level per run). The raised level is read back from the dedupe keys; a reaction (accept, reject,
 * withdraw, expire) resolves the to-do via `closeQuoteTodos`.
 */
async function runQuoteFollowUps(ctx: ModelCtx, quotes: readonly SalesDoc[], today: string): Promise<number> {
  const rows = [];
  for (const q of quotes) {
    if (q.status !== "sent" || !q.sentOn) continue;
    let level = 0;
    for (const s of QUOTE_FOLLOW_UP_POLICY.steps) {
      const n = await ctx.db
        .query("notifications")
        .withIndex("by_dedupe", (x) => x.eq("dedupeKey", followUpKey(q._id, s.level)))
        .first();
      if (n) level = Math.max(level, s.level);
    }
    rows.push({ id: q._id as string, status: q.status, sentOn: q.sentOn, validUntil: q.validUntil, level });
  }
  const byId = new Map(quotes.map((q) => [q._id as string, q]));
  const due = quoteFollowUps(rows, today);
  for (const f of due) {
    const q = byId.get(f.id) as SalesDoc;
    await resolveNotifications(ctx, q._id, "quote_follow_up");
    await upsertNotification(ctx, {
      kind: "quote_follow_up",
      severity: "info",
      title: `${f.title}: ${label(q)} – seit ${f.daysSinceSent} Tagen keine Reaktion (versendet am ${formatGermanDate(q.sentOn as CalendarDate)})`,
      link: documentPath(q.type, q._id),
      entity: { table: "salesDocuments", id: q._id },
      dedupeKey: followUpKey(q._id, f.level),
    });
  }
  return due.length;
}
