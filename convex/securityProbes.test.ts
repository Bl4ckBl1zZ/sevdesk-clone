import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { makeT } from "./test.setup";

/** F12 AUD-020 live probes on the security page (deployed stack; fetch is stubbed here). */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubHosts(statusOf: (url: string) => number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(null, { status: statusOf(url) });
    }),
  );
}

const healthy = (url: string) => (url.includes("api.test.local") ? 404 : url.includes("convex-dash.") ? 401 : 200);

describe("api. self-test (E-AUD-22)", () => {
  test("E-AUD-22 api. answering an admin path with 200 is a critical finding with the F12 text", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    stubHosts(healthy);
    const ok = await owner.action(api.settings.runAccessChecks, {});
    expect(ok.find((c) => c.id === "api-ui")).toMatchObject({ status: "ok" });

    stubHosts((url) => (url.includes("api.test.local") ? 200 : healthy(url)));
    const bad = await owner.action(api.settings.runAccessChecks, {});
    expect(bad.find((c) => c.id === "api-ui")).toMatchObject({
      status: "error",
      detail: "Admin-Seiten sind über api.test.local erreichbar. Sofort Proxy-Konfiguration prüfen.",
    });
  });

  test("E-AUD-22 the port 8443 listener serving more than /api/v1 is reported with the port", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    stubHosts((url) => (url.startsWith("https://api.test.local:8443/") ? 200 : healthy(url)));
    const checks = await owner.action(api.settings.runAccessChecks, {});
    expect(checks.find((c) => c.id === "api-ui")).toMatchObject({
      status: "error",
      detail: "Admin-Seiten sind über api.test.local:8443 erreichbar. Sofort Proxy-Konfiguration prüfen.",
    });
  });
});
