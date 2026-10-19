import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { invalidAllowlistEntries } from "../src/domain/inbox/allowlist";
import { INBOX_POLL } from "../src/domain/inbox/r2-plan";
import {
  INBOX_FILTERS,
  INBOX_STATUS_LABEL_DE,
  type InboxFilter,
  matchesInboxFilter,
  REJECT_REASONS,
} from "../src/domain/inbox/status";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { CAPTURE_MESSAGES, checkUpload, pageCount } from "../src/domain/vouchers/capture";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, actorMutation, mutation, query, systemMutation, systemQuery } from "./functions";
import { appError } from "./lib/errors";
import { inboxBucketFromEnv } from "./lib/r2Inbox";
import { getCompanyProfile } from "./model/companyProfile";
import {
  appendInboxFiles,
  beginClassification,
  finishClassification,
  overrideInboxDuplicate,
  recordMailParse,
  recreateDraft,
  rejectInboxItem,
  requireInboxItem,
  scheduleClassifyRetry,
  setOcrPending,
  storeInboxItem,
} from "./model/inbox";
import {
  claudeConfigOf,
  ocrActive,
  r2ConfigOf,
  recordOcrCall,
  recordPollRun,
  saveClaudeSettings,
  saveInboxSettings,
} from "./model/inboxSettings";
import { getIntegration, recordIntegrationTest } from "./model/integrations";
import { kuOn } from "./model/vouchers";
import { vVoucherDraftInput } from "./voucherValidators";

/**
 * Posteingang (F06 §3.1–3.3, §6.1): capture, list/detail, reject, duplicate override, settings. The classification
 * pipeline and the R2 poll run as Node actions in convex/inboxNode.ts and write through the internal mutations below.
 */

const MAX_BASE64_CHARS = 10 * 1024 * 1024; // INB-001 / EC-INB-02: ≤ 10 MB base64 JSON (05 §3)
const MAX_FILES = 100;

const vRejectReason = v.union(...REJECT_REASONS.map((r) => v.literal(r)));
const vSource = v.union(v.literal("upload"), v.literal("app"));

// ── views ───────────────────────────────────────────────────────────────────────────────────────────────

type ItemDoc = Doc<"inboxItems">;

async function rowOf(ctx: { db: { get: (id: Id<"vouchers">) => Promise<Doc<"vouchers"> | null> } }, item: ItemDoc) {
  const voucher = item.voucherId ? await ctx.db.get(item.voucherId) : null;
  const main = item.files.find((f) => f.role === "original") ?? item.files[0];
  return {
    id: item._id,
    source: item.source,
    status: item.status,
    statusLabel: INBOX_STATUS_LABEL_DE[item.status],
    receivedAt: item.receivedAt,
    from: item.from ?? null,
    subject: item.subject ?? null,
    fileName: main?.name ?? null,
    fileCount: item.files.length,
    classification: item.classification ?? null,
    einvoiceProfile: item.einvoiceProfile ?? null,
    einvoiceOk: item.einvoice?.validation ? item.einvoice.validation.acceptable : null,
    notEInvoice: item.einvoice?.notEInvoice ?? false,
    confidence: item.confidence ?? null,
    flags: item.flags ?? [],
    rejectReason: item.rejectReason ?? null,
    voucherId: item.voucherId ?? null,
    supplierName: voucher?.supplierName ?? null,
    grossCents: voucher ? voucher.totals.grossCents : null,
    currency: voucher?.currency ?? null,
    documentDate: voucher?.documentDate ?? null,
  };
}

export type InboxRow = Awaited<ReturnType<typeof rowOf>>;

export const list = query({
  permission: "vouchers.read",
  args: { filter: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const filter = (INBOX_FILTERS as readonly string[]).includes(args.filter ?? "")
      ? (args.filter as InboxFilter)
      : "all";
    const now = ctx.now();
    const items = await ctx.db.query("inboxItems").withIndex("by_receivedAt").order("desc").take(500);
    const rows: InboxRow[] = [];
    for (const item of items) {
      if (!matchesInboxFilter(item, filter, now)) continue;
      rows.push(await rowOf(ctx, item));
      if (rows.length >= Math.min(args.limit ?? 200, 200)) break;
    }
    return rows;
  },
});

export const counts = query({
  permission: "vouchers.read",
  args: {},
  handler: async (ctx) => {
    const now = ctx.now();
    const items = await ctx.db.query("inboxItems").withIndex("by_receivedAt").order("desc").take(500);
    return Object.fromEntries(
      INBOX_FILTERS.map((f) => [f, items.filter((i) => matchesInboxFilter(i, f, now)).length]),
    ) as Record<InboxFilter, number>;
  },
});

export const get = query({
  permission: "vouchers.read",
  args: { id: v.id("inboxItems") },
  handler: async (ctx, { id }) => {
    const item = await ctx.db.get(id);
    if (!item) return null;
    const files = await Promise.all(
      item.files.map(async (f, index) => ({
        index,
        name: f.name,
        mime: f.mime,
        bytes: f.bytes,
        sha256: f.sha256,
        role: f.role,
        pages: f.pages ?? null,
        derivedFrom: f.derivedFrom ?? null,
        capturedAt: f.capturedAt,
        clientCapturedAt: f.clientCapturedAt ?? null,
        capturedBy: f.capturedBy,
        capturedVia: f.capturedVia,
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
    const validation = item.einvoice?.validation;
    return {
      ...(await rowOf(ctx, item)),
      to: item.to ?? null,
      messageId: item.messageId ?? null,
      mailText: item.mailText ?? null,
      note: item.note ?? null,
      capturedAt: item.capturedAt,
      clientCapturedAt: item.clientCapturedAt ?? null,
      actor: item.actor,
      files,
      skippedAttachments: item.skippedAttachments ?? [],
      warnings: item.warnings ?? [],
      einvoice: item.einvoice
        ? {
            syntax: item.einvoice.syntax,
            profile: item.einvoice.profile,
            notEInvoice: item.einvoice.notEInvoice,
            xmlFileIndex: item.einvoice.xmlFileIndex,
            model: item.einvoice.model ?? null,
            validation: validation
              ? {
                  acceptable: validation.acceptable,
                  category: validation.category,
                  tool: validation.tool,
                  at: validation.at,
                  unavailable: validation.unavailable ?? false,
                  findings: validation.findings,
                  reportSha256: validation.reportSha256 ?? null,
                  reportUrl: validation.reportStorageId ? await ctx.storage.getUrl(validation.reportStorageId) : null,
                }
              : null,
          }
        : null,
      supplierMatch: item.supplierMatch ?? null,
      supplierProposal: (item.supplierProposal as Record<string, unknown> | undefined) ?? null,
      duplicateOfInboxItemId: item.duplicateOfInboxItemId ?? null,
      duplicateOfVoucherId: item.duplicateOfVoucherId ?? null,
      duplicateOverride: item.duplicateOverride ?? null,
      rejectText: item.rejectText ?? null,
      rejectedAt: item.rejectedAt ?? null,
      retentionUntil: item.retentionUntil ?? null,
      purgeEligibleFrom: item.purgeEligibleFrom ?? null,
      attempts: item.attempts,
      nextAttemptAt: item.nextAttemptAt ?? null,
    };
  },
});

// ── capture (INB-001…003, INB-008, INB-020) ─────────────────────────────────────────────────────────────

export const generateUploadUrl = mutation({
  permission: "vouchers.write",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

const vNewFile = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  name: v.string(),
  mime: v.string(),
  bytes: v.number(),
  pages: v.optional(v.number()),
  clientCapturedAt: v.optional(v.number()),
  role: v.optional(
    v.union(v.literal("original"), v.literal("extracted_xml"), v.literal("embedded_attachment"), v.literal("eml")),
  ),
  derivedFrom: v.optional(v.number()),
});

export const storeInternal = actorMutation({
  permission: "vouchers.write",
  args: {
    source: v.union(v.literal("upload"), v.literal("app"), v.literal("api"), v.literal("mcp")),
    files: v.array(vNewFile),
    clientCapturedAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    storeInboxItem(ctx, {
      source: args.source,
      files: args.files,
      ...(args.clientCapturedAt !== undefined ? { clientCapturedAt: args.clientCapturedAt } : {}),
      ...(args.note ? { note: args.note } : {}),
    }),
});

interface Checked {
  storageId: Id<"_storage">;
  sha256: string;
  name: string;
  mime: string;
  bytes: number;
  pages: number;
  clientCapturedAt?: number;
}

/** Reads and checks stored uploads (magic bytes, size); on any rejection every stored blob of the call is deleted. */
async function checkStored(
  ctx: {
    storage: { get: (id: Id<"_storage">) => Promise<Blob | null>; delete: (id: Id<"_storage">) => Promise<void> };
  },
  files: readonly { storageId: Id<"_storage">; name: string; clientCapturedAt?: number }[],
  maxBytes?: number,
): Promise<Checked[]> {
  const out: Checked[] = [];
  const drop = async () => {
    for (const f of files) await ctx.storage.delete(f.storageId).catch(() => undefined);
  };
  for (const f of files) {
    const blob = await ctx.storage.get(f.storageId);
    if (!blob) {
      await drop();
      throw appError("not_found", "Die hochgeladene Datei wurde nicht gefunden.");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const checked = checkUpload(bytes, maxBytes);
    if (!checked.ok) {
      await drop();
      throw appError("invalid_input", `${f.name}: ${checked.error.message}`, {
        reason: checked.error.code.toUpperCase(),
        file: f.name,
      });
    }
    out.push({
      storageId: f.storageId,
      sha256: await sha256Hex(bytes),
      name: f.name.trim().slice(0, 255) || "beleg",
      mime: checked.value.mime,
      bytes: bytes.byteLength,
      pages: pageCount(bytes, checked.value.mime),
      ...(f.clientCapturedAt !== undefined ? { clientCapturedAt: f.clientCapturedAt } : {}),
    });
  }
  return out;
}

const SOURCE_BY_CHANNEL: Record<string, "upload" | "api" | "mcp"> = { ui: "upload", api: "api", mcp: "mcp" };

/**
 * INB-001/003/020: one capture = one inbox item. Several files in one call are the pages of one receipt (camera
 * multi-page, front/back), stored in the given order; a folder drop calls this once per file (INB-002).
 */
export const ingest = action({
  permission: "vouchers.write",
  args: {
    files: v.array(
      v.object({ storageId: v.id("_storage"), name: v.string(), clientCapturedAt: v.optional(v.number()) }),
    ),
    via: v.optional(vSource),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: Id<"inboxItems">; status: ItemDoc["status"] }> => {
    if (args.files.length === 0 || args.files.length > MAX_FILES) {
      throw appError("invalid_input", `Bitte 1 bis ${MAX_FILES} Dateien hochladen.`);
    }
    const checked = await checkStored(ctx, args.files);
    try {
      const firstClient = checked.find((f) => f.clientCapturedAt !== undefined)?.clientCapturedAt;
      const r = await ctx.runMutation(internal.inbox.storeInternal, {
        actorContext: ctx.actorContext,
        source: args.via ?? SOURCE_BY_CHANNEL[ctx.actorContext.channel] ?? "upload",
        files: checked,
        ...(firstClient !== undefined ? { clientCapturedAt: firstClient } : {}),
        ...(args.note ? { note: args.note } : {}),
      });
      return { id: r.id, status: r.status };
    } catch (e) {
      for (const f of checked) await ctx.storage.delete(f.storageId).catch(() => undefined);
      throw e;
    }
  },
});

const decodeBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    throw appError("invalid_input", "content_base64 ist kein gültiges Base64.");
  const s = atob(clean);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * INB-008 REST `POST /inbox-items` (JSON `content_base64`) and MCP `voucher_create_from_file`: ≤ 10 MB base64 per
 * file (EC-INB-02); no URL fetching (SEC-06). Same checks and item as the app upload.
 */
export const ingestBase64 = action({
  permission: "vouchers.write",
  args: {
    files: v.array(v.object({ filename: v.string(), contentBase64: v.string() })),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ id: Id<"inboxItems">; status: ItemDoc["status"] }> => {
    if (args.files.length === 0 || args.files.length > MAX_FILES) {
      throw appError("invalid_input", `Bitte 1 bis ${MAX_FILES} Dateien hochladen.`);
    }
    for (const f of args.files) {
      if (f.contentBase64.length > MAX_BASE64_CHARS) {
        throw appError("invalid_input", `${f.filename}: ${CAPTURE_MESSAGES.tooLarge(10)}`, {
          reason: "FILE_TOO_LARGE",
          file: f.filename,
        });
      }
    }
    const stored: { storageId: Id<"_storage">; name: string }[] = [];
    try {
      for (const f of args.files) {
        const bytes = decodeBase64(f.contentBase64);
        stored.push({
          storageId: await ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>])),
          name: f.filename,
        });
      }
    } catch (e) {
      for (const s of stored) await ctx.storage.delete(s.storageId).catch(() => undefined);
      throw e;
    }
    const checked = await checkStored(ctx, stored);
    try {
      const r = await ctx.runMutation(internal.inbox.storeInternal, {
        actorContext: ctx.actorContext,
        source: SOURCE_BY_CHANNEL[ctx.actorContext.channel] ?? "api",
        files: checked,
        ...(args.note ? { note: args.note } : {}),
      });
      return { id: r.id, status: r.status };
    } catch (e) {
      for (const f of checked) await ctx.storage.delete(f.storageId).catch(() => undefined);
      throw e;
    }
  },
});

// ── owner actions ───────────────────────────────────────────────────────────────────────────────────────

export const reject = mutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems"), reason: vRejectReason, text: v.optional(v.string()) },
  handler: async (ctx, args) => rejectInboxItem(ctx, args),
});

export const overrideDuplicate = mutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems"), reason: v.string() },
  handler: async (ctx, args) => overrideInboxDuplicate(ctx, args),
});

export const createDraft = mutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems") },
  handler: async (ctx, { id }) => recreateDraft(ctx, id),
});

// ── settings (SET-110…113, INB-011/051/052) ─────────────────────────────────────────────────────────────

export const settings = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const r2 = await getIntegration(ctx, "r2_inbox");
    const claude = await getIntegration(ctx, "claude");
    const rc = r2ConfigOf(r2);
    const cc = claudeConfigOf(claude);
    const bucket = inboxBucketFromEnv();
    return {
      inbox: {
        enabled: r2?.enabled ?? false,
        dpaConfirmedAt: r2?.dpaConfirmedAt ?? null,
        receivingAddress: rc.receivingAddress ?? null,
        allowlist: rc.allowlist,
        credentials: bucket ? ("configured" as const) : ("missing" as const),
        bucket: bucket?.bucket ?? null,
        endpoint: process.env.R2_ACCOUNT_ENDPOINT?.trim() || null,
        pollIntervalMinutes: 5,
        limits: { mailMb: Math.round(INBOX_POLL.maxRawBytes / 1024 / 1024), attachmentMb: 20 },
        health: rc.health,
        lastTestAt: r2?.lastTestAt ?? null,
        lastTestOk: r2?.lastTestOk ?? null,
        lastTestDetail: r2?.lastTestDetail ?? null,
      },
      ocr: {
        enabled: claude?.enabled ?? false,
        active: ocrActive(claude),
        dpaConfirmedAt: claude?.dpaConfirmedAt ?? null,
        apiKeyStored: !!claude?.encryptedSecrets,
        endpoint: cc.endpoint ?? null,
        model: cc.model,
        region: cc.region,
        pageLimit: cc.pageLimit,
        monthlyBudget: cc.monthlyBudget ?? null,
        usage: cc.usage ?? null,
        lastTestAt: claude?.lastTestAt ?? null,
        lastTestOk: claude?.lastTestOk ?? null,
        lastTestDetail: claude?.lastTestDetail ?? null,
      },
    };
  },
});

export const saveInbox = mutation({
  permission: "integrations.manage",
  args: {
    enabled: v.boolean(),
    receivingAddress: v.optional(v.string()),
    allowlist: v.string(),
    dpaConfirmed: v.boolean(),
  },
  handler: async (ctx, args) => {
    const bad = invalidAllowlistEntries(args.allowlist);
    if (bad.length > 0) throw appError("invalid_input", `Ungültige Einträge in der Absenderliste: ${bad.join(", ")}`);
    await saveInboxSettings(ctx, args);
  },
});

export const saveOcr = mutation({
  permission: "integrations.manage",
  args: {
    enabled: v.boolean(),
    dpaConfirmed: v.boolean(),
    endpoint: v.optional(v.string()),
    model: v.optional(v.string()),
    region: v.union(v.literal("eu"), v.literal("us"), v.literal("global"), v.literal("other")),
    pageLimit: v.optional(v.number()),
    monthlyBudget: v.optional(v.number()),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => saveClaudeSettings(ctx, args),
});

export const recordTestInternal = actorMutation({
  permission: "integrations.manage",
  args: { kind: v.union(v.literal("r2_inbox"), v.literal("claude")), ok: v.boolean(), detail: v.string() },
  handler: async (ctx, { kind, ok, detail }) => recordIntegrationTest(ctx, kind, { ok, detail }),
});

// ── internal: classification pipeline (convex/inboxNode.ts) ─────────────────────────────────────────────

export const classifyInput = systemQuery({
  job: "inbox.classify",
  args: { id: v.id("inboxItems") },
  handler: async (ctx, { id }) => {
    const item = await ctx.db.get(id);
    if (!item) return null;
    const profile = await getCompanyProfile(ctx);
    const claude = await getIntegration(ctx, "claude");
    const r2 = await getIntegration(ctx, "r2_inbox");
    const today = berlinCalendarDate(Date.now());
    return {
      item,
      today,
      company: profile
        ? {
            name: profile.name,
            ...(profile.tradeName ? { tradeName: profile.tradeName } : {}),
            ...(profile.vatId ? { vatId: profile.vatId } : {}),
            ku: kuOn(profile, today),
          }
        : null,
      ocr: {
        active: ocrActive(claude),
        config: claudeConfigOf(claude),
        encryptedSecrets: claude?.encryptedSecrets ?? null,
      },
      allowlist: r2ConfigOf(r2).allowlist,
    };
  },
});

export const beginInternal = actorMutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems") },
  handler: async (ctx, { id }) => beginClassification(ctx, id),
});

const vWarning = v.object({ code: v.string(), message: v.string(), acknowledge: v.optional(v.boolean()) });

export const mailParsedInternal = actorMutation({
  permission: "vouchers.write",
  args: {
    id: v.id("inboxItems"),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    subject: v.optional(v.string()),
    messageId: v.optional(v.string()),
    mailText: v.optional(v.string()),
    files: v.array(vNewFile),
    skipped: v.array(
      v.object({
        name: v.string(),
        mime: v.string(),
        bytes: v.number(),
        reason: v.union(v.literal("too_large"), v.literal("unsupported")),
      }),
    ),
    flags: v.array(v.string()),
    warnings: v.array(vWarning),
    duplicateText: v.string(),
  },
  handler: async (ctx, { duplicateText, ...args }) =>
    recordMailParse(ctx, { ...args, duplicateMessage: (d) => duplicateText.replace("{date}", d) }),
});

export const appendFilesInternal = actorMutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems"), files: v.array(vNewFile) },
  handler: async (ctx, { id, files }) => appendInboxFiles(ctx, id, files),
});

export const retryInternal = actorMutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems"), delayMs: v.number(), warning: vWarning },
  handler: async (ctx, args) => scheduleClassifyRetry(ctx, args),
});

export const ocrPendingInternal = actorMutation({
  permission: "vouchers.write",
  args: { id: v.id("inboxItems"), pending: v.boolean() },
  handler: async (ctx, { id, pending }) => {
    await setOcrPending(ctx, id, pending);
    if (pending) await recordOcrCall(ctx);
  },
});

export const ocrTestInput = systemQuery({
  job: "inbox.classify",
  args: {},
  handler: async (ctx) => {
    const row = await getIntegration(ctx, "claude");
    const c = claudeConfigOf(row);
    return { encryptedSecrets: row?.encryptedSecrets ?? null, endpoint: c.endpoint ?? null, model: c.model };
  },
});

/** The OCR switch re-read right before the call (SET-113: disabling takes effect immediately). */
export const ocrStillActive = systemQuery({
  job: "inbox.classify",
  args: {},
  handler: async (ctx) => ocrActive(await getIntegration(ctx, "claude")),
});

export const finishInternal = actorMutation({
  permission: "vouchers.write",
  args: {
    id: v.id("inboxItems"),
    classification: v.union(
      v.literal("xrechnung"),
      v.literal("zugferd"),
      v.literal("pdf"),
      v.literal("image"),
      v.literal("other"),
    ),
    input: vVoucherDraftInput,
    einvoice: v.optional(v.any()),
    confidence: v.optional(v.number()),
    flags: v.optional(v.array(v.string())),
    warnings: v.optional(v.array(vWarning)),
    supplier: v.optional(v.any()),
    payee: v.optional(v.object({ name: v.string(), iban: v.string(), bic: v.optional(v.string()) })),
    ocr: v.optional(v.any()),
    hintText: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...r }) => {
    await requireInboxItem(ctx, id);
    return finishClassification(ctx, id, r);
  },
});

// ── internal: R2 e-mail-in (INB-049/052) ────────────────────────────────────────────────────────────────

export const r2ObjectKnown = systemQuery({
  job: "cron.inbox.pollR2",
  args: { bucket: v.string(), objectKey: v.string() },
  handler: async (ctx, { bucket, objectKey }) =>
    (await ctx.db
      .query("inboxItems")
      .withIndex("by_r2Object", (q) => q.eq("r2.bucket", bucket).eq("r2.objectKey", objectKey))
      .first()) !== null,
});

export const pollState = systemQuery({
  job: "cron.inbox.pollR2",
  args: {},
  handler: async (ctx) => {
    const row = await getIntegration(ctx, "r2_inbox");
    const c = r2ConfigOf(row);
    return {
      enabled: row?.enabled === true && row.dpaConfirmedAt !== undefined,
      paused: c.health.pausedAt !== undefined,
    };
  },
});

/** INB-049 step 3: the raw .eml becomes the inbox item in ONE mutation (re-checks `by_r2Object`, EC-INB-23). */
export const storeEmailInternal = systemMutation({
  job: "cron.inbox.pollR2",
  args: {
    bucket: v.string(),
    objectKey: v.string(),
    etag: v.optional(v.string()),
    lastModified: v.number(),
    file: vNewFile,
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    subject: v.optional(v.string()),
    messageId: v.optional(v.string()),
  },
  handler: async (ctx, a) =>
    storeInboxItem(ctx, {
      source: "email",
      files: [{ ...a.file, role: "eml" }],
      receivedAt: a.lastModified,
      r2: { bucket: a.bucket, objectKey: a.objectKey, ...(a.etag ? { etag: a.etag } : {}) },
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.subject ? { subject: a.subject } : {}),
      ...(a.messageId ? { messageId: a.messageId } : {}),
    }),
});

export const pollRunInternal = systemMutation({
  job: "cron.inbox.pollR2",
  args: {
    outcome: v.union(v.literal("ok"), v.literal("failed"), v.literal("unauthorized")),
    objectsWaiting: v.optional(v.number()),
    staleCount: v.optional(v.number()),
    oldestStaleAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => recordPollRun(ctx, args),
});

/** „Verbindung testen“ (owner): records the result; a successful test resumes a paused poll (EC-INB-29). */
export const r2TestInternal = actorMutation({
  permission: "integrations.manage",
  args: {
    ok: v.boolean(),
    detail: v.string(),
    objectsWaiting: v.optional(v.number()),
    unauthorized: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await recordIntegrationTest(ctx, "r2_inbox", { ok: args.ok, detail: args.detail });
    await recordPollRun(ctx, {
      outcome: args.ok ? "ok" : args.unauthorized ? "unauthorized" : "failed",
      ...(args.objectsWaiting !== undefined ? { objectsWaiting: args.objectsWaiting } : {}),
      ...(args.ok ? {} : { error: args.detail }),
      resume: args.ok,
    });
  },
});
