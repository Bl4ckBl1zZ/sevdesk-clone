import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { handleProxy, type ProxyConfig } from "./proxy";

const CONFIG: ProxyConfig = {
  appOrigin: "https://app.example.de",
  apiOrigin: "https://api.example.de",
  convexUrl: "https://convex.example.de",
  dev: false,
};

function req(url: string, init: { cookie?: string; method?: string } = {}) {
  const u = new URL(url);
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { host: u.host, ...(init.cookie ? { cookie: init.cookie } : {}) },
  });
}

const SESSION = "__Secure-better-auth.session_token=abc.def";

describe("proxy: host resolution (SEC-06)", () => {
  test("SEC-06 an unknown Host is refused with 421 (DNS rebinding)", () => {
    const res = handleProxy(req("https://evil.example.com/rechnungen"), CONFIG);
    expect(res.status).toBe(421);
  });

  test("SEC-06 the port 8443 listener of api. is treated as the api host", () => {
    const res = handleProxy(req("https://api.example.de:8443/api/v1/invoices"), CONFIG);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy: api. path allowlist (02 §4.1)", () => {
  test.each(["/api/v1/invoices", "/api/v1", "/api/mcp", "/api/docs", "/api/openapi.json", "/api/health"])(
    "SEC-06 api. serves %s",
    (path) => {
      expect(handleProxy(req(`https://api.example.de${path}`), CONFIG).headers.get("x-middleware-next")).toBe("1");
    },
  );

  test.each([
    "/",
    "/anmelden",
    "/api/auth/get-session",
    "/rechnungen",
    "/api/v10",
    "/api/mcp/extra",
    "/_next/data/x.json",
  ])("SEC-06 api. answers 404 for %s", (path) => {
    expect(handleProxy(req(`https://api.example.de${path}`), CONFIG).status).toBe(404);
  });

  test("SEC-06 cookies are not forwarded on api. (API keys only)", () => {
    const res = handleProxy(req("https://api.example.de/api/v1/invoices", { cookie: SESSION }), CONFIG);
    const forwarded = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
    expect(forwarded).toContain("host");
    expect(forwarded).not.toContain("cookie");
    expect(res.headers.get("x-middleware-request-cookie")).toBeNull();
  });
});

describe("proxy: optimistic session redirect on app. (02 §4.1 step 3)", () => {
  test("SEC-02 without a session cookie, app pages redirect to /anmelden?weiter=<path>", () => {
    const res = handleProxy(req("https://app.example.de/rechnungen/neu?typ=angebot"), CONFIG);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://app.example.de/anmelden?weiter=%2Frechnungen%2Fneu%3Ftyp%3Dangebot",
    );
  });

  test("SEC-02 the root redirects without a weiter parameter", () => {
    expect(handleProxy(req("https://app.example.de/"), CONFIG).headers.get("location")).toBe(
      "https://app.example.de/anmelden",
    );
  });

  test.each([
    "/anmelden",
    "/anmelden/code",
    "/anmelden/zwei-faktor",
    "/api/auth/email-otp/send-verification-otp",
    "/api/auth/rechnungen/first-run",
    "/api/health",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
  ])("SEC-02 %s is public on app.", (path) => {
    expect(handleProxy(req(`https://app.example.de${path}`), CONFIG).headers.get("x-middleware-next")).toBe("1");
  });

  test("SEC-02 with a session cookie the request passes (authoritative checks happen server-side)", () => {
    const res = handleProxy(req("https://app.example.de/rechnungen", { cookie: SESSION }), CONFIG);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  test("SEC-02 only direct icon files are public, not nested paths", () => {
    expect(handleProxy(req("https://app.example.de/icons/a/b.png"), CONFIG).status).toBe(307);
  });

  test("SET-001 the signed-in layout receives the requested path (x-pathname) for the setup redirect", () => {
    const res = handleProxy(req("https://app.example.de/rechnungen?status=offen", { cookie: SESSION }), CONFIG);
    expect(res.headers.get("x-middleware-request-x-pathname")).toBe("/rechnungen?status=offen");
  });

  test("SEC-02 the REST API is not served on app.", () => {
    expect(handleProxy(req("https://app.example.de/api/v1/invoices", { cookie: SESSION }), CONFIG).status).toBe(404);
  });
});

describe("proxy: security headers (SEC-06)", () => {
  test("SEC-06 app. responses carry a nonce CSP, frame/referrer/HSTS headers and passkey permissions", () => {
    const res = handleProxy(req("https://app.example.de/anmelden"), CONFIG);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://convex.example.de wss://convex.example.de");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("permissions-policy")).toContain("publickey-credentials-get=(self)");
    expect(res.headers.get("permissions-policy")).toContain("camera=(self)");
  });

  test("SEC-06 each request gets a fresh nonce", () => {
    const a = handleProxy(req("https://app.example.de/anmelden"), CONFIG).headers.get("x-middleware-request-x-nonce");
    const b = handleProxy(req("https://app.example.de/anmelden"), CONFIG).headers.get("x-middleware-request-x-nonce");
    expect(a).not.toBe(b);
  });

  test("SEC-06 api. responses deny camera and passkeys and are never framed", () => {
    const res = handleProxy(req("https://api.example.de/api/health"), CONFIG);
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("permissions-policy")).toContain("publickey-credentials-get=()");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("SEC-06 redirects and 404s carry the security headers too", () => {
    expect(handleProxy(req("https://app.example.de/x"), CONFIG).headers.get("x-frame-options")).toBe("DENY");
    expect(handleProxy(req("https://api.example.de/x"), CONFIG).headers.get("x-frame-options")).toBe("DENY");
  });
});
