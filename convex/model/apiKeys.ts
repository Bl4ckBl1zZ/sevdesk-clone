import { matchingPreset } from "../../src/domain/api/scopes";
import { parseActor } from "../../src/domain/schemas/actor";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * API keys (05 §2.1, 03 §10). The only writer of `apiKeys` and `apiRequestLog`. Keys are never deleted (revocation
 * via `revokedAt`); the hash is redacted in the audit diff (AUD-003). `lastUsedAt` is a technical field
 * (src/domain/audit/technical.ts), debounced to once a minute.
 */
export const LAST_USED_DEBOUNCE_MS = 60_000;
export const ACCESS_LOG_RETENTION_MS = 90 * 24 * 3600_000;

export type ApiKeyDoc = Doc<"apiKeys">;

export async function keyByPublicId(ctx: ReadCtx, publicId: string): Promise<ApiKeyDoc | null> {
  return ctx.db
    .query("apiKeys")
    .withIndex("by_prefix", (q) => q.eq("prefix", publicId))
    .unique();
}

/** The key of the calling `api-key:`/`mcp:` actor (the wrapper has already verified it). */
export async function callerKey(ctx: ReadCtx & { actor: string }): Promise<ApiKeyDoc> {
  const { kind, id } = parseActor(ctx.actor);
  if (kind !== "api-key" && kind !== "mcp") throw appError("forbidden_scope", "Nur für API-Schlüssel.");
  const key = await keyByPublicId(ctx, id);
  if (!key) throw appError("key_revoked");
  return key;
}

export function keyStatus(k: ApiKeyDoc, now: number): "active" | "revoked" | "expired" {
  if (k.revokedAt !== undefined) return "revoked";
  if (k.expiresAt !== undefined && k.expiresAt <= now) return "expired";
  return "active";
}

export function keyView(k: ApiKeyDoc, now: number) {
  return {
    keyId: k._id,
    publicId: k.prefix,
    name: k.name,
    display: `sk_live_${k.prefix.slice(4)}…${k.last4}`,
    scopes: k.scopes,
    preset: matchingPreset(k.scopes),
    channel: k.channel,
    createdAt: k.createdAt,
    createdBy: k.createdBy,
    lastUsedAt: k.lastUsedAt ?? null,
    expiresAt: k.expiresAt ?? null,
    revokedAt: k.revokedAt ?? null,
    rateLimitPerMinute: k.rateLimitPerMinute ?? null,
    status: keyStatus(k, now),
  };
}

export interface NewApiKey {
  name: string;
  channel: "api" | "mcp" | "both";
  scopes: string[];
  prefix: string;
  last4: string;
  hash: string;
  expiresAt?: number;
  rateLimitPerMinute?: number;
}

/** 05 §2.1: insert a key created by the owner (the plaintext never reaches the database). */
export async function insertApiKey(ctx: ModelCtx, k: NewApiKey): Promise<Id<"apiKeys">> {
  if (!ctx.actor.startsWith("user:"))
    throw appError("forbidden_role", "API-Schlüssel legt nur die Inhaberin bzw. der Inhaber an.");
  if (await keyByPublicId(ctx, k.prefix)) {
    throw appError("conflict", "Schlüssel-ID bereits vergeben – bitte erneut versuchen.", {
      reason: "KEY_ID_COLLISION",
    });
  }
  return auditedInsert(
    ctx,
    "apiKeys",
    {
      name: k.name,
      prefix: k.prefix,
      last4: k.last4,
      hash: k.hash,
      scopes: k.scopes,
      channel: k.channel,
      createdAt: ctx.now(),
      createdBy: ctx.actor,
      ...(k.expiresAt !== undefined ? { expiresAt: k.expiresAt } : {}),
      ...(k.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: k.rateLimitPerMinute } : {}),
    },
    { action: "api_key.create", label: k.name },
  );
}

/** 05 §2.1, EC-186: revocation takes effect with the next request (every request re-reads the key). */
export async function revokeApiKey(ctx: ModelCtx, id: Id<"apiKeys">, reason?: string): Promise<void> {
  const k = await ctx.db.get(id);
  if (!k) throw appError("not_found", "API-Schlüssel nicht gefunden.");
  if (k.revokedAt !== undefined) return;
  await auditedPatch(
    ctx,
    "apiKeys",
    id,
    { revokedAt: ctx.now() },
    { action: "api_key.revoke", label: k.name, ...(reason ? { reason } : {}) },
  );
}

/** 05 §2.1 „Every request updates lastUsedAt (debounced: at most once a minute)". Technical, not audited. */
export async function touchLastUsed(ctx: ModelCtx, k: ApiKeyDoc): Promise<void> {
  const now = ctx.now();
  if (k.lastUsedAt !== undefined && now - k.lastUsedAt < LAST_USED_DEBOUNCE_MS) return;
  await ctx.db.patch("apiKeys", k._id, { lastUsedAt: now });
}

export interface AccessLogEntry {
  method: string;
  target: string;
  status: number;
  durationMs: number;
  requestId: string;
  code?: string;
}

/** 05 §7 access log: one technical row per request (no bodies, no client IP). */
export async function appendAccessLog(ctx: ModelCtx, k: ApiKeyDoc, e: AccessLogEntry): Promise<void> {
  const channel = ctx.actorContext.channel === "mcp" ? "mcp" : "api";
  await ctx.db.insert("apiRequestLog", {
    apiKeyId: k.prefix,
    channel,
    method: e.method.slice(0, 16),
    target: e.target.slice(0, 200),
    status: e.status,
    durationMs: Math.max(0, Math.round(e.durationMs)),
    requestId: e.requestId.slice(0, 100),
    ...(e.code ? { code: e.code.slice(0, 64) } : {}),
    ...(ctx.actorContext.client ? { client: ctx.actorContext.client } : {}),
    at: ctx.now(),
  });
}

export async function recentRequests(ctx: ReadCtx, publicId: string, limit: number) {
  return ctx.db
    .query("apiRequestLog")
    .withIndex("by_apiKey_at", (q) => q.eq("apiKeyId", publicId))
    .order("desc")
    .take(limit);
}

/** cron.api.cleanup: access log rows older than 90 days. */
export async function purgeAccessLog(ctx: ModelCtx, before: number, max: number): Promise<number> {
  const rows = await ctx.db
    .query("apiRequestLog")
    .withIndex("by_at", (q) => q.lt("at", before))
    .take(max);
  for (const r of rows) await ctx.db.delete("apiRequestLog", r._id);
  return rows.length;
}
