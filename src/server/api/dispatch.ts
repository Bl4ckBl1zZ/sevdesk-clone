import "server-only";
import { api } from "@convex/_generated/api";
import type { z } from "zod";
import { defaultFieldMapper, type ProblemFieldError, preferredLang } from "@/domain/api/problems";
import { canonicalize } from "@/domain/audit/canonical";
import { sha256Hex } from "@/domain/audit/chain";
import { authenticate, type KeyInfo } from "./auth";
import type { ConvexCaller, Principal } from "./backend";
import { type CompiledRoute, matchRoute } from "./endpoint";
import {
  ApiProblem,
  errorResponse,
  jsonResponse,
  problemResponse,
  type ResponseContext,
  requestIdFrom,
  typeBaseFor,
} from "./http";

export const API_BASE_PATH = "/api/v1";

/** zod issues of the wire schemas → problem `errors[]` (paths are already snake_case). */
export function zodErrors(error: z.ZodError, code = "invalid"): ProblemFieldError[] {
  return error.issues.map((i) => {
    const field = defaultFieldMapper(i.path.map(String).join("."));
    return { code, ...(field ? { field } : {}), message: i.message };
  });
}

function queryObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return undefined;
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/(.+\+)?json\b/i.test(type)) throw new ApiProblem("unsupported_media_type");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiProblem("bad_request", { detail: "Der Request-Body ist kein gültiges JSON." });
  }
}

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new ApiProblem("bad_request", { detail: "Der multipart-Body ist ungültig." });
  }
}

function textFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form) if (typeof v === "string") out[k] = v;
  return out;
}

async function fileDigests(form: FormData): Promise<{ field: string; name: string; sha256: string }[]> {
  const out: { field: string; name: string; sha256: string }[] = [];
  for (const [k, v] of form) {
    if (typeof v !== "string") {
      out.push({ field: k, name: v.name, sha256: await sha256Hex(new Uint8Array(await v.arrayBuffer())) });
    }
  }
  return out;
}

function hasScope(key: KeyInfo, scope: string | readonly string[]): boolean {
  const wanted = typeof scope === "string" ? [scope] : scope;
  return wanted.some((s) => key.scopes.includes(s));
}

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/**
 * The REST pipeline (05 §3, §7): routing → request id → key auth + per-key rate limit → fail-fast scope →
 * zod parsing → Idempotency-Key (POST) → handler → problem+json mapping → access log. No client IP is used anywhere
 * (tailnet only; CLAUDE.md).
 */
export async function handleApiRequest(request: Request, routes: readonly CompiledRoute[]): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const ctx: ResponseContext = {
    requestId: requestIdFrom(request.headers),
    lang: preferredLang(request.headers.get("accept-language")),
    typeBase: typeBaseFor(request),
    headers: {},
  };
  const path = url.pathname.slice(API_BASE_PATH.length).replace(/\/+$/, "") || "/";
  let convex: ConvexCaller | undefined;
  let response: Response;
  let code: string | undefined;
  try {
    response = await run();
  } catch (e) {
    response = errorResponse(e, ctx);
  }
  if (response.status >= 400 && response.headers.get("content-type")?.includes("problem+json")) {
    code = ((await response.clone().json()) as { code?: string }).code;
  }
  if (convex) {
    try {
      await convex.mutation(api.apiKeys.logRequest, {
        method: request.method,
        target: path,
        status: response.status,
        durationMs: Date.now() - started,
        requestId: ctx.requestId,
        ...(code ? { code } : {}),
      });
    } catch (e) {
      console.error("REST API: access log failed", e);
    }
  }
  return response;

  async function run(): Promise<Response> {
    const match = matchRoute(routes, request.method, path);
    if (!match) return problemResponse("not_found", ctx);
    if ("allowed" in match) return problemResponse("method_not_allowed", ctx, {}, { Allow: match.allowed.join(", ") });
    const { route, params: rawParams } = match;
    const def = route.endpoint;

    let principal: Principal | undefined;
    let key: KeyInfo | undefined;
    if (def.scope !== "public") {
      const auth = await authenticate(request, "api-key", ctx);
      if (!auth.ok) {
        convex = auth.convex;
        return auth.response;
      }
      ({ principal, key, convex } = auth);
      ctx.headers = { ...auth.rateHeaders };
      if (def.scope !== "any" && !hasScope(auth.key, def.scope)) {
        const required = typeof def.scope === "string" ? def.scope : def.scope.join(" ");
        return problemResponse("insufficient_scope", ctx, { extra: { required_scope: required } });
      }
    }

    const params = def.params ? def.params.safeParse(rawParams) : { success: true as const, data: rawParams };
    if (!params.success) return problemResponse("not_found", ctx);
    const query = def.query ? def.query.safeParse(queryObject(url.searchParams)) : { success: true as const, data: {} };
    if (!query.success) return problemResponse("bad_request", ctx, { errors: zodErrors(query.error) });
    let body: unknown;
    let rawBody: unknown;
    let form: FormData | undefined;
    if (def.body && def.multipart && /^multipart\/form-data\b/i.test(request.headers.get("content-type") ?? "")) {
      form = await readForm(request);
      const fields = textFields(form);
      rawBody = { ...fields, files: await fileDigests(form) };
      const parsed = def.body.safeParse(fields);
      if (!parsed.success) return problemResponse("validation_failed", ctx, { errors: zodErrors(parsed.error) });
      body = parsed.data;
    } else if (def.body) {
      rawBody = await readJson(request);
      const parsed = def.body.safeParse(rawBody ?? {});
      if (!parsed.success) return problemResponse("validation_failed", ctx, { errors: zodErrors(parsed.error) });
      body = parsed.data;
    }

    // ── Idempotency-Key (05 §3): POST only, per API key, 24 h ──────────────────────────────────────
    const idemKey = request.method === "POST" ? request.headers.get("idempotency-key") : null;
    const dryRun = (body as { dry_run?: unknown } | undefined)?.dry_run === true;
    if (idemKey === null && def.idempotency === "required" && request.method === "POST" && !dryRun) {
      return problemResponse("idempotency_key_required", ctx);
    }
    let idemId: string | undefined;
    if (idemKey !== null && convex) {
      if (!IDEMPOTENCY_KEY_RE.test(idemKey)) {
        return problemResponse("bad_request", ctx, {
          errors: [{ code: "invalid", field: "Idempotency-Key", message: "1–255 sichtbare ASCII-Zeichen." }],
        });
      }
      const requestHash = await sha256Hex(
        canonicalize({ method: request.method, path, query: url.search, body: rawBody ?? null }),
      );
      const begun = await convex.mutation(api.idempotency.begin, { key: idemKey, requestHash });
      if (begun.state === "replay") {
        return new Response(begun.body, {
          status: begun.status,
          headers: {
            "Content-Type":
              begun.status >= 400 ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8",
            "X-Request-Id": ctx.requestId,
            "Idempotent-Replayed": "true",
            ...ctx.headers,
          },
        });
      }
      idemId = begun.id;
    }

    let result: Response;
    try {
      if (!convex || !principal || !key) {
        const out = await def.handler({
          params: params.data,
          query: query.data,
          body,
          convex: undefined as never,
          principal: undefined as never,
          key: undefined as never,
          request,
          requestId: ctx.requestId,
          ifMatch: null,
          ...(form ? { form } : {}),
        });
        return jsonResponse(out.status ?? def.response.status, out.body, ctx, out.headers);
      }
      const ifMatch = request.headers.get("if-match")?.replace(/^W\//, "").replace(/"/g, "").trim() || null;
      const out = await def.handler({
        params: params.data,
        query: query.data,
        body,
        convex,
        principal,
        key,
        request,
        requestId: ctx.requestId,
        ifMatch,
        ...(form ? { form } : {}),
      });
      result = jsonResponse(out.status ?? def.response.status, out.body, ctx, out.headers);
    } catch (e) {
      result = errorResponse(e, ctx, def.fieldMapper);
    }
    if (idemId && convex) {
      const id = idemId as never;
      if (result.status < 500) {
        await convex.mutation(api.idempotency.complete, {
          id,
          status: result.status,
          body: await result.clone().text(),
        });
      } else {
        await convex.mutation(api.idempotency.release, { id });
      }
    }
    return result;
  }
}
