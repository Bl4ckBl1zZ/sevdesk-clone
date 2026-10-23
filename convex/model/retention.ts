import { canonicalize } from "../../src/domain/audit/canonical";
import { sha256Hex } from "../../src/domain/audit/chain";
import {
  auditPrefixEnd,
  auditRetentionUntil,
  checkPurgeRequest,
  type EligibleGroup,
  groupEligible,
  isPurgeEligible,
  PURGE_MESSAGES,
  type RetainedRecord,
} from "../../src/domain/privacy/purge";
import { isRetained, type RetentionClass, retentionUntilFor } from "../../src/domain/rules/retention";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit, auditedInsert, auditedPatch } from "./audit";
import { shredContactKey } from "./contactKeys";
import { createJob } from "./jobs";
import { notifyKind } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Retention engine (F12 PRV-003…PRV-009, GOBD-21, F02 CON-163, EC-181). Nothing is purged automatically:
 *
 *  - `scanRetention` (monthly cron) lists purge-eligible records grouped by class and year and notifies the owner;
 *  - the owner starts a batch in the purge wizard (Ablaufhemmung checklist + „ENDGÜLTIG LÖSCHEN"), never via API/MCP;
 *  - `purgeStep` replaces each record (with its children and files) by a `purgeTombstones` row — the guarded db
 *    (model/db.ts) allows a protected delete only with a tombstone in the same transaction and after the retention;
 *  - contacts are anonymised (key shredded, personal fields removed) only once no record referencing them is still
 *    retained (PRV-007); journal lines then lose the contact link;
 *  - the audit log is purged only as a prefix behind a signed chain anchor (PRV-008);
 *  - audit entries of a purge carry ids, counts and hashes only — never personal content (PRV-006).
 */

export type PurgeClass = Exclude<RetentionClass, "none"> | "auditLog" | "contacts";
export const PURGE_CLASSES: readonly PurgeClass[] = ["books10", "vouchers8", "letters6", "auditLog", "contacts"];

export const PURGE_CLASS_LABEL_DE: Readonly<Record<PurgeClass, string>> = {
  books10: "Bücher und Aufzeichnungen (10 Jahre)",
  vouchers8: "Buchungsbelege (8 Jahre)",
  letters6: "Handels- und Geschäftsbriefe (6 Jahre)",
  auditLog: "Änderungsprotokoll (10 Jahre, nur als Anfangsstück)",
  contacts: "Kontakte mit Löschantrag (Anonymisierung)",
};

interface UnitDef {
  table: TableNames;
  cls: Exclude<RetentionClass, "none">;
  until: (doc: Record<string, unknown>, today: CalendarDate) => string | undefined;
  label: (doc: Record<string, unknown>) => string;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const computed =
  (cls: Exclude<RetentionClass, "none">, field: string) => (doc: Record<string, unknown>, today: CalendarDate) => {
    const trigger = str(doc[field]);
    return trigger ? (retentionUntilFor(cls, trigger, today > trigger ? today : trigger) ?? undefined) : undefined;
  };

/** Purgeable root records (children and files follow their root, see `childrenOf`). */
export const PURGE_UNITS: readonly UnitDef[] = [
  {
    table: "salesDocuments",
    cls: "vouchers8",
    until: (d) => (d.status === "draft" ? undefined : str(d.retentionUntil)),
    label: (d) => str(d.number) ?? "Dokument",
  },
  {
    table: "vouchers",
    cls: "vouchers8",
    until: (d) => str(d.retentionUntil),
    label: (d) => str(d.internalNumber) ?? "Beleg",
  },
  {
    table: "payments",
    cls: "vouchers8",
    until: computed("vouchers8", "date"),
    label: (d) => `Zahlung ${str(d.number) ?? ""}`.trim(),
  },
  {
    table: "bankTransactions",
    cls: "vouchers8",
    until: computed("vouchers8", "bookingDate"),
    label: (d) => `Bankumsatz ${str(d.bookingDate) ?? ""}`,
  },
  { table: "bankStatements", cls: "vouchers8", until: (d) => str(d.retentionUntil), label: () => "Kontoauszug" },
  {
    table: "journalEntries",
    cls: "books10",
    until: computed("books10", "date"),
    label: (d) => `Buchung ${String(d.seq ?? "")}`,
  },
  { table: "vatIdChecks", cls: "books10", until: (d) => str(d.retentionUntil), label: () => "USt-IdNr.-Prüfung" },
  // F05 PAY-005/048, DUN-028/044: archived account statements, payment confirmations, interest claims and
  // Mahnbescheid sheets are business correspondence (Handels- und Geschäftsbriefe, 6 years from the letter date).
  {
    table: "receivableLetters",
    cls: "letters6",
    until: computed("letters6", "date"),
    label: (d) => `${str(d.title) ?? "Schreiben"} ${str(d.date) ?? ""}`.trim(),
  },
  // F06 INB-046: the archived „Bitte um Rechnungskorrektur“ letter (owner = the inbox item, not a document); the
  // artifacts of documents are purged with their document (children).
  {
    table: "documentArtifacts",
    cls: "letters6",
    until: (d) => (d.kind === "supplier_correction_letter" ? str(d.retentionUntil) : undefined),
    label: (d) => str(d.name) ?? "Korrekturschreiben",
  },
];

export interface PurgeUnit extends RetainedRecord {
  label: string;
}

const today = (ctx: { now: () => number }) => berlinCalendarDate(ctx.now());

/** Every root record with its retention end (eligible or not); the purge scan filters by date. */
async function allUnits(ctx: ReadCtx, day: CalendarDate): Promise<PurgeUnit[]> {
  const out: PurgeUnit[] = [];
  for (const def of PURGE_UNITS) {
    for (const doc of (await ctx.db.query(def.table).collect()) as unknown as Record<string, unknown>[]) {
      const until = def.until(doc, day);
      if (!until) continue;
      out.push({
        table: def.table,
        id: String(doc._id),
        retentionClass: def.cls,
        retentionUntil: until,
        label: def.label(doc),
      });
    }
  }
  return out;
}

export async function activeHold(ctx: ReadCtx): Promise<Doc<"retentionHolds"> | null> {
  return ctx.db
    .query("retentionHolds")
    .withIndex("by_endedAt", (q) => q.eq("endedAt", undefined))
    .first();
}

/** Contacts with a deletion request whose purge date has come and that no retained record references any more. */
async function dueContacts(ctx: ReadCtx, day: CalendarDate): Promise<PurgeUnit[]> {
  const out: PurgeUnit[] = [];
  for (const c of await ctx.db.query("contacts").collect()) {
    const due = c.dsgvo?.scheduledPurgeAt;
    if (!c.dsgvo?.deletionRequestedAt || !due || due > day) continue;
    if (await isAnonymised(ctx, c._id)) continue;
    const refs = await contactReferences(ctx, c._id, day);
    if (refs.some((r) => isRetained(r.retentionUntil, day))) continue;
    const until =
      refs
        .map((r) => r.retentionUntil)
        .sort()
        .at(-1) ?? day;
    out.push({ table: "contacts", id: c._id, retentionClass: "books10", retentionUntil: until, label: c.number });
  }
  return out;
}

async function isAnonymised(ctx: ReadCtx, contactId: string): Promise<boolean> {
  return (
    (await ctx.db
      .query("purgeTombstones")
      .withIndex("by_record", (q) => q.eq("table", "contacts").eq("recordId", contactId))
      .first()) !== null
  );
}

export interface ContactReference extends PurgeUnit {
  kind: string;
}

/**
 * Records referencing a contact that carry a retention duty (PRV-007, CON-162): finalised documents, vouchers,
 * payments, journal lines, VAT-ID checks, opening items. Drafts are not retained (deletable).
 */
export async function contactReferences(ctx: ReadCtx, contactId: Id<"contacts">, day: CalendarDate) {
  const out: ContactReference[] = [];
  const push = (
    kind: string,
    table: string,
    id: string,
    cls: Exclude<RetentionClass, "none">,
    until: string | undefined | null,
    label: string,
  ) => {
    if (until) out.push({ kind, table, id, retentionClass: cls, retentionUntil: until, label });
  };
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (d.status === "draft") continue;
    push("salesDocument", "salesDocuments", d._id, "vouchers8", d.retentionUntil, d.number ?? "Dokument");
  }
  for (const v of await ctx.db
    .query("vouchers")
    .withIndex("by_supplier_documentNumber", (q) => q.eq("supplierContactId", contactId))
    .collect()) {
    if (v.status === "draft") continue;
    push("voucher", "vouchers", v._id, "vouchers8", v.retentionUntil, v.internalNumber ?? "Beleg");
  }
  for (const p of await ctx.db
    .query("payments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    push(
      "payment",
      "payments",
      p._id,
      "vouchers8",
      retentionUntilFor("vouchers8", p.date, day > p.date ? day : p.date),
      `Zahlung ${p.number ?? ""}`.trim(),
    );
  }
  const seen = new Set<string>();
  for (const l of await ctx.db
    .query("journalLines")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (seen.has(l.entryId)) continue;
    seen.add(l.entryId);
    push(
      "journalEntry",
      "journalEntries",
      l.entryId,
      "books10",
      retentionUntilFor("books10", l.date, day > l.date ? day : l.date),
      `Buchung ${l.seq}`,
    );
  }
  for (const c of await ctx.db
    .query("vatIdChecks")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    push("vatIdCheck", "vatIdChecks", c._id, "books10", c.retentionUntil, "USt-IdNr.-Prüfung");
  }
  for (const o of await ctx.db
    .query("openingItems")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    push("openingItem", "openingItems", o._id, "books10", `${o.fiscalYear + 10}-12-31`, `Eröffnungsposten ${o.number}`);
  }
  for (const l of await receivableLettersOfContact(ctx, contactId)) {
    push(
      "receivableLetter",
      "receivableLetters",
      l._id,
      "letters6",
      retentionUntilFor("letters6", l.date, day > l.date ? day : l.date),
      `${l.title} ${l.date}`,
    );
  }
  for (const a of await correctionLettersOfContact(ctx, contactId)) {
    push("correctionLetter", "documentArtifacts", a._id, "letters6", a.retentionUntil, a.name);
  }
  // F08 manual journal entries naming the contact on a line (books10 from the entry date)
  for (const m of await ctx.db.query("manualEntries").collect()) {
    if (!m.lines.some((l) => l.contactId === contactId)) continue;
    const until = retentionUntilFor("books10", m.date, day > m.date ? day : m.date);
    if (until) push("manualEntry", "manualEntries", m._id, "books10", until, `Buchung ${m.date} ${m.text}`);
  }
  // F11 invoiced time entries are part of the invoice basis (vouchers8, retentionUntil set when invoiced)
  for (const e of await ctx.db
    .query("timeEntries")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    if (e.retentionClass === "vouchers8" && e.retentionUntil) {
      push("timeEntry", "timeEntries", e._id, "vouchers8", e.retentionUntil, `Zeiteintrag ${e.date}`);
    }
  }
  return out;
}

/**
 * F05 receivable letters addressed to the contact: linked directly or through one of its documents (a payment
 * confirmation may carry only the document link).
 */
export async function receivableLettersOfContact(
  ctx: ReadCtx,
  contactId: Id<"contacts">,
): Promise<Doc<"receivableLetters">[]> {
  const byId = new Map<string, Doc<"receivableLetters">>();
  for (const l of await ctx.db
    .query("receivableLetters")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    byId.set(l._id, l);
  }
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect()) {
    for (const l of await ctx.db
      .query("receivableLetters")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .collect()) {
      byId.set(l._id, l);
    }
  }
  return [...byId.values()];
}

/**
 * F06 INB-046 supplier correction letters to the contact: the inbox item matched the supplier contact or was
 * converted into a voucher of that supplier.
 */
export async function correctionLettersOfContact(
  ctx: ReadCtx,
  contactId: Id<"contacts">,
): Promise<Doc<"documentArtifacts">[]> {
  const out: Doc<"documentArtifacts">[] = [];
  for (const a of await ctx.db.query("documentArtifacts").collect()) {
    if (a.kind !== "supplier_correction_letter" || !a.inboxItemId) continue;
    const item = await ctx.db.get(a.inboxItemId);
    if (!item) continue;
    const voucher = item.voucherId ? await ctx.db.get(item.voucherId) : null;
    if (item.supplierMatch?.contactId === contactId || voucher?.supplierContactId === contactId) out.push(a);
  }
  return out;
}

// ── scan + worklist (PRV-003, CON-163) ─────────────────────────────────────────────────────────────────

export interface RetentionWorklist {
  today: string;
  groups: EligibleGroup[];
  auditPrefix: { upToSeq: number; count: number };
  contacts: { id: string; number: string; scheduledPurgeAt: string | null; blockedBy: number }[];
  hold: { reason: string; fiscalYears: number[]; activeFrom: number } | null;
  total: number;
}

async function auditPrefix(ctx: ReadCtx, day: CalendarDate) {
  const first = await ctx.db.query("auditLog").withIndex("by_seq").order("asc").take(2000);
  const upToSeq = auditPrefixEnd(first, day);
  return { upToSeq, count: upToSeq === 0 ? 0 : first.filter((e) => e.seq <= upToSeq).length };
}

export async function retentionWorklist(ctx: ReadCtx & { now: () => number }): Promise<RetentionWorklist> {
  const day = today(ctx);
  const groups = groupEligible(await allUnits(ctx, day), day);
  const prefix = await auditPrefix(ctx, day);
  const contacts: RetentionWorklist["contacts"] = [];
  for (const c of await ctx.db.query("contacts").collect()) {
    if (!c.dsgvo?.deletionRequestedAt || (await isAnonymised(ctx, c._id))) continue;
    const refs = await contactReferences(ctx, c._id, day);
    contacts.push({
      id: c._id,
      number: c.number,
      scheduledPurgeAt: c.dsgvo.scheduledPurgeAt ?? null,
      blockedBy: refs.filter((r) => isRetained(r.retentionUntil, day)).length,
    });
  }
  const hold = await activeHold(ctx);
  const dueContactCount = contacts.filter(
    (c) => c.blockedBy === 0 && c.scheduledPurgeAt && c.scheduledPurgeAt <= day,
  ).length;
  return {
    today: day,
    groups,
    auditPrefix: prefix,
    contacts,
    hold: hold ? { reason: hold.reason, fiscalYears: hold.fiscalYears, activeFrom: hold.activeFrom } : null,
    total: groups.reduce((s, g) => s + g.count, 0) + prefix.count + dueContactCount,
  };
}

/** PRV-003: monthly scan → notification „{n} Datensätze können gelöscht werden" (purge itself stays manual). */
export async function scanRetention(ctx: ModelCtx): Promise<number> {
  const w = await retentionWorklist(ctx);
  await appendAudit(ctx, {
    action: "retention.scan",
    entity: { table: "purgeBatches", id: "scan", label: w.today },
    diff: { after: { eligible: w.total, groups: w.groups.length } },
  });
  if (w.total > 0) {
    await notifyKind(ctx, "retention.purge_eligible", {
      title: `${w.total} Datensätze können gelöscht werden`,
      body: "Die Aufbewahrungsfrist ist abgelaufen. Die Löschung erfolgt nur manuell (Einstellungen › Datenschutz › Aufbewahrung).",
      link: "/einstellungen/datenschutz?tab=aufbewahrung",
      dedupeKey: `retention.purge_eligible|${w.today.slice(0, 7)}`,
    });
  }
  return w.total;
}

// ── Betriebsprüfung-Modus (PRV-004) ────────────────────────────────────────────────────────────────────

export async function startHold(ctx: ModelCtx, input: { reason: string; fiscalYears: number[] }) {
  if (!input.reason.trim())
    throw appError("invalid_input", "Bitte geben Sie den Grund an (z. B. Prüfungsanordnung vom …).");
  if (await activeHold(ctx)) throw appError("conflict", "Der Betriebsprüfung-Modus ist bereits aktiv.");
  return auditedInsert(
    ctx,
    "retentionHolds",
    {
      reason: input.reason.trim().slice(0, 500),
      fiscalYears: [...new Set(input.fiscalYears)].sort((a, b) => a - b),
      activeFrom: ctx.now(),
      actor: ctx.actor,
    },
    { action: "retention.hold", label: "Betriebsprüfung-Modus" },
  );
}

export async function endHold(ctx: ModelCtx, reason: string) {
  const hold = await activeHold(ctx);
  if (!hold) throw appError("conflict", "Der Betriebsprüfung-Modus ist nicht aktiv.");
  if (!reason.trim()) throw appError("invalid_input", "Bitte geben Sie den Grund für das Beenden an.");
  await auditedPatch(
    ctx,
    "retentionHolds",
    hold._id,
    { endedAt: ctx.now(), endReason: reason.trim().slice(0, 500) },
    { action: "retention.hold_end", label: "Betriebsprüfung-Modus", reason: reason.trim() },
  );
}

// ── preview + batch (PRV-005) ──────────────────────────────────────────────────────────────────────────

export interface PurgeSelection {
  classes: PurgeClass[];
  /** Years in which the retention ended; empty = every eligible year. */
  years: number[];
}

const selected = (sel: PurgeSelection, u: PurgeUnit) =>
  sel.classes.includes(u.table === "contacts" ? "contacts" : u.retentionClass) &&
  (sel.years.length === 0 || sel.years.includes(Number(u.retentionUntil.slice(0, 4))));

export async function selectedUnits(ctx: ReadCtx, day: CalendarDate, sel: PurgeSelection): Promise<PurgeUnit[]> {
  const units = (await allUnits(ctx, day)).filter((u) => isPurgeEligible(u.retentionUntil, day) && selected(sel, u));
  if (sel.classes.includes("contacts")) units.push(...(await dueContacts(ctx, day)));
  return units;
}

export async function purgePreview(ctx: ReadCtx & { now: () => number }, sel: PurgeSelection) {
  const day = today(ctx);
  const units = await selectedUnits(ctx, day, sel);
  const files = (await Promise.all(units.map((u) => filesOf(ctx, u)))).flat();
  const prefix = sel.classes.includes("auditLog") ? await auditPrefix(ctx, day) : { upToSeq: 0, count: 0 };
  const counts: Record<string, number> = {};
  for (const u of units) counts[u.table] = (counts[u.table] ?? 0) + 1;
  if (prefix.count > 0) counts.auditLog = prefix.count;
  return {
    today: day,
    counts,
    total: units.length + prefix.count,
    files: files.length,
    auditPrefixUpTo: prefix.upToSeq,
    examples: units.slice(0, 10).map((u) => ({ table: u.table, label: u.label, retentionUntil: u.retentionUntil })),
    holdActive: (await activeHold(ctx)) !== null,
  };
}

/** PRV-005: owner UI only (E-PRV-05). Validates the checklist and phrase, then creates the batch + job. */
export async function createPurgeBatch(
  ctx: ModelCtx,
  input: PurgeSelection & { checklist: Record<string, boolean>; phrase: string },
): Promise<{ batchId: Id<"purgeBatches">; jobId: Id<"jobs"> }> {
  if (ctx.actorContext.channel !== "ui") throw appError("forbidden_scope", PURGE_MESSAGES.apiForbidden);
  const issues = checkPurgeRequest({
    checklist: input.checklist,
    phrase: input.phrase,
    holdActive: (await activeHold(ctx)) !== null,
  });
  if (issues.length > 0) throw appError("invalid_input", issues[0], { reason: "PURGE_REFUSED" });
  const preview = await purgePreview(ctx, input);
  if (preview.total === 0) throw appError("invalid_input", PURGE_MESSAGES.nothing);
  const batchId = await auditedInsert(
    ctx,
    "purgeBatches",
    {
      createdAt: ctx.now(),
      actor: ctx.actor,
      classes: input.classes,
      years: input.years,
      checklist: input.checklist,
      status: "running",
      counts: {},
    },
    { action: "retention.batch", label: `Löschlauf ${preview.today}` },
  );
  const jobId = await createJob(ctx, {
    kind: "purge",
    label: `Löschlauf ${preview.today}`,
    params: { batchId, classes: input.classes, years: input.years },
    total: preview.total,
  });
  return { batchId, jobId };
}

// ── purge step (PRV-006, PRV-007) ──────────────────────────────────────────────────────────────────────

interface Row {
  table: string;
  id: string;
  doc: Record<string, unknown>;
}

async function childrenOf(ctx: ReadCtx, u: PurgeUnit): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (table: string, docs: readonly { _id: string }[]) => {
    for (const d of docs) rows.push({ table, id: d._id, doc: d as unknown as Record<string, unknown> });
  };
  if (u.table === "salesDocuments") {
    const id = u.id as Id<"salesDocuments">;
    add(
      "documentLines",
      await ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    add(
      "documentSnapshots",
      await ctx.db
        .query("documentSnapshots")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    add(
      "documentArtifacts",
      await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    add(
      "sendLog",
      await ctx.db
        .query("sendLog")
        .withIndex("by_document_at", (q) => q.eq("documentId", id))
        .collect(),
    );
  } else if (u.table === "vouchers") {
    const id = u.id as Id<"vouchers">;
    add(
      "voucherLines",
      await ctx.db
        .query("voucherLines")
        .withIndex("by_voucher", (q) => q.eq("voucherId", id))
        .collect(),
    );
    add(
      "voucherFileHashes",
      await ctx.db
        .query("voucherFileHashes")
        .withIndex("by_voucher", (q) => q.eq("voucherId", id))
        .collect(),
    );
  } else if (u.table === "journalEntries") {
    const id = u.id as Id<"journalEntries">;
    add(
      "journalLines",
      await ctx.db
        .query("journalLines")
        .withIndex("by_entry", (q) => q.eq("entryId", id))
        .collect(),
    );
  } else if (u.table === "bankTransactions") {
    const id = u.id as Id<"bankTransactions">;
    add(
      "bankTransactionRevisions",
      await ctx.db
        .query("bankTransactionRevisions")
        .withIndex("by_transaction", (q) => q.eq("transactionId", id))
        .collect(),
    );
  }
  return rows;
}

const storageOf = (doc: Record<string, unknown>): string[] => {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.storageId === "string") out.push(o.storageId);
      for (const [k, x] of Object.entries(o)) if (k !== "storageId") visit(x);
    }
  };
  visit(doc);
  return out;
};

async function filesOf(ctx: ReadCtx, u: PurgeUnit): Promise<string[]> {
  if (u.table === "contacts") return [];
  const root = await ctx.db.get(u.id as Id<"salesDocuments">);
  const rows = [
    ...(root ? [root as unknown as Record<string, unknown>] : []),
    ...(await childrenOf(ctx, u)).map((r) => r.doc),
  ];
  return [...new Set(rows.flatMap(storageOf))];
}

const contentHash = async (doc: Record<string, unknown>) => sha256Hex(canonicalize(doc));

async function tombstone(ctx: ModelCtx, batchId: Id<"purgeBatches">, r: Row, u: PurgeUnit, label?: string) {
  await auditedInsert(
    ctx,
    "purgeTombstones",
    {
      table: r.table,
      recordId: r.id,
      retentionClass: u.retentionClass,
      retentionUntil: u.retentionUntil,
      contentSha256: await contentHash(r.doc),
      batchId,
      purgedAt: ctx.now(),
      ...(label ? { label } : {}),
      ...(r.table === "journalEntries" && typeof r.doc.seq === "number" ? { seq: r.doc.seq } : {}),
    },
    { action: "retention.purge", label: `${r.table}:${r.id}` },
  );
}

/** Deletes a sub-record without its content in the audit log (DSGVO: hash only, E-PRV-18). */
export async function deleteHashed(ctx: ModelCtx, table: TableNames, id: string, action: string, label?: string) {
  const doc = (await ctx.db.get(id as Id<TableNames>)) as unknown as Record<string, unknown> | null;
  if (!doc) return;
  await ctx.db.delete(table, id as Id<TableNames>);
  const { _id, _creationTime, ...rest } = doc;
  await appendAudit(ctx, {
    action,
    entity: { table, id, ...(label ? { label } : {}) },
    diff: { before: { contentSha256: await contentHash(rest) } },
  });
}

/** Deletes one root record with children and files, leaving tombstones. Returns the number of rows removed. */
async function purgeUnit(ctx: ModelCtx, batchId: Id<"purgeBatches">, u: PurgeUnit): Promise<number> {
  const root = (await ctx.db.get(u.id as Id<"salesDocuments">)) as unknown as Record<string, unknown> | null;
  if (!root) return 0;
  const rows = [...(await childrenOf(ctx, u)), { table: u.table, id: u.id, doc: root }];
  const files = new Set(rows.flatMap((r) => storageOf(r.doc)));
  for (const r of rows) {
    await tombstone(ctx, batchId, r, u);
    await ctx.db.delete(r.table as TableNames, r.id as Id<TableNames>);
  }
  for (const f of files) {
    try {
      await ctx.storage.delete(f as Id<"_storage">);
    } catch {
      // already gone (shared file) — the tombstone keeps the hash
    }
  }
  return rows.length;
}

/** CON-163 / PRV-007: anonymise a contact (tombstone with number, key shredded, personal data removed). */
async function anonymiseContact(ctx: ModelCtx, batchId: Id<"purgeBatches">, u: PurgeUnit): Promise<number> {
  const id = u.id as Id<"contacts">;
  const c = await ctx.db.get(id);
  if (!c) return 0;
  await tombstone(ctx, batchId, { table: "contacts", id, doc: c as unknown as Record<string, unknown> }, u, c.number);
  let n = 1;
  const subTables = [
    "contactAddresses",
    "contactChannels",
    "contactActivities",
    "customerPrices",
    "contactAliases", // BNK-048 learned counterparty name token / IBAN
  ] as const;
  for (const t of subTables) {
    for (const row of await ctx.db
      .query(t)
      .withIndex("by_contact", (q) => q.eq("contactId", id))
      .collect()) {
      await deleteHashed(ctx, t, row._id, "retention.anonymise", c.number);
      n++;
    }
  }
  const name = `Gelöschter Kontakt ${c.number}`;
  await auditedPatch(
    ctx,
    "contacts",
    id,
    {
      displayName: name,
      searchText: c.number.toLowerCase(),
      organizationName: c.kind === "organization" ? name : undefined,
      organizationName2: undefined,
      salutation: undefined,
      academicTitle: undefined,
      firstName: undefined,
      lastName: c.kind === "person" ? name : undefined,
      position: undefined,
      birthday: undefined,
      vatId: undefined,
      vatIdStatus: undefined,
      taxNumber: undefined,
      registerNumber: undefined,
      buyerReference: undefined,
      electronicAddress: undefined,
      iban: undefined,
      bic: undefined,
      notes: undefined,
      tags: [],
      customFields: {},
      reverseCharge13bCertificates: [],
      einvoice: { preferredFormat: c.einvoice.preferredFormat, pdfConsents: [] },
      status: "archived",
      version: c.version + 1,
    },
    { action: "retention.anonymise", label: c.number },
  );
  // Crypto-shredding after the patch: the personal fields of every earlier audit diff become unreadable (CON-163).
  await shredContactKey(ctx, id);
  // PRV-007: remaining (expired, not yet purged) journal lines lose the contact link; account, amount, text stay.
  for (const l of await ctx.db
    .query("journalLines")
    .withIndex("by_contact", (q) => q.eq("contactId", id))
    .collect()) {
    await ctx.db.patch("journalLines", l._id, { contactId: undefined });
    const e = await ctx.db.get(l.entryId);
    if (e?.lines.some((x) => x.contactId === id)) {
      await auditedPatch(
        ctx,
        "journalEntries",
        e._id,
        {
          lines: e.lines.map((x) => {
            if (x.contactId !== id) return x;
            const { contactId: _c, ...rest } = x;
            return rest;
          }),
        },
        { action: "retention.anonymise", label: `Buchung ${e.seq}` },
      );
    }
  }
  return n;
}

/**
 * One purge batch step: up to `limit` root records (or contacts). Returns `done` once nothing selected is left.
 * One `retention.purge` audit entry per step (ids, counts, no content).
 */
export async function purgeStep(
  ctx: ModelCtx,
  batchId: Id<"purgeBatches">,
  limit = 25,
): Promise<{ done: boolean; processed: number }> {
  const batch = await ctx.db.get(batchId);
  if (batch?.status !== "running") return { done: true, processed: 0 };
  if (await activeHold(ctx)) throw appError("conflict", PURGE_MESSAGES.hold);
  const day = today(ctx);
  const units = (await selectedUnits(ctx, day, { classes: batch.classes as PurgeClass[], years: batch.years })).slice(
    0,
    limit,
  );
  const counts: Record<string, number> = { ...batch.counts };
  const ids: string[] = [];
  for (const u of units) {
    const n = u.table === "contacts" ? await anonymiseContact(ctx, batchId, u) : await purgeUnit(ctx, batchId, u);
    counts[u.table] = (counts[u.table] ?? 0) + 1;
    counts.rows = (counts.rows ?? 0) + n;
    ids.push(`${u.table}:${u.id}`);
  }
  if (units.length > 0) {
    await auditedPatch(
      ctx,
      "purgeBatches",
      batchId,
      { counts },
      {
        action: "retention.batch",
        label: `Löschlauf ${day}`,
        reason: `${ids.length} Datensätze nach Ablauf der Aufbewahrungsfrist gelöscht (Ablaufhemmung verneint)`,
      },
    );
  }
  return { done: units.length < limit, processed: units.length };
}

// ── audit-log prefix (PRV-008) ─────────────────────────────────────────────────────────────────────────

export async function auditPrefixCandidate(ctx: ReadCtx & { now: () => number }, batchId: Id<"purgeBatches">) {
  const batch = await ctx.db.get(batchId);
  if (batch?.status !== "running" || !batch.classes.includes("auditLog")) return null;
  const { upToSeq } = await auditPrefix(ctx, today(ctx));
  if (upToSeq === 0) return null;
  const entry = await ctx.db
    .query("auditLog")
    .withIndex("by_seq", (q) => q.eq("seq", upToSeq))
    .unique();
  return entry ? { seq: upToSeq, hash: entry.hash, at: entry.at } : null;
}

export async function insertAnchor(
  ctx: ModelCtx,
  input: { batchId: Id<"purgeBatches">; seq: number; hash: string; jws: string; entryAt?: number; exportedTo?: string },
) {
  const existing = await ctx.db
    .query("chainAnchors")
    .withIndex("by_seq", (q) => q.eq("seq", input.seq))
    .first();
  if (existing) return existing._id;
  return auditedInsert(
    ctx,
    "chainAnchors",
    {
      seq: input.seq,
      hash: input.hash,
      jws: input.jws,
      createdAt: ctx.now(),
      purgeBatchId: input.batchId,
      ...(input.entryAt !== undefined ? { entryAt: input.entryAt } : {}),
      ...(input.exportedTo ? { exportedTo: input.exportedTo } : {}),
    },
    { action: "retention.anchor", label: `Ankerpunkt seq ${input.seq}` },
  );
}

/** Deletes up to `limit` audit entries with `seq ≤` the latest anchor (oldest first), each with a tombstone. */
export async function purgeAuditPrefixStep(ctx: ModelCtx, batchId: Id<"purgeBatches">, limit = 200) {
  const anchor = await ctx.db.query("chainAnchors").withIndex("by_seq").order("desc").first();
  if (!anchor) return { done: true, processed: 0 };
  const rows = await ctx.db
    .query("auditLog")
    .withIndex("by_seq", (q) => q.lte("seq", anchor.seq))
    .order("asc")
    .take(limit);
  for (const e of rows) await ctx.db.delete("auditLog", e._id);
  if (rows.length > 0) {
    const first = rows[0] as Doc<"auditLog">;
    const last = rows.at(-1) as Doc<"auditLog">;
    await auditedInsert(
      ctx,
      "purgeTombstones",
      {
        table: "auditLog",
        recordId: `${first.seq}-${last.seq}`,
        retentionClass: "books10",
        retentionUntil: auditRetentionUntil(last.at),
        contentSha256: last.hash,
        batchId,
        purgedAt: ctx.now(),
        label: `Protokoll seq ${first.seq}–${last.seq} (Ankerpunkt seq ${anchor.seq})`,
      },
      { action: "retention.purge", label: `auditLog:${first.seq}-${last.seq}` },
    );
    const batch = await ctx.db.get(batchId);
    const counts = { ...(batch?.counts ?? {}) };
    counts.auditLog = (counts.auditLog ?? 0) + rows.length;
    await auditedPatch(
      ctx,
      "purgeBatches",
      batchId,
      { counts },
      { action: "retention.batch", label: "Protokoll-Anfangsstück" },
    );
  }
  return { done: rows.length < limit, processed: rows.length };
}

// ── finish + off-host log (PRV-006) ────────────────────────────────────────────────────────────────────

export const purgeLogKey = (batchId: string) => `purges/${batchId}.json`;
export const PURGE_INDEX_KEY = "purges/index.json";

export interface PurgeLog {
  format: "rechnungen-purge-log/1";
  batch: {
    id: string;
    createdAt: number;
    actor: string;
    classes: string[];
    years: number[];
    checklist: Record<string, boolean>;
    replayOf?: string;
  };
  tombstones: {
    table: string;
    recordId: string;
    retentionClass: string;
    retentionUntil: string;
    contentSha256: string;
    purgedAt: number;
  }[];
  anchors: { seq: number; hash: string; jws: string; entryAt?: number }[];
}

export async function purgeLog(ctx: ReadCtx, batchId: Id<"purgeBatches">): Promise<PurgeLog | null> {
  const b = await ctx.db.get(batchId);
  if (!b) return null;
  const tombstones = await ctx.db
    .query("purgeTombstones")
    .withIndex("by_batch", (q) => q.eq("batchId", batchId))
    .collect();
  const anchors = (await ctx.db.query("chainAnchors").collect()).filter((a) => a.purgeBatchId === batchId);
  return {
    format: "rechnungen-purge-log/1",
    batch: {
      id: b._id,
      createdAt: b.createdAt,
      actor: b.actor,
      classes: b.classes,
      years: b.years,
      checklist: b.checklist,
      ...(b.replayOf ? { replayOf: b.replayOf } : {}),
    },
    tombstones: tombstones.map((t) => ({
      table: t.table,
      recordId: t.recordId,
      retentionClass: t.retentionClass,
      retentionUntil: t.retentionUntil,
      contentSha256: t.contentSha256,
      purgedAt: t.purgedAt,
    })),
    anchors: anchors.map((a) => ({
      seq: a.seq,
      hash: a.hash,
      jws: a.jws,
      ...(a.entryAt !== undefined ? { entryAt: a.entryAt } : {}),
    })),
  };
}

export async function finishPurgeBatch(
  ctx: ModelCtx,
  batchId: Id<"purgeBatches">,
  result: { ok: boolean; offHostLogKey?: string; error?: string },
) {
  const b = await ctx.db.get(batchId);
  if (b?.status !== "running") return;
  await auditedPatch(
    ctx,
    "purgeBatches",
    batchId,
    {
      status: result.ok ? "done" : "failed",
      finishedAt: ctx.now(),
      ...(result.offHostLogKey ? { offHostLogKey: result.offHostLogKey } : {}),
    },
    {
      action: "retention.batch",
      label: "Löschlauf beendet",
      ...(result.error ? { reason: result.error.slice(0, 300) } : {}),
    },
  );
}

export async function purgeHistory(ctx: ReadCtx) {
  return (await ctx.db.query("purgeBatches").withIndex("by_createdAt").order("desc").take(100)).map((b) => ({
    id: b._id,
    createdAt: b.createdAt,
    actor: b.actor,
    classes: b.classes,
    years: b.years,
    status: b.status,
    counts: b.counts,
    offHostLogKey: b.offHostLogKey ?? null,
    finishedAt: b.finishedAt ?? null,
    replayOf: b.replayOf ?? null,
  }));
}

// ── replay after restore (PRV-009, E-PRV-08) ───────────────────────────────────────────────────────────

export async function createReplayBatch(ctx: ModelCtx, log: PurgeLog): Promise<Id<"purgeBatches">> {
  return auditedInsert(
    ctx,
    "purgeBatches",
    {
      createdAt: ctx.now(),
      actor: ctx.actor,
      classes: log.batch.classes,
      years: log.batch.years,
      checklist: log.batch.checklist,
      status: "running",
      counts: {},
      replayOf: log.batch.id,
    },
    { action: "retention.replay", label: `Wiederholung Löschlauf ${log.batch.id}` },
  );
}

/** Re-applies a chunk of tombstones from an off-host purge log: records that reappeared (restore) are purged again. */
export async function replayChunk(
  ctx: ModelCtx,
  batchId: Id<"purgeBatches">,
  tombstones: PurgeLog["tombstones"],
  anchors: PurgeLog["anchors"],
): Promise<number> {
  let repurged = 0;
  for (const a of anchors) {
    await insertAnchor(ctx, {
      batchId,
      seq: a.seq,
      hash: a.hash,
      jws: a.jws,
      ...(a.entryAt !== undefined ? { entryAt: a.entryAt } : {}),
    });
    // the restored audit log may again hold the anchored prefix: remove it behind the (re-inserted) anchor
    for (const e of await ctx.db
      .query("auditLog")
      .withIndex("by_seq", (q) => q.lte("seq", a.seq))
      .take(500)) {
      await ctx.db.delete("auditLog", e._id);
      repurged++;
    }
  }
  for (const t of tombstones) {
    if (t.table === "auditLog") continue; // covered by the anchors above
    const id = ctx.db.normalizeId(t.table as TableNames, t.recordId);
    if (!id) continue;
    const doc = (await ctx.db.get(id)) as unknown as Record<string, unknown> | null;
    if (!doc) continue;
    const unit: PurgeUnit = {
      table: t.table,
      id: t.recordId,
      retentionClass: t.retentionClass as Exclude<RetentionClass, "none">,
      retentionUntil: t.retentionUntil,
      label: t.table,
    };
    if (t.table === "contacts") {
      if (!(await isAnonymised(ctx, t.recordId))) repurged += (await anonymiseContact(ctx, batchId, unit)) > 0 ? 1 : 0;
      continue;
    }
    await tombstone(ctx, batchId, { table: t.table, id: t.recordId, doc }, unit);
    await ctx.db.delete(t.table as TableNames, id);
    for (const f of storageOf(doc)) {
      try {
        await ctx.storage.delete(f as Id<"_storage">);
      } catch {
        // gone
      }
    }
    repurged++;
  }
  const b = await ctx.db.get(batchId);
  const counts = { ...(b?.counts ?? {}) };
  counts.repurged = (counts.repurged ?? 0) + repurged;
  counts.checked = (counts.checked ?? 0) + tombstones.length;
  await auditedPatch(
    ctx,
    "purgeBatches",
    batchId,
    { counts },
    { action: "retention.replay", label: "Löschlauf wiederholt" },
  );
  return repurged;
}

/** Message for E-PRV-08. */
export const replayMessage = (n: number) =>
  `${n} bereits gelöschte Datensätze aus der Sicherung wurden erneut gelöscht.`;
