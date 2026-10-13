import "server-only";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { extractApiKey, hashApiKey, parseApiKey } from "@/domain/api/keys";
import { rateLimitHeaders } from "@/domain/api/rate-limit";
import { backendFor, type ConvexCaller, type Principal } from "./backend";
import { appErrorData, problemResponse, type ResponseContext } from "./http";

export type KeyInfo = FunctionReturnType<typeof api.apiKeys.authorize>;

export type AuthResult =
  | { ok: true; principal: Principal; convex: ConvexCaller; key: KeyInfo; rateHeaders: Record<string, string> }
  | { ok: false; response: Response; convex?: ConvexCaller };

/**
 * Authenticates a REST or MCP request (05 §2.1/§3, 06 §1): the key comes from `Authorization: Bearer` or
 * `X-API-Key` (never the query string), its public id and SHA-256 identify it, and `apiKeys.authorize` — called with
 * the server JWT of that key — verifies it against the stored hash, channel, expiry and revocation, takes one token
 * from the key's bucket (per key only; client IPs are not visible behind the tailnet edge) and stamps last use.
 */
export async function authenticate(
  request: Request,
  channel: "api-key" | "mcp",
  ctx: ResponseContext,
  extra: { client?: { name: string; version: string } } = {},
): Promise<AuthResult> {
  const url = new URL(request.url);
  const challenge = { "WWW-Authenticate": 'Bearer realm="rechnungen"' };
  const extracted = extractApiKey(request.headers, url.searchParams);
  if ("error" in extracted) {
    return {
      ok: false,
      response:
        extracted.error === "in_query"
          ? problemResponse("key_in_query_not_allowed", ctx)
          : problemResponse("unauthorized", ctx, {}, challenge),
    };
  }
  const parsed = parseApiKey(extracted.key);
  if (!parsed) return { ok: false, response: problemResponse("unauthorized", ctx, {}, challenge) };
  const userAgent = request.headers.get("user-agent")?.slice(0, 200);
  const principal: Principal = {
    kind: channel,
    publicId: parsed.publicId,
    keyHash: await hashApiKey(parsed.key),
    requestId: ctx.requestId,
    ...(userAgent ? { userAgent } : {}),
    ...(extra.client ? { client: extra.client } : {}),
  };
  const convex = backendFor(principal);
  let key: KeyInfo;
  try {
    key = await convex.mutation(api.apiKeys.authorize, {});
  } catch (e) {
    const data = appErrorData(e);
    if (data && (data.code === "key_revoked" || data.code === "unauthenticated" || data.code === "forbidden_scope")) {
      return { ok: false, response: problemResponse("unauthorized", ctx, {}, challenge) };
    }
    console.error("REST API: key verification failed", e);
    return { ok: false, response: problemResponse("dependency_unavailable", ctx) };
  }
  const rateHeaders = rateLimitHeaders(key.rateLimit);
  if (!key.rateLimit.ok) {
    return { ok: false, response: problemResponse("rate_limited", ctx, {}, rateHeaders), convex };
  }
  return { ok: true, principal, convex, key, rateHeaders };
}
