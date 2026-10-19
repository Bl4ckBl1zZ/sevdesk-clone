import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bookedTransaction } from "../../convex/payments.fixtures";
import { setupCompany, TODAY } from "../../convex/vouchers.fixtures";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { apiTest, call } from "./harness";

/** F07 §7.1/§7.2: /bank-connection, the removed sync endpoint, /matching-rules, POST /bank-transactions/{id}/voucher, MCP matching_rule_upsert. */

let restore: (() => void) | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

function setup() {
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

type Json = Record<string, unknown>;
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const json = async (res: Response) => (await res.json()) as Json;

const ruleBody = {
  name: "Kontoführung",
  priority: 10,
  mode: "auto",
  when: { purpose_contains: "plan fee", direction: "out" },
  apply: { action: "categorize", account: "6855", tax_rule: "no_input_vat", statement_suffices_as_voucher: true },
};

describe("REST bank feed (F07 §7.1)", { timeout: 60_000 }, () => {
  test("BNK-107 BNK-013 GET /bank-connection has no secrets; POST /bank-accounts/{id}/sync → 409 owner_presence_required", async () => {
    const t = setup();
    const { bank } = await setupCompany(t, { ku: true });
    const key = (await t.asApiKey(["banking:read", "banking:write"])).key;
    const res = await call("GET", "/bank-connection", { key });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      provider: "enable_banking",
      status: "not_configured",
      key_stored: false,
      accounts: [],
    });
    expect(JSON.stringify(body)).not.toMatch(/private|PRIVATE KEY|session/i);
    const sync = await call("POST", `/bank-accounts/bac_${bank}/sync`, { key, body: {} });
    expect(sync.status).toBe(409);
    expect(await json(sync)).toMatchObject({ code: "owner_presence_required" });
  });

  test("BNK-054 EC-BNK-73 BNK-051 POST /matching-rules is stored as suggest with a warning; preview; PATCH keeps suggest", async () => {
    const t = setup();
    const { bank } = await setupCompany(t, { ku: true });
    await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -1500, purpose: "Monthly plan fee" });
    const key = (await t.asApiKey(["banking:read", "banking:write"])).key;
    const created = await call("POST", "/matching-rules", { key, body: ruleBody });
    expect(created.status).toBe(201);
    const rule = await json(created);
    expect(rule).toMatchObject({
      id: expect.stringMatching(/^mrl_/),
      mode: "suggest",
      created_via: "api",
      hits_90_days: 1,
      warning:
        "Regeln aus API/MCP werden als Vorschlagsregel gespeichert. Automatik bitte in der Oberfläche aktivieren.",
      apply: { action: "categorize", account: "6855", statement_suffices_as_voucher: true },
    });
    const patched = await json(
      await call("PATCH", `/matching-rules/${rule.id}`, { key, body: { mode: "auto", priority: 5 } }),
    );
    expect(patched).toMatchObject({ mode: "suggest", priority: 5 });
    const list = await json(await call("GET", "/matching-rules", { key }));
    expect((list.data as Json[]).map((r) => r.id)).toEqual([rule.id]);
    const preview = await json(
      await call("POST", "/matching-rules/preview", { key, body: { when: { purpose_contains: "fee" } } }),
    );
    expect(preview).toMatchObject({ count: 1, message: "Diese Regel würde 1 Umsatz der letzten 90 Tage treffen" });
    const bad = await call("POST", "/matching-rules", {
      key,
      body: { ...ruleBody, when: { purpose_regex: "(\\w+)*x" } },
    });
    expect(bad.status).toBe(422);
    expect(await call("GET", "/matching-rules/mrl_doesnotexist0000000", { key }).then((r) => r.status)).toBe(404);
  });

  test("BNK-065 POST /bank-transactions/{id}/voucher creates the prefilled draft", async () => {
    const t = setup();
    const { bank } = await setupCompany(t, { ku: true });
    const tx = await bookedTransaction(t, bank, {
      bookingDate: TODAY,
      amountCents: -4990,
      purpose: "Abo",
      counterpartyName: "Adobe Systems",
    });
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write", "banking:read"])).key;
    const res = await call("POST", `/bank-transactions/btx_${tx}/voucher`, { key, body: { account: "6815" } });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({
      id: expect.stringMatching(/^vou_/),
      status: "draft",
      supplier_name: "Adobe Systems",
      document_date: TODAY,
    });
  });
});

describe("MCP matching_rule_upsert (06 §3.7)", { timeout: 60_000 }, () => {
  test("BNK-054 T07-085 EC-BNK-73 a rule via MCP is stored as suggest; there is no fetch/sync tool (BNK-107)", async () => {
    const t = setup();
    await setupCompany(t, { ku: true });
    const client = await connect((await t.asMcp(["banking:read", "banking:write"])).key);
    const r = (await client.callTool({
      name: "matching_rule_upsert",
      arguments: { name: ruleBody.name, when: ruleBody.when, apply: ruleBody.apply },
    })) as ToolCall;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ mode: "suggest", created_via: "mcp" });
    const rows = await t.run((ctx) => ctx.db.query("matchingRules").collect());
    expect(rows.map((x) => x.mode)).toEqual(["suggest"]);
    const tool = TOOLS.find((x) => x.name === "matching_rule_upsert");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(TOOLS.map((x) => x.name).filter((n) => /sync|fetch|poll|refresh/.test(n))).toEqual([]);
    const missing = (await client.callTool({ name: "matching_rule_upsert", arguments: { name: "x" } })) as ToolCall;
    expect(missing.isError).toBe(true);
  });
});
