import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { apiTest, call } from "./harness";

/**
 * „PDF-Vorschau“ of drafts (F04 §4.4.7, DOC-42): REST `POST /{type}/{id}/preview-pdf` and the MCP tool
 * `document_preview_pdf` (MCP-017) — the draft as PDF or as PNG pages, watermarked „ENTWURF“, nothing written.
 */

vi.setConfig({ testTimeout: 60_000 });

let restore: (() => void) | undefined;
const clients: Client[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
});

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: "vitest", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://api.test.local/api/mcp"), {
    fetch: (input, init) => handleMcpRequest(new Request(input as string | URL, init as RequestInit)),
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed tool results in assertions
type Json = Record<string, any>;
type Content = { type: string; text?: string; data?: string; mimeType?: string; resource?: Json };
type ToolCall = { isError?: boolean; structuredContent?: Json; content: Content[] };
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; errors?: Json[] };

async function setup() {
  const h = apiTest();
  restore = h.restore;
  const s = await setupInvoicing(h.t);
  const { personId } = await b2bBuyer(s.owner);
  const { id } = await s.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
  return { t: h.t, owner: s.owner, id, personId };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64").slice(0, 4);

describe("MCP document_preview_pdf (MCP-017)", () => {
  test("MCP-017 png: the draft pages as images plus a JSON summary; nothing is written", async () => {
    const { t, id } = await setup();
    const client = await connect((await t.asMcp(["documents:read"])).key);
    const tool = (await client.listTools()).tools.find((x) => x.name === "document_preview_pdf");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const before = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length);
    const r = (await client.callTool({
      name: "document_preview_pdf",
      arguments: { id: `inv_${id}`, format: "png" },
    })) as ToolCall;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const images = r.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data?.startsWith(PNG)).toBe(true);
    expect(r.structuredContent).toMatchObject({
      id: `inv_${id}`,
      format: "png",
      file_name: "Rechnung-Entwurf.pdf",
      page_count: 1,
      pages_returned: 1,
    });
    // the MCP access log is the only row the call adds (no snapshot, no artifact, no audit entry)
    const after = await t.run(async (ctx) => ({
      audit: (await ctx.db.query("auditLog").collect()).length,
      artifacts: (await ctx.db.query("documentArtifacts").collect()).length,
    }));
    expect(after).toEqual({ audit: before, artifacts: 0 });
  });

  test("MCP-017 pdf: the draft PDF as an embedded resource (application/pdf, base64)", async () => {
    const { t, id } = await setup();
    const client = await connect((await t.asMcp(["documents:read"])).key);
    const r = (await client.callTool({
      name: "document_preview_pdf",
      arguments: { id: `inv_${id}`, format: "pdf" },
    })) as ToolCall;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const res = r.content.find((c) => c.type === "resource")?.resource;
    expect(res).toMatchObject({
      mimeType: "application/pdf",
      uri: `rechnung://documents/inv_${id}/Rechnung-Entwurf.pdf`,
    });
    expect(
      Buffer.from(res?.blob ?? "", "base64")
        .subarray(0, 5)
        .toString("latin1"),
    ).toBe("%PDF-");
  });

  test("MCP-017 a finalised invoice is refused with a pointer to document_export", async () => {
    const { t, owner, id } = await setup();
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const client = await connect((await t.asMcp(["documents:read"])).key);
    const r = (await client.callTool({ name: "document_preview_pdf", arguments: { id: `inv_${id}` } })) as ToolCall;
    expect(r.isError).toBe(true);
    expect(errorOf(r).code).toBe("immutable_record");
    expect(JSON.parse(r.content[0]?.text ?? "{}").error.message).toContain("document_export");
  });

  test("MCP-017 a draft with blocking findings returns them instead of a picture", async () => {
    const { t, owner, personId } = await setup();
    const { contactId: _c, ...noContact } = invoiceValues(personId);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: noContact });
    const client = await connect((await t.asMcp(["documents:read"])).key);
    const r = (await client.callTool({ name: "document_preview_pdf", arguments: { id: `inv_${id}` } })) as ToolCall;
    expect(r.isError).toBe(true);
    expect(errorOf(r).code).toBe("validation_failed");
    expect(errorOf(r).errors?.length).toBeGreaterThan(0);
  });

  test("MCP-017 the tool is listed only for keys with documents:read", async () => {
    const { t } = await setup();
    const client = await connect((await t.asMcp(["contacts:read"])).key);
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain("document_preview_pdf");
  });
});

describe("REST preview-pdf (DOC-42)", () => {
  test("DOC-42 POST /invoices/{id}/preview-pdf returns the watermarked draft PDF inline", async () => {
    const { t, id } = await setup();
    const { key } = await t.asApiKey(["documents:read"]);
    const res = await call("POST", `/invoices/inv_${id}/preview-pdf`, { key, body: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="Rechnung-Entwurf.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(0, 5)
        .toString("latin1"),
    ).toBe("%PDF-");
  });

  test("DOC-42 preview-pdf of a finalised invoice → 409 immutable_record", async () => {
    const { t, owner, id } = await setup();
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const { key } = await t.asApiKey(["documents:read"]);
    const res = await call("POST", `/invoices/inv_${id}/preview-pdf`, { key, body: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("immutable_record");
  });
});
