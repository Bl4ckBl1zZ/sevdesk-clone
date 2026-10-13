import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";
import { setupCatalog } from "../../convex/catalog.fixtures";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { runScenario } from "../mcp-eval/runner";
import { SCENARIOS } from "../mcp-eval/scenarios";
import { apiTest } from "./harness";

let restore: (() => void) | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  restore?.();
  restore = undefined;
});

describe("MCP eval scenarios (06 §7): the reference tool calls succeed in-process", () => {
  test.each(SCENARIOS.map((s) => [s.id, s] as const))("MCP-009 %s", async (_id, scenario) => {
    const h = apiTest();
    restore = h.restore;
    await setupCatalog(h.t);
    const key = await h.t.asMcp([...scenario.scopes]);
    client = new Client({ name: "eval", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://api.test.local/api/mcp"), {
        fetch: (input, init) => handleMcpRequest(new Request(input as string | URL, init as RequestInit)),
        requestInit: { headers: { Authorization: `Bearer ${key.key}` } },
      }),
    );
    const outcomes = await runScenario(client, scenario);
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(outcomes).toHaveLength(scenario.steps.length);
  });

  test("MCP-009 every ⚠ step of a scenario follows a preview and an approval", () => {
    const danger = new Set(TOOLS.filter((t) => t.kind === "danger").map((t) => t.name));
    for (const s of SCENARIOS) {
      s.steps.forEach((step, i) => {
        if (!danger.has(step.tool)) return;
        expect(step.afterApproval, `${s.id} step ${i}`).toBe(true);
        expect(
          s.steps.slice(0, i).some((p) => p.tool === "preview_action"),
          `${s.id} step ${i}`,
        ).toBe(true);
      });
    }
  });
});
