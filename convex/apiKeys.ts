import { v } from "convex/values";
import { apiKeyFromBytes, hashApiKey, parseApiKey } from "../src/domain/api/keys";
import { keyRateLimit, rateLimitState } from "../src/domain/api/rate-limit";
import { apiKeyCreateSchema, validateExpiry } from "../src/domain/schemas/api-keys";
import { berlinCalendarDate, berlinEndOfDay } from "../src/domain/time/berlin";
import { calendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import { action, actorMutation, mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { appError, errorCode } from "./lib/errors";
import { parse } from "./lib/parse";
import { rateLimiter } from "./lib/rateLimits";
import {
  ACCESS_LOG_RETENTION_MS,
  appendAccessLog,
  callerKey,
  insertApiKey,
  keyView,
  purgeAccessLog,
  recentRequests,
  revokeApiKey,
  touchLastUsed,
} from "./model/apiKeys";
import { purgeConfirmTokens } from "./model/confirmTokens";
import { purgeIdempotency } from "./model/idempotency";

/**
 * API keys (05 §2, 02 §4.4). Owner functions for Einstellungen › API / MCP (list, create with a fresh session,
 * revoke) and the per-request functions of the REST/MCP layer (`authorize`, `logRequest`) that run as the key's own
 * actor (`apiKeys.self`). Keys are generated in an action (real randomness); only the SHA-256 is stored.
 */

export const list = query({
  permission: "apiKeys.read",
  args: {},
  handler: async (ctx) => {
    const now = ctx.now();
    const keys = await ctx.db.query("apiKeys").order("desc").take(500);
    return keys.map((k) => keyView(k, now)).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Last requests of one key (Einstellungen › API detail; access log, 05 §7). */
export const requests = query({
  permission: "apiKeys.read",
  args: { keyId: v.id("apiKeys") },
  handler: async (ctx, { keyId }) => {
    const k = await ctx.db.get(keyId);
    if (!k) throw appError("not_found", "API-Schlüssel nicht gefunden.");
    return (await recentRequests(ctx, k.prefix, 50)).map((r) => ({
      at: r.at,
      method: r.method,
      target: r.target,
      status: r.status,
      durationMs: r.durationMs,
      channel: r.channel,
      requestId: r.requestId,
    }));
  },
});

export const insert = actorMutation({
  permission: "apiKeys.manage",
  args: {
    name: v.string(),
    channel: v.union(v.literal("api"), v.literal("mcp"), v.literal("both")),
    scopes: v.array(v.string()),
    prefix: v.string(),
    last4: v.string(),
    hash: v.string(),
    expiresAt: v.optional(v.number()),
    rateLimitPerMinute: v.optional(v.number()),
  },
  handler: async (ctx, args) => insertApiKey(ctx, args),
});

/**
 * „API-Schlüssel erstellen" (05 §2.1): owner only with a fresh session (02 §4.2, permission `apiKeys.manage`).
 * Returns the plaintext key exactly once.
 */
export const create = action({
  permission: "apiKeys.manage",
  args: { values: v.any() },
  handler: async (ctx, { values }): Promise<{ key: string; publicId: string; display: string }> => {
    const input = parse(apiKeyCreateSchema, values);
    const today = berlinCalendarDate(Date.now());
    const expiryError = validateExpiry(input.expiresOn, today);
    if (expiryError) throw appError("invalid_input", expiryError, { field: "expiresOn", reason: "EXPIRY_PAST" });
    for (let attempt = 0; ; attempt++) {
      const key = apiKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const parsed = parseApiKey(key);
      if (!parsed) throw new Error("generated key does not parse");
      try {
        await ctx.runMutation(internal.apiKeys.insert, {
          actorContext: ctx.actorContext,
          name: input.name,
          channel: input.channel,
          scopes: input.scopes,
          prefix: parsed.publicId,
          last4: parsed.last4,
          hash: await hashApiKey(key),
          ...(input.expiresOn ? { expiresAt: berlinEndOfDay(calendarDate(input.expiresOn)) } : {}),
          ...(input.rateLimitPerMinute ? { rateLimitPerMinute: Number(input.rateLimitPerMinute) } : {}),
        });
        return { key, publicId: parsed.publicId, display: parsed.display };
      } catch (e) {
        if (errorCode(e) !== "conflict" || attempt >= 2) throw e;
      }
    }
  },
});

/** 05 §2.1 / EC-186: revoke immediately (no re-authentication needed). */
export const revoke = mutation({
  permission: "apiKeys.revoke",
  args: { keyId: v.id("apiKeys"), reason: v.optional(v.string()) },
  handler: async (ctx, { keyId, reason }) => revokeApiKey(ctx, keyId, reason?.trim() || undefined),
});

/**
 * First call of every REST/MCP request (05 §7 `withApi`): the wrapper has verified the key (hash, revocation,
 * expiry, channel); this consumes one token of the key's bucket (05 §3, never per IP), stamps `lastUsedAt` and
 * returns what `web` needs for the scope check and the RateLimit-* headers.
 */
export const authorize = mutation({
  permission: "apiKeys.self",
  args: {},
  handler: async (ctx) => {
    const key = await callerKey(ctx);
    const config = keyRateLimit(key.rateLimitPerMinute);
    const name = `apiKey:${key.prefix}`;
    const res = await rateLimiter.limit(ctx, name, { config });
    const value = await rateLimiter.getValue(ctx, name, { config });
    await touchLastUsed(ctx, key);
    return {
      publicId: key.prefix,
      name: key.name,
      channel: key.channel,
      scopes: key.scopes,
      expiresAt: key.expiresAt ?? null,
      createdAt: key.createdAt,
      rateLimitPerMinute: config.rate,
      rateLimit: rateLimitState(config, {
        ok: res.ok,
        value: value.value,
        ...(res.retryAfter !== undefined ? { retryAfterMs: res.retryAfter } : {}),
      }),
    };
  },
});

/** Last call of every request: one access-log row (05 §7; technical, no bodies, no IP). */
export const logRequest = mutation({
  permission: "apiKeys.self",
  args: {
    method: v.string(),
    target: v.string(),
    status: v.number(),
    durationMs: v.number(),
    requestId: v.string(),
    code: v.optional(v.string()),
  },
  handler: async (ctx, args) => appendAccessLog(ctx, await callerKey(ctx), args),
});

/** cron.api.cleanup (hourly): expired idempotency records and confirm tokens, access-log rows > 90 days. */
export const cleanupCron = systemMutation({
  job: "cron.api.cleanup",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return { idempotency: 0, confirmTokens: 0, accessLog: 0 };
    const now = ctx.now();
    return {
      idempotency: await purgeIdempotency(ctx, now, 2000),
      confirmTokens: await purgeConfirmTokens(ctx, now, 2000),
      accessLog: await purgeAccessLog(ctx, now - ACCESS_LOG_RETENTION_MS, 2000),
    };
  },
});
