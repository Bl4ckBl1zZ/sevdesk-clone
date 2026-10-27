import "server-only";
import { ConvexError } from "convex/values";
import { scopeFor } from "@/domain/access/permissions";
import {
  type AppErrorData,
  type FieldMapper,
  type Lang,
  mapAppError,
  type ProblemCode,
  type ProblemFieldError,
  problem,
} from "@/domain/api/problems";

/** A problem raised by the REST layer itself (routing, parsing, preconditions). */
export class ApiProblem extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly opts: { detail?: string; errors?: ProblemFieldError[]; extra?: Record<string, unknown> } = {},
  ) {
    super(opts.detail ?? code);
  }
}

export interface ResponseContext {
  requestId: string;
  lang: Lang;
  typeBase: string;
  headers: Record<string, string>;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

/** 05 §3: `X-Request-Id` echoed when well-formed, otherwise generated. */
export function requestIdFrom(headers: Headers): string {
  const given = headers.get("x-request-id")?.trim();
  if (given && REQUEST_ID_RE.test(given)) return given;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `req_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Base for problem `type` URIs: the API origin (05 §3.1). */
export function typeBaseFor(request: Request): string {
  return (process.env.API_ORIGIN ?? new URL(request.url).origin).replace(/\/$/, "");
}

export function jsonResponse(status: number, body: unknown, ctx: ResponseContext, extra: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(status === 204 ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      "X-Request-Id": ctx.requestId,
      "Cache-Control": "no-store",
      ...ctx.headers,
      ...extra,
    },
  });
}

/** A binary success body (PDF preview); same request id and cache headers as `jsonResponse`. */
export function bytesResponse(
  status: number,
  body: Uint8Array,
  contentType: string,
  ctx: ResponseContext,
  extra: Record<string, string> = {},
) {
  return new Response(body as Uint8Array<ArrayBuffer>, {
    status,
    headers: {
      "Content-Type": contentType,
      "X-Request-Id": ctx.requestId,
      "Cache-Control": "no-store",
      ...ctx.headers,
      ...extra,
    },
  });
}

export function problemResponse(
  code: ProblemCode,
  ctx: ResponseContext,
  opts: { detail?: string; errors?: ProblemFieldError[]; extra?: Record<string, unknown> } = {},
  headers: Record<string, string> = {},
): Response {
  const body = problem(code, { requestId: ctx.requestId, lang: ctx.lang, typeBase: ctx.typeBase, ...opts });
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      "Content-Type": "application/problem+json; charset=utf-8",
      "X-Request-Id": ctx.requestId,
      "Cache-Control": "no-store",
      ...ctx.headers,
      ...headers,
    },
  });
}

export function appErrorData(e: unknown): AppErrorData | null {
  if (e instanceof ConvexError && typeof e.data === "object" && e.data !== null && "code" in e.data) {
    return e.data as AppErrorData;
  }
  // convex-test and older clients: a ConvexError-shaped object.
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && "code" in data) return data as AppErrorData;
  return null;
}

/** Any error → problem response: Convex application errors are mapped, everything else is a 500. */
export function errorResponse(e: unknown, ctx: ResponseContext, fieldMapper?: FieldMapper): Response {
  if (e instanceof ApiProblem) return problemResponse(e.code, ctx, e.opts);
  const data = appErrorData(e);
  if (data) {
    const mapped = mapAppError(data, {
      ...(fieldMapper ? { fieldMapper } : {}),
      scopeForPermission: (p) => scopeFor(p as never),
    });
    return problemResponse(mapped.code, ctx, {
      ...(mapped.detail ? { detail: mapped.detail } : {}),
      errors: mapped.errors,
      extra: mapped.extra,
    });
  }
  console.error("REST API: unexpected error", e);
  return problemResponse("internal_error", ctx);
}
