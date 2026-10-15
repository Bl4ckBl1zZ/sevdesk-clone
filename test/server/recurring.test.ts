import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { b2bBuyer, setupInvoicing } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { apiTest, call } from "./harness";

/** F04 §7.1/§7.2 recurring invoice templates over REST and MCP (REC-01, REC-10, REC-12, REC-13, REC-14, REC-16). */

let restore: (() => void) | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T09:00:00Z"));
  const h = apiTest();
  restore = h.restore;
  return h.t;
}

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

type ToolCall = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text?: string }[] };
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function buyer(t: TestT) {
  const { owner } = await setupInvoicing(t);
  const { personId } = await b2bBuyer(owner);
  return `con_${personId}`;
}

const body = (contactId: string, over: Record<string, unknown> = {}) => ({
  name: "Hosting Beispiel",
  contact_id: contactId,
  lines: [{ name: "Hosting-Paket", quantity: "1", unit_price: "49.00", vat_rate_key: "standard" }],
  schedule: { interval: "P1M", first_date: "2026-11-01", billing: "in_advance", period_text: true },
  ...over,
});

describe("REST /recurring-invoices (F04 §7.1)", { timeout: 30_000 }, () => {
  test("REC-14 SEC-02 T-REC-011 finalise automation needs invoices:finalize; with it it waits for the UI; a send field is 422", async () => {
    const t = setup();
    const contactId = await buyer(t);
    const plain = (await t.asApiKey(["documents:read", "documents:write"])).key;
    const denied = await call("POST", "/recurring-invoices", {
      key: plain,
      body: body(contactId, { automation: { finalize: true } }),
    });
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe("insufficient_scope");

    const finalizer = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize"])).key;
    const created = await call("POST", "/recurring-invoices", {
      key: finalizer,
      body: body(contactId, { automation: { finalize: true } }),
    });
    expect(created.status).toBe(201);
    const tpl = await json(created);
    expect(tpl).toMatchObject({
      name: "Hosting Beispiel",
      state: "active",
      automation: { finalize: true, confirmed: false, effective: false },
      schedule: { interval: "P1M", first_date: "2026-11-01", next_date: "2026-11-01", billing: "in_advance" },
      amount: { net_cents: 4900, gross_cents: 5831, currency: "EUR" },
    });
    expect(String(tpl.id)).toMatch(/^rec_/);

    const send = await call("POST", "/recurring-invoices", {
      key: finalizer,
      body: body(contactId, { automation: { finalize: true, send: true } }),
    });
    expect(send.status).toBe(422);
  });

  test("REC-13 REC-12 REC-10 occurrences, run-now, pause and resume", async () => {
    const t = setup();
    const contactId = await buyer(t);
    const key = (await t.asApiKey(["documents:read", "documents:write"])).key;
    const tpl = await json(await call("POST", "/recurring-invoices", { key, body: body(contactId) }));
    const id = String(tpl.id);

    const occ = await json(await call("GET", `/recurring-invoices/${id}/occurrences?count=12`, { key }));
    const data = occ.data as { date: string; period: { from: string; to: string }; gross_cents: number }[];
    expect(data).toHaveLength(12);
    expect(data[0]).toMatchObject({
      date: "2026-11-01",
      period: { from: "2026-11-01", to: "2026-11-30" },
      gross_cents: 5831,
    });

    const run = await call("POST", `/recurring-invoices/${id}/run-now`, { key });
    expect(run.status).toBe(200);
    const r = await json(run);
    expect(r).toMatchObject({ created: 1, finalized: 0 });
    expect((r.documents as string[])[0]).toMatch(/^inv_/);

    const paused = await json(await call("POST", `/recurring-invoices/${id}/pause`, { key }));
    expect(paused.state).toBe("paused");
    const resumed = await json(
      await call("POST", `/recurring-invoices/${id}/resume`, { key, body: { catch_up: false } }),
    );
    expect(resumed).toMatchObject({ state: "active", schedule: { next_date: "2026-12-01" } });

    const patched = await call("PATCH", `/recurring-invoices/${id}`, {
      key,
      body: { name: "Hosting XL", version: resumed.version },
    });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ name: "Hosting XL", generated_count: 1 });

    const list = await json(await call("GET", "/recurring-invoices", { key }));
    expect((list.data as { id: string }[]).map((x) => x.id)).toEqual([id]);
  });
});

describe("MCP recurring_invoice_* (06 §3.4)", { timeout: 30_000 }, () => {
  test("REC-14 T-REC-011 recurring_invoice_upsert without invoices:finalize cannot enable automation; list shows the next occurrences", async () => {
    const t = setup();
    const contactId = await buyer(t);
    const mcp = await t.asMcp(["documents:read", "documents:write"]);
    const client = await connect(mcp.key);
    const denied = (await client.callTool({
      name: "recurring_invoice_upsert",
      arguments: body(contactId, { automation: { finalize: true } }),
    })) as ToolCall;
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]?.text ?? "{}").error.code).toBe("insufficient_scope");

    const ok = (await client.callTool({ name: "recurring_invoice_upsert", arguments: body(contactId) })) as ToolCall;
    expect(ok.isError).toBeFalsy();
    const list = (await client.callTool({ name: "recurring_invoice_list", arguments: {} })) as ToolCall;
    const rows = (list.structuredContent?.data ?? []) as { name: string; next_occurrences: { date: string }[] }[];
    expect(rows[0]?.name).toBe("Hosting Beispiel");
    expect(rows[0]?.next_occurrences.map((o) => o.date)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });
});
