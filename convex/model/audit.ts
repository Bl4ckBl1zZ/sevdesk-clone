import { assertAuditAction } from "../../src/domain/audit/actions";
import { computeEntryHash, genesisHash } from "../../src/domain/audit/chain";
import { changedFields } from "../../src/domain/audit/immutability";
import { mapPersonalFields, personalContactId } from "../../src/domain/audit/personal";
import { redactSecrets } from "../../src/domain/audit/redact";
import { isActor } from "../../src/domain/schemas/actor";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { instanceName } from "../lib/env";
import { appError } from "../lib/errors";
import { personalEncryptor } from "./contactKeys";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Audit log writer (F12 AUD-001…AUD-005, 02 §4.6). The only code that inserts into `auditLog`.
 *
 * Entry pipeline: redact secrets (AUD-003) → encrypt personal fields per contact (crypto-shredding) →
 * read the chain head (by_seq desc) → seq + 1, prevHash = head.hash (genesis for seq 1) →
 * hash = SHA-256(prevHash ‖ JCS(entry)) → insert. Convex's serialisable transactions give a total order.
 */
export interface AuditInput {
  action: string;
  entity: { table: string; id: string; label?: string };
  diff?: { before?: unknown; after?: unknown };
  reason?: string;
}

export async function chainHead(ctx: ReadCtx): Promise<Doc<"auditLog"> | null> {
  return ctx.db.query("auditLog").withIndex("by_seq").order("desc").first();
}

export async function appendAudit(ctx: ModelCtx, input: AuditInput): Promise<Doc<"auditLog">> {
  assertAuditAction(input.action);
  const a = ctx.actorContext;
  if (!isActor(a.actor)) throw appError("invalid_input", `Ungültiger Akteur: ${a.actor}`);

  let diff = input.diff === undefined ? undefined : redactSecrets(input.diff);
  if (diff) {
    const contactId = personalContactId(
      input.entity.table,
      input.entity.id,
      diff as { before?: Record<string, unknown>; after?: Record<string, unknown> },
    );
    if (contactId) diff = await mapPersonalFields(input.entity.table, diff, await personalEncryptor(ctx, contactId));
  }

  const head = await chainHead(ctx);
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? (await genesisHash(instanceName()));
  const entry = {
    seq,
    prevHash,
    at: ctx.now(),
    actor: a.actor,
    ...(a.role ? { actorRole: a.role } : {}),
    ...(a.label ? { actorLabel: a.label } : {}),
    ...(a.client ? { client: a.client } : {}),
    channel: a.channel,
    ...(a.userAgent ? { userAgent: a.userAgent } : {}),
    ...(a.requestId ? { requestId: a.requestId } : {}),
    ...(a.sessionId ? { sessionId: a.sessionId } : {}),
    action: input.action,
    entity: input.entity,
    ...(diff ? { diff: stripUndefined(diff) as { before?: unknown; after?: unknown } } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  // TODO(P1, AUD-003): diffs > 64 KB go to file storage (`diffBlob`); mutations cannot store
  // files, so the blob must be written by an action first. P0 diffs are small (settings, members, invites).
  const hash = await computeEntryHash(prevHash, entry);
  const id = await ctx.db.insert("auditLog", { ...entry, hash });
  return { ...entry, hash, _id: id, _creationTime: 0 } as Doc<"auditLog">;
}

/** JSON round-trip semantics: drop `undefined` members (Convex rejects them, JCS omits them). */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    if (v !== undefined) out[k] = stripUndefined(v);
  return out;
}

const withoutSystem = (doc: Record<string, unknown>) => {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
};

/**
 * `updatedAt` sync stamps (05 §3 `updated_since`): a change of a contact, a product or one of their sub-records
 * stamps the root record. Technical field (src/domain/audit/technical.ts): not part of the audit diff.
 */
const SYNC_ROOTS: Partial<Record<TableNames, { root: "contacts" | "products"; via?: string }>> = {
  contacts: { root: "contacts" },
  contactAddresses: { root: "contacts", via: "contactId" },
  contactChannels: { root: "contacts", via: "contactId" },
  products: { root: "products" },
  customerPrices: { root: "products", via: "productId" },
};

async function touchSyncStamp(ctx: ModelCtx, table: TableNames, id: string, doc: Record<string, unknown> | null) {
  const rule = SYNC_ROOTS[table];
  if (!rule) return;
  const rootId = (rule.via ? doc?.[rule.via] : id) as Id<"contacts" | "products"> | undefined;
  if (!rootId) return;
  if (!(await ctx.db.get(rootId))) return;
  await ctx.db.patch(rule.root, rootId as never, { updatedAt: ctx.now() } as never);
}

/** Insert + audit entry with the full content (AUD-002: full content for creates). */
export async function auditedInsert<T extends TableNames>(
  ctx: ModelCtx,
  table: T,
  value: Omit<Doc<T>, "_id" | "_creationTime">,
  audit: { action: string; label?: string; reason?: string },
): Promise<Id<T>> {
  const id = await ctx.db.insert(table, value as never);
  await appendAudit(ctx, {
    action: audit.action,
    entity: { table, id, ...(audit.label ? { label: audit.label } : {}) },
    diff: { after: value },
    ...(audit.reason ? { reason: audit.reason } : {}),
  });
  await touchSyncStamp(ctx, table, id, value as Record<string, unknown>);
  return id as Id<T>;
}

/** Patch + audit entry with the changed fields only (AUD-002). A no-op patch writes nothing. */
export async function auditedPatch<T extends TableNames>(
  ctx: ModelCtx,
  table: T,
  id: Id<T>,
  patch: Partial<Omit<Doc<T>, "_id" | "_creationTime">>,
  audit: { action: string; label?: string; reason?: string },
): Promise<Doc<"auditLog"> | null> {
  const before = (await ctx.db.get(id)) as Record<string, unknown> | null;
  if (!before) throw appError("not_found");
  const changed = changedFields(before, { op: "patch", patch: patch as Record<string, unknown> });
  if (changed.size === 0) return null;
  await ctx.db.patch(table, id, patch as never);
  const diff = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const [field, [from, to]] of changed) {
    diff.before[field] = from;
    diff.after[field] = to;
  }
  const entry = await appendAudit(ctx, {
    action: audit.action,
    entity: { table, id, ...(audit.label ? { label: audit.label } : {}) },
    diff,
    ...(audit.reason ? { reason: audit.reason } : {}),
  });
  await touchSyncStamp(ctx, table, id, before);
  return entry;
}

/** Delete + audit entry with the deleted content (AUD-002: full content for draft deletions). */
export async function auditedDelete<T extends TableNames>(
  ctx: ModelCtx,
  table: T,
  id: Id<T>,
  audit: { action: string; label?: string; reason?: string },
): Promise<void> {
  const before = (await ctx.db.get(id)) as Record<string, unknown> | null;
  if (!before) throw appError("not_found");
  await ctx.db.delete(table, id);
  await appendAudit(ctx, {
    action: audit.action,
    entity: { table, id, ...(audit.label ? { label: audit.label } : {}) },
    diff: { before: withoutSystem(before) },
    ...(audit.reason ? { reason: audit.reason } : {}),
  });
  if (SYNC_ROOTS[table]?.via) await touchSyncStamp(ctx, table, id, before);
}
