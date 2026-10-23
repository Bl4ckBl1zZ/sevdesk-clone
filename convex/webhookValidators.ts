import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vActor } from "./validators";

/**
 * Outbound webhooks (05 §5, 03 §10 webhookEndpoints/webhookEvents/webhookDeliveries). Spread into schema.ts as
 * `webhookTables`. Deviations from 03 §10 are listed in 03 §12 „Webhooks 2026-10-23“:
 *  - endpoints keep the rolled secret for 24 h (`encryptedPreviousSecret`, `previousSecretExpiresAt`) and a display
 *    hint; `failingSince` / `lastSuccessAt` / `lastFailureAt` are technical fields (no audit per delivery);
 *  - events store the object and the changed fields as values (the body is rendered at delivery, `webhook-id` =
 *    `evt_<id>`); webhookEvents and webhookDeliveries are technical tables (src/domain/audit/technical.ts), purged
 *    after 30 days.
 * No table references `contacts`: payloads carry prefixed IDs and changed field names only (DSGVO coverage).
 */
export const vWebhookDisabledReason = v.union(v.literal("manual"), v.literal("gone"), v.literal("failing"));
export const vWebhookDeliveryStatus = v.union(
  v.literal("pending"),
  v.literal("success"),
  v.literal("failed"),
  v.literal("gave_up"),
  v.literal("cancelled"),
);

export const webhookTables = {
  webhookEndpoints: defineTable({
    url: v.string(),
    description: v.optional(v.string()),
    /** Subscribed event types, or `["*"]`. */
    events: v.array(v.string()),
    /** AES-256-GCM with APP_ENCRYPTION_KEY (02 §4.5); redacted in the audit diff. */
    encryptedSecret: v.string(),
    secretHint: v.string(),
    /** 05 §5.1 "Roll secret": the old secret stays valid (and signed with) for 24 h. */
    encryptedPreviousSecret: v.optional(v.string()),
    previousSecretExpiresAt: v.optional(v.number()),
    enabled: v.boolean(),
    disabledReason: v.optional(vWebhookDisabledReason),
    disabledAt: v.optional(v.number()),
    /** Technical: first failure of the current failure streak (3 days → disabled), last success / failure. */
    failingSince: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: vActor,
  }).index("by_enabled", ["enabled"]),

  webhookEvents: defineTable({
    type: v.string(),
    /** `data.object`: prefixed IDs, statuses, amounts — no personal values. */
    object: v.any(),
    /** `data.previous`: changed fields (names only for personal resources). */
    previous: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  webhookDeliveries: defineTable({
    eventId: v.id("webhookEvents"),
    endpointId: v.id("webhookEndpoints"),
    type: v.string(),
    status: vWebhookDeliveryStatus,
    /** Attempts made so far (1 immediate + 9 retries max). */
    attempts: v.number(),
    nextAttemptAt: v.optional(v.number()),
    /** A worker holds the delivery until then (no double sends between the scheduler and the sweep). */
    claimedUntil: v.optional(v.number()),
    lastAttemptAt: v.optional(v.number()),
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    requestSnippet: v.optional(v.string()),
    responseSnippet: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    /** „Erneut senden": the delivery this one replays. */
    replayOf: v.optional(v.id("webhookDeliveries")),
    createdAt: v.number(),
  })
    .index("by_endpoint_createdAt", ["endpointId", "createdAt"])
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_createdAt", ["createdAt"]),
};
