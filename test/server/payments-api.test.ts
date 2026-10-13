import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { finalizedInvoice } from "../../convex/invoices.fixtures";
import { bookedTransaction } from "../../convex/payments.fixtures";
import type { TestT } from "../../convex/test.setup";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { REQUIRES_USER_INTERACTION } from "../../src/server/mcp/tool";
import { apiTest, call } from "./harness";

/**
 * F05 §7.1 / F07 §7 REST endpoints and the 06 §3.5/§3.7 MCP tools over convex-test. The invoice is T-GLD-01
 * (1.190,00 gross, 2 % Skonto within 14 days).
 */

let restore: (() => void) | undefined;
const clients: Client[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

function setup() {
  const h = apiTest();
  restore = h.restore;
  return h.t;
}

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

async function invoice(t: TestT) {
  const f = await finalizedInvoice(t);
  return { ...f, id: f.id as Id<"salesDocuments">, inv: `inv_${f.id}` };
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
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; message?: string };

describe("REST payments (05 §4.4, F05 §7.1)", () => {
  test("PAY-012 PAY-030 PAY-040 API-011 partial clearing payment, excess → 422, preview writes nothing, reversal", async () => {
    const t = setup();
    const { inv, bankAccount } = await invoice(t);
    const key = (await t.asApiKey(["payments:read", "payments:write"])).key;
    const clearing = { kind: "clearing", account_id: `bac_${bankAccount}` };

    const preview = await call("POST", "/payments/preview", {
      key,
      body: { invoice_id: inv, date: "2026-10-13", amount_cents: 50_000, source: clearing },
    });
    expect(preview.status).toBe(200);
    expect(await json(preview)).toMatchObject({
      allocations: [{ target: { kind: "invoice", id: inv }, amount_cents: 50_000, open_after_cents: 69_000 }],
    });
    expect((await json(await call("GET", "/payments", { key }))).data).toEqual([]);

    const excess = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 130_000, source: clearing },
    });
    expect(excess.status).toBe(422);
    expect(await json(excess)).toMatchObject({ code: "validation_failed", errors: [{ code: "excess" }] });

    const res = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 50_000, source: clearing },
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    const [payment] = body.data as Json[];
    expect(payment).toMatchObject({
      id: expect.stringMatching(/^pay_/),
      target: { kind: "invoice", id: inv },
      amount_cents: 50_000,
      source: { kind: "clearing", transaction_id: null },
    });

    const open = await json(await call("GET", "/open-items", { key }));
    expect(open.data).toEqual([expect.objectContaining({ id: inv, paid_cents: 50_000, open_cents: 69_000 })]);
    expect((await json(await call("GET", `/payments?target_id=${inv}`, { key }))).data).toHaveLength(1);

    const short = await call("POST", `/payments/${payment?.id}/reverse`, { key, body: { reason: "x" } });
    expect(short.status).toBe(422);
    const rev = await call("POST", `/payments/${payment?.id}/reverse`, { key, body: { reason: "Falsche Rechnung" } });
    expect(rev.status).toBe(201);
    expect((await json(rev)).data).toEqual([
      expect.objectContaining({ reversal_of_id: payment?.id, amount_cents: -50_000 }),
    ]);
    const after = await json(await call("GET", "/open-items", { key }));
    expect(after.data).toEqual([expect.objectContaining({ id: inv, open_cents: 119_000 })]);
  });

  test("PAY-061 PAY-063 cash payment over REST; the receipt is archived once, then served as „Kopie“", async () => {
    const t = setup();
    const { inv } = await invoice(t);
    const key = (await t.asApiKey(["payments:read", "payments:write"])).key;
    const res = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 119_000, source: { kind: "cash" } },
    });
    expect(res.status).toBe(201);
    const id = ((await json(res)).data as Json[])[0]?.id as string;
    const first = await json(await call("GET", `/payments/${id}/receipt`, { key }));
    expect(first).toMatchObject({ copy: false, content_type: "application/pdf" });
    expect(atob(first.content_base64 as string).startsWith("%PDF")).toBe(true);
    const second = await json(await call("GET", `/payments/${id}/receipt`, { key }));
    expect(second).toMatchObject({ copy: true, file_name: expect.stringMatching(/-Kopie\.pdf$/) });
    const p = await json(await call("GET", `/payments/${id}`, { key }));
    expect(p.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("BNK-041 BNK-046 suggestions by invoice number, match → paid; foreign prefix 404", async () => {
    const t = setup();
    const { inv, number, bankAccount } = await invoice(t);
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-13",
      amountCents: 119_000,
      purpose: `RE ${number} Danke`,
      counterpartyName: "Beispiel Handels GmbH",
    });
    const key = (await t.asApiKey(["banking:read", "banking:write", "payments:read"])).key;
    expect((await call("GET", `/bank-transactions/pay_${tx}/suggestions`, { key })).status).toBe(404);
    const s = await json(await call("GET", `/bank-transactions/btx_${tx}/suggestions`, { key }));
    const [best] = s.candidates as { score: number; reasons: string[]; targets: Json[] }[];
    expect(best?.reasons).toContain("number_in_purpose");
    expect(best?.targets[0]).toMatchObject({ kind: "invoice", id: inv, amount_cents: 119_000 });
    const m = await call("POST", `/bank-transactions/btx_${tx}/match`, {
      key,
      body: { targets: [{ kind: "invoice", id: inv, amount_cents: 119_000 }] },
    });
    expect(m.status).toBe(201);
    expect(((await json(m)).data as Json[])[0]).toMatchObject({ source: { kind: "bank", transaction_id: `btx_${tx}` } });
    const open = await json(await call("GET", "/open-items", { key }));
    expect(open.data).toEqual([]);
  });
});

describe("MCP payment and bank tools (06 §3.5, §3.7)", () => {
  test("MCP-005 the F05/F07 ⚠ tools are destructive, need user interaction and a confirm token", () => {
    for (const name of [
      "payment_record",
      "payment_reverse",
      "bank_match_confirm",
      "bank_transaction_mark",
      "cash_transfer_record",
    ]) {
      const tool = TOOLS.find((x) => x.name === name);
      expect(tool?.annotations.destructiveHint, name).toBe(true);
      expect(tool?.meta[REQUIRES_USER_INTERACTION], name).toBe(true);
      expect(tool?.confirmIntent, name).toBe(name);
    }
  });

  test("MCP-004 PAY-019 payment_record needs a preview token bound to source, date and amounts; payment_reverse too", async () => {
    const t = setup();
    const { inv, bankAccount } = await invoice(t);
    const client = await connect((await t.asMcp(["payments:read", "payments:write"])).key);
    const params = {
      source: { kind: "clearing", account_id: `bac_${bankAccount}` },
      date: "2026-10-13",
      allocations: [{ target: { kind: "invoice", id: inv }, amount_cents: 119_000 }],
    };
    const noToken = (await client.callTool({ name: "payment_record", arguments: params })) as ToolCall;
    expect(noToken.isError).toBe(true);

    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "payment_record", params },
    })) as ToolCall;
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent?.effect).toMatchObject({
      allocations: [{ amount_cents: 119_000, open_after_cents: 0, booking: { status: "lines" } }],
    });
    const token = preview.structuredContent?.confirm_token as string;

    const other = (await client.callTool({
      name: "payment_record",
      arguments: {
        ...params,
        allocations: [{ target: { kind: "invoice", id: inv }, amount_cents: 100_000 }],
        confirm_token: token,
      },
    })) as ToolCall;
    expect(errorOf(other).code).toBe("preview_outdated");

    const ok = (await client.callTool({
      name: "payment_record",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(ok.isError).toBeFalsy();
    const paymentId = (ok.structuredContent?.data as Json[])[0]?.id as string;
    const open = (await client.callTool({ name: "receivables_open_items", arguments: {} })) as ToolCall;
    expect(open.structuredContent?.data).toEqual([]);

    const revParams = { id: paymentId, reason: "Doppelt erfasst" };
    const rp = (await client.callTool({
      name: "preview_action",
      arguments: { action: "payment_reverse", params: revParams },
    })) as ToolCall;
    expect(rp.isError).toBeFalsy();
    const rev = (await client.callTool({
      name: "payment_reverse",
      arguments: { ...revParams, confirm_token: rp.structuredContent?.confirm_token },
    })) as ToolCall;
    expect(rev.isError).toBeFalsy();
    const list = (await client.callTool({ name: "payment_list", arguments: { invoice_id: inv } })) as ToolCall;
    expect(list.structuredContent?.data).toHaveLength(2);
  });

  test("MCP-004 BNK-046 CSH-024 bank_match_confirm and cash_transfer_record with preview tokens", async () => {
    const t = setup();
    const { inv, number, bankAccount } = await invoice(t);
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-13",
      amountCents: 119_000,
      purpose: `Rechnung ${number}`,
    });
    const client = await connect(
      (await t.asMcp(["payments:read", "payments:write", "banking:read", "banking:write"])).key,
    );
    const sugg = (await client.callTool({
      name: "bank_match_suggestions",
      arguments: { transaction_id: `btx_${tx}` },
    })) as ToolCall;
    expect((sugg.structuredContent?.candidates as Json[]).length).toBeGreaterThan(0);
    const params = { transaction_id: `btx_${tx}`, targets: [{ kind: "invoice", id: inv, amount_cents: 119_000 }] };
    const p = (await client.callTool({
      name: "preview_action",
      arguments: { action: "bank_match_confirm", params },
    })) as ToolCall;
    expect(p.isError).toBeFalsy();
    expect(p.structuredContent?.effect).toMatchObject({ booking: { allocations: [{ open_after_cents: 0 }] } });
    const ok = (await client.callTool({
      name: "bank_match_confirm",
      arguments: { ...params, confirm_token: p.structuredContent?.confirm_token },
    })) as ToolCall;
    expect(ok.isError).toBeFalsy();

    // Cash: the till receives 119,00 in cash first, then 50,00 go to the bank.
    const { inv: inv2 } = await finalizedSecond(t);
    const cashParams = {
      source: { kind: "cash" },
      date: "2026-10-13",
      allocations: [{ target: { kind: "invoice", id: inv2 }, amount_cents: 119_000 }],
    };
    const cp = (await client.callTool({
      name: "preview_action",
      arguments: { action: "payment_record", params: cashParams },
    })) as ToolCall;
    await client.callTool({
      name: "payment_record",
      arguments: { ...cashParams, confirm_token: cp.structuredContent?.confirm_token },
    });
    const transfer = {
      kind: "deposit_to_bank",
      date: "2026-10-13",
      amount_cents: 200_000,
      bank_account_id: `bac_${bankAccount}`,
    };
    const tooMuch = (await client.callTool({
      name: "preview_action",
      arguments: { action: "cash_transfer_record", params: transfer },
    })) as ToolCall;
    expect(errorOf(tooMuch).code).toBe("cash_negative");
    const fine = { ...transfer, amount_cents: 50_000 };
    const tp = (await client.callTool({
      name: "preview_action",
      arguments: { action: "cash_transfer_record", params: fine },
    })) as ToolCall;
    expect(tp.structuredContent?.effect).toMatchObject({ cash_balance_cents: 119_000, cash_balance_after_cents: 69_000 });
    const done = (await client.callTool({
      name: "cash_transfer_record",
      arguments: { ...fine, confirm_token: tp.structuredContent?.confirm_token },
    })) as ToolCall;
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent?.id).toMatch(/^csh_/);
  });
});

/** A second invoice of the same seller (the fixture seeds settings only once per test backend). */
async function finalizedSecond(t: TestT) {
  const { api } = await import("../../convex/_generated/api");
  const { invoiceValues, settle } = await import("../../convex/invoices.fixtures");
  const owner = await t.asUser("owner");
  const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
  const person = contacts.find((c) => c.kind === "person");
  const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(person?._id as string) });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { inv: `inv_${id}` };
}
