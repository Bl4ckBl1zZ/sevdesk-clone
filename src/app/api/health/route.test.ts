import { beforeEach, expect, test, vi } from "vitest";

const report = vi.hoisted(() => ({
  checks: [] as { id: string; label: string; status: string; detail?: string }[],
}));
vi.mock("@/server/system/health", () => ({
  cachedHealth: async () => ({ at: 0, checks: report.checks, einvoiceTools: null, clockOffsetMs: 0 }),
}));

const { GET } = await import("./route");

beforeEach(() => {
  report.checks = [{ id: "convex", label: "Datenbank (Convex)", status: "ok" }];
});

test("SMOKE GET /api/health answers with a minimal status body", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", version: expect.any(String) });
});

test("SET-131 a failing dependency reports „degraded“ without details (no hosts, no errors)", async () => {
  report.checks = [
    { id: "convex", label: "Datenbank (Convex)", status: "error", detail: "connect ECONNREFUSED 10.0.0.3:3210" },
  ];
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ status: "degraded", version: expect.any(String) });
  expect(JSON.stringify(body)).not.toContain("10.0.0.3");
});
