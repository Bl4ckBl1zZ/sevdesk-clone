import { v } from "convex/values";
import { mutation } from "./functions";
import { callerKey } from "./model/apiKeys";
import { beginIdempotent, completeIdempotent, releaseIdempotent } from "./model/idempotency";

/**
 * `Idempotency-Key` on POST (05 §3): records per API key, 24 h. Called by the REST layer as the key's own actor.
 * The request hash is computed by `web` over method, path, query and the canonical JSON body.
 */
export const begin = mutation({
  permission: "apiKeys.self",
  args: { key: v.string(), requestHash: v.string() },
  handler: async (ctx, { key, requestHash }) => beginIdempotent(ctx, (await callerKey(ctx)).prefix, key, requestHash),
});

export const complete = mutation({
  permission: "apiKeys.self",
  args: { id: v.id("idempotencyKeys"), status: v.number(), body: v.string() },
  handler: async (ctx, { id, status, body }) =>
    completeIdempotent(ctx, id, (await callerKey(ctx)).prefix, status, body),
});

export const release = mutation({
  permission: "apiKeys.self",
  args: { id: v.id("idempotencyKeys") },
  handler: async (ctx, { id }) => releaseIdempotent(ctx, id, (await callerKey(ctx)).prefix),
});
