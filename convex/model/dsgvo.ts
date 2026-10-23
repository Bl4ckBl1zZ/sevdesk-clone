import { formatCents } from "../../src/domain/money/format";
import {
  canTransitionRequest,
  completionIssue,
  DSGVO_KIND_LABEL_DE,
  DSGVO_MESSAGES,
  type DsgvoChannel,
  type DsgvoKind,
  type DsgvoStatus,
  dsgvoDueDate,
  type ErasureItem,
  erasurePlan,
  extensionIssue,
  type RetainedItem,
  reminderStage,
  responseTemplate,
} from "../../src/domain/privacy/dsgvo";
import { isRetained } from "../../src/domain/rules/retention";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { shredContactKey } from "./contactKeys";
import { createJob } from "./jobs";
import { notifyKind } from "./notifications";
import { contactReferences, correctionLettersOfContact, deleteHashed, receivableLettersOfContact } from "./retention";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * DSGVO request register and the erasure/restriction/access flows (F12 PRV-010…PRV-014, F02 CON-162…CON-165,
 * 01 DSGVO-02/03, EC-180). Owner-only UI acts (permissions with `scope: null`, so REST/MCP get 403).
 * Deletions of erasure bucket 1 are audited with a content hash only (no personal data in the log, E-PRV-18).
 */

const today = (ctx: { now: () => number }) => berlinCalendarDate(ctx.now());

async function companyState(ctx: ReadCtx): Promise<string | undefined> {
  return (await ctx.db.query("companyProfile").first())?.taxNumberState ?? undefined;
}

async function requireRequest(ctx: ReadCtx, id: Id<"dsgvoRequests">): Promise<Doc<"dsgvoRequests">> {
  const r = await ctx.db.get(id);
  if (!r) throw appError("not_found", "Anfrage nicht gefunden.");
  return r;
}

const subjectLabel = async (ctx: ReadCtx, r: Doc<"dsgvoRequests">) =>
  r.contactId ? ((await ctx.db.get(r.contactId))?.displayName ?? "Kontakt") : (r.subject?.name ?? "Unbekannt");

export interface NewRequestInput {
  contactId?: Id<"contacts">;
  subject?: { name: string; email?: string };
  kind: DsgvoKind;
  channel: DsgvoChannel;
  receivedAt: string;
  notes?: string;
}

/** PRV-010: register a request; `dueAt` = received + 1 month (E-PRV-14). */
export async function createRequest(ctx: ModelCtx, input: NewRequestInput): Promise<Id<"dsgvoRequests">> {
  if (!input.contactId && !input.subject?.name.trim()) throw appError("invalid_input", DSGVO_MESSAGES.subjectMissing);
  if (!isCalendarDate(input.receivedAt) || input.receivedAt > today(ctx)) {
    throw appError("invalid_input", "Bitte ein gültiges Eingangsdatum (nicht in der Zukunft) angeben.");
  }
  if (input.contactId && !(await ctx.db.get(input.contactId))) throw appError("not_found", "Kontakt nicht gefunden.");
  const dueAt = dsgvoDueDate(input.receivedAt as CalendarDate, await companyState(ctx));
  return auditedInsert(
    ctx,
    "dsgvoRequests",
    {
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.subject?.name.trim()
        ? {
            subject: {
              name: input.subject.name.trim(),
              ...(input.subject.email?.trim() ? { email: input.subject.email.trim() } : {}),
            },
          }
        : {}),
      kind: input.kind,
      channel: input.channel,
      receivedAt: input.receivedAt,
      dueAt,
      status: "open",
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 2000) } : {}),
      createdAt: ctx.now(),
    },
    { action: "dsgvo.request.create", label: DSGVO_KIND_LABEL_DE[input.kind] },
  );
}

export async function verifyIdentity(ctx: ModelCtx, id: Id<"dsgvoRequests">, method: string) {
  const r = await requireRequest(ctx, id);
  if (!method.trim()) throw appError("invalid_input", "Bitte die Art der Identitätsprüfung angeben.");
  await auditedPatch(
    ctx,
    "dsgvoRequests",
    id,
    { identityVerified: { method: method.trim().slice(0, 200), at: ctx.now() } },
    { action: "dsgvo.request.identity", label: DSGVO_KIND_LABEL_DE[r.kind] },
  );
}

/** PRV-010: open → in_progress → done/rejected (E-PRV-15: done needs a verified identity). */
export async function setStatus(
  ctx: ModelCtx,
  id: Id<"dsgvoRequests">,
  to: Exclude<DsgvoStatus, "extended" | "open">,
  opts: { rejectionReason?: string } = {},
) {
  const r = await requireRequest(ctx, id);
  if (!canTransitionRequest(r.status, to)) throw appError("illegal_transition", DSGVO_MESSAGES.transition);
  if (to === "done" || to === "rejected") {
    const issue = completionIssue({
      to,
      identityVerified: r.identityVerified !== undefined,
      ...(opts.rejectionReason !== undefined ? { rejectionReason: opts.rejectionReason } : {}),
    });
    if (issue) throw appError("invalid_input", issue);
  }
  await auditedPatch(
    ctx,
    "dsgvoRequests",
    id,
    {
      status: to,
      ...(to === "rejected" ? { rejectionReason: opts.rejectionReason?.trim().slice(0, 1000) } : {}),
      ...(to === "done" || to === "rejected" ? { doneAt: ctx.now() } : {}),
    },
    { action: `dsgvo.request.${to}`, label: DSGVO_KIND_LABEL_DE[r.kind] },
  );
}

/** Art. 12 Abs. 3: extension by up to two months with reason and notice date (E-PRV-13). */
export async function extendRequest(
  ctx: ModelCtx,
  id: Id<"dsgvoRequests">,
  x: { months: number; reason: string; noticeSentOn: string },
) {
  const r = await requireRequest(ctx, id);
  const issue = extensionIssue(x);
  if (issue) throw appError("invalid_input", issue);
  if (!canTransitionRequest(r.status, "extended")) throw appError("illegal_transition", DSGVO_MESSAGES.transition);
  const newDueAt = dsgvoDueDate(r.receivedAt as CalendarDate, await companyState(ctx), 1 + x.months);
  await auditedPatch(
    ctx,
    "dsgvoRequests",
    id,
    {
      status: "extended",
      dueAt: newDueAt,
      extension: { newDueAt, reason: x.reason.trim().slice(0, 1000), noticeSentOn: x.noticeSentOn },
      remindedStage: undefined,
    },
    { action: "dsgvo.request.extend", label: DSGVO_KIND_LABEL_DE[r.kind], reason: x.reason.trim() },
  );
}

export async function listRequests(ctx: ReadCtx & { now: () => number }) {
  const day = today(ctx);
  const rows = await ctx.db.query("dsgvoRequests").collect();
  const out = [];
  for (const r of rows.sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))) {
    const active = r.status !== "done" && r.status !== "rejected";
    out.push({
      id: r._id,
      kind: r.kind,
      kindLabel: DSGVO_KIND_LABEL_DE[r.kind],
      subject: await subjectLabel(ctx, r),
      contactId: r.contactId ?? null,
      channel: r.channel,
      receivedAt: r.receivedAt,
      dueAt: r.dueAt,
      status: r.status,
      identityVerified: r.identityVerified ?? null,
      extension: r.extension ?? null,
      erasure: r.erasure ?? null,
      hasResult: r.resultStorageId !== undefined,
      overdue: active && reminderStage(r.dueAt as CalendarDate, day) === "overdue",
      stage: active ? reminderStage(r.dueAt as CalendarDate, day) : "none",
    });
  }
  return out;
}

/** PRV-010 / E-PRV-12: daily — warning at due − 7 and due − 1, error when overdue (once per stage). */
export async function notifyDeadlines(ctx: ModelCtx): Promise<number> {
  const day = today(ctx);
  let n = 0;
  for (const r of await ctx.db.query("dsgvoRequests").collect()) {
    if (r.status === "done" || r.status === "rejected") continue;
    const stage = reminderStage(r.dueAt as CalendarDate, day);
    if (stage === "none" || r.remindedStage === stage) continue;
    const who = await subjectLabel(ctx, r);
    const due = r.dueAt.split("-").reverse().join(".");
    if (stage === "overdue") {
      await notifyKind(ctx, "dsgvo.overdue", {
        title: `DSGVO-Anfrage von ${who} ist seit ${due} überfällig.`,
        link: "/einstellungen/datenschutz?tab=anfragen",
        entity: { table: "dsgvoRequests", id: r._id },
      });
    } else {
      await notifyKind(ctx, "dsgvo.deadline", {
        title: `DSGVO-Anfrage von ${who}: Frist ${due}`,
        link: "/einstellungen/datenschutz?tab=anfragen",
        entity: { table: "dsgvoRequests", id: r._id },
      });
    }
    await auditedPatch(ctx, "dsgvoRequests", r._id, { remindedStage: stage }, { action: "dsgvo.request.reminder" });
    n++;
  }
  return n;
}

// ── data subject search (E-PRV-16) ───────────────────────────────────────────────────────────────────

export interface SubjectHit {
  kind: "contact" | "contactChannel" | "inboxItem" | "sendLog";
  id: string;
  contactId: string | null;
  label: string;
}

/**
 * F12 E-PRV-16: a data subject who is not a contact (e.g. a contact person in a supplier e-mail) is registered as a
 * free subject; to find their data the owner searches the e-mail address across contacts (e-invoice address),
 * contact channels, inbox items (sender, mail text) and send logs (notes). Case-insensitive, exact address match.
 */
export async function findSubjectByEmail(ctx: ReadCtx, email: string): Promise<SubjectHit[]> {
  const needle = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(needle))
    throw appError("invalid_input", "Bitte eine gültige E-Mail-Adresse angeben.");
  const has = (text: string | undefined) => (text ?? "").toLowerCase().includes(needle);
  const hits: SubjectHit[] = [];
  for (const c of await ctx.db.query("contacts").collect()) {
    if (c.electronicAddress?.scheme === "EM" && c.electronicAddress.value.trim().toLowerCase() === needle) {
      hits.push({ kind: "contact", id: c._id, contactId: c._id, label: `${c.number} ${c.displayName}` });
    }
  }
  for (const ch of await ctx.db.query("contactChannels").collect()) {
    if (ch.type === "email" && ch.value.trim().toLowerCase() === needle) {
      const c = await ctx.db.get(ch.contactId);
      hits.push({
        kind: "contactChannel",
        id: ch._id,
        contactId: ch.contactId,
        label: c ? `${c.number} ${c.displayName}` : "Kontaktweg",
      });
    }
  }
  for (const item of await ctx.db.query("inboxItems").collect()) {
    if (has(item.from) || has(item.mailText)) {
      hits.push({
        kind: "inboxItem",
        id: item._id,
        contactId: null,
        label: `Posteingang ${berlinCalendarDate(Math.floor(item._creationTime))}`,
      });
    }
  }
  for (const s of await ctx.db.query("sendLog").collect()) {
    if (has(s.note)) hits.push({ kind: "sendLog", id: s._id, contactId: null, label: `Versand ${s.sentOn}` });
  }
  return hits;
}

// ── erasure (PRV-011, CON-162, EC-180) ─────────────────────────────────────────────────────────────────

const addrKey = (a: { street?: string; postalCode?: string; city?: string }) =>
  `${a.street ?? ""}|${a.postalCode ?? ""}|${a.city ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();

/** Addresses/e-mails printed on finalised documents of the contact (those stay with the restricted record). */
async function printedOnDocuments(ctx: ReadCtx, contactId: Id<"contacts">) {
  const addresses = new Set<string>();
  const emails = new Set<string>();
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (d.status === "draft") continue;
    const snap = await ctx.db
      .query("documentSnapshots")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .first();
    if (!snap) continue;
    try {
      const buyer = (JSON.parse(snap.json) as { buyer?: { address?: Record<string, string>; invoiceEmail?: string } })
        .buyer;
      if (buyer?.address) addresses.add(addrKey(buyer.address));
      if (buyer?.invoiceEmail) emails.add(buyer.invoiceEmail.toLowerCase());
    } catch {
      // unreadable snapshot: keep everything (conservative)
      addresses.add("*");
      emails.add("*");
    }
  }
  return { addresses, emails };
}

export interface ErasurePreview {
  contactId: Id<"contacts">;
  contactNumber: string;
  deleteNow: ErasureItem[];
  clearFields: string[];
  restrict: RetainedItem[];
  byClass: Record<string, string>;
  scheduledPurgeAt: string | null;
  deleteContact: boolean;
  openReceivablesCents: number;
  /** E-PRV-10 warning text when open receivables exist (dunning stays allowed). */
  receivablesNotice: string | null;
}

export async function erasurePreview(
  ctx: ReadCtx & { now: () => number },
  contactId: Id<"contacts">,
): Promise<ErasurePreview> {
  const c = await ctx.db.get(contactId);
  if (!c) throw appError("not_found", "Kontakt nicht gefunden.");
  const day = today(ctx);
  const deletable: ErasureItem[] = [];
  for (const a of await ctx.db
    .query("contactActivities")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    deletable.push({ kind: "contactActivities", id: a._id, label: `Aktivität (${a.kind})` });
  }
  for (const p of await ctx.db
    .query("customerPrices")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    deletable.push({ kind: "customerPrices", id: p._id, label: "Kundenpreis" });
  }
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (d.status === "draft") deletable.push({ kind: "salesDocuments", id: d._id, label: "Entwurf" });
  }
  for (const r of await ctx.db
    .query("recurringTemplates")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    deletable.push({ kind: "recurringTemplates", id: r._id, label: "Vorlage für wiederkehrende Rechnungen" });
  }
  for (const a of await ctx.db
    .query("contactAliases")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    deletable.push({ kind: "contactAliases", id: a._id, label: "Gelernter Zahlungsname (Bankabgleich)" });
  }
  // learned or configured data without retention duty that points at the person (PRV-011 bucket 1)
  for (const s of await ctx.db.query("supplierProfiles").collect()) {
    if (s.contactId === contactId)
      deletable.push({ kind: "supplierProfiles", id: s._id, label: "Gelernte Lieferantenvorgaben" });
  }
  for (const r of await ctx.db.query("matchingRules").collect()) {
    if (r.apply.contactId === contactId)
      deletable.push({ kind: "matchingRules", id: r._id, label: `Abgleichsregel „${r.name}“` });
  }
  for (const r of await ctx.db.query("recurringVouchers").collect()) {
    if (r.template.supplierContactId === contactId) {
      deletable.push({ kind: "recurringVouchers", id: r._id, label: `Wiederkehrender Beleg „${r.name}“` });
    }
  }
  for (const d of await ctx.db.query("dismissedDuplicates").collect()) {
    if (d.a === contactId || d.b === contactId) {
      deletable.push({ kind: "dismissedDuplicates", id: d._id, label: "Verworfener Dublettenhinweis" });
    }
  }
  for (const m of await ctx.db.query("contactMerges").collect()) {
    if (m.winnerId === contactId || m.loserId === contactId) {
      deletable.push({ kind: "contactMerges", id: m._id, label: "Zusammenführungsprotokoll (Rückgängig-Daten)" });
    }
  }
  for (const timer of await ctx.db.query("runningTimer").collect()) {
    if (timer.contactId === contactId)
      deletable.push({ kind: "runningTimer", id: timer._id, label: "Laufende Zeiterfassung" });
  }
  const refs = (await contactReferences(ctx, contactId, day)).filter((r) => isRetained(r.retentionUntil, day));
  const printed =
    refs.length > 0
      ? await printedOnDocuments(ctx, contactId)
      : { addresses: new Set<string>(), emails: new Set<string>() };
  for (const a of await ctx.db
    .query("contactAddresses")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (printed.addresses.has("*") || printed.addresses.has(addrKey(a.address))) continue;
    deletable.push({ kind: "contactAddresses", id: a._id, label: "Anschrift (nicht auf Belegen)" });
  }
  for (const ch of await ctx.db
    .query("contactChannels")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (printed.emails.has("*") || (ch.type === "email" && printed.emails.has(ch.value.toLowerCase()))) continue;
    deletable.push({ kind: "contactChannels", id: ch._id, label: `Kontaktweg (${ch.type})` });
  }
  const fields = (["notes", "birthday"] as const).filter((f) => c[f] !== undefined);
  const plan = erasurePlan({
    deletable,
    retained: refs.map((r) => ({
      kind: r.kind,
      id: r.id,
      label: r.label,
      retentionClass: r.retentionClass,
      retentionUntil: r.retentionUntil,
    })),
    fields: [...fields, ...(c.tags.length > 0 ? ["tags"] : [])],
  });
  let open = 0;
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (d.status !== "draft" && (d.openAmountCents ?? 0) > 0) open += d.openAmountCents ?? 0;
  }
  return {
    contactId,
    contactNumber: c.number,
    ...plan,
    byClass: plan.byClass as Record<string, string>,
    openReceivablesCents: open,
    receivablesNotice:
      open > 0
        ? `Offene Forderungen (${formatCents(open)} €) dürfen weiter verfolgt werden (Art. 18 Abs. 2 DSGVO).`
        : null,
  };
}

async function deleteItem(ctx: ModelCtx, item: ErasureItem, label: string) {
  if (item.kind === "salesDocuments") {
    const docId = item.id as Id<"salesDocuments">;
    const d = await ctx.db.get(docId);
    if (d?.status !== "draft") return; // only drafts (bucket 1)
    for (const l of await ctx.db
      .query("documentLines")
      .withIndex("by_document", (q) => q.eq("documentId", docId))
      .collect()) {
      await deleteHashed(ctx, "documentLines", l._id, "dsgvo.erase", label);
    }
  }
  if (item.kind === "contactActivities") {
    const a = await ctx.db.get(item.id as Id<"contactActivities">);
    for (const f of a?.attachments ?? []) {
      try {
        await ctx.storage.delete(f.storageId);
      } catch {
        // gone
      }
    }
  }
  if (item.kind === "recurringVouchers") {
    // the supplier's reference invoice kept with the template
    const r = await ctx.db.get(item.id as Id<"recurringVouchers">);
    if (r?.referenceFile) {
      try {
        await ctx.storage.delete(r.referenceFile.storageId);
      } catch {
        // gone
      }
    }
  }
  await deleteHashed(ctx, item.kind as "contactActivities", item.id, "dsgvo.erase", label);
}

/**
 * PRV-011 execute: deletes bucket 1, clears the non-retained fields, restricts the contact and records the purge due
 * date (manual worklist, nothing is purged automatically); E-PRV-18 a contact without retained records is deleted
 * completely and its key shredded. Requires a verified identity (E-PRV-15).
 */
export async function executeErasure(ctx: ModelCtx, requestId: Id<"dsgvoRequests">) {
  const r = await requireRequest(ctx, requestId);
  if (r.kind !== "erasure" && r.kind !== "restriction")
    throw appError("invalid_input", "Nur für Löschungs- oder Einschränkungsanfragen.");
  if (!r.contactId) throw appError("invalid_input", "Die Anfrage ist keinem Kontakt zugeordnet.");
  if (!r.identityVerified) throw appError("invalid_input", DSGVO_MESSAGES.identity);
  if (r.status === "done" || r.status === "rejected") throw appError("illegal_transition", DSGVO_MESSAGES.transition);
  const contactId = r.contactId;
  const c = await ctx.db.get(contactId);
  if (!c) throw appError("not_found", "Kontakt nicht gefunden.");
  const p = await erasurePreview(ctx, contactId);
  const now = ctx.now();
  let deleted = 0;
  if (r.kind === "erasure") {
    for (const item of p.deleteNow) {
      await deleteItem(ctx, item, c.number);
      deleted++;
    }
  }
  const contactDeleted = r.kind === "erasure" && p.deleteContact;
  if (contactDeleted) {
    // E-PRV-18: no retained record — the contact goes completely (audited with a hash, key shredded).
    await deleteHashed(ctx, "contacts", contactId, "dsgvo.erase", c.number);
    await shredContactKey(ctx, contactId);
  } else {
    await auditedPatch(
      ctx,
      "contacts",
      contactId,
      {
        ...(r.kind === "erasure" ? { notes: undefined, birthday: undefined, tags: [] } : {}),
        dsgvo: {
          restrictedAt: c.dsgvo?.restrictedAt ?? now,
          ...(r.kind === "erasure" ? { deletionRequestedAt: now } : {}),
          ...(r.kind === "erasure" && p.scheduledPurgeAt ? { scheduledPurgeAt: p.scheduledPurgeAt } : {}),
        },
        version: c.version + 1,
      },
      { action: "dsgvo.restrict", label: c.number, reason: `DSGVO-Anfrage ${DSGVO_KIND_LABEL_DE[r.kind]}` },
    );
  }
  await auditedPatch(
    ctx,
    "dsgvoRequests",
    requestId,
    {
      status: r.status === "open" ? "in_progress" : r.status,
      erasure: {
        executedAt: now,
        deleted,
        restricted: contactDeleted ? 0 : p.restrict.length,
        ...(p.scheduledPurgeAt && !contactDeleted ? { scheduledPurgeAt: p.scheduledPurgeAt } : {}),
        contactDeleted,
      },
    },
    { action: "dsgvo.request.execute", label: DSGVO_KIND_LABEL_DE[r.kind] },
  );
  return { deleted, restricted: p.restrict.length, scheduledPurgeAt: p.scheduledPurgeAt, contactDeleted };
}

/** PRV-011 / PRV-014: confirmation/response letter (the owner sends it; no e-mail from the app). */
export async function responseLetter(ctx: ReadCtx, requestId: Id<"dsgvoRequests">) {
  const r = await requireRequest(ctx, requestId);
  const profile = await ctx.db.query("companyProfile").first();
  const purgeDate = r.erasure?.scheduledPurgeAt ?? null;
  let openAmount: string | undefined;
  if (r.contactId) {
    let open = 0;
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_contact", (q) => q.eq("contactId", r.contactId))
      .collect()) {
      if (d.status !== "draft") open += d.openAmountCents ?? 0;
    }
    if (open > 0) openAmount = formatCents(open);
  }
  return responseTemplate(r.kind, {
    name: await subjectLabel(ctx, r),
    company: profile?.name ?? "Ihr Unternehmen",
    purgeDate,
    ...(openAmount ? { openAmount } : {}),
  });
}

// ── access / portability export (PRV-013, CON-164, DSGVO-03) ───────────────────────────────────────────

export async function startAccessExport(ctx: ModelCtx, requestId: Id<"dsgvoRequests">) {
  const r = await requireRequest(ctx, requestId);
  if (r.kind !== "access" && r.kind !== "portability")
    throw appError("invalid_input", "Nur für Auskunfts- oder Übertragbarkeitsanfragen.");
  if (!r.contactId) throw appError("invalid_input", "Die Anfrage ist keinem Kontakt zugeordnet.");
  const jobId = await createJob(ctx, {
    kind: "dsgvo_export",
    label: `DSGVO-Auskunft ${await subjectLabel(ctx, r)}`,
    params: { requestId },
    total: 1,
  });
  if (r.status === "open") {
    await auditedPatch(
      ctx,
      "dsgvoRequests",
      requestId,
      { status: "in_progress" },
      { action: "dsgvo.request.in_progress" },
    );
  }
  return jobId;
}

/** Data of the access export (read by the Node worker): everything about the person, personal fields decrypted. */
export async function accessExportData(ctx: ReadCtx, requestId: Id<"dsgvoRequests">) {
  const r = await requireRequest(ctx, requestId);
  const contactId = r.contactId as Id<"contacts">;
  const contact = await ctx.db.get(contactId);
  if (!contact) return null;
  const addresses = await ctx.db
    .query("contactAddresses")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const channels = await ctx.db
    .query("contactChannels")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const activities = await ctx.db
    .query("contactActivities")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const customerPrices = await ctx.db
    .query("customerPrices")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const documents = await ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const artifacts = [];
  for (const d of documents) {
    for (const a of await ctx.db
      .query("documentArtifacts")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .collect()) {
      artifacts.push({ number: d.number ?? d._id, kind: a.kind, storageId: a.storageId, sha256: a.sha256 });
    }
  }
  // F05 receivable letters and F06 supplier correction letters addressed to the person (PDFs into belege/)
  const letters = await receivableLettersOfContact(ctx, contactId);
  for (const l of letters) {
    artifacts.push({
      number: `${l.title}-${l.date}`,
      kind: "letter_pdf",
      storageId: l.file.storageId,
      sha256: l.file.sha256,
    });
  }
  const corrections = await correctionLettersOfContact(ctx, contactId);
  for (const a of corrections) {
    artifacts.push({ number: a.name.replace(/\.pdf$/i, ""), kind: a.kind, storageId: a.storageId, sha256: a.sha256 });
  }
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const vatChecks = await ctx.db
    .query("vatIdChecks")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
  const audit = (
    await ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) => q.eq("entity.table", "contacts").eq("entity.id", contactId))
      .collect()
  ).map((e) => ({ seq: e.seq, at: e.at, action: e.action, actor: e.actor, entity: e.entity, hash: e.hash }));
  return {
    kind: r.kind,
    subject: contact.displayName,
    contact,
    addresses,
    channels,
    activities,
    customerPrices,
    documents: documents.map((d) => ({
      id: d._id,
      type: d.type,
      number: d.number ?? null,
      status: d.status,
      documentDate: d.documentDate ?? null,
      totals: d.totals ?? null,
      openAmountCents: d.openAmountCents ?? null,
    })),
    artifacts,
    payments: payments.map((p) => ({ id: p._id, date: p.date, amountCents: p.amountCents, number: p.number ?? null })),
    vatChecks: vatChecks.map((v) => ({ id: v._id, vatId: v.vatId, checkedAt: v.checkedAt, status: v.status })),
    letters: [
      ...letters.map((l) => ({
        id: l._id,
        kind: l.kind as string,
        date: l.date,
        title: l.title,
        subject: l.subject,
        sentOn: l.sent?.sentOn ?? null,
      })),
      ...corrections.map((a) => ({
        id: a._id,
        kind: a.kind as string,
        date: berlinCalendarDate(a.createdAt) as string,
        title: "Bitte um Rechnungskorrektur",
        subject: a.name,
        sentOn: null,
      })),
    ],
    audit,
  };
}

export async function recordAccessExport(ctx: ModelCtx, requestId: Id<"dsgvoRequests">, storageId: Id<"_storage">) {
  await auditedPatch(ctx, "dsgvoRequests", requestId, { resultStorageId: storageId }, { action: "dsgvo.export" });
}
