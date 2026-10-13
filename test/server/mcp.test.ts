import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { BERLIN, createValues, orgForm, setupCatalog } from "../../convex/catalog.fixtures";
import type { TestT } from "../../convex/test.setup";
import { SCOPE_PRESETS } from "../../src/domain/api/scopes";
import type { Scope } from "../../src/domain/schemas/scopes";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { INSTRUCTIONS, TOOLS } from "../../src/server/mcp/server";
import { REQUIRES_USER_INTERACTION } from "../../src/server/mcp/tool";
import { apiTest } from "./harness";

let restore: (() => void) | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
});

function setup() {
  const h = apiTest();
  restore = h.restore;
  return h.t;
}

const MCP_URL = "https://api.test.local/api/mcp";

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => handleMcpRequest(new Request(input as string | URL, init as RequestInit)),
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function mcpKey(t: TestT, scopes: readonly Scope[]) {
  return t.asMcp([...scopes]);
}

type ToolCall = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text?: string }[] };
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; hint?: string };

describe("MCP server (06)", () => {
  test("MCP-001 a REST-only key, a missing key and a foreign Origin are refused", async () => {
    const t = setup();
    const res = await handleMcpRequest(new Request(MCP_URL, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const rest = await t.asApiKey(["contacts:read"]);
    await expect(connect(rest.key)).rejects.toThrow();
    const mcp = await mcpKey(t, ["contacts:read"]);
    const foreign = await handleMcpRequest(
      new Request(MCP_URL, {
        method: "POST",
        headers: { Origin: "https://evil.example", Authorization: `Bearer ${mcp.key}` },
      }),
    );
    expect(foreign.status).toBe(403);
  });

  test("MCP-002 MCP-005 every tool's annotations follow its kind; ⚠ tools require confirm_token and user interaction", () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.kind === "read");
      expect(tool.annotations.destructiveHint, tool.name).toBe(tool.kind === "danger");
      if (tool.kind === "danger") {
        expect(tool.meta[REQUIRES_USER_INTERACTION], tool.name).toBe(true);
        expect(tool.confirmIntent, tool.name).toBe(tool.name);
        expect(tool.input.safeParse({}).success, tool.name).toBe(false);
      }
    }
    expect(TOOLS.find((x) => x.name === "contact_merge")?.kind).toBe("danger");
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  });

  test("MCP-003 tools/list is filtered by the key's scopes; annotations and _meta reach the client", async () => {
    const t = setup();
    const reader = await connect((await mcpKey(t, SCOPE_PRESETS.read_only)).key);
    const readNames = (await reader.listTools()).tools.map((x) => x.name);
    expect(readNames).toEqual(expect.arrayContaining(["workspace_overview", "contact_search", "product_get"]));
    expect(readNames).not.toContain("contact_upsert");
    expect(readNames).not.toContain("contact_merge");
    expect(readNames).not.toContain("preview_action");

    const writer = await connect((await mcpKey(t, ["contacts:read", "contacts:write"])).key);
    const tools = (await writer.listTools()).tools;
    const merge = tools.find((x) => x.name === "contact_merge");
    expect(merge?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(merge?._meta?.[REQUIRES_USER_INTERACTION]).toBe(true);
    expect((merge?.inputSchema as { required?: string[] } | undefined)?.required).toContain("confirm_token");
    expect(tools.find((x) => x.name === "contact_search")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.map((x) => x.name)).not.toContain("product_get");
  });

  test("MCP-007 contact tools: upsert dedupes by e-mail, search finds it, structured output plus JSON text", async () => {
    const t = setup();
    await setupCatalog(t);
    const client = await connect((await mcpKey(t, ["contacts:read", "contacts:write"])).key);
    const contact = {
      kind: "organization",
      organization_name: "Claude GmbH",
      channels: [{ type: "email", value: "info@claude.example" }],
    };
    const first = (await client.callTool({ name: "contact_upsert", arguments: { contact } })) as ToolCall;
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ matched_existing: false });
    const second = (await client.callTool({
      name: "contact_upsert",
      arguments: { contact: { ...contact, notes: "zweiter Kontakt" } },
    })) as ToolCall;
    expect(second.structuredContent).toMatchObject({ matched_existing: true, matched_by: "email" });
    const search = (await client.callTool({ name: "contact_search", arguments: { query: "Claude" } })) as ToolCall;
    expect((search.structuredContent?.data as { name: string }[] | undefined)?.[0]?.name).toBe("Claude GmbH");
    expect(JSON.parse(search.content[0]?.text ?? "{}")).toEqual(search.structuredContent);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.channel === "mcp" && e.actor.startsWith("mcp:"))).toBe(true);
  });

  test("MCP-010 validation and scope errors come back as isError with code and hint", async () => {
    const t = setup();
    await setupCatalog(t);
    const client = await connect((await mcpKey(t, ["contacts:read", "contacts:write"])).key);
    const bad = (await client.callTool({
      name: "contact_upsert",
      arguments: { contact: { kind: "organization", organization_name: "X GmbH", vat_id: "DE123456789" } },
    })) as ToolCall;
    expect(bad.isError).toBe(true);
    expect(errorOf(bad)).toMatchObject({ code: "validation_failed" });
    const missing = (await client.callTool({
      name: "contact_get",
      arguments: { id: "con_k57f3x2m9q8w1e4r6t" },
    })) as ToolCall;
    expect(errorOf(missing).code).toBe("not_found");
  });

  test("MCP-004 MCP-006 contact_merge: preview_action issues a token; the token works once; params and intent are bound", async () => {
    const t = setup();
    const owner = await setupCatalog(t);
    const a = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Alpha GmbH"), { address: BERLIN }),
    });
    const b = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Alpha G.m.b.H."), { address: BERLIN }),
    });
    const client = await connect((await mcpKey(t, ["contacts:read", "contacts:write"])).key);
    const params = { winner_id: `con_${a.id}`, loser_ids: [`con_${b.id}`] };

    const noToken = (await client.callTool({ name: "contact_merge", arguments: params })) as ToolCall;
    expect(noToken.isError).toBe(true);

    const fake = (await client.callTool({
      name: "contact_merge",
      arguments: { ...params, confirm_token: "ct_x" },
    })) as ToolCall;
    expect(errorOf(fake).code).toBe("confirm_token_invalid");

    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "contact_merge", params },
    })) as ToolCall;
    expect(preview.isError).toBeFalsy();
    const token = preview.structuredContent?.confirm_token as string;
    expect(token).toMatch(/^ct_/);
    expect(preview.structuredContent?.effect).toMatchObject({
      losers: [expect.objectContaining({ id: `con_${b.id}` })],
    });

    const otherParams = (await client.callTool({
      name: "contact_merge",
      arguments: { ...params, confirm_vat_conflict: true, confirm_token: token },
    })) as ToolCall;
    expect(errorOf(otherParams)).toMatchObject({ code: "preview_outdated", hint: expect.any(String) });

    const ok = (await client.callTool({
      name: "contact_merge",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent?.merges as string[] | undefined)?.[0]).toMatch(/^mrg_/);
    const again = (await client.callTool({
      name: "contact_merge",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(errorOf(again).code).toBe("confirm_token_used");
  });

  test("MCP-004 a read-only key can neither preview nor merge (scope denial); stubs answer not_implemented", async () => {
    const t = setup();
    const client = await connect((await mcpKey(t, ["contacts:read", "documents:read"])).key);
    // Tools outside the key's scopes are not registered for this request: calling them is a protocol error.
    await expect(
      client.callTool({ name: "preview_action", arguments: { action: "contact_merge", params: {} } }),
    ).rejects.toThrow(/not found/);
    await expect(client.callTool({ name: "contact_merge", arguments: {} })).rejects.toThrow(/not found/);
    const doc = (await client.callTool({ name: "document_preview", arguments: { id: "x" } })) as ToolCall;
    expect(errorOf(doc).code).toBe("not_implemented");
  });

  test("MCP-007 MCP-008 product tools, the company resource and the prompts", async () => {
    const t = setup();
    await setupCatalog(t);
    const client = await connect((await mcpKey(t, ["products:read", "products:write", "settings:read"])).key);
    const created = (await client.callTool({
      name: "product_upsert",
      arguments: { product: { name: "Workshop-Tag", unit_price: "1200.00", unit_code: "DAY" } },
    })) as ToolCall;
    expect(created.structuredContent).toMatchObject({ created: true });
    const search = (await client.callTool({ name: "product_search", arguments: { query: "Workshop" } })) as ToolCall;
    expect((search.structuredContent?.data as { net_today: string }[] | undefined)?.[0]?.net_today).toBe("1200.0000");
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("rechnung://company");
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["angebot", "monatsabschluss"]));
    const prompt = await client.getPrompt({ name: "angebot", arguments: { kunde: "Müller GmbH" } });
    expect(JSON.stringify(prompt.messages)).toContain("Müller GmbH");
    const overview = (await client.callTool({ name: "workspace_overview", arguments: {} })) as ToolCall;
    expect(overview.structuredContent).toMatchObject({ counts: { active_products: 1 } });
  });

  test("MCP-001 every MCP request is access-logged with the JSON-RPC method", async () => {
    const t = setup();
    const seeded = await mcpKey(t, ["contacts:read"]);
    const client = await connect(seeded.key);
    await client.callTool({ name: "contact_search", arguments: {} });
    const rows = await t.run((ctx) => ctx.db.query("apiRequestLog").collect());
    expect(rows.every((r) => r.channel === "mcp")).toBe(true);
    expect(rows.map((r) => r.target)).toContain("/api/mcp tools/call contact_search");
  });
});
