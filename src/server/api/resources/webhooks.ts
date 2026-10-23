import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId, encodeOptionalId } from "@/domain/api/ids";
import { instant, prefixedId, toInstant, toOptionalInstant } from "@/domain/schemas/api/common";
import { webhookEndpointCreateSchema, webhookEndpointUpdateSchema } from "@/domain/schemas/webhooks";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, rawId } from "./shared";

/** Wire shape of `convex/model/webhooks.ts` EndpointView (camelCase there). */
interface EndpointRecord {
  endpointId: string;
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

interface DeliveryRecord {
  deliveryId: string;
  eventId: string;
  type: string;
  status: string;
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  requestSnippet: string | null;
  responseSnippet: string | null;
  replayOf: string | null;
  createdAt: number;
}

const nullableInstant = instant.nullable();

export const webhookEndpointOut = z
  .object({
    id: z.string(),
    object: z.literal("webhook_endpoint"),
    url: z.string(),
    description: z.string().nullable(),
    events: z.array(z.string()).meta({ description: "Abonnierte Ereignisse oder `*`" }),
    enabled: z.boolean(),
    disabled_reason: z.enum(["manual", "gone", "failing"]).nullable(),
    disabled_at: nullableInstant,
    secret_hint: z.string().meta({ description: "`whsec_…` plus die letzten vier Zeichen; das Secret selbst nie" }),
    secret_rolling_until: nullableInstant.meta({
      description: "Bis dahin wird zusätzlich mit dem alten Secret signiert",
    }),
    failing_since: nullableInstant,
    last_success_at: nullableInstant,
    last_failure_at: nullableInstant,
    created_at: instant,
  })
  .meta({ id: "WebhookEndpoint" });

const endpointWithSecret = webhookEndpointOut
  .extend({ secret: z.string().meta({ description: "`whsec_…` — wird nur in dieser Antwort gezeigt" }) })
  .meta({ id: "WebhookEndpointWithSecret" });

const deliveryOut = z
  .object({
    id: z.string(),
    object: z.literal("webhook_delivery"),
    event_id: z.string().meta({ description: "`evt_…` = Header `webhook-id`" }),
    type: z.string(),
    status: z.enum(["pending", "success", "failed", "gave_up", "cancelled"]),
    attempts: z.number().int(),
    next_attempt_at: nullableInstant,
    last_attempt_at: nullableInstant,
    http_status: z.number().int().nullable(),
    error: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    request_snippet: z.string().nullable(),
    response_snippet: z.string().nullable(),
    replay_of: z.string().nullable(),
    created_at: instant,
  })
  .meta({ id: "WebhookDelivery" });

const endpointList = z
  .object({ data: z.array(webhookEndpointOut), next_cursor: z.null() })
  .meta({ id: "WebhookEndpointList" });
const deliveryList = z
  .object({ data: z.array(deliveryOut), next_cursor: z.null() })
  .meta({ id: "WebhookDeliveryList" });

const deliveryQueued = z.object({ delivery_id: z.string() }).meta({ id: "WebhookDeliveryQueued" });
const createBody = webhookEndpointCreateSchema.strict().meta({ id: "WebhookEndpointCreateRequest" });
const patchBody = webhookEndpointUpdateSchema.strict().meta({ id: "WebhookEndpointPatchRequest" });
const deliveriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });
const deliveryParams = z.object({ id: prefixedId("webhookEndpoints"), delivery_id: prefixedId("webhookDeliveries") });

export function serializeEndpoint(e: EndpointRecord): z.output<typeof webhookEndpointOut> {
  return {
    id: encodeId("webhookEndpoints", e.endpointId),
    object: "webhook_endpoint",
    url: e.url,
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    disabled_reason: e.disabledReason,
    disabled_at: toOptionalInstant(e.disabledAt),
    secret_hint: e.secretHint,
    secret_rolling_until: toOptionalInstant(e.secretRollingUntil),
    failing_since: toOptionalInstant(e.failingSince),
    last_success_at: toOptionalInstant(e.lastSuccessAt),
    last_failure_at: toOptionalInstant(e.lastFailureAt),
    created_at: toInstant(e.createdAt),
  };
}

function serializeDelivery(d: DeliveryRecord): z.output<typeof deliveryOut> {
  return {
    id: encodeId("webhookDeliveries", d.deliveryId),
    object: "webhook_delivery",
    event_id: d.eventId,
    type: d.type,
    status: d.status as z.output<typeof deliveryOut>["status"],
    attempts: d.attempts,
    next_attempt_at: toOptionalInstant(d.nextAttemptAt),
    last_attempt_at: toOptionalInstant(d.lastAttemptAt),
    http_status: d.httpStatus,
    error: d.error,
    duration_ms: d.durationMs,
    request_snippet: d.requestSnippet,
    response_snippet: d.responseSnippet,
    replay_of: encodeOptionalId("webhookDeliveries", d.replayOf),
    created_at: toInstant(d.createdAt),
  };
}

async function loadEndpoint(convex: ConvexCaller, id: string) {
  const row = (await convex.query(api.webhooks.get, { endpointId: id })) as EndpointRecord | null;
  if (!row) throw new ApiProblem("not_found", { detail: "Webhook-Endpunkt nicht gefunden." });
  return serializeEndpoint(row);
}

const TAG = "Webhooks";
const SCOPE = "webhooks:manage" as const;

/**
 * 05 §5.1 outbound webhook endpoints (owner keys with `webhooks:manage`). This manages where the server SENDS
 * events — it is not an inbound webhook receiver (BNK-108: nothing calls in).
 */
export const webhooksResource = defineResource("webhook-endpoints", "Ausgehende Webhooks (Endpunkte)", [
  defineEndpoint({
    method: "GET",
    path: "/webhook-endpoints",
    operationId: "listWebhookEndpoints",
    summary: "Webhook-Endpunkte auflisten",
    tag: TAG,
    scope: SCOPE,
    response: { status: 200, schema: endpointList, description: "Alle Endpunkte (ohne Secrets)" },
    handler: async ({ convex }) => ({
      body: {
        data: ((await convex.query(api.webhooks.list, {})) as EndpointRecord[]).map(serializeEndpoint),
        next_cursor: null,
      },
    }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/webhook-endpoints",
    operationId: "createWebhookEndpoint",
    summary: "Webhook-Endpunkt anlegen",
    description:
      "HTTPS-URL (Produktion), Ereignisse oder `*`. Interne Adressen (localhost, private Netze, Link-Local, " +
      "Metadaten-Dienst) werden abgelehnt; Tailnet-Adressen sind erlaubt. Das Secret `whsec_…` steht nur in dieser Antwort.",
    tag: TAG,
    scope: SCOPE,
    body: createBody,
    response: { status: 201, schema: endpointWithSecret, description: "Angelegt, mit Secret (einmalig)" },
    errors: ["validation_failed", "idempotency_key_reused"],
    handler: async ({ convex, body }) => {
      const r = await convex.action(api.webhooks.create, { values: body });
      const endpoint = await loadEndpoint(convex, r.endpointId);
      return {
        status: 201,
        body: { ...endpoint, secret: r.secret },
        headers: { Location: `/api/v1/webhook-endpoints/${endpoint.id}` },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/webhook-endpoints/{id}",
    operationId: "getWebhookEndpoint",
    summary: "Webhook-Endpunkt abrufen",
    tag: TAG,
    scope: SCOPE,
    params: idParams("webhookEndpoints"),
    response: { status: 200, schema: webhookEndpointOut, description: "Der Endpunkt" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({ body: await loadEndpoint(convex, rawId("webhookEndpoints", params.id)) }),
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/webhook-endpoints/{id}",
    operationId: "updateWebhookEndpoint",
    summary: "Webhook-Endpunkt ändern",
    description: "URL, Beschreibung, Ereignisse, `enabled`. Wieder aktivieren setzt den Fehlerzähler zurück.",
    tag: TAG,
    scope: SCOPE,
    params: idParams("webhookEndpoints"),
    body: patchBody,
    response: { status: 200, schema: webhookEndpointOut, description: "Der geänderte Endpunkt" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("webhookEndpoints", params.id);
      const row = (await convex.mutation(api.webhooks.update, { endpointId: id, values: body })) as EndpointRecord;
      return { body: serializeEndpoint(row) };
    },
  }),
  defineEndpoint({
    method: "DELETE",
    path: "/webhook-endpoints/{id}",
    operationId: "deleteWebhookEndpoint",
    summary: "Webhook-Endpunkt löschen",
    description: "Offene Zustellungen werden abgebrochen.",
    tag: TAG,
    scope: SCOPE,
    params: idParams("webhookEndpoints"),
    response: { status: 204, description: "Gelöscht" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      await convex.mutation(api.webhooks.remove, { endpointId: rawId("webhookEndpoints", params.id) });
      return { status: 204 };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/webhook-endpoints/{id}/roll-secret",
    operationId: "rollWebhookSecret",
    summary: "Secret erneuern",
    description:
      "Neues Secret (nur in dieser Antwort); das alte bleibt 24 h gültig, bis dahin werden beide Signaturen gesendet.",
    tag: TAG,
    scope: SCOPE,
    params: idParams("webhookEndpoints"),
    response: {
      status: 200,
      schema: z.object({ secret: z.string(), previous_valid_until: instant }).meta({ id: "WebhookSecretRolled" }),
      description: "Neues Secret",
    },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      const r = await convex.action(api.webhooks.rollSecret, { endpointId: rawId("webhookEndpoints", params.id) });
      return { body: { secret: r.secret, previous_valid_until: toInstant(r.previousValidUntil) } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/webhook-endpoints/{id}/test",
    operationId: "testWebhookEndpoint",
    summary: "Test senden",
    description: "Sendet `test.ping` an diesen Endpunkt (ohne Wiederholungen).",
    tag: TAG,
    scope: SCOPE,
    params: idParams("webhookEndpoints"),
    response: {
      status: 202,
      schema: deliveryQueued,
      description: "Zustellung eingeplant",
    },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      const r = await convex.mutation(api.webhooks.sendTest, { endpointId: rawId("webhookEndpoints", params.id) });
      return { status: 202, body: { delivery_id: encodeId("webhookDeliveries", r.deliveryId) } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/webhook-endpoints/{id}/deliveries",
    operationId: "listWebhookDeliveries",
    summary: "Zustellprotokoll",
    description: "Die letzten 30 Tage, neueste zuerst, mit Anfrage- und Antwortauszug.",
    tag: TAG,
    scope: SCOPE,
    params: idParams("webhookEndpoints"),
    query: deliveriesQuery,
    response: { status: 200, schema: deliveryList, description: "Zustellungen" },
    errors: ["not_found"],
    handler: async ({ convex, params, query }) => {
      const rows = (await convex.query(api.webhooks.deliveries, {
        endpointId: rawId("webhookEndpoints", params.id),
        limit: query.limit,
      })) as DeliveryRecord[];
      return { body: { data: rows.map(serializeDelivery), next_cursor: null } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/webhook-endpoints/{id}/deliveries/{delivery_id}/replay",
    operationId: "replayWebhookDelivery",
    summary: "Erneut senden",
    description: "Stellt dasselbe Ereignis (gleiche `webhook-id`) noch einmal zu.",
    tag: TAG,
    scope: SCOPE,
    params: deliveryParams,
    response: {
      status: 202,
      schema: deliveryQueued,
      description: "Zustellung eingeplant",
    },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      const r = await convex.mutation(api.webhooks.replay, {
        endpointId: rawId("webhookEndpoints", params.id),
        deliveryId: rawId("webhookDeliveries", params.delivery_id),
      });
      return { status: 202, body: { delivery_id: encodeId("webhookDeliveries", r.deliveryId) } };
    },
  }),
]);
