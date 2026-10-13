import { SCOPES } from "@/domain/schemas/scopes";
import { type ConvexCaller, setBackendFactory } from "@/server/api/backend";
import { handleApiRequest } from "@/server/api/dispatch";
import { ROUTES } from "@/server/api/resources";
import { makeT, SERVER_ISSUER, type TestT } from "../../convex/test.setup";

/**
 * REST/MCP harness (05 §7 "contract tests against convex-test-backed handlers"): the real route pipeline, with the
 * Convex calls of each request running in convex-test under the identity the server JWT would carry.
 */
export function routeConvexTo(t: TestT): () => void {
  return setBackendFactory((p) => {
    const accessor = t.withIdentity({
      issuer: SERVER_ISSUER,
      subject: `${p.kind}:${p.publicId}`,
      scopes: [...SCOPES],
      keyHash: p.keyHash,
      requestId: p.requestId,
      ...(p.userAgent ? { ua: p.userAgent } : {}),
      ...(p.client ? { client: p.client } : {}),
    } as never);
    type Call = (ref: unknown, args: unknown) => Promise<never>;
    return {
      query: (ref, args) => (accessor.query as Call)(ref, args),
      mutation: (ref, args) => (accessor.mutation as Call)(ref, args),
      action: (ref, args) => (accessor.action as Call)(ref, args),
    } as ConvexCaller;
  });
}

export interface CallOptions {
  key?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export const API_BASE = "https://api.test.local/api/v1";

export function call(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  let body: string | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] ??= "application/json";
  }
  return handleApiRequest(
    new Request(`${API_BASE}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }),
    ROUTES,
  );
}

export function apiTest() {
  const t = makeT();
  const restore = routeConvexTo(t);
  return { t, restore };
}
