import { api } from "@convex/_generated/api";
import { describe, expect, test } from "vitest";
import { estimateTaxReserve } from "@/domain/tax/reserve";
import { reportsResource } from "../../api/resources/reports";
import { reportTools } from "./reports";

const result = estimateTaxReserve({
  year: 2026,
  today: "2026-10-20",
  entity: "natural",
  gewerbe: true,
  ytdProfitCents: 5_000_000,
  profitBasis: "euer",
  splitting: false,
  churchTaxBp: 0,
  hebesatzBp: 40_000,
  prepaidCents: { est: 0, gewst: 0, kst: 0 },
  ust: { openCents: 190_000, periods: ["09/2026"] },
});

function fakeConvex() {
  const calls: { fn: unknown; args: unknown }[] = [];
  return {
    calls,
    convex: {
      query: async (fn: unknown, args: unknown) => {
        calls.push({ fn, args });
        return result;
      },
    } as never,
  };
}

const expectEstimate = (body: Record<string, unknown>) => {
  expect(body).toMatchObject({
    estimate: true,
    disclaimer: "Schätzung – keine Steuerberatung",
    year: 2026,
    reserve_now_cents: result.reserveNowCents,
    monthly_cents: result.monthlyCents,
  });
  expect(body.assumptions).toEqual(result.assumptions);
  expect((body.assumptions as string[]).length).toBeGreaterThan(3);
  expect(body.inputs).toMatchObject({ hebesatzBp: 40_000, churchTaxBp: 0 });
};

describe("tax reserve over REST and MCP (RPT-011, TST-RPT-06)", () => {
  test("RPT-011 TST-RPT-06 GET /reports/tax-reserve: estimate: true, disclaimer, assumptions; query overrides map to Convex args", async () => {
    const endpoint = reportsResource.endpoints.find((e) => e.operationId === "getTaxReserveEstimate");
    if (!endpoint) throw new Error("missing endpoint");
    expect(endpoint.scope).toBe("reports:read");
    const f = fakeConvex();
    const out = await endpoint.handler({
      params: {},
      query: { year: 2026, splitting: "true", church_tax_bp: "900", hebesatz_bp: 41_000 },
      body: undefined,
      convex: f.convex,
    } as never);
    expectEstimate(out.body as Record<string, unknown>);
    expect(f.calls).toEqual([
      { fn: api.reports.taxReserve, args: { year: 2026, splitting: true, churchTaxBp: 900, hebesatzBp: 41_000 } },
    ]);
  });

  test("RPT-011 TST-RPT-06 MCP tax_reserve_estimate is read-only with scope reports:read and returns the same shape", async () => {
    const tool = reportTools.find((t) => t.name === "tax_reserve_estimate");
    if (!tool) throw new Error("missing tool");
    expect(tool.scopes).toEqual(["reports:read"]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.description).toContain("Schätzung – keine Steuerberatung");
    const f = fakeConvex();
    const body = await tool.handler({ year: 2026, profit_override_cents: 6_000_000 }, { convex: f.convex } as never);
    expectEstimate(body as Record<string, unknown>);
    expect(f.calls[0]?.args).toEqual({ year: 2026, profitOverrideCents: 6_000_000 });
  });
});
