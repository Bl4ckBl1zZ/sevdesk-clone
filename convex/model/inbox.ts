import type { Infer } from "convex/values";
import {
  canSplitOrMerge,
  MERGE_MAX,
  mergeFiles,
  SPLIT_MERGE_MESSAGES,
  splitFiles,
} from "../../src/domain/inbox/split-merge";
import {
  canOverrideDuplicate,
  canReject,
  INBOX_MESSAGES,
  type RejectReason,
  rejectRetention,
} from "../../src/domain/inbox/status";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import { allowedAccounts } from "../../src/domain/vouchers/accounts";
import { suggestAccount } from "../../src/domain/vouchers/suggest";
import { normaliseSupplierName, supplierKeys } from "../../src/domain/vouchers/supplier-key";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import type { vEinvoiceFinding, vInboxEinvoice, vInboxFile } from "../voucherValidators";
import { auditedInsert, auditedPatch } from "./audit";
import type { ActorContext, ModelCtx, ReadCtx } from "./types";
import {
  accountContextAt,
  createVoucher,
  type DraftInput,
  deleteVoucherDraft,
  type OriginalFileValue,
  type VoucherDoc,
} from "./vouchers";

/**
 * Receipt inbox (F06 §3.1–3.3, §4.1): capture, duplicate check, classification results → voucher draft, rejection.
 *
 *  storeInboxItem          INB-020 one mutation per capture: files with capture metadata, SHA-256 index, exact-hash
 *                          duplicate (VOU-050), e-mail-in R2 identity re-checked (INB-049, EC-INB-23)
 *  recordMailParse         INB-050 attachments of the .eml as original-derived files; Message-ID duplicate (EC-INB-24)
 *  finishClassification    INB-028 the draft (always) linked to the item; supplier match / proposal (INB-045)
 *  rejectInboxItem         INB-010, EC-INB-12 retention
 *  splitInboxItem /        INB-009 new items with copies of the file entries (same blob + hash); the sources stay
 *  mergeInboxItems         (`superseded`, linked both ways, audited)
 * The bytes are handled by the actions (convex/inbox.ts, convex/inboxNode.ts); this layer only writes rows.
 */

export type InboxItem = Doc<"inboxItems">;
export type InboxFileValue = Infer<typeof vInboxFile>;
export type InboxEinvoiceValue = Infer<typeof vInboxEinvoice>;
export type EinvoiceFinding = Infer<typeof vEinvoiceFinding>;

export interface NewInboxFile {
  storageId: Id<"_storage">;
  sha256: string;
  name: string;
  mime: string;
  bytes: number;
  pages?: number;
  clientCapturedAt?: number;
  role?: InboxFileValue["role"];
  derivedFrom?: number;
  image?: InboxFileValue["image"];
}

export interface InboxWarning {
  code: string;
  message: string;
  acknowledge?: boolean;
}

const label = (item: Pick<InboxItem, "subject" | "files">) => item.subject ?? item.files[0]?.name ?? "Beleg";

export async function requireInboxItem(ctx: ReadCtx, id: Id<"inboxItems">): Promise<InboxItem> {
  const item = await ctx.db.get(id);
  if (!item) throw appError("not_found", "Posteingangsbeleg nicht gefunden.");
  return item;
}

function toInboxFile(ctx: ModelCtx, f: NewInboxFile, source: InboxItem["source"], capturedAt: number): InboxFileValue {
  return {
    storageId: f.storageId,
    sha256: f.sha256,
    name: f.name,
    mime: f.mime,
    bytes: f.bytes,
    ...(f.pages !== undefined ? { pages: f.pages } : {}),
    role: f.role ?? (f.mime === "message/rfc822" ? "eml" : "original"),
    ...(f.derivedFrom !== undefined ? { derivedFrom: f.derivedFrom } : {}),
    capturedAt,
    ...(f.clientCapturedAt !== undefined ? { clientCapturedAt: f.clientCapturedAt } : {}),
    capturedBy: ctx.actor,
    capturedVia: source,
    ...(f.image ? { image: f.image } : {}),
  };
}

/** VOU-050: an identical SHA-256 on another inbox item or on a voucher original. */
async function exactDuplicate(
  ctx: ReadCtx,
  hashes: readonly string[],
  self?: Id<"inboxItems"> | ReadonlySet<Id<"inboxItems">>,
): Promise<{ inboxItemId?: Id<"inboxItems">; voucherId?: Id<"vouchers">; at: number } | null> {
  const isSelf = (id: Id<"inboxItems"> | undefined) =>
    id !== undefined && (typeof self === "string" ? id === self : (self?.has(id) ?? false));
  for (const h of hashes) {
    for (const row of await ctx.db
      .query("inboxFileHashes")
      .withIndex("by_sha256", (q) => q.eq("sha256", h))
      .collect()) {
      if (isSelf(row.inboxItemId)) continue;
      const other = await ctx.db.get(row.inboxItemId);
      if (other) return { inboxItemId: other._id, at: other.receivedAt };
    }
    for (const row of await ctx.db
      .query("voucherFileHashes")
      .withIndex("by_sha256", (q) => q.eq("sha256", h))
      .collect()) {
      const v = await ctx.db.get(row.voucherId);
      if (v && v.status !== "cancelled" && !isSelf(v.inboxItemId)) return { voucherId: v._id, at: v.receivedAt };
    }
  }
  return null;
}

const germanDateTime = (ms: number) =>
  new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(ms);

async function indexHashes(ctx: ModelCtx, id: Id<"inboxItems">, files: readonly InboxFileValue[], from: number) {
  for (let i = from; i < files.length; i++) {
    await auditedInsert(
      ctx,
      "inboxFileHashes",
      { sha256: (files[i] as InboxFileValue).sha256, inboxItemId: id, fileIndex: i },
      { action: "inbox.file_index" },
    );
  }
}

export function scheduleClassify(ctx: ModelCtx, id: Id<"inboxItems">, delayMs = 0, actorContext?: ActorContext) {
  return ctx.scheduler.runAfter(delayMs, internal.inboxNode.classify, {
    id,
    actorContext: actorContext ?? ctx.actorContext,
  });
}

/**
 * INB-020 / INB-049 step 3: one mutation stores the capture. For e-mail-in the R2 object identity is re-checked in
 * the transaction (`by_r2Object`): a second run loses and gets `{ existed: true }` (its blob is deleted by the action).
 */
export async function storeInboxItem(
  ctx: ModelCtx,
  args: {
    source: InboxItem["source"];
    files: readonly NewInboxFile[];
    receivedAt?: number;
    clientCapturedAt?: number;
    note?: string;
    r2?: { bucket: string; objectKey: string; etag?: string };
    from?: string;
    to?: string;
    subject?: string;
    messageId?: string;
    schedule?: boolean;
  },
): Promise<{ id: Id<"inboxItems">; status: InboxItem["status"]; existed: boolean }> {
  if (args.files.length === 0) throw appError("invalid_input", "Bitte mindestens eine Datei hochladen.");
  if (args.r2) {
    const r2 = args.r2;
    const existing = await ctx.db
      .query("inboxItems")
      .withIndex("by_r2Object", (q) => q.eq("r2.bucket", r2.bucket).eq("r2.objectKey", r2.objectKey))
      .first();
    if (existing) return { id: existing._id, status: existing.status, existed: true };
  }
  // One clock read: the item and its files share the server capture time (GOBD-04).
  const capturedAt = ctx.now();
  const files = args.files.map((f) => toInboxFile(ctx, f, args.source, capturedAt));
  const dup = await exactDuplicate(
    ctx,
    files.map((f) => f.sha256),
  );
  const status: InboxItem["status"] = dup ? "duplicate" : "new";
  const clean = (s: string | undefined, max: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, max) : undefined);
  const from = clean(args.from, 320);
  const to = clean(args.to, 320);
  const subject = clean(args.subject, 600);
  const messageId = clean(args.messageId, 400)?.replace(/^<|>$/g, "");
  const note = clean(args.note, 2000);
  const id = await auditedInsert(
    ctx,
    "inboxItems",
    {
      source: args.source,
      receivedAt: args.receivedAt ?? capturedAt,
      capturedAt,
      ...(args.clientCapturedAt !== undefined ? { clientCapturedAt: args.clientCapturedAt } : {}),
      actor: ctx.actor,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(subject ? { subject } : {}),
      ...(messageId ? { messageId } : {}),
      ...(note ? { note } : {}),
      ...(args.r2 ? { r2: args.r2 } : {}),
      files,
      status,
      ...(dup?.inboxItemId ? { duplicateOfInboxItemId: dup.inboxItemId } : {}),
      ...(dup?.voucherId ? { duplicateOfVoucherId: dup.voucherId } : {}),
      ...(dup
        ? { warnings: [{ code: "duplicate_file", message: INBOX_MESSAGES.duplicateFile(germanDateTime(dup.at)) }] }
        : {}),
      attempts: 0,
    },
    { action: "inbox.capture", label: subject ?? files[0]?.name ?? "Beleg" },
  );
  await indexHashes(ctx, id, files, 0);
  if (status === "new" && args.schedule !== false) await scheduleClassify(ctx, id);
  return { id, status, existed: false };
}

/** Classification start: `new`/`processing` → `processing`, attempts + 1. Anything else is not (re)classified. */
export async function beginClassification(
  ctx: ModelCtx,
  id: Id<"inboxItems">,
): Promise<{ proceed: boolean; attempts: number }> {
  const item = await requireInboxItem(ctx, id);
  if ((item.status !== "new" && item.status !== "processing") || item.voucherId) {
    return { proceed: false, attempts: item.attempts };
  }
  await auditedPatch(
    ctx,
    "inboxItems",
    id,
    { status: "processing", attempts: item.attempts + 1, nextAttemptAt: undefined },
    { action: "inbox.classify_start", label: label(item) },
  );
  return { proceed: true, attempts: item.attempts + 1 };
}

/**
 * INB-050: the parsed .eml — headers from the message itself (R2 metadata was only a hint), attachments as
 * original-derived files (each with its own SHA-256, `derivedFrom` = the .eml), skipped attachments listed. A second
 * message with the same Message-ID (EC-INB-24) or an attachment identical to an earlier capture (VOU-050) turns the
 * item into a `duplicate` linked to the first — never dropped.
 */
export async function recordMailParse(
  ctx: ModelCtx,
  args: {
    id: Id<"inboxItems">;
    from?: string;
    to?: string;
    subject?: string;
    messageId?: string;
    mailText?: string;
    files: readonly NewInboxFile[];
    /** INB-007: the PDF rendition of a mail without attachment. */
    mailRendition?: { storageId: Id<"_storage">; sha256: string };
    skipped: NonNullable<InboxItem["skippedAttachments"]>;
    flags: readonly string[];
    warnings: readonly InboxWarning[];
    duplicateMessage: (date: string) => string;
  },
): Promise<{ duplicate: boolean }> {
  const item = await requireInboxItem(ctx, args.id);
  if (item.mailParsed) return { duplicate: item.status === "duplicate" };
  const now = ctx.now();
  const added = args.files.map((f) => toInboxFile(ctx, f, item.source, now));
  const files = [...item.files, ...added];
  let dupOfItem: Id<"inboxItems"> | undefined;
  let dupWarning: InboxWarning | undefined;
  const messageId = args.messageId?.replace(/^<|>$/g, "").slice(0, 400);
  if (messageId) {
    const first = (
      await ctx.db
        .query("inboxItems")
        .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
        .collect()
    ).find((o) => o._id !== item._id && o._creationTime < item._creationTime);
    if (first) {
      dupOfItem = first._id;
      dupWarning = { code: "duplicate_message", message: args.duplicateMessage(germanDateTime(first.receivedAt)) };
    }
  }
  const fileDup = dupOfItem
    ? null
    : await exactDuplicate(
        ctx,
        added.map((f) => f.sha256),
        item._id,
      );
  if (fileDup) {
    dupWarning = { code: "duplicate_file", message: INBOX_MESSAGES.duplicateFile(germanDateTime(fileDup.at)) };
  }
  const duplicate = dupOfItem !== undefined || fileDup !== null;
  const flags = [...new Set([...(item.flags ?? []), ...args.flags])];
  await auditedPatch(
    ctx,
    "inboxItems",
    item._id,
    {
      files,
      mailParsed: true,
      ...(args.from ? { from: args.from.slice(0, 320) } : {}),
      ...(args.to ? { to: args.to.slice(0, 320) } : {}),
      ...(args.subject ? { subject: args.subject.replace(/\s+/g, " ").slice(0, 600) } : {}),
      ...(messageId ? { messageId } : {}),
      ...(args.mailText ? { mailText: args.mailText.slice(0, 20_000) } : {}),
      ...(args.mailRendition ? { mailRendition: { ...args.mailRendition, createdAt: now } } : {}),
      ...(args.skipped.length ? { skippedAttachments: args.skipped } : {}),
      ...(flags.length ? { flags } : {}),
      warnings: [...(item.warnings ?? []), ...args.warnings, ...(dupWarning ? [dupWarning] : [])],
      ...(duplicate
        ? {
            status: "duplicate" as const,
            ...(dupOfItem ? { duplicateOfInboxItemId: dupOfItem } : {}),
            ...(fileDup?.inboxItemId ? { duplicateOfInboxItemId: fileDup.inboxItemId } : {}),
            ...(fileDup?.voucherId ? { duplicateOfVoucherId: fileDup.voucherId } : {}),
          }
        : {}),
    },
    { action: "inbox.mail_parsed", label: args.subject ?? label(item) },
  );
  await indexHashes(ctx, item._id, files, item.files.length);
  return { duplicate };
}

/** Files found during classification (XML of a hybrid PDF, BG-24 attachments): appended, never replacing (INB-041). */
export async function appendInboxFiles(
  ctx: ModelCtx,
  id: Id<"inboxItems">,
  newFiles: readonly NewInboxFile[],
): Promise<{ firstIndex: number }> {
  const item = await requireInboxItem(ctx, id);
  const existing = new Set(item.files.map((f) => `${f.sha256}:${f.role}`));
  const now = ctx.now();
  const add = newFiles
    .map((f) => toInboxFile(ctx, f, item.source, now))
    .filter((f) => !existing.has(`${f.sha256}:${f.role}`));
  if (add.length === 0) {
    const first = newFiles[0];
    return { firstIndex: first ? item.files.findIndex((f) => f.sha256 === first.sha256) : item.files.length };
  }
  const files = [...item.files, ...add];
  await auditedPatch(ctx, "inboxItems", id, { files }, { action: "inbox.files_extracted", label: label(item) });
  await indexHashes(ctx, id, files, item.files.length);
  return { firstIndex: item.files.length };
}

/** EC-INB-13: the sidecar is down — the item stays `processing` and is retried; never „valid“ by default. */
export async function scheduleClassifyRetry(
  ctx: ModelCtx,
  args: { id: Id<"inboxItems">; delayMs: number; warning: InboxWarning; partial?: Partial<InboxItem> },
): Promise<void> {
  const item = await requireInboxItem(ctx, args.id);
  if (item.status !== "processing") return;
  const warnings = [...(item.warnings ?? []).filter((w) => w.code !== args.warning.code), args.warning];
  await auditedPatch(
    ctx,
    "inboxItems",
    item._id,
    { ...(args.partial ?? {}), warnings, nextAttemptAt: ctx.now() + args.delayMs },
    { action: "inbox.classify_retry", label: label(item) },
  );
  await scheduleClassify(ctx, item._id, args.delayMs);
}

/** SET-113 bookkeeping: items waiting for an OCR answer carry the flag `ocr_pending`. */
export async function setOcrPending(ctx: ModelCtx, id: Id<"inboxItems">, pending: boolean): Promise<void> {
  const item = await requireInboxItem(ctx, id);
  const flags = (item.flags ?? []).filter((f) => f !== "ocr_pending");
  if (pending) flags.push("ocr_pending");
  await auditedPatch(ctx, "inboxItems", id, { flags }, { action: "inbox.ocr_pending", label: label(item) });
}

// ── supplier (INB-045) and account suggestion (VOU-041) ─────────────────────────────────────────────────────

export interface SupplierFacts {
  name?: string;
  vatId?: string;
  taxNumber?: string;
  iban?: string;
  email?: string;
  electronicAddress?: { scheme: string; value: string };
  address?: { line1?: string; line2?: string; postalCode?: string; city?: string; countryCode?: string };
}

/** INB-045: VAT ID → IBAN → normalised name; otherwise a prefilled „Lieferant anlegen“ proposal (role supplier). */
export async function matchSupplier(
  ctx: ReadCtx,
  s: SupplierFacts,
): Promise<{ contactId: Id<"contacts">; by: "vat_id" | "iban" | "name" } | null> {
  const live = (c: Doc<"contacts"> | null) => c !== null && c.mergedIntoId === undefined;
  const vatId = s.vatId?.replace(/\s+/g, "").toUpperCase();
  if (vatId) {
    const c = await ctx.db
      .query("contacts")
      .withIndex("by_vatId", (q) => q.eq("vatId", vatId))
      .first();
    if (live(c)) return { contactId: (c as Doc<"contacts">)._id, by: "vat_id" };
  }
  const iban = s.iban?.replace(/\s+/g, "").toUpperCase();
  if (iban) {
    const c = await ctx.db
      .query("contacts")
      .withIndex("by_iban", (q) => q.eq("iban", iban))
      .first();
    if (live(c)) return { contactId: (c as Doc<"contacts">)._id, by: "iban" };
  }
  const wanted = s.name ? normaliseSupplierName(s.name) : "";
  if (wanted) {
    const hits = await ctx.db
      .query("contacts")
      .withSearchIndex("search", (q) => q.search("searchText", s.name as string))
      .take(10);
    const hit = hits.find((c) => live(c) && normaliseSupplierName(c.displayName) === wanted);
    if (hit) return { contactId: hit._id, by: "name" };
  }
  return null;
}

export function supplierProposal(s: SupplierFacts): Record<string, unknown> | undefined {
  if (!s.name) return undefined;
  return {
    name: s.name,
    roles: ["supplier"],
    ...(s.vatId ? { vatId: s.vatId } : {}),
    ...(s.taxNumber ? { taxNumber: s.taxNumber } : {}),
    ...(s.iban ? { iban: s.iban } : {}),
    ...(s.email ? { email: s.email } : {}),
    ...(s.electronicAddress ? { electronicAddress: s.electronicAddress } : {}),
    ...(s.address ? { address: s.address } : {}),
  };
}

/** VOU-041 for the draft lines: supplier profile → OCR hint → keyword table; never auto-booked. */
async function suggestLineAccount(ctx: ReadCtx, input: DraftInput, date: CalendarDate, text: string) {
  const accounts = await accountContextAt(ctx, date);
  const keys = supplierKeys({
    ...(input.supplierVatId ? { vatId: input.supplierVatId } : {}),
    ...(input.supplierIban ? { iban: input.supplierIban } : {}),
    ...(input.supplierName ? { name: input.supplierName } : {}),
  });
  let profile: Doc<"supplierProfiles"> | null = null;
  for (const k of keys) {
    profile = await ctx.db
      .query("supplierProfiles")
      .withIndex("by_key", (q) => q.eq("key", k))
      .first();
    if (profile) break;
  }
  const rule = (input.taxRule ?? "input_vat_deductible") as Parameters<typeof allowedAccounts>[0]["taxRule"];
  const allowed = new Set(allowedAccounts({ direction: "expense", taxRule: rule }, accounts).map((a) => a.number));
  return suggestAccount({
    ...(profile
      ? {
          profile: {
            ...(profile.lastAccount ? { lastAccount: profile.lastAccount } : {}),
            uses: profile.uses,
            accountStreak: profile.accountStreak,
          },
        }
      : {}),
    text: `${input.supplierName ?? ""} ${text}`,
    chart: accounts.chart,
    allowed,
  });
}

// ── draft (INB-028) ──────────────────────────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  classification: NonNullable<InboxItem["classification"]>;
  input: DraftInput;
  einvoice?: InboxEinvoiceValue;
  confidence?: number;
  flags?: readonly string[];
  warnings?: readonly InboxWarning[];
  supplier?: SupplierFacts;
  payee?: VoucherDoc["payee"];
  ocr?: VoucherDoc["ocr"];
  /** Free text used for the keyword account suggestion (subject, line descriptions). */
  hintText?: string;
  /** INB-040: the stamped visualisation PDF of an E-Rechnung (a rendition, never the original). */
  visualisation?: { storageId: Id<"_storage">; sha256: string };
}

const voucherRoleOf = (f: InboxFileValue): OriginalFileValue["role"] => f.role;

/**
 * INB-028: classification always ends in a draft (status `draft`, prefilled) linked to the item; the item becomes
 * `needs_review` (also at confidence ≥ 0.9 — never booked silently, INB-026). Idempotent: an item that already has a
 * draft (or was rejected meanwhile) is left alone.
 */
export async function finishClassification(
  ctx: ModelCtx,
  id: Id<"inboxItems">,
  r: ClassificationResult,
): Promise<{ voucherId: Id<"vouchers"> | null }> {
  const item = await requireInboxItem(ctx, id);
  if (item.voucherId) return { voucherId: item.voucherId };
  if (item.status !== "processing" && item.status !== "new") return { voucherId: null };
  const today = berlinCalendarDate(ctx.now());
  const input: DraftInput = { ...r.input };
  const match = r.supplier ? await matchSupplier(ctx, r.supplier) : null;
  if (match) input.supplierContactId = match.contactId;
  if (input.lines?.some((l) => l.account === "")) {
    const date = (input.documentDate ?? today) as CalendarDate;
    const text = [r.hintText ?? "", ...input.lines.map((l) => l.description ?? "")].join(" ");
    const s = await suggestLineAccount(ctx, input, date, text);
    if (s) input.lines = input.lines.map((l) => (l.account === "" ? { ...l, account: s.account } : l));
  }
  const xml = r.einvoice ? item.files[r.einvoice.xmlFileIndex] : undefined;
  const v = r.einvoice?.validation;
  const voucherId = await createVoucher(ctx, {
    input,
    files: item.files.map((f) => ({
      storageId: f.storageId,
      sha256: f.sha256,
      bytes: f.bytes,
      mime: f.mime,
      name: f.name,
      ...(f.pages !== undefined ? { pages: f.pages } : {}),
      role: voucherRoleOf(f),
      capturedAt: f.capturedAt,
      ...(f.clientCapturedAt !== undefined ? { clientCapturedAt: f.clientCapturedAt } : {}),
      capturedBy: f.capturedBy,
      capturedVia: f.capturedVia,
      ...(f.image ? { image: f.image } : {}),
    })),
    receivedAt: item.receivedAt,
    extra: {
      inboxItemId: item._id,
      ...(r.payee ? { payee: r.payee } : {}),
      ...(r.ocr ? { ocr: r.ocr } : {}),
      ...(r.visualisation && r.einvoice
        ? {
            renditions: [
              {
                storageId: r.visualisation.storageId,
                sha256: r.visualisation.sha256,
                mime: "application/pdf",
                ofFileIndex: r.einvoice.xmlFileIndex,
                kind: "visualisation" as const,
                createdAt: ctx.now(),
              },
            ],
          }
        : item.mailRendition
          ? {
              // INB-007: the readable PDF of the mail travels with the draft as a rendition of the .eml.
              renditions: [
                {
                  storageId: item.mailRendition.storageId,
                  sha256: item.mailRendition.sha256,
                  mime: "application/pdf",
                  ofFileIndex: Math.max(
                    item.files.findIndex((f) => f.role === "eml"),
                    0,
                  ),
                  kind: "html_pdf" as const,
                  createdAt: item.mailRendition.createdAt,
                },
              ],
            }
          : {}),
      ...(r.einvoice && xml
        ? {
            einvoice: {
              syntax: r.einvoice.syntax,
              profile: r.einvoice.profile,
              xmlStorageId: xml.storageId,
              xmlSha256: xml.sha256,
              notEInvoice: r.einvoice.notEInvoice,
              validation: {
                acceptable: v?.acceptable === true,
                category: v?.category ?? "format",
                ...(v?.reportStorageId ? { reportStorageId: v.reportStorageId } : {}),
                ...(v?.reportSha256 ? { reportSha256: v.reportSha256 } : {}),
                tool: v?.tool ?? "none",
                at: v?.at ?? ctx.now(),
                findings: (v?.findings ?? []).slice(0, 200),
              },
            },
          }
        : {}),
    },
  });
  const flags = [...new Set([...(item.flags ?? []).filter((f) => f !== "ocr_pending"), ...(r.flags ?? [])])];
  const warnings = [...(item.warnings ?? []).filter((w) => w.code !== "einvoice_sidecar_unavailable")];
  for (const w of r.warnings ?? []) if (!warnings.some((x) => x.code === w.code)) warnings.push({ ...w });
  const proposal = !match && r.supplier ? supplierProposal(r.supplier) : undefined;
  await auditedPatch(
    ctx,
    "inboxItems",
    item._id,
    {
      status: "needs_review",
      voucherId,
      classification: r.classification,
      processedAt: ctx.now(),
      nextAttemptAt: undefined,
      flags,
      warnings,
      ...(r.einvoice ? { einvoice: r.einvoice, einvoiceProfile: r.einvoice.profile } : {}),
      ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
      ...(match ? { supplierMatch: match } : {}),
      ...(proposal ? { supplierProposal: proposal } : {}),
    },
    { action: "inbox.classified", label: label(item) },
  );
  return { voucherId };
}

/** INB-027 „Beleg erfassen“ again after the draft was deleted: a new empty draft with the same originals. */
export async function recreateDraft(ctx: ModelCtx, id: Id<"inboxItems">): Promise<Id<"vouchers">> {
  const item = await requireInboxItem(ctx, id);
  if (item.voucherId) return item.voucherId;
  if (item.status !== "needs_review") {
    throw appError("invalid_input", "Für diesen Posteingangsbeleg kann kein Entwurf angelegt werden.");
  }
  await auditedPatch(ctx, "inboxItems", id, { status: "processing" }, { action: "inbox.redraft", label: label(item) });
  const r = await finishClassification(ctx, id, {
    classification: item.classification ?? "other",
    input: { direction: "expense" },
  });
  return r.voucherId as Id<"vouchers">;
}

// ── owner actions ─────────────────────────────────────────────────────────────────────────────────────────

/** INB-010 / EC-INB-12: reject with a reason; an unbooked draft is deleted (audited), the files stay on the item. */
export async function rejectInboxItem(
  ctx: ModelCtx,
  args: { id: Id<"inboxItems">; reason: RejectReason; text?: string },
): Promise<void> {
  const item = await requireInboxItem(ctx, args.id);
  if (!canReject(item.status)) throw appError("invalid_input", INBOX_MESSAGES.rejectState);
  const text = args.text?.trim();
  if (args.reason === "other" && (text?.length ?? 0) < 5) throw appError("invalid_input", INBOX_MESSAGES.rejectText);
  if (item.voucherId) {
    const v = await ctx.db.get(item.voucherId);
    if (v && v.status !== "draft") throw appError("invalid_input", INBOX_MESSAGES.rejectState);
    if (v) await deleteVoucherDraft(ctx, v._id);
  }
  const retention = rejectRetention({
    reason: args.reason,
    receivedOn: berlinCalendarDate(item.receivedAt),
    parsedEinvoice: item.einvoice !== undefined,
  });
  await auditedPatch(
    ctx,
    "inboxItems",
    item._id,
    {
      status: "rejected",
      rejectReason: args.reason,
      ...(text ? { rejectText: text.slice(0, 1000) } : {}),
      rejectedAt: ctx.now(),
      rejectedBy: ctx.actor,
      voucherId: undefined,
      retentionUntil: retention.retentionUntil,
      ...(retention.purgeEligibleFrom ? { purgeEligibleFrom: retention.purgeEligibleFrom } : {}),
    },
    { action: "inbox.reject", label: label(item), ...(text ? { reason: text } : { reason: args.reason }) },
  );
}

// ── INB-009 split / merge ─────────────────────────────────────────────────────────────────────────────────

/** Checks one source item and deletes its unbooked draft (audited; the files stay on the item). */
async function prepareSplitMergeSource(ctx: ModelCtx, id: Id<"inboxItems">): Promise<InboxItem> {
  const item = await requireInboxItem(ctx, id);
  const voucher = item.voucherId ? await ctx.db.get(item.voucherId) : null;
  const emlPending = item.files.some((f) => f.role === "eml") && item.mailParsed !== true;
  const why = canSplitOrMerge({
    status: item.status,
    ...(voucher ? { voucherStatus: voucher.status } : {}),
    emlPending,
  });
  if (why) throw appError("invalid_input", why, { reason: "SPLIT_MERGE_STATE" });
  if (voucher) await deleteVoucherDraft(ctx, voucher._id);
  return requireInboxItem(ctx, id);
}

/** Inserts one new item carrying copies of `files`; context (Zugang, sender, subject) from the first source. */
async function insertDerivedItem(
  ctx: ModelCtx,
  sources: readonly InboxItem[],
  files: InboxFileValue[],
  kind: "split" | "merge",
): Promise<Id<"inboxItems">> {
  const first = sources[0] as InboxItem;
  const sourceIds = new Set(sources.map((s) => s._id));
  // The .eml goes with every split part, so it is no duplicate signal here (EC-INB-24 uses the Message-ID).
  const dup = await exactDuplicate(
    ctx,
    files.filter((f) => f.role !== "eml").map((f) => f.sha256),
    sourceIds,
  );
  const override = sources.find((s) => s.duplicateOverride)?.duplicateOverride;
  const rendition = sources.find((s) => s.mailRendition)?.mailRendition;
  const skipped = sources.flatMap((s) => s.skippedAttachments ?? []);
  const status: InboxItem["status"] = dup && !override ? "duplicate" : "new";
  const name = first.subject ?? files.find((f) => f.role === "original")?.name ?? "Beleg";
  const id = await auditedInsert(
    ctx,
    "inboxItems",
    {
      source: first.source,
      receivedAt: Math.min(...sources.map((s) => s.receivedAt)),
      capturedAt: ctx.now(), // the split/merge commit; Zugang stays in receivedAt, file entries keep their capture time
      ...(first.clientCapturedAt !== undefined ? { clientCapturedAt: first.clientCapturedAt } : {}),
      actor: ctx.actor,
      ...(first.from ? { from: first.from } : {}),
      ...(first.to ? { to: first.to } : {}),
      ...(first.subject ? { subject: first.subject } : {}),
      ...(first.messageId ? { messageId: first.messageId } : {}),
      ...(first.mailText ? { mailText: first.mailText } : {}),
      ...(first.note ? { note: first.note } : {}),
      ...(sources.some((s) => s.mailParsed) ? { mailParsed: true } : {}),
      ...(skipped.length > 0 ? { skippedAttachments: skipped } : {}),
      ...(rendition ? { mailRendition: rendition } : {}),
      ...(override ? { duplicateOverride: override } : {}),
      files,
      status,
      ...(status === "duplicate" && dup?.inboxItemId ? { duplicateOfInboxItemId: dup.inboxItemId } : {}),
      ...(status === "duplicate" && dup?.voucherId ? { duplicateOfVoucherId: dup.voucherId } : {}),
      ...(status === "duplicate" && dup
        ? { warnings: [{ code: "duplicate_file", message: INBOX_MESSAGES.duplicateFile(germanDateTime(dup.at)) }] }
        : {}),
      createdFrom: { kind, inboxItemIds: sources.map((s) => s._id), at: ctx.now(), actor: ctx.actor },
      attempts: 0,
    },
    { action: kind === "split" ? "inbox.split" : "inbox.merge", label: name },
  );
  await indexHashes(ctx, id, files, 0);
  if (status === "new") await scheduleClassify(ctx, id);
  return id;
}

async function supersede(ctx: ModelCtx, item: InboxItem, kind: "split" | "merge", ids: Id<"inboxItems">[]) {
  await auditedPatch(
    ctx,
    "inboxItems",
    item._id,
    {
      status: "superseded",
      supersededBy: { kind, inboxItemIds: ids, at: ctx.now(), actor: ctx.actor },
      nextAttemptAt: undefined,
    },
    { action: kind === "split" ? "inbox.split" : "inbox.merge", label: label(item) },
  );
}

/**
 * INB-009 split: `groups` = indexes of the files with role `original` per new item. The source item keeps all its
 * files and hashes (GOBD-08) and becomes `superseded`; an unbooked draft is deleted first, the new items are classified.
 */
export async function splitInboxItem(
  ctx: ModelCtx,
  args: { id: Id<"inboxItems">; groups: readonly (readonly number[])[] },
): Promise<Id<"inboxItems">[]> {
  const item = await prepareSplitMergeSource(ctx, args.id);
  const parts = splitFiles(item.files, args.groups);
  if (!parts.ok) throw appError("invalid_input", parts.error.message, { reason: "SPLIT_MERGE_GROUPS" });
  const ids: Id<"inboxItems">[] = [];
  for (const files of parts.value) ids.push(await insertDerivedItem(ctx, [item], files, "split"));
  await supersede(ctx, item, "split", ids);
  return ids;
}

/** INB-009 merge (e.g. front and back photo): one new item with the files of all items in the given order. */
export async function mergeInboxItems(ctx: ModelCtx, ids: readonly Id<"inboxItems">[]): Promise<Id<"inboxItems">> {
  const unique = [...new Set(ids)];
  // Count check before any draft is deleted.
  if (unique.length < 2 || unique.length > MERGE_MAX) {
    const message = unique.length < 2 ? SPLIT_MERGE_MESSAGES.mergeTwo : SPLIT_MERGE_MESSAGES.mergeMax;
    throw appError("invalid_input", message, { reason: "SPLIT_MERGE_GROUPS" });
  }
  const sources: InboxItem[] = [];
  for (const id of unique) sources.push(await prepareSplitMergeSource(ctx, id));
  const files = mergeFiles(sources.map((s) => s.files));
  if (!files.ok) throw appError("invalid_input", files.error.message, { reason: "SPLIT_MERGE_GROUPS" });
  const id = await insertDerivedItem(ctx, sources, files.value, "merge");
  for (const s of sources) await supersede(ctx, s, "merge", [id]);
  return id;
}

/** VOU-050 „Trotzdem verarbeiten“: a duplicate is classified anyway, with a reason (audited). */
export async function overrideInboxDuplicate(
  ctx: ModelCtx,
  args: { id: Id<"inboxItems">; reason: string },
): Promise<void> {
  const item = await requireInboxItem(ctx, args.id);
  if (!canOverrideDuplicate(item.status)) throw appError("invalid_input", INBOX_MESSAGES.notDuplicate);
  const reason = args.reason.trim();
  if (reason.length < 5) throw appError("invalid_input", INBOX_MESSAGES.overrideReason);
  await auditedPatch(
    ctx,
    "inboxItems",
    item._id,
    { status: "new", duplicateOverride: { reason, actor: ctx.actor, at: ctx.now() } },
    { action: "inbox.duplicate_override", label: label(item), reason },
  );
  await scheduleClassify(ctx, item._id);
}

/**
 * SET-113: disabling OCR takes effect immediately — items waiting for an OCR answer get their (empty) manual draft
 * now; a late OCR answer finds the draft and is discarded (finishClassification is idempotent).
 */
export async function releaseOcrPending(ctx: ModelCtx, message: string): Promise<number> {
  let n = 0;
  for (const item of await ctx.db
    .query("inboxItems")
    .withIndex("by_status_receivedAt", (q) => q.eq("status", "processing"))
    .collect()) {
    if (!(item.flags ?? []).includes("ocr_pending")) continue;
    await finishClassification(ctx, item._id, {
      classification: item.classification ?? (item.files[0]?.mime.startsWith("image/") ? "image" : "pdf"),
      input: { direction: "expense" },
      warnings: [{ code: "ocr_disabled", message }],
    });
    n++;
  }
  return n;
}
