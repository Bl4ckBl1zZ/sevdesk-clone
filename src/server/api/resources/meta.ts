import "server-only";
import { z } from "zod";
import { publicHealthBody } from "@/domain/system/health";
import { cachedHealth } from "@/server/system/health";
import { defineEndpoint, defineResource } from "../endpoint";

const healthOut = z
  .object({ status: z.enum(["ok", "degraded"]), version: z.string() })
  .meta({ id: "Health", example: { status: "ok", version: "1.4.0" } });

const meOut = z
  .object({
    object: z.literal("api_key"),
    id: z.string().meta({ description: "Öffentliche Schlüssel-ID (key_…)" }),
    name: z.string(),
    channel: z.enum(["api", "mcp", "both"]),
    scopes: z.array(z.string()),
    expires_at: z.string().nullable(),
    created_at: z.string(),
    rate_limit: z.object({ per_minute: z.number().int(), limit: z.number().int(), remaining: z.number().int() }),
    server_time: z.string(),
    app_version: z.string(),
  })
  .meta({ id: "Me" });

const iso = (ms: number) => new Date(ms).toISOString();

/** 05 §4.8 meta endpoints. */
export const metaResource = defineResource("meta", "Status und Schlüsselinformationen", [
  defineEndpoint({
    method: "GET",
    path: "/health",
    operationId: "getHealth",
    summary: "Status",
    description: "Ohne Schlüssel: nur `{ status, version }` (keine Details, keine Hosts).",
    tag: "Meta",
    scope: "public",
    response: { status: 200, schema: healthOut, description: "Status" },
    handler: async () => {
      const report = await cachedHealth();
      return { body: publicHealthBody(report.checks, process.env.APP_VERSION ?? "dev") };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/me",
    operationId: "getMe",
    summary: "Aufrufender Schlüssel",
    description: "Name, Scopes und Rate-Limit des Schlüssels, Serverzeit und App-Version (jeder gültige Schlüssel).",
    tag: "Meta",
    scope: "any",
    response: { status: 200, schema: meOut, description: "Schlüsselinformationen" },
    handler: async ({ key }) => ({
      body: {
        object: "api_key",
        id: key.publicId,
        name: key.name,
        channel: key.channel,
        scopes: key.scopes,
        expires_at: key.expiresAt === null ? null : iso(key.expiresAt),
        created_at: iso(key.createdAt),
        rate_limit: {
          per_minute: key.rateLimitPerMinute,
          limit: key.rateLimit.limit,
          remaining: key.rateLimit.remaining,
        },
        server_time: new Date().toISOString(),
        app_version: process.env.APP_VERSION ?? "dev",
      },
    }),
  }),
]);
