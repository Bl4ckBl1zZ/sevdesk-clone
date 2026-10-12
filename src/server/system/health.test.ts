import { beforeEach, describe, expect, test, vi } from "vitest";
import { cachedHealth, type HealthDeps, resetHealthCache, runHealthChecks } from "./health";
import { systemVersions } from "./info";

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  let t = 1_000;
  return {
    fetch: vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/version")) return new Response("1.46.0");
      if (u.endsWith("/health")) {
        return Response.json({
          status: "ok",
          version: "2026-08-31-1",
          kosit: { status: "up", version: "1.5.2" },
          xrechnungConfig: "2026-07-31",
          mustang: "2.16.4",
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch,
    clockOffset: async () => 120,
    now: () => (t += 5),
    env: {
      CONVEX_URL_INTERNAL: "http://backend:3210",
      EINVOICE_TOOLS_URL: "http://einvoice-tools:8080",
    } as unknown as NodeJS.ProcessEnv,
    ...over,
  };
}

beforeEach(() => resetHealthCache());

describe("SET-131 web-side health checks", () => {
  test("SET-131 Convex, einvoice-tools and clock skew with status, latency and detail", async () => {
    const r = await runHealthChecks(deps());
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["convex", "ok"],
      ["einvoice-tools", "ok"],
      ["clock", "ok"],
    ]);
    expect(r.checks[0]?.latencyMs).toBeGreaterThan(0);
    expect(r.einvoiceTools).toEqual({
      tools: "2026-08-31-1",
      kosit: "1.5.2",
      xrechnungConfig: "2026-07-31",
      mustang: "2.16.4",
    });
  });

  test("SET-131 GOBD-22 unreachable services and a 61 s clock skew are errors", async () => {
    const r = await runHealthChecks(
      deps({
        fetch: (async () => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
        clockOffset: async () => 61_000,
      }),
    );
    expect(r.checks.map((c) => c.status)).toEqual(["error", "error", "error"]);
  });

  test("SET-131 results are cached for 60 s", async () => {
    const d = deps();
    let now = 10_000;
    d.now = () => now;
    await cachedHealth(d);
    await cachedHealth(d);
    expect(d.fetch).toHaveBeenCalledTimes(2); // one run: /version + /health
    now += 61_000;
    await cachedHealth(d);
    expect(d.fetch).toHaveBeenCalledTimes(4);
  });
});

describe("SET-130 versions", () => {
  test("SET-130 app version, git SHA, build date, Next.js, Node, Convex image SHA, rule-table release", () => {
    const v = systemVersions({
      APP_VERSION: "1.0.0",
      GIT_SHA: "abc1234",
      BUILD_DATE: "2026-10-12",
      CONVEX_SHA: "72ce13c",
    } as unknown as NodeJS.ProcessEnv);
    expect(v).toMatchObject({
      app: { version: "1.0.0", gitSha: "abc1234", buildDate: "2026-10-12" },
      next: expect.stringMatching(/^16\./),
      node: process.version,
      convexImage: "72ce13c",
      betterAuth: "1.6.33",
      ruleTables: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });
});
