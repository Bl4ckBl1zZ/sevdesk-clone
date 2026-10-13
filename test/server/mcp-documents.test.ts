import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "../../convex/catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import { SCOPE_PRESETS } from "../../src/domain/api/scopes";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { apiTest } from "./harness";

/** 06 §3.4 / F04 §7.2 document tools: quote draft → (owner finalises) → acceptance → conversion → chain. */

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
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; errors?: Json[] };

async function setup() {
  const h = apiTest();
  restore = h.restore;
  const s = await setupInvoicing(h.t);
  await s.owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        CONTACT_RANGE,
        PRODUCT_RANGE,
        INVOICE_RANGE,
        { key: "quote", name: "Angebote", format: "AN-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
      ],
    },
  });
  const { personId } = await b2bBuyer(s.owner);
  return { t: h.t, owner: s.owner, contact: `con_${personId}` };
}

describe("MCP document tools (06 §3.4)", () => {
  test("MCP-003 the read-only preset lists document_search/document_get but no draft tools and no document_finalize", async () => {
    const { t } = await setup();
    const reader = await connect((await t.asMcp([...SCOPE_PRESETS.read_only])).key);
    const names = (await reader.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["document_search", "document_get"]));
    expect(names).not.toContain("quote_create_draft");
    expect(names).not.toContain("document_convert");
    expect(names).not.toContain("document_finalize");
  });

  test("MCP-011 QUO-05 DOC-33 quote_create_draft → finalised by the owner → quote_mark_accepted → document_convert → document_get", async () => {
    const { t, owner, contact } = await setup();
    const client = await connect((await t.asMcp(["documents:read", "documents:write"])).key);
    const call = async (name: string, args: Json) => (await client.callTool({ name, arguments: args })) as ToolCall;

    const draft = await call("quote_create_draft", {
      contact_id: contact,
      lines: [{ name: "Beratung", quantity: "8", unit_price: "120", unit_code: "HUR" }],
    });
    expect(draft.isError, JSON.stringify(draft.content)).toBeFalsy();
    const quote = draft.structuredContent as Json;
    expect(quote).toMatchObject({ type: "quote", status: "draft", totals: { net_cents: 96_000 } });

    const updated = await call("document_update_draft", {
      id: quote.id,
      version: quote.version,
      subject: "Angebot Beratung",
    });
    expect(updated.structuredContent?.subject).toBe("Angebot Beratung");

    const raw = quote.id.slice(4) as Id<"salesDocuments">;
    await owner.action(api.invoices.finalize, { id: raw, version: updated.structuredContent?.version });
    await settle(t);

    const early = await call("document_convert", { id: quote.id, to: "invoice" });
    expect(early.isError).toBe(true);
    expect(errorOf(early).errors?.[0]?.code).toBe("quote_not_accepted");

    const accepted = await call("quote_mark_accepted", {
      id: quote.id,
      date: "2026-10-12",
      accepted_by: "Max Beispiel",
      channel: "phone",
    });
    expect(accepted.structuredContent).toMatchObject({ status: "accepted", number: "AN-2026-0001" });

    const converted = await call("document_convert", { id: quote.id, to: "invoice" });
    expect(converted.isError, JSON.stringify(converted.content)).toBeFalsy();
    expect(converted.structuredContent?.document).toMatchObject({ type: "invoice", status: "draft" });

    const got = await call("document_get", { id: quote.id });
    expect(got.structuredContent?.chain.data.map((d: Json) => d.type)).toEqual(["quote", "invoice"]);
    const search = await call("document_search", { type: "quote", status: "accepted" });
    expect(search.structuredContent?.data.map((d: Json) => d.number)).toEqual(["AN-2026-0001"]);

    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.action === "document.convert" && e.actor.startsWith("mcp:"))).toBe(true);
  });

  test("MCP-011 DOC-25 invoice_create_draft creates a proforma; quote_mark_rejected refuses a non-quote id", async () => {
    const { t, contact } = await setup();
    const client = await connect((await t.asMcp(["documents:read", "documents:write"])).key);
    const pf = (await client.callTool({
      name: "invoice_create_draft",
      arguments: {
        contact_id: contact,
        invoice_type: "proforma",
        supply_date: { kind: "date", date: "2026-10-09" },
        lines: [{ name: "Anzahlung Material", quantity: "1", unit_price: "1000" }],
      },
    })) as ToolCall;
    expect(pf.structuredContent).toMatchObject({ type: "proforma", invoice_type: "proforma" });
    const wrong = (await client.callTool({
      name: "quote_mark_rejected",
      arguments: { id: pf.structuredContent?.id, date: "2026-10-12" },
    })) as ToolCall;
    expect(wrong.isError).toBe(true);
    expect(errorOf(wrong).code).toBe("not_found");
  });
});
