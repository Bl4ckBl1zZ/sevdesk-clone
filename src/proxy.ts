import { type NextRequest, NextResponse } from "next/server";

/**
 * Next.js 16 proxy (formerly middleware) — P0 placeholder.
 *
 * To be implemented test-first (02 §4.1/§4.2, 05 §1):
 *  - host allowlist: `app.` serves the UI + Server Actions + /api/auth/*; `api.` serves only
 *    /api/v1/**, /api/mcp, /api/docs, /api/openapi.json, /api/health; port 8443 only /api/v1/**
 *  - optimistic session redirect to /anmelden (authoritative checks happen in Server Actions and Convex)
 *  - security headers (CSP, HSTS, frame-ancestors, referrer-policy, …)
 */
export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  // Skip static assets and Next internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
