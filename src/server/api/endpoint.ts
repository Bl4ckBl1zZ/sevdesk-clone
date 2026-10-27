import "server-only";
import type { z } from "zod";
import type { FieldMapper, ProblemCode } from "@/domain/api/problems";
import type { Scope } from "@/domain/schemas/scopes";
import type { KeyInfo } from "./auth";
import type { ConvexCaller, Principal } from "./backend";

/**
 * One REST endpoint (05 §7): method, path, scope, zod schemas and a thin handler. The same definition drives the
 * router (src/app/api/v1/[...path]/route.ts), the fail-fast scope check, request parsing, idempotency and the
 * OpenAPI document (src/server/openapi.ts). Handlers only map wire ⇄ Convex — business rules stay in the domain
 * and the Convex model (CLAUDE.md rule 5).
 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HandlerContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  convex: ConvexCaller;
  principal: Principal;
  key: KeyInfo;
  request: Request;
  requestId: string;
  /** Raw `If-Match` value without quotes/`W/` (05 §3 Concurrency). */
  ifMatch: string | null;
  /** The parsed `multipart/form-data` body of an endpoint with `multipart: true` (the zod body sees the text fields). */
  form?: FormData;
}

/** `body` is JSON, or raw bytes for an endpoint whose `response.contentType` is not JSON (e.g. a PDF preview). */
export type HandlerResult = { status?: number; body?: unknown; headers?: Record<string, string> };

export interface EndpointDef<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  /** OpenAPI-style path below /api/v1, e.g. `/contacts/{id}`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  /**
   * `"public"` = no key (only `/health`); `"any"` = any valid key; otherwise the key needs one of the scopes.
   * Convex re-checks every call (authoritative); this check only fails fast with 403 `insufficient_scope`.
   */
  scope: "public" | "any" | Scope | readonly Scope[];
  params?: P;
  query?: Q;
  body?: B;
  /** Success response (status + schema) for OpenAPI and contract tests. */
  response: {
    status: number;
    schema?: z.ZodType;
    description: string;
    /** Binary success response (handler returns a `Uint8Array` body), e.g. `application/pdf`; default JSON. */
    contentType?: string;
  };
  /** Problem codes this endpoint documents besides the generic ones (401/403/429/500). */
  errors?: readonly ProblemCode[];
  /** `required`: POST without `Idempotency-Key` → 400 `idempotency_key_required` (finalize, cancel, … F04 §7.1). */
  idempotency?: "required";
  /** Maps form issue paths from Convex validation to wire fields. */
  fieldMapper?: FieldMapper;
  /**
   * Also accept `multipart/form-data` (F06 INB-008 `POST /inbox-items`): the text fields are validated with `body`,
   * the files reach the handler as `form`; the idempotency hash covers the text fields and each file's SHA-256.
   */
  multipart?: true;
  handler: (ctx: HandlerContext<z.output<P>, z.output<Q>, z.output<B>>) => Promise<HandlerResult>;
}

export type AnyEndpoint = EndpointDef<z.ZodType, z.ZodType, z.ZodType>;

export function defineEndpoint<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType>(
  def: EndpointDef<P, Q, B>,
): AnyEndpoint {
  if (!def.path.startsWith("/")) throw new Error(`endpoint ${def.operationId}: path must start with /`);
  if (def.method === "GET" && def.body) throw new Error(`endpoint ${def.operationId}: GET has no body`);
  return def as unknown as AnyEndpoint;
}

/** A resource module registers its endpoints once: `defineResource("contacts", [ … ])`. */
export interface Resource {
  name: string;
  description: string;
  endpoints: readonly AnyEndpoint[];
}

export function defineResource(name: string, description: string, endpoints: readonly AnyEndpoint[]): Resource {
  return { name, description, endpoints };
}

// ── routing ──────────────────────────────────────────────────────────────────────────────────────────
export interface CompiledRoute {
  endpoint: AnyEndpoint;
  regex: RegExp;
  names: string[];
}

export function compileRoutes(resources: readonly Resource[]): CompiledRoute[] {
  const seen = new Set<string>();
  return resources.flatMap((r) =>
    r.endpoints.map((endpoint) => {
      const key = `${endpoint.method} ${endpoint.path}`;
      if (seen.has(key)) throw new Error(`duplicate endpoint ${key}`);
      seen.add(key);
      const names: string[] = [];
      const pattern = endpoint.path.replace(/\{([a-zA-Z_]+)\}/g, (_, n: string) => {
        names.push(n);
        return "([^/]+)";
      });
      return { endpoint, regex: new RegExp(`^${pattern}$`), names };
    }),
  );
}

export function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  path: string,
): { route: CompiledRoute; params: Record<string, string> } | { allowed: HttpMethod[] } | null {
  const allowed: HttpMethod[] = [];
  for (const route of routes) {
    const m = route.regex.exec(path);
    if (!m) continue;
    if (route.endpoint.method !== method) {
      allowed.push(route.endpoint.method);
      continue;
    }
    const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]));
    return { route, params };
  }
  return allowed.length > 0 ? { allowed } : null;
}
