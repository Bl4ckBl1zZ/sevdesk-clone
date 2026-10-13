import "server-only";
import { z } from "zod";
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponseObject,
} from "zod-openapi";
import { PROBLEMS, type ProblemCode } from "@/domain/api/problems";
import { problemSchema } from "@/domain/schemas/api/common";
import { API_BASE_PATH } from "./api/dispatch";
import type { AnyEndpoint, Resource } from "./api/endpoint";
import { RESOURCES } from "./api/resources";

/**
 * OpenAPI 3.1 document of /api/v1 (05 §7), generated from the endpoint registry and the shared zod schemas
 * (`.meta({ id, description, example })`). Served at /api/openapi.json, rendered by Scalar at /api/docs, and
 * snapshot-checked in CI (`pnpm openapi:check`).
 */
const GENERIC: readonly ProblemCode[] = ["unauthorized", "rate_limited", "internal_error"];

const problemContent = { "application/problem+json": { schema: problemSchema } };

const rateHeaders = z.object({
  "RateLimit-Limit": z.string().meta({ description: "Bucket-Größe" }),
  "RateLimit-Remaining": z.string().meta({ description: "Verbleibende Anfragen" }),
  "RateLimit-Reset": z.string().meta({ description: "Sekunden bis zum vollen Bucket" }),
  "X-Request-Id": z.string(),
});

function operation(e: AnyEndpoint): ZodOpenApiOperationObject {
  const codes = new Set<ProblemCode>([
    ...(e.scope === "public" ? [] : GENERIC),
    ...(typeof e.scope === "string" && e.scope !== "public" && e.scope !== "any"
      ? (["insufficient_scope"] as const)
      : []),
    ...(Array.isArray(e.scope) ? (["insufficient_scope"] as const) : []),
    ...(e.body ? (["validation_failed", "unsupported_media_type", "bad_request"] as const) : []),
    ...(e.errors ?? []),
  ]);
  const byStatus = new Map<number, ProblemCode[]>();
  for (const c of codes) byStatus.set(PROBLEMS[c].status, [...(byStatus.get(PROBLEMS[c].status) ?? []), c]);
  const responses: Record<string, ZodOpenApiResponseObject> = {
    [e.response.status]: {
      description: e.response.description,
      ...(e.response.schema ? { content: { "application/json": { schema: e.response.schema } } } : {}),
      ...(e.scope === "public" ? {} : { headers: rateHeaders }),
    },
  };
  for (const [status, list] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    responses[String(status)] = {
      description: list.map((c) => `\`${c}\` – ${PROBLEMS[c].de}`).join("; "),
      content: problemContent,
    };
  }
  const scopeText =
    e.scope === "public"
      ? "Ohne Schlüssel."
      : e.scope === "any"
        ? "Jeder gültige Schlüssel."
        : `Scope: \`${typeof e.scope === "string" ? e.scope : e.scope.join("` oder `")}\`.`;
  const idempotency =
    e.method === "POST"
      ? z.object({
          "Idempotency-Key": z
            .string()
            .optional()
            .meta({ description: "24 h je Schlüssel; gleicher Body → gleiche Antwort (Idempotent-Replayed: true)" }),
        })
      : undefined;
  const ifMatch =
    e.method === "PATCH"
      ? z.object({ "If-Match": z.string().optional().meta({ description: "Erwartete Version" }) })
      : undefined;
  const header = idempotency ?? ifMatch;
  return {
    operationId: e.operationId,
    summary: e.summary,
    description: [e.description, scopeText].filter(Boolean).join("\n\n"),
    tags: [e.tag],
    ...(e.scope === "public" ? { security: [] } : {}),
    requestParams: {
      ...(e.params ? { path: e.params as z.ZodObject } : {}),
      ...(e.query ? { query: e.query as z.ZodObject } : {}),
      ...(header ? { header } : {}),
    },
    ...(e.body ? { requestBody: { required: true, content: { "application/json": { schema: e.body } } } } : {}),
    responses: responses as ZodOpenApiOperationObject["responses"],
  };
}

export function buildOpenApi(resources: readonly Resource[] = RESOURCES, version = process.env.APP_VERSION ?? "1.0.0") {
  const paths: ZodOpenApiPathsObject = {};
  for (const r of resources) {
    for (const e of r.endpoints) {
      const path = `${API_BASE_PATH}${e.path}`;
      paths[path] = { ...(paths[path] ?? {}), [e.method.toLowerCase()]: operation(e) };
    }
  }
  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "Rechnungen API",
      version,
      description:
        "REST-API (05-api). Nur im Tailnet erreichbar: `https://api.<BASE_DOMAIN>/api/v1` (Port 8443 für Website-Server). Authentifizierung mit `Authorization: Bearer sk_live_…` oder `X-API-Key`; Schlüssel in der URL werden abgelehnt. Fehler als RFC 9457 problem+json.",
    },
    servers: [{ url: "/", description: "Dieser Server" }],
    security: [{ bearer: [] }, { apiKey: [] }],
    tags: [...new Set(resources.flatMap((r) => r.endpoints.map((e) => e.tag)))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "sk_live_…" },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    paths,
  });
}
