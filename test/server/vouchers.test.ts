import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { postJournalEntry } from "../../convex/model/journal";
import type { TestT } from "../../convex/test.setup";
import { OWNER, setupCompany, TODAY, upload, YEAR } from "../../convex/vouchers.fixtures";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { REQUIRES_USER_INTERACTION } from "../../src/server/mcp/tool";
import { apiTest, call } from "./harness";

/** F06 §7 purchase vouchers over REST (05 §4.5 /vouchers) and MCP (06 §3 voucher_*; VOU-007, VOU-008, VOU-136…138). */

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
type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;
const text = (r: ToolCall) => r.content.map((c) => c.text ?? "").join("\n");

let seq = 0;
const draftBody = (over: Json = {}) => ({
  supplier_name: "Büro Schmidt GmbH",
  supplier_vat_id: "DE123456789",
  supplier_address: "Hauptstraße 1, 10115 Berlin",
  document_number: `RE-${YEAR}-${++seq}${Math.floor(Math.random() * 1e5)}`,
  document_date: TODAY,
  price_mode: "gross",
  lines: [{ account: "6805", description: "Telefon und Internet", amount_cents: 11_900, vat_rate_bp: 1900 }],
  ...over,
});

/** The original file comes from the app/inbox (not part of the REST slice): the owner uploads it to the draft. */
async function attachOriginal(t: TestT, publicId: string) {
  const owner = await t.asUser("owner");
  await upload(t, owner, { voucherId: publicId.slice(4) as Id<"vouchers"> });
}

async function openingCash(t: TestT, cents: number) {
  await t.model(OWNER, (ctx) =>
    postJournalEntry(ctx, {
      kind: "opening_balance",
      fiscalYear: YEAR,
      date: `${YEAR}-01-01`,
      part: { kind: "cash", amountCents: cents },
    }),
  );
}

describe("REST /vouchers (05 §4.5)", { timeout: 60_000 }, () => {
  test("VOU-001 VOU-007 VOU-138 create, read, preview and book a voucher with „Bezahlt mit: Privat“", async () => {
    const t = setup();
    await setupCompany(t);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;

    const created = await call("POST", "/vouchers", { key, body: draftBody() });
    expect(created.status).toBe(201);
    const draft = await json(created);
    expect(String(draft.id)).toMatch(/^vou_/);
    expect(created.headers.get("Location")).toBe(`/api/v1/vouchers/${draft.id}`);
    expect(draft).toMatchObject({
      status: "draft",
      internal_number: null,
      totals: { net_cents: 10_000, vat_cents: 1900, gross_cents: 11_900 },
    });

    // RI-21 / VOU-007: without an original the dry run names the missing Beleg and nothing is booked.
    const noFile = await json(await call("POST", `/vouchers/${draft.id}/preview`, { key, body: {} }));
    expect(noFile.allowed).toBe(false);

    await attachOriginal(t, String(draft.id));
    const preview = await json(
      await call("POST", `/vouchers/${draft.id}/preview`, { key, body: { payment: { method: "private" } } }),
    );
    expect(preview).toMatchObject({ allowed: true, payment: { method: "private", amountCents: 11_900 } });

    const noIdem = await call("POST", `/vouchers/${draft.id}/finalize`, {
      key,
      body: { payment: { method: "private" } },
    });
    expect(noIdem.status).toBe(400);
    expect((await json(noIdem)).code).toBe("idempotency_key_required");

    const booked = await call("POST", `/vouchers/${draft.id}/finalize`, {
      key,
      body: { payment: { method: "private" } },
      headers: { "Idempotency-Key": "vou-fin-1" },
    });
    expect(booked.status).toBe(200);
    const v = await json(booked);
    expect(v).toMatchObject({ status: "paid", open_amount_cents: 0 });
    expect(String(v.internal_number)).toMatch(new RegExp(`^BE-${YEAR}-\\d{5}$`));
    expect(v.payments).toEqual([expect.objectContaining({ source: "private", amount_cents: 11_900, reversed: false })]);

    const list = await json(await call("GET", "/vouchers?status=paid", { key }));
    expect((list.data as Json[]).map((r) => r.id)).toEqual([draft.id]);
    expect((await call("GET", "/vouchers/inv_abcdefghijklmnop1234", { key })).status).toBe(404);
  });

  test("VOU-008 PATCH on a booked voucher needs correction_reason; drafts are deleted, booked ones are not", async () => {
    const t = setup();
    await setupCompany(t);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const draft = await json(await call("POST", "/vouchers", { key, body: draftBody() }));
    await attachOriginal(t, String(draft.id));
    const booked = await json(
      await call("POST", `/vouchers/${draft.id}/finalize`, { key, body: {}, headers: { "Idempotency-Key": "v8" } }),
    );
    expect(booked.status).toBe("open");

    const lines = [{ account: "6805", description: "Telefon", amount_cents: 23_800, vat_rate_bp: 1900 }];
    const noReason = await call("PATCH", `/vouchers/${draft.id}`, {
      key,
      body: { lines, version: booked.version },
    });
    expect(noReason.status).toBe(422);
    expect(JSON.stringify(await json(noReason))).toContain("correction_reason");

    const corrected = await call("PATCH", `/vouchers/${draft.id}`, {
      key,
      body: { lines, version: booked.version, correction_reason: "Betrag falsch abgetippt" },
    });
    expect(corrected.status).toBe(200);
    expect(await json(corrected)).toMatchObject({
      status: "open",
      internal_number: booked.internal_number,
      totals: { gross_cents: 23_800 },
    });
    expect((await call("DELETE", `/vouchers/${draft.id}`, { key })).status).toBeGreaterThanOrEqual(400);

    const other = await json(await call("POST", "/vouchers", { key, body: draftBody() }));
    expect((await call("DELETE", `/vouchers/${other.id}`, { key })).status).toBe(204);
    expect((await call("GET", `/vouchers/${other.id}`, { key })).status).toBe(404);
  });

  test("VOU-007 scopes: vouchers:read cannot write; later payments need payments:write and vouchers:write", async () => {
    const t = setup();
    await setupCompany(t);
    const reader = (await t.asApiKey(["vouchers:read"])).key;
    const denied = await call("POST", "/vouchers", { key: reader, body: draftBody() });
    expect(denied.status).toBe(403);
    expect((await json(denied)).code).toBe("insufficient_scope");

    const writer = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const draft = await json(await call("POST", "/vouchers", { key: writer, body: draftBody() }));
    const payer = (await t.asApiKey(["payments:write"])).key;
    const noVoucherScope = await call("POST", `/vouchers/${draft.id}/payments`, {
      key: payer,
      body: { method: "private" },
      headers: { "Idempotency-Key": "p1" },
    });
    expect(noVoucherScope.status).toBe(403);
  });
});

describe("MCP voucher tools (06 §3)", { timeout: 60_000 }, () => {
  test("VOU-007 MCP-safety voucher_finalize is ⚠: destructive, user interaction, preview_action intent", () => {
    const tool = TOOLS.find((x) => x.name === "voucher_finalize");
    expect(tool?.annotations.destructiveHint).toBe(true);
    expect(tool?.meta[REQUIRES_USER_INTERACTION]).toBe(true);
    expect(tool?.confirmIntent).toBe("voucher_finalize");
    for (const name of ["voucher_search", "voucher_get"]) {
      expect(TOOLS.find((x) => x.name === name)?.annotations.readOnlyHint, name).toBe(true);
    }
    expect(TOOLS.find((x) => x.name === "voucher_update_draft")?.annotations.destructiveHint).toBe(false);
  });

  test("VOU-136 VOU-137 voucher_finalize: the preview shows the cash balance; the token binds method, date and amount", async () => {
    const t = setup();
    await setupCompany(t);
    const client = await connect((await t.asMcp(["vouchers:read", "vouchers:write"])).key);

    const created = (await client.callTool({ name: "voucher_update_draft", arguments: draftBody() })) as ToolCall;
    expect(created.isError).toBeFalsy();
    const id = String(created.structuredContent?.id);
    expect(id).toMatch(/^vou_/);
    await attachOriginal(t, id);

    // CSH-026: 119,00 € in cash from an empty till → no token, the act's message.
    const tooMuch = (await client.callTool({
      name: "preview_action",
      arguments: { action: "voucher_finalize", params: { id, payment: { method: "cash" } } },
    })) as ToolCall;
    expect(tooMuch.isError).toBe(true);
    expect(text(tooMuch)).toContain("cash_negative");

    await openingCash(t, 25_000);
    const params = { id, payment: { method: "cash", date: TODAY, amount_cents: 11_900 } };
    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "voucher_finalize", params },
    })) as ToolCall;
    expect(preview.isError, text(preview)).toBeFalsy();
    expect(preview.structuredContent?.effect).toMatchObject({
      payment: { method: "cash", date: TODAY, amount_cents: 11_900 },
      cash_balance_cents: 25_000,
      cash_balance_after_cents: 13_100,
    });
    const token = String(preview.structuredContent?.confirm_token);

    const noToken = (await client.callTool({ name: "voucher_finalize", arguments: params })) as ToolCall;
    expect(noToken.isError).toBe(true);

    const otherMethod = (await client.callTool({
      name: "voucher_finalize",
      arguments: { id, payment: { method: "private", date: TODAY, amount_cents: 11_900 }, confirm_token: token },
    })) as ToolCall;
    expect(otherMethod.isError).toBe(true);

    const ok = (await client.callTool({
      name: "voucher_finalize",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ status: "paid", open_amount_cents: 0 });
    expect(String(ok.structuredContent?.internal_number)).toMatch(/^BE-/);

    const again = (await client.callTool({
      name: "voucher_update_draft",
      arguments: { id, internal_note: "nachträglich" },
    })) as ToolCall;
    expect(again.isError).toBe(true);

    const found = (await client.callTool({ name: "voucher_search", arguments: { status: "paid" } })) as ToolCall;
    expect(((found.structuredContent?.data ?? []) as Json[]).map((r) => r.id)).toEqual([id]);
    const got = (await client.callTool({ name: "voucher_get", arguments: { id } })) as ToolCall;
    expect(got.structuredContent?.payments).toEqual([
      expect.objectContaining({ source: "cash", amount_cents: 11_900 }),
    ]);
  });
});
