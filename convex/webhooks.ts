import { v } from "convex/values";
import { webhookEndpointCreateSchema, webhookEndpointUpdateSchema } from "../src/domain/schemas/webhooks";
import { normaliseSubscriptions } from "../src/domain/webhooks/events";
import { secretFromBytes, secretHint, SECRET_BYTES } from "../src/domain/webhooks/signature";
import { checkEndpointUrl } from "../src/domain/webhooks/url";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, actorMutation, mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { encryptSecret } from "./lib/secrets";
import {
  type AttemptResult,
  claimDelivery,
  deleteEndpoint,
  dueDeliveries,
  getEndpoint,
  insertEndpoint,
  listDeliveries,
  listEndpoints,
  endpointView,
  purgeWebhookLog,
  recordAttempt,
  replayDelivery,
  rollEndpointSecret,
  sendTestPing,
  updateEndpoint,
  webhookProduction,
} from "./model/webhooks";

/**
 * Outbound webhooks (05 §5): Einstellungen › Webhooks and REST `/webhook-endpoints` (owner, `webhooks:manage`), the
 * delivery worker's bookkeeping (`claim`, `record`; the HTTP call itself runs in convex/webhooksNode.ts) and the
 * sweep cron. Secrets are generated in actions (real randomness), stored AES-256-GCM encrypted and shown once.
 */

export const list = query({
  permission: "webhooks.read",
  args: {},
  handler: async (ctx) => listEndpoints(ctx, ctx.now()),
});

export const get = query({
  permission: "webhooks.read",
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, { endpointId }) => endpointView(await getEndpoint(ctx, endpointId), ctx.now()),
});

/** Delivery log of one endpoint (last 30 days, request/response snippets). */
export const deliveries = query({
  permission: "webhooks.read",
  args: { endpointId: v.id("webhookEndpoints"), limit: v.optional(v.number()) },
  handler: async (ctx, { endpointId, limit }) => {
    await getEndpoint(ctx, endpointId);
    return listDeliveries(ctx, endpointId, ctx.now(), limit ?? 100);
  },
});

async function newSecret(): Promise<{ secret: string; encryptedSecret: string; secretHint: string }> {
  const secret = secretFromBytes(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  return { secret, encryptedSecret: await encryptSecret(secret), secretHint: secretHint(secret) };
}

/** „Endpunkt hinzufügen": returns the `whsec_…` secret exactly once. */
export const create = action({
  permission: "webhooks.manage",
  args: { values: v.any() },
  handler: async (ctx, { values }): Promise<{ endpointId: Id<"webhookEndpoints">; secret: string }> => {
    const input = parse(webhookEndpointCreateSchema, values);
    // fail fast before encrypting; the model re-checks authoritatively
    const url = checkEndpointUrl(input.url, webhookProduction());
    if (!url.ok) throw appError("invalid_input", url.error, { field: "url" });
    const events = normaliseSubscriptions(input.events);
    if (!events.ok) throw appError("invalid_input", events.error, { field: "events" });
    const s = await newSecret();
    const endpointId: Id<"webhookEndpoints"> = await ctx.runMutation(internal.webhooks.insert, {
      actorContext: ctx.actorContext,
      url: url.url,
      ...(input.description ? { description: input.description } : {}),
      events: events.events,
      enabled: input.enabled,
      encryptedSecret: s.encryptedSecret,
      secretHint: s.secretHint,
    });
    return { endpointId, secret: s.secret };
  },
});

export const insert = actorMutation({
  permission: "webhooks.manage",
  args: {
    url: v.string(),
    description: v.optional(v.string()),
    events: v.array(v.string()),
    enabled: v.boolean(),
    encryptedSecret: v.string(),
    secretHint: v.string(),
  },
  handler: async (ctx, args) => insertEndpoint(ctx, args),
});

export const update = mutation({
  permission: "webhooks.manage",
  args: { endpointId: v.id("webhookEndpoints"), values: v.any() },
  handler: async (ctx, { endpointId, values }) => {
    const input = parse(webhookEndpointUpdateSchema, values);
    await updateEndpoint(ctx, endpointId, input);
    return endpointView(await getEndpoint(ctx, endpointId), ctx.now());
  },
});

export const remove = mutation({
  permission: "webhooks.manage",
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, { endpointId }) => deleteEndpoint(ctx, endpointId),
});

/** „Secret erneuern": the new secret is returned once; the old one stays valid (and signed with) for 24 h. */
export const rollSecret = action({
  permission: "webhooks.manage",
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, { endpointId }): Promise<{ secret: string; previousValidUntil: number }> => {
    const s = await newSecret();
    const r: { previousValidUntil: number } = await ctx.runMutation(internal.webhooks.storeRolledSecret, {
      actorContext: ctx.actorContext,
      endpointId,
      encryptedSecret: s.encryptedSecret,
      secretHint: s.secretHint,
    });
    return { secret: s.secret, previousValidUntil: r.previousValidUntil };
  },
});

export const storeRolledSecret = actorMutation({
  permission: "webhooks.manage",
  args: { endpointId: v.id("webhookEndpoints"), encryptedSecret: v.string(), secretHint: v.string() },
  handler: async (ctx, { endpointId, ...next }) => rollEndpointSecret(ctx, endpointId, next),
});

/** „Test senden": `test.ping` to this endpoint. */
export const sendTest = mutation({
  permission: "webhooks.manage",
  args: { endpointId: v.id("webhookEndpoints") },
  handler: async (ctx, { endpointId }) => ({ deliveryId: await sendTestPing(ctx, endpointId) }),
});

/** „Erneut senden": replays one delivery (same event, same `webhook-id`). */
export const replay = mutation({
  permission: "webhooks.manage",
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => ({ deliveryId: await replayDelivery(ctx, deliveryId) }),
});

// ── delivery worker (webhooksNode.deliver) ───────────────────────────────────────────────────────────

export const claim = systemMutation({
  job: "webhooks.deliver",
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => claimDelivery(ctx, deliveryId),
});

export const record = systemMutation({
  job: "webhooks.deliver",
  args: {
    deliveryId: v.id("webhookDeliveries"),
    status: v.union(v.number(), v.null()),
    error: v.optional(v.string()),
    durationMs: v.number(),
    responseSnippet: v.optional(v.string()),
    retryAfterMs: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { deliveryId, ...r }) => recordAttempt(ctx, deliveryId, r as AttemptResult),
});

/**
 * cron.webhooks.sweep (every 5 min): re-schedules due pending deliveries whose scheduled call was lost (crash
 * between commit and delivery) and purges the 30-day delivery log.
 */
export const sweep = systemMutation({
  job: "cron.webhooks.sweep",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return { scheduled: 0, purged: 0 };
    const now = ctx.now();
    const due = await dueDeliveries(ctx, now);
    for (const deliveryId of due) await ctx.scheduler.runAfter(0, internal.webhooksNode.deliver, { deliveryId });
    return { scheduled: due.length, purged: await purgeWebhookLog(ctx, now) };
  },
});
