import { afterEach, describe, expect, test } from "vitest";
import * as docsRoute from "../../src/app/api/docs/route";
import * as mcpRoute from "../../src/app/api/mcp/route";
import * as openapiRoute from "../../src/app/api/openapi.json/route";
import * as v1Route from "../../src/app/api/v1/[...path]/route";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { API_BASE, apiTest } from "./harness";

/**
 * The Next route modules under src/app/api (05 §7, 06 §1): the exported verbs must reach the shared pipelines, so a
 * missing export (e.g. a dropped PATCH) or a wrong runtime flag shows up here and not only in e2e.
 */
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("/api/v1/[...path] route module", () => {
  test("API-009 every REST verb is exported, runs on Node and dispatches through the endpoint registry", async () => {
    const h = apiTest();
    restore = h.restore;
    expect(v1Route.runtime).toBe("nodejs");
    expect(v1Route.dynamic).toBe("force-dynamic");
    // /contacts allows GET and POST (auth is checked → 401); the other verbs reach the registry's 405 branch.
    const expected = { GET: 401, POST: 401, PATCH: 405, PUT: 405, DELETE: 405 } as const;
    const handlers = {
      GET: v1Route.GET,
      POST: v1Route.POST,
      PATCH: v1Route.PATCH,
      PUT: v1Route.PUT,
      DELETE: v1Route.DELETE,
    };
    for (const verb of Object.keys(expected) as (keyof typeof expected)[]) {
      const res = await handlers[verb](new Request(`${API_BASE}/contacts`, { method: verb }));
      expect(res.status, verb).toBe(expected[verb]);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }
    const { key } = await h.t.asApiKey(["contacts:read"]);
    const me = await v1Route.GET(new Request(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${key}` } }));
    expect(me.status).toBe(200);
    const wrongVerb = await v1Route.DELETE(
      new Request(`${API_BASE}/me`, { method: "DELETE", headers: { Authorization: `Bearer ${key}` } }),
    );
    expect(wrongVerb.status).toBe(405);
  });
});

describe("/api/mcp route module", () => {
  test("MCP-001 GET, POST and DELETE are the MCP handler and refuse a request without a key", async () => {
    expect(mcpRoute.GET).toBe(handleMcpRequest);
    expect(mcpRoute.POST).toBe(handleMcpRequest);
    expect(mcpRoute.DELETE).toBe(handleMcpRequest);
    expect(mcpRoute.runtime).toBe("nodejs");
    const res = await mcpRoute.POST(new Request("https://api.test.local/api/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });
});

describe("/api/openapi.json and /api/docs route modules", () => {
  test("API-014 /api/openapi.json serves the OpenAPI 3.1 document with a 5-minute public cache", async () => {
    const res = openapiRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths)).toContain("/api/v1/contacts");
  });

  test("API-014 /api/docs serves the Scalar reference pointing at /api/openapi.json", async () => {
    const res = await docsRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/api/openapi.json");
    expect(html).toContain("Rechnungen API");
  });
});
