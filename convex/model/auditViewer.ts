import { describeAuditEntry } from "../../src/domain/audit/describe";
import { isEncryptedValue } from "../../src/domain/audit/personal";
import {
  type AuditFilter,
  type AuditPreset,
  actorBadge,
  auditCsv,
  auditJson,
  chainStatus,
  combineFilters,
  type ExportEntry,
  matchesFilter,
  presetFilter,
} from "../../src/domain/audit/viewer";
import type { Doc } from "../_generated/dataModel";
import { instanceName } from "../lib/env";
import { keyByPublicId } from "./apiKeys";
import { appendAudit } from "./audit";
import { latestRun } from "./integrity";
import { notifyKind } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Audit viewer, per-record history and export (F12 AUD-006…009). Reads only — except the logged reads of AUD-009
 * (exports, auditor access, secret screens), which append an audit entry without touching any other table.
 */

const SCAN_LIMIT = 5000;
const ENCRYPTED = "[personenbezogen, verschlüsselt]";

/** Encrypted personal values (crypto-shredding) are never decrypted in the viewer. */
function maskEncrypted(v: unknown): unknown {
  if (isEncryptedValue(v)) return ENCRYPTED;
  if (Array.isArray(v)) return v.map(maskEncrypted);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskEncrypted(x)]));
  }
  return v;
}

const ENTITY_LINKS: Readonly<Record<string, (id: string) => string>> = {
  salesDocuments: (id) => `/rechnungen/${id}`,
  contacts: (id) => `/kontakte/${id}`,
  products: (id) => `/produkte/${id}`,
  bankTransactions: () => "/bank",
  integrityRuns: () => "/einstellungen/system/integritaet",
  companyProfile: () => "/einstellungen/unternehmen",
};

async function keyNames(ctx: ReadCtx, rows: readonly Doc<"auditLog">[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const r of rows) {
    const kind = r.actor.slice(0, r.actor.indexOf(":"));
    if ((kind !== "api-key" && kind !== "mcp") || names.has(r.actor)) continue;
    const key = await keyByPublicId(ctx, r.actor.slice(kind.length + 1));
    if (key) names.set(r.actor, key.name);
  }
  return names;
}

async function present(ctx: ReadCtx, rows: Doc<"auditLog">[], viewerActor: string) {
  const names = await keyNames(ctx, rows);
  const run = await latestRun(ctx);
  const okRun = run ? { lastVerifiedSeq: run.lastVerifiedSeq, at: run.at, ok: run.ok } : null;
  return rows.map((r) => ({
    id: r._id,
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    badge: actorBadge(r, { viewerActor, keyName: names.get(r.actor) }),
    channel: r.channel,
    requestId: r.requestId ?? null,
    action: r.action,
    description: describeAuditEntry(r),
    entity: r.entity,
    link: ENTITY_LINKS[r.entity.table]?.(r.entity.id) ?? null,
    reason: r.reason ?? null,
    diff: r.diff ? (maskEncrypted(r.diff) as { before?: unknown; after?: unknown }) : null,
    hash: r.hash.slice(0, 12),
    chain: chainStatus(r.seq, okRun),
  }));
}

export interface SearchArgs extends AuditFilter {
  preset?: AuditPreset | undefined;
  apiKeyActor?: string | undefined;
  /** Cursor: entries with seq < beforeSeq (newest first). */
  beforeSeq?: number | undefined;
  limit?: number | undefined;
}

function filterOf(args: SearchArgs, now: number): AuditFilter {
  const { preset, apiKeyActor, beforeSeq: _b, limit: _l, ...explicit } = args;
  return combineFilters(preset ? presetFilter(preset, now, apiKeyActor) : {}, explicit);
}

async function scan(ctx: ReadCtx, filter: AuditFilter, beforeSeq: number | undefined, limit: number) {
  const q = ctx.db
    .query("auditLog")
    .withIndex("by_seq", (i) => (beforeSeq !== undefined ? i.lt("seq", beforeSeq) : i))
    .order("desc");
  const out: Doc<"auditLog">[] = [];
  let scanned = 0;
  let lastSeq: number | null = null;
  for await (const r of q) {
    scanned++;
    lastSeq = r.seq;
    if (matchesFilter(r, filter)) out.push(r);
    if (out.length >= limit || scanned >= SCAN_LIMIT) break;
  }
  const done = lastSeq === null || lastSeq <= 1 || (out.length < limit && scanned < SCAN_LIMIT);
  return { rows: out, nextCursor: done ? null : lastSeq };
}

/** AUD-006 viewer: newest first, cursor by seq; scans at most 5 000 entries per page. */
export async function searchAudit(ctx: ReadCtx & { now: () => number; actor: string }, args: SearchArgs) {
  const filter = filterOf(args, ctx.now());
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const { rows, nextCursor } = await scan(ctx, filter, args.beforeSeq, limit);
  const head = await ctx.db.query("auditLog").withIndex("by_seq").order("desc").first();
  const run = await latestRun(ctx);
  return {
    entries: await present(ctx, rows, ctx.actor),
    nextCursor,
    head: head ? { seq: head.seq, hash: head.hash.slice(0, 12) } : null,
    lastRun: run ? { at: run.at, ok: run.ok, lastVerifiedSeq: run.lastVerifiedSeq } : null,
  };
}

/** AUD-007 „Verlauf": the entity's entries plus related records (invoice → payments, artifacts, send log). */
export async function entityHistory(
  ctx: ReadCtx & { actor: string },
  table: string,
  id: string,
): Promise<Awaited<ReturnType<typeof present>>> {
  const refs: { table: string; id: string }[] = [{ table, id }];
  if (table === "salesDocuments") {
    const docId = ctx.db.normalizeId("salesDocuments", id);
    if (docId) {
      for (const p of await ctx.db
        .query("payments")
        .withIndex("by_target", (q) => q.eq("target.kind", "salesDocument").eq("target.id", id))
        .collect()) {
        refs.push({ table: "payments", id: p._id });
      }
      for (const a of await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", docId))
        .collect()) {
        refs.push({ table: "documentArtifacts", id: a._id });
      }
      for (const s of await ctx.db
        .query("sendLog")
        .withIndex("by_document_at", (q) => q.eq("documentId", docId))
        .collect()) {
        refs.push({ table: "sendLog", id: s._id });
      }
    }
  }
  const rows: Doc<"auditLog">[] = [];
  for (const r of refs) {
    rows.push(
      ...(await ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", r.table).eq("entity.id", r.id))
        .collect()),
    );
  }
  rows.sort((a, b) => b.seq - a.seq);
  return present(ctx, rows.slice(0, 500), ctx.actor);
}

export const AUDIT_EXPORT_MAX = 20_000;

/** AUD-008 export (CSV/JSON incl. seq/hash/prevHash); the export itself is logged (AUD-009). */
export async function exportAudit(ctx: ModelCtx, args: SearchArgs & { format: "csv" | "json" }) {
  const filter = filterOf(args, ctx.now());
  const rows: Doc<"auditLog">[] = [];
  for await (const r of ctx.db.query("auditLog").withIndex("by_seq").order("asc")) {
    if (matchesFilter(r, filter)) rows.push(r);
    if (rows.length >= AUDIT_EXPORT_MAX) break;
  }
  const contiguous = rows.every((r, i) => i === 0 || r.seq === (rows[i - 1] as Doc<"auditLog">).seq + 1);
  const content =
    args.format === "csv"
      ? auditCsv(rows as unknown as ExportEntry[])
      : auditJson(rows as unknown as Record<string, unknown>[], {
          instance: instanceName(),
          exportedAt: ctx.now(),
          filter,
        });
  await appendAudit(ctx, {
    action: "export.audit",
    entity: { table: "auditLog", id: rows.length ? `${rows[0]?.seq}-${rows.at(-1)?.seq}` : "leer", label: args.format },
    diff: { after: { filter, count: rows.length, format: args.format, contiguous } },
  });
  const stamp = new Date(ctx.now()).toISOString().slice(0, 10);
  return {
    filename: `audit-log-${stamp}.${args.format}`,
    mime: args.format === "csv" ? "text/csv;charset=utf-8" : "application/json",
    content,
    count: rows.length,
    contiguous,
    truncated: rows.length >= AUDIT_EXPORT_MAX,
  };
}

/**
 * AUD-009: auditor access is logged on every request (the shell reports each page), and access to the settings
 * secrets screens (API keys, MCP, integrations) by anyone. Other reads are never logged.
 */
export async function recordAccess(ctx: ModelCtx, input: { path: string; secretScreen?: string }): Promise<boolean> {
  const path = input.path.slice(0, 300);
  if (ctx.role === "auditor") {
    const before = await ctx.db
      .query("auditLog")
      .withIndex("by_actor_at", (q) => q.eq("actor", ctx.actor))
      .filter((q) => q.eq(q.field("action"), "auditor.access"))
      .first();
    await appendAudit(ctx, { action: "auditor.access", entity: { table: "routes", id: path } });
    if (!before) {
      await notifyKind(ctx, "auditor.first_access", {
        title: `Prüferzugang erstmals genutzt (${ctx.actorContext.label ?? "Prüfer"})`,
        link: "/einstellungen/audit",
        dedupeKey: `auditor.first_access|${ctx.actor}`,
      });
    }
    return true;
  }
  if (input.secretScreen) {
    await appendAudit(ctx, {
      action: "security.secret_screen",
      entity: { table: "routes", id: path, label: input.secretScreen.slice(0, 60) },
    });
    return true;
  }
  return false;
}

export type AuditEntryView = Awaited<ReturnType<typeof present>>[number];

/**
 * F04 DOC-41 / 04 §1.4: the newest change by an API key or MCP key, for the shell's „Aktualisiert durch …" toast.
 * Scans the last 200 entries only (live toasts are about what just happened).
 */
export async function latestExternalChange(ctx: ReadCtx) {
  for (const r of await ctx.db.query("auditLog").withIndex("by_seq").order("desc").take(200)) {
    const kind = r.actor.slice(0, r.actor.indexOf(":"));
    if (kind !== "api-key" && kind !== "mcp") continue;
    const names = await keyNames(ctx, [r]);
    const badge = actorBadge(r, { keyName: names.get(r.actor) });
    return { seq: r.seq, at: r.at, text: `Aktualisiert durch ${badge.label}`, description: describeAuditEntry(r) };
  }
  return null;
}
