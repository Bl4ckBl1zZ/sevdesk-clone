import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Next.js 16 proxy (02 §4.1, SEC-06). Runs on every request to `web`:
 *  1. Host resolution (APP_ORIGIN / API_ORIGIN); unknown host → 421 (DNS rebinding).
 *  2. `api.`: path allowlist (/api/v1/**, /api/mcp, /api/docs, /api/openapi.json, /api/health; port 8443 only
 *     /api/v1/**), everything else → 404; cookies are stripped (API keys only).
 *  3. `app.`: optimistic redirect to /anmelden?weiter=<path> when no Better Auth session cookie is present.
 *     Authoritative checks happen in Server Components/Actions (`requireRole`) and in every Convex function.
 *  4. Security headers incl. a per-request nonce CSP (the nonce is forwarded as request header `x-nonce`;
 *     Next.js applies it to its own scripts automatically).
 */
export interface ProxyConfig {
  appOrigin: string | undefined;
  apiOrigin: string | undefined;
  /** Convex client URL (NEXT_PUBLIC_CONVEX_URL) for connect-src (https + wss). */
  convexUrl: string | undefined;
  dev: boolean;
}

const API_PATHS = [
  /^\/api\/v1(\/.*)?$/,
  /^\/api\/mcp$/,
  /^\/api\/docs(\/.*)?$/,
  /^\/api\/openapi\.json$/,
  /^\/api\/health$/,
];
const API_8443_PATHS = [/^\/api\/v1(\/.*)?$/];
/** Reachable without a session cookie (02 §4.1 step 3): sign-in pages, Better Auth, health, PWA manifest and icons. */
const APP_PUBLIC = [
  /^\/anmelden(\/.*)?$/,
  /^\/api\/auth(\/.*)?$/,
  /^\/api\/health$/,
  /^\/manifest\.webmanifest$/,
  /^\/icons\/[^/]+$/,
];
/** Paths of the api. host that must never be served on app. */
const APP_FORBIDDEN = [/^\/api\/v1(\/.*)?$/, /^\/api\/mcp$/];

function configFromEnv(): ProxyConfig {
  return {
    appOrigin: process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_SITE_URL,
    apiOrigin: process.env.API_ORIGIN,
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
    dev: process.env.NODE_ENV !== "production",
  };
}

const hostOf = (origin: string | undefined) => {
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

function splitHost(raw: string): { hostname: string; port: string } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw.trim().toLowerCase());
  return { hostname: m?.[1] ?? "", port: m?.[2] ?? "" };
}

type Site = "app" | "api" | "api-8443" | "unknown";

function resolveSite(request: NextRequest, config: ProxyConfig): Site {
  const { hostname, port } = splitHost(request.headers.get("host") ?? request.nextUrl.host);
  const app = hostOf(config.appOrigin);
  const api = hostOf(config.apiOrigin);
  if (api && hostname === api) return port === "8443" ? "api-8443" : "api";
  if (app && hostname === app) return "app";
  // Local dev without configured origins: everything is the app.
  if (config.dev && !app && !api) return "app";
  return "unknown";
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function csp(n: string, config: ProxyConfig): string {
  const convex = config.convexUrl ? new URL(config.convexUrl) : undefined;
  const connect = [
    "'self'",
    ...(convex ? [convex.origin, `${convex.protocol === "http:" ? "ws" : "wss"}://${convex.host}`] : []),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${n}' 'strict-dynamic'${config.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(config.dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function withSecurityHeaders(res: NextResponse, site: Site, config: ProxyConfig, cspValue?: string): NextResponse {
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  if (!config.dev) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.headers.set(
    "Permissions-Policy",
    site === "app"
      ? "camera=(self), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)"
      : "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(), publickey-credentials-create=()",
  );
  if (cspValue) res.headers.set("Content-Security-Policy", cspValue);
  else if (site !== "app") res.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  return res;
}

export function handleProxy(request: NextRequest, config: ProxyConfig = configFromEnv()): NextResponse {
  const site = resolveSite(request, config);
  const path = request.nextUrl.pathname;

  if (site === "unknown")
    return withSecurityHeaders(new NextResponse("Misdirected Request", { status: 421 }), site, config);

  if (site === "api" || site === "api-8443") {
    const allowed = (site === "api" ? API_PATHS : API_8443_PATHS).some((re) => re.test(path));
    if (!allowed) return withSecurityHeaders(new NextResponse("Not Found", { status: 404 }), site, config);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    return withSecurityHeaders(NextResponse.next({ request: { headers } }), site, config);
  }

  // app.
  if (APP_FORBIDDEN.some((re) => re.test(path))) {
    return withSecurityHeaders(new NextResponse("Not Found", { status: 404 }), site, config);
  }
  if (!APP_PUBLIC.some((re) => re.test(path)) && !getSessionCookie(request)) {
    const target = new URL("/anmelden", config.appOrigin ?? request.nextUrl.origin);
    const back = `${path}${request.nextUrl.search}`;
    if (back !== "/") target.searchParams.set("weiter", back);
    return withSecurityHeaders(NextResponse.redirect(target, 307), site, config);
  }
  const n = nonce();
  const cspValue = csp(n, config);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", n);
  // Layouts cannot read the URL; the signed-in layout needs it for SET-001 (redirect to /einrichtung).
  headers.set("x-pathname", `${path}${request.nextUrl.search}`);
  headers.set("Content-Security-Policy", cspValue);
  return withSecurityHeaders(NextResponse.next({ request: { headers } }), site, config, cspValue);
}

export function proxy(request: NextRequest) {
  return handleProxy(request);
}

export const config = {
  // Skip static assets and Next internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
