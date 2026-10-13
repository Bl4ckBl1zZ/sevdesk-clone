import "server-only";
import { api } from "@convex/_generated/api";
import { createMcpHandler } from "mcp-handler";
import { preferredLang } from "@/domain/api/problems";
import { authenticate } from "../api/auth";
import type { ConvexCaller } from "../api/backend";
import { problemResponse, type ResponseContext, requestIdFrom, typeBaseFor } from "../api/http";
import { INSTRUCTIONS, registerSurface, SERVER_INFO } from "./server";

/**
 * /api/mcp (06 §1): stateless Streamable HTTP (MCP 2026-07-28 with the 2025 fallback) via mcp-handler. Per request:
 * Origin check (DNS rebinding), API key → `mcp:<keyId>` principal (same key store, scopes and per-key rate limit as
 * REST), a fresh server with only the tools the key's scopes allow, and an access-log row. No client IP is used.
 */
function allowedOrigins(): Set<string> {
  return new Set(
    [process.env.API_ORIGIN, process.env.SITE_URL, process.env.NEXT_PUBLIC_SITE_URL]
      .filter((x): x is string => Boolean(x))
      .map((x) => new URL(x).origin),
  );
}

interface RpcPeek {
  label: string;
  client?: { name: string; version: string };
}

async function peek(request: Request): Promise<RpcPeek> {
  if (request.method !== "POST") return { label: request.method };
  try {
    const body = (await request.clone().json()) as {
      method?: string;
      params?: { name?: string; clientInfo?: { name?: string; version?: string }; _meta?: Record<string, unknown> };
    };
    const metaClient = Object.entries(body.params?._meta ?? {}).find(([k]) => k.endsWith("clientInfo"))?.[1] as
      | { name?: string; version?: string }
      | undefined;
    const info = body.params?.clientInfo ?? metaClient;
    const label = [body.method, body.params?.name].filter(Boolean).join(" ") || "batch";
    return {
      label,
      ...(info?.name
        ? { client: { name: String(info.name).slice(0, 80), version: String(info.version ?? "").slice(0, 40) } }
        : {}),
    };
  } catch {
    return { label: "invalid" };
  }
}

function clientFromUserAgent(ua: string | null): { name: string; version: string } | undefined {
  const m = ua ? /^([\w.-]+)\/([\w.+-]+)/.exec(ua) : null;
  return m?.[1] && m[2] ? { name: m[1], version: m[2] } : undefined;
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const started = Date.now();
  const ctx: ResponseContext = {
    requestId: requestIdFrom(request.headers),
    lang: preferredLang(request.headers.get("accept-language")),
    typeBase: typeBaseFor(request),
    headers: {},
  };
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins().has(origin)) {
    return problemResponse("insufficient_scope", ctx, { detail: "Origin nicht erlaubt (DNS-Rebinding-Schutz)." });
  }
  const rpc = await peek(request);
  const client = rpc.client ?? clientFromUserAgent(request.headers.get("user-agent"));
  const auth = await authenticate(request, "mcp", ctx, client ? { client } : {});
  let convex: ConvexCaller | undefined;
  let response: Response;
  if (!auth.ok) {
    convex = auth.convex;
    response = auth.response;
  } else {
    convex = auth.convex;
    const toolCtx = { convex: auth.convex, principal: auth.principal, key: auth.key };
    const handler = createMcpHandler((server) => registerSurface(server, toolCtx), {
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
    (request as Request & { auth?: unknown }).auth = {
      token: "redacted",
      clientId: auth.principal.publicId,
      scopes: [...auth.key.scopes],
    };
    const inner = await handler(request);
    const headers = new Headers(inner.headers);
    headers.set("X-Request-Id", ctx.requestId);
    for (const [k, v] of Object.entries(auth.rateHeaders)) headers.set(k, v);
    response = new Response(inner.body, { status: inner.status, statusText: inner.statusText, headers });
  }
  if (convex) {
    try {
      await convex.mutation(api.apiKeys.logRequest, {
        method: request.method,
        target: `/api/mcp ${rpc.label}`.slice(0, 200),
        status: response.status,
        durationMs: Date.now() - started,
        requestId: ctx.requestId,
      });
    } catch (e) {
      console.error("MCP: access log failed", e);
    }
  }
  return response;
}
