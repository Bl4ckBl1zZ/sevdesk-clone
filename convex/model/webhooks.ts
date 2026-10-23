import {
  classifyAttempt,
  DELIVERY_LOG_RETENTION_MS,
  eventBody,
  nextAttemptDelay,
  SECRET_ROLL_OVERLAP_MS,
  shouldDisableForFailures,
  snippet,
} from "../../src/domain/webhooks/delivery";
import {
  documentEvent,
  endpointSubscribes,
  isReservedEventType,
  normaliseSubscriptions,
  type WebhookEventType,
} from "../../src/domain/webhooks/events";
import { encodeDocumentId } from "../../src/domain/api/ids";
import { contactObject, type DocumentLike, documentObject, refObject } from "../../src/domain/webhooks/objects";
import { checkEndpointUrl, isProductionSite } from "../../src/domain/webhooks/url";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { siteUrl } from "../lib/env";
import { appError } from "../lib/errors";
import { appendAudit, auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { notifyKind } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Outbound webhooks (05 §5). The only writer of webhookEndpoints, webhookEvents and webhookDeliveries.
 *
 * Outbox (05 §5.2): `emitEvent` is called by the model write paths in the SAME transaction as the state change. It
 * writes one event row and one pending delivery per subscribed, enabled endpoint and schedules the delivery worker
 * (convex/webhooksNode.ts). Convex commits the rows and the scheduled call atomically, and `cron.webhooks.sweep`
 * re-schedules due deliveries, so a crash between the commit and the delivery cannot lose an event. Without a
 * subscribed endpoint nothing is written. Portal events (F10) are reserved and refused.
 *
 * Event rows and the delivery log are technical (no audit per delivery) and are purged after 30 days; endpoint
 * changes, automatic disables, test pings and replays are audited (`webhook.*`).
 */
export type WebhookEndpointDoc = Doc<"webhookEndpoints">;

/** Lease of a claimed delivery: longer than the 15 s timeout plus DNS and the bookkeeping mutation. */
export const CLAIM_LEASE_MS = 60_000;

export const WEBHOOK_MESSAGES = {
  notFound: "Webhook-Endpunkt nicht gefunden.",
  deliveryNotFound: "Zustellung nicht gefunden.",
  reserved: "Portal-Ereignisse sind reserviert und werden nicht gesendet.",
  tooMany: "Höchstens 20 Webhook-Endpunkte.",
} as const;
const MAX_ENDPOINTS = 20;

// ── outbox ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Writes `type` to the outbox for every enabled endpoint that subscribes to it (in the caller's transaction).
 * `object`: prefixed IDs and non-personal state (src/domain/webhooks/objects.ts); `previous`: changed fields.
 */
export async function emitEvent(
  ctx: ModelCtx,
  type: WebhookEventType,
  object: Record<string, unknown>,
  previous?: Record<string, unknown>,
): Promise<Id<"webhookEvents"> | null> {
  if (isReservedEventType(type) || type === "test.ping") throw new Error(`webhook event ${type} is not emitted`);
  const endpoints = (
    await ctx.db
      .query("webhookEndpoints")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(MAX_ENDPOINTS)
  ).filter((e) => endpointSubscribes(e.events, type));
  if (endpoints.length === 0) return null;
  return enqueue(ctx, type, object, previous, endpoints);
}

/**
 * Sales-document events (F04 SND-15, F05 PAY-060): `<prefix>.<suffix>` for the document's type when the catalog has
 * it (`invoice.sent`, `quote.accepted`, `reminder.finalized`, …); a no-op for types without events.
 */
export async function emitDocumentEvent(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  suffix: string,
  previous?: Record<string, unknown>,
): Promise<Id<"webhookEvents"> | null> {
  const doc = await ctx.db.get(id);
  const type = doc ? documentEvent(doc.type, suffix) : null;
  if (!doc || !type) return null;
  return emitEvent(ctx, type, documentObject(doc as unknown as DocumentLike, ctx.now()), previous);
}

/** Contact events (F02 §7): the contact ID and the changed field NAMES only. */
export async function emitContactEvent(
  ctx: ModelCtx,
  type: Extract<WebhookEventType, `contact.${string}`>,
  contactId: Id<"contacts">,
  changedFields?: Iterable<string>,
): Promise<Id<"webhookEvents"> | null> {
  const fields = changedFields ? [...new Set(changedFields)].filter((f) => !f.startsWith("_")).sort() : [];
  return emitEvent(ctx, type, contactObject(contactId, ctx.now()), fields.length ? { changed_fields: fields } : undefined);
}

/** F05 PAY-060 `dunning_case.paused` / `dunning_case.handed_over`: case and invoice IDs, status, level. */
export async function emitDunningCaseEvent(
  ctx: ModelCtx,
  type: "dunning_case.paused" | "dunning_case.handed_over",
  caseId: Id<"dunningCases">,
  previous?: Record<string, unknown>,
): Promise<Id<"webhookEvents"> | null> {
  const c = await ctx.db.get(caseId);
  if (!c) return null;
  return emitEvent(
    ctx,
    type,
    refObject("dunningCases", caseId, "dunning_case", ctx.now(), {
      invoice_id: encodeDocumentId("invoice", c.invoiceId),
      status: c.status,
      level: c.currentLevel,
      paused_until: c.pausedUntil ?? null,
    }),
    previous,
  );
}

async function enqueue(
  ctx: ModelCtx,
  type: string,
  object: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  endpoints: readonly WebhookEndpointDoc[],
): Promise<Id<"webhookEvents">> {
  const now = ctx.now();
  const eventId = await ctx.db.insert("webhookEvents", {
    type,
    object,
    ...(previous && Object.keys(previous).length > 0 ? { previous } : {}),
    createdAt: now,
  });
  for (const ep of endpoints) await newDelivery(ctx, { eventId, endpointId: ep._id, type });
  return eventId;
}

async function newDelivery(
  ctx: ModelCtx,
  d: { eventId: Id<"webhookEvents">; endpointId: Id<"webhookEndpoints">; type: string; replayOf?: Id<"webhookDeliveries"> },
): Promise<Id<"webhookDeliveries">> {
  const now = ctx.now();
  const id = await ctx.db.insert("webhookDeliveries", {
    ...d,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.webhooksNode.deliver, { deliveryId: id });
  return id;
}

/** The public event id = the `webhook-id` header (stable per event, the receiver's idempotency key). */
export const publicEventId = (id: Id<"webhookEvents">) => `evt_${id}`;

// ── delivery worker bookkeeping ───────────────────────────────────────────────────────────────────────

export interface ClaimedDelivery {
  deliveryId: Id<"webhookDeliveries">;
  url: string;
  /** Encrypted secrets to sign with: current first, the rolled one while its 24 h overlap lasts. */
  encryptedSecrets: string[];
  msgId: string;
  body: string;
  attempt: number;
}

/**
 * Claims a due delivery for one attempt (serialisable: the scheduler and the sweep cannot both send it). Null when it
 * is not pending, not yet due, already claimed, or its endpoint is gone/disabled (then it is cancelled).
 */
export async function claimDelivery(
  ctx: ModelCtx,
  deliveryId: Id<"webhookDeliveries">,
): Promise<ClaimedDelivery | null> {
  const now = ctx.now();
  const d = await ctx.db.get(deliveryId);
  if (!d || d.status !== "pending") return null;
  if ((d.nextAttemptAt ?? 0) > now || (d.claimedUntil ?? 0) > now) return null;
  const [ep, event] = await Promise.all([ctx.db.get(d.endpointId), ctx.db.get(d.eventId)]);
  if (!ep || !event || (!ep.enabled && d.type !== "test.ping")) {
    await ctx.db.patch("webhookDeliveries", deliveryId, {
      status: "cancelled",
      error: !ep ? "Endpunkt gelöscht" : !event ? "Ereignis abgelaufen" : "Endpunkt deaktiviert",
      claimedUntil: undefined,
    });
    return null;
  }
  const body = JSON.stringify(
    eventBody({
      type: event.type,
      eventId: publicEventId(event._id),
      createdAt: event.createdAt,
      object: event.object as Record<string, unknown>,
      ...(event.previous ? { previous: event.previous as Record<string, unknown> } : {}),
    }),
  );
  await ctx.db.patch("webhookDeliveries", deliveryId, {
    claimedUntil: now + CLAIM_LEASE_MS,
    ...(d.requestSnippet ? {} : { requestSnippet: snippet(body) }),
  });
  const encryptedSecrets = [ep.encryptedSecret];
  if (ep.encryptedPreviousSecret && (ep.previousSecretExpiresAt ?? 0) > now) {
    encryptedSecrets.push(ep.encryptedPreviousSecret);
  }
  return { deliveryId, url: ep.url, encryptedSecrets, msgId: publicEventId(event._id), body, attempt: d.attempts + 1 };
}

export interface AttemptResult {
  /** HTTP status; null = network error, timeout or refused address. */
  status: number | null;
  error?: string;
  durationMs: number;
  responseSnippet?: string;
  retryAfterMs: number | null;
}

/**
 * Records one attempt (05 §5.1/§5.2): 2xx → success and the endpoint's failure streak ends; 410 → the endpoint is
 * disabled; otherwise the next attempt is scheduled (jitter, `Retry-After`) until the schedule ends (gave_up) or the
 * endpoint has failed for 3 days (disabled + owner notification). Returns the delay of the next attempt, if any.
 */
export async function recordAttempt(
  ctx: ModelCtx,
  deliveryId: Id<"webhookDeliveries">,
  r: AttemptResult,
  random: number = Math.random(),
): Promise<{ outcome: "success" | "gone" | "retry" | "gave_up" | "disabled" | "ignored"; retryInMs?: number }> {
  const now = ctx.now();
  const d = await ctx.db.get(deliveryId);
  if (!d || d.status !== "pending") return { outcome: "ignored" };
  const attempts = d.attempts + 1;
  const log = {
    attempts,
    lastAttemptAt: now,
    claimedUntil: undefined,
    durationMs: r.durationMs,
    httpStatus: r.status ?? undefined,
    error: r.error?.slice(0, 500),
    responseSnippet: snippet(r.responseSnippet),
  };
  const ep = await ctx.db.get(d.endpointId);
  const outcome = classifyAttempt(r.status);
  if (outcome === "success") {
    await ctx.db.patch("webhookDeliveries", deliveryId, { ...log, status: "success", nextAttemptAt: undefined });
    if (ep) await ctx.db.patch("webhookEndpoints", ep._id, { failingSince: undefined, lastSuccessAt: now });
    return { outcome };
  }
  if (outcome === "gone") {
    await ctx.db.patch("webhookDeliveries", deliveryId, { ...log, status: "failed", nextAttemptAt: undefined });
    if (ep?.enabled) await disableEndpoint(ctx, ep, "gone");
    return { outcome };
  }
  // A test ping is a one-shot check: it never retries and never counts towards the 3-day streak.
  if (d.type === "test.ping") {
    await ctx.db.patch("webhookDeliveries", deliveryId, { ...log, status: "failed", nextAttemptAt: undefined });
    return { outcome: "gave_up" };
  }
  const failingSince = ep?.failingSince ?? now;
  if (ep) await ctx.db.patch("webhookEndpoints", ep._id, { failingSince, lastFailureAt: now });
  if (ep?.enabled && shouldDisableForFailures(failingSince, now)) {
    await ctx.db.patch("webhookDeliveries", deliveryId, { ...log, status: "gave_up", nextAttemptAt: undefined });
    await disableEndpoint(ctx, ep, "failing");
    return { outcome: "disabled" };
  }
  const delay = nextAttemptDelay(attempts, random, r.retryAfterMs);
  if (delay === null) {
    await ctx.db.patch("webhookDeliveries", deliveryId, { ...log, status: "gave_up", nextAttemptAt: undefined });
    return { outcome: "gave_up" };
  }
  await ctx.db.patch("webhookDeliveries", deliveryId, { ...log, nextAttemptAt: now + delay });
  await ctx.scheduler.runAfter(delay, internal.webhooksNode.deliver, { deliveryId });
  return { outcome: "retry", retryInMs: delay };
}

const DISABLE_TEXT = {
  gone: "Der Empfänger hat mit 410 Gone geantwortet.",
  failing: "Zustellungen sind seit 3 Tagen fehlgeschlagen.",
} as const;

/** 05 §5.1: automatic disable (410 Gone, 3 days of failures) — audited, pending deliveries cancelled, owner notified. */
async function disableEndpoint(ctx: ModelCtx, ep: WebhookEndpointDoc, reason: "gone" | "failing"): Promise<void> {
  const now = ctx.now();
  await auditedPatch(
    ctx,
    "webhookEndpoints",
    ep._id,
    { enabled: false, disabledReason: reason, disabledAt: now },
    { action: "webhook.endpoint.disable", label: hostOf(ep.url), reason: DISABLE_TEXT[reason] },
  );
  await cancelPending(ctx, ep._id, "Endpunkt deaktiviert");
  await notifyKind(ctx, "webhook.disabled", {
    title: `Webhook deaktiviert: ${hostOf(ep.url)}`,
    body: `${DISABLE_TEXT[reason]} Bitte den Empfänger prüfen und den Endpunkt unter Einstellungen › Webhooks wieder aktivieren.`,
    link: "/einstellungen/webhooks",
    entity: { table: "webhookEndpoints", id: ep._id },
  });
}

async function cancelPending(ctx: ModelCtx, endpointId: Id<"webhookEndpoints">, why: string): Promise<void> {
  const rows = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_endpoint_createdAt", (q) => q.eq("endpointId", endpointId))
    .order("desc")
    .take(500);
  for (const r of rows) {
    if (r.status === "pending") {
      await ctx.db.patch("webhookDeliveries", r._id, { status: "cancelled", error: why, nextAttemptAt: undefined });
    }
  }
}

/** cron.webhooks.sweep: due pending deliveries whose scheduled call was lost (crash safety). */
export async function dueDeliveries(ctx: ReadCtx, now: number, limit = 100): Promise<Id<"webhookDeliveries">[]> {
  const rows = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_status_next", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
    .take(limit);
  return rows.filter((r) => (r.claimedUntil ?? 0) <= now).map((r) => r._id);
}

/** cron.webhooks.sweep: delivery log and outbox rows older than 30 days (05 §5.1). */
export async function purgeWebhookLog(ctx: ModelCtx, now: number, limit = 500): Promise<number> {
  const cutoff = now - DELIVERY_LOG_RETENTION_MS;
  let n = 0;
  const deliveries = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
    .take(limit);
  for (const d of deliveries) {
    if (d.status === "pending") continue;
    await ctx.db.delete("webhookDeliveries", d._id);
    n++;
  }
  const events = await ctx.db
    .query("webhookEvents")
    .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
    .take(limit);
  for (const e of events) {
    await ctx.db.delete("webhookEvents", e._id);
    n++;
  }
  return n;
}

// ── endpoints (Einstellungen › Webhooks, /webhook-endpoints) ─────────────────────────────────────────

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

export function webhookProduction(): boolean {
  return isProductionSite(siteUrl());
}

/** URL and subscriptions as the model accepts them (the action checks the same before encrypting). */
export function checkEndpointInput(input: { url: string; events: readonly string[] }): { url: string; events: string[] } {
  const url = checkEndpointUrl(input.url, webhookProduction());
  if (!url.ok) throw appError("invalid_input", url.error, { field: "url" });
  const events = normaliseSubscriptions(input.events);
  if (!events.ok) throw appError("invalid_input", events.error, { field: "events" });
  return { url: url.url, events: events.events };
}

export interface EndpointView {
  endpointId: Id<"webhookEndpoints">;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  disabledReason: "manual" | "gone" | "failing" | null;
  disabledAt: number | null;
  secretHint: string;
  secretRollingUntil: number | null;
  failingSince: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  createdAt: number;
}

export function endpointView(ep: WebhookEndpointDoc, now: number): EndpointView {
  return {
    endpointId: ep._id,
    url: ep.url,
    description: ep.description ?? null,
    events: ep.events,
    enabled: ep.enabled,
    disabledReason: ep.disabledReason ?? null,
    disabledAt: ep.disabledAt ?? null,
    secretHint: ep.secretHint,
    secretRollingUntil:
      ep.encryptedPreviousSecret && (ep.previousSecretExpiresAt ?? 0) > now ? (ep.previousSecretExpiresAt ?? null) : null,
    failingSince: ep.failingSince ?? null,
    lastSuccessAt: ep.lastSuccessAt ?? null,
    lastFailureAt: ep.lastFailureAt ?? null,
    createdAt: ep.createdAt,
  };
}

export async function listEndpoints(ctx: ReadCtx, now: number): Promise<EndpointView[]> {
  const rows = await ctx.db.query("webhookEndpoints").order("desc").take(MAX_ENDPOINTS * 5);
  return rows.map((r) => endpointView(r, now));
}

export async function getEndpoint(ctx: ReadCtx, id: Id<"webhookEndpoints">): Promise<WebhookEndpointDoc> {
  const ep = await ctx.db.get(id);
  if (!ep) throw appError("not_found", WEBHOOK_MESSAGES.notFound);
  return ep;
}

export async function insertEndpoint(
  ctx: ModelCtx,
  input: { url: string; description?: string; events: string[]; enabled: boolean; encryptedSecret: string; secretHint: string },
): Promise<Id<"webhookEndpoints">> {
  const { url, events } = checkEndpointInput(input);
  const count = (await ctx.db.query("webhookEndpoints").take(MAX_ENDPOINTS + 1)).length;
  if (count >= MAX_ENDPOINTS) throw appError("invalid_input", WEBHOOK_MESSAGES.tooMany);
  const description = input.description?.trim();
  return auditedInsert(
    ctx,
    "webhookEndpoints",
    {
      url,
      ...(description ? { description: description.slice(0, 500) } : {}),
      events,
      encryptedSecret: input.encryptedSecret,
      secretHint: input.secretHint,
      enabled: input.enabled,
      ...(input.enabled ? {} : { disabledReason: "manual" as const }),
      createdAt: ctx.now(),
      createdBy: ctx.actor,
    },
    { action: "webhook.endpoint.create", label: hostOf(url) },
  );
}

export async function updateEndpoint(
  ctx: ModelCtx,
  id: Id<"webhookEndpoints">,
  input: { url?: string; description?: string | null; events?: string[]; enabled?: boolean },
): Promise<void> {
  const ep = await getEndpoint(ctx, id);
  const checked = checkEndpointInput({ url: input.url ?? ep.url, events: input.events ?? ep.events });
  const patch: Partial<WebhookEndpointDoc> = { url: checked.url, events: checked.events };
  if (input.description !== undefined) {
    const d = input.description?.trim();
    patch.description = d ? d.slice(0, 500) : undefined;
  }
  if (input.enabled === true && !ep.enabled) {
    // re-enabling starts a new failure streak
    Object.assign(patch, { enabled: true, disabledReason: undefined, disabledAt: undefined, failingSince: undefined });
  } else if (input.enabled === false && ep.enabled) {
    Object.assign(patch, { enabled: false, disabledReason: "manual", disabledAt: ctx.now() });
  }
  await auditedPatch(ctx, "webhookEndpoints", id, patch, { action: "webhook.endpoint.update", label: hostOf(checked.url) });
  if (patch.enabled === false) await cancelPending(ctx, id, "Endpunkt deaktiviert");
}

export async function deleteEndpoint(ctx: ModelCtx, id: Id<"webhookEndpoints">): Promise<void> {
  const ep = await getEndpoint(ctx, id);
  await cancelPending(ctx, id, "Endpunkt gelöscht");
  await auditedDelete(ctx, "webhookEndpoints", id, { action: "webhook.endpoint.delete", label: hostOf(ep.url) });
}

/** 05 §5.1 „Secret erneuern": the old secret stays valid for 24 h and is signed with as well. */
export async function rollEndpointSecret(
  ctx: ModelCtx,
  id: Id<"webhookEndpoints">,
  next: { encryptedSecret: string; secretHint: string },
): Promise<{ previousValidUntil: number }> {
  const ep = await getEndpoint(ctx, id);
  const until = ctx.now() + SECRET_ROLL_OVERLAP_MS;
  await auditedPatch(
    ctx,
    "webhookEndpoints",
    id,
    {
      encryptedSecret: next.encryptedSecret,
      secretHint: next.secretHint,
      encryptedPreviousSecret: ep.encryptedSecret,
      previousSecretExpiresAt: until,
    },
    { action: "webhook.endpoint.roll_secret", label: hostOf(ep.url) },
  );
  return { previousValidUntil: until };
}

/** „Test senden": a `test.ping` to this one endpoint (also while disabled, to check a receiver before enabling). */
export async function sendTestPing(ctx: ModelCtx, id: Id<"webhookEndpoints">): Promise<Id<"webhookDeliveries">> {
  const ep = await getEndpoint(ctx, id);
  const now = ctx.now();
  const eventId = await ctx.db.insert("webhookEvents", {
    type: "test.ping",
    object: { object: "test", message: "Testereignis aus Einstellungen › Webhooks", endpoint_url: ep.url, updated_at: new Date(now).toISOString() },
    createdAt: now,
  });
  const deliveryId = await newDelivery(ctx, { eventId, endpointId: id, type: "test.ping" });
  await appendAudit(ctx, { action: "webhook.endpoint.test", entity: { table: "webhookEndpoints", id, label: hostOf(ep.url) } });
  return deliveryId;
}

/** „Erneut senden": a new delivery of the same event (same `webhook-id`) to the same endpoint. */
export async function replayDelivery(
  ctx: ModelCtx,
  deliveryId: Id<"webhookDeliveries">,
): Promise<Id<"webhookDeliveries">> {
  const d = await ctx.db.get(deliveryId);
  if (!d) throw appError("not_found", WEBHOOK_MESSAGES.deliveryNotFound);
  const ep = await getEndpoint(ctx, d.endpointId);
  if (!(await ctx.db.get(d.eventId))) throw appError("not_found", WEBHOOK_MESSAGES.deliveryNotFound);
  const id = await newDelivery(ctx, { eventId: d.eventId, endpointId: d.endpointId, type: d.type, replayOf: deliveryId });
  await appendAudit(ctx, {
    action: "webhook.delivery.replay",
    entity: { table: "webhookEndpoints", id: ep._id, label: `${hostOf(ep.url)} · ${d.type}` },
  });
  return id;
}

export interface DeliveryView {
  deliveryId: Id<"webhookDeliveries">;
  eventId: string;
  type: string;
  status: Doc<"webhookDeliveries">["status"];
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  requestSnippet: string | null;
  responseSnippet: string | null;
  replayOf: Id<"webhookDeliveries"> | null;
  createdAt: number;
}

/** Delivery log of one endpoint: the last 30 days (05 §5.1). */
export async function listDeliveries(
  ctx: ReadCtx,
  endpointId: Id<"webhookEndpoints">,
  now: number,
  limit = 100,
): Promise<DeliveryView[]> {
  const rows = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_endpoint_createdAt", (q) =>
      q.eq("endpointId", endpointId).gte("createdAt", now - DELIVERY_LOG_RETENTION_MS),
    )
    .order("desc")
    .take(Math.min(Math.max(limit, 1), 200));
  return rows.map((d) => ({
    deliveryId: d._id,
    eventId: publicEventId(d.eventId),
    type: d.type,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.status === "pending" ? (d.nextAttemptAt ?? null) : null,
    lastAttemptAt: d.lastAttemptAt ?? null,
    httpStatus: d.httpStatus ?? null,
    error: d.error ?? null,
    durationMs: d.durationMs ?? null,
    requestSnippet: d.requestSnippet ?? null,
    responseSnippet: d.responseSnippet ?? null,
    replayOf: d.replayOf ?? null,
    createdAt: d.createdAt,
  }));
}
