import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { ROUTES } from "./resources";

const ROOT = join(import.meta.dirname, "../../..");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, acc);
    else if (name === "route.ts") acc.push(relative(join(ROOT, "src/app"), p));
  }
  return acc;
}

describe("no inbound webhooks (BNK-108, SEC-06, 05 §5.1)", () => {
  test("BNK-108 the only HTTP entry points are auth, health, docs, MCP and the keyed REST API — no bank or payment webhook", () => {
    expect(routeFiles(join(ROOT, "src/app")).sort()).toEqual([
      "(app)/(shell)/einstellungen/layouts/vorschau/route.ts", // session-checked layout preview (SET-073)
      "api/auth/[...all]/route.ts",
      "api/docs/route.ts",
      "api/health/route.ts",
      "api/mcp/route.ts",
      "api/openapi.json/route.ts",
      "api/v1/[...path]/route.ts",
    ]);
    // Convex HTTP actions: Better Auth only.
    const http = readFileSync(join(ROOT, "convex/http.ts"), "utf8");
    expect(http).toContain("authComponent.registerRoutes(http, createAuth)");
    expect(http).not.toMatch(/http\.route\(/);
    // REST: no webhook receiver; every endpoint except /health needs an API key.
    for (const { endpoint } of ROUTES) {
      expect(endpoint.path, endpoint.path).not.toMatch(/webhook|callback|notify|psd2|enable-?banking/i);
      if (endpoint.scope === "public") expect(endpoint.path).toBe("/health");
    }
  });
});
