import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import type { ModelCtx } from "./types";

/**
 * Idempotency records (05 §3 „Idempotency", 03 §10 `idempotencyKeys`). Technical table: one row per
 * (API key, Idempotency-Key), kept 24 h. `status: 0` marks a request that is still running.
 *
 *   begin → new (row reserved) | replay (same request hash, finished) | idempotency_key_reused (other hash)
 *         | idempotency_in_progress (same key, first request still running)
 *   complete → stores status + body; release → drops the reservation (5xx: the client may retry)
 */
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export type BeginResult =
  | { state: "new"; id: Id<"idempotencyKeys"> }
  | { state: "replay"; status: number; body: string };

export async function beginIdempotent(
  ctx: ModelCtx,
  apiKeyId: string,
  key: string,
  requestHash: string,
): Promise<BeginResult> {
  if (!KEY_RE.test(key)) {
    throw appError("invalid_input", "Idempotency-Key muss 1–255 druckbare ASCII-Zeichen lang sein.", {
      reason: "IDEMPOTENCY_KEY_INVALID",
      field: "Idempotency-Key",
    });
  }
  const now = ctx.now();
  const existing = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_apiKey_key", (q) => q.eq("apiKeyId", apiKeyId).eq("key", key))
    .unique();
  if (existing && existing.expiresAt <= now) {
    await ctx.db.delete("idempotencyKeys", existing._id);
  } else if (existing) {
    if (existing.requestHash !== requestHash) throw appError("idempotency_key_reused");
    if (existing.status === 0) throw appError("idempotency_in_progress");
    return { state: "replay", status: existing.status, body: existing.responseBody };
  }
  const id = await ctx.db.insert("idempotencyKeys", {
    apiKeyId,
    key,
    requestHash,
    status: 0,
    responseBody: "",
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  });
  return { state: "new", id };
}

async function ownRow(ctx: ModelCtx, id: Id<"idempotencyKeys">, apiKeyId: string) {
  const row = await ctx.db.get(id);
  if (!row || row.apiKeyId !== apiKeyId) throw appError("not_found");
  return row;
}

export async function completeIdempotent(
  ctx: ModelCtx,
  id: Id<"idempotencyKeys">,
  apiKeyId: string,
  status: number,
  body: string,
): Promise<void> {
  await ownRow(ctx, id, apiKeyId);
  await ctx.db.patch("idempotencyKeys", id, { status, responseBody: body.slice(0, 900_000) });
}

export async function releaseIdempotent(ctx: ModelCtx, id: Id<"idempotencyKeys">, apiKeyId: string): Promise<void> {
  await ownRow(ctx, id, apiKeyId);
  await ctx.db.delete("idempotencyKeys", id);
}

export async function purgeIdempotency(ctx: ModelCtx, now: number, max: number): Promise<number> {
  const rows = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
    .take(max);
  for (const r of rows) await ctx.db.delete("idempotencyKeys", r._id);
  return rows.length;
}
