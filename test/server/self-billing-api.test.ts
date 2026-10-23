import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CONTACT_RANGE, createValues, orgForm, PRODUCT_RANGE } from "../../convex/catalog.fixtures";
import { INVOICE_RANGE, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { apiTest, call } from "./harness";

/**
 * Self-billing Gutschrift over REST (05 §4.3 `/self-billing`, `sbc_`) and MCP (06 §3.4): drafts, finalisation
 * (Idempotency-Key / document_preview → ⚠ document_finalize), export, mark-sent and the supplier's objection
 * (`POST /self-billing/{id}/cancel`, MCP document_preview intent cancel → ⚠ invoice_cancel with the sbc_ id).
 */

vi.setConfig({ testTimeout: 90_000 });

let restore: (() => void) | undefined;
const clients: Client[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  vi.useRealTimers();
  restore?.();
  restore = undefined;
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON responses in assertions
type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };

const GS_RANGE = {
  key: "self_billing",
  name: "Gutschriften",
  format: "GS-{YYYY}-{####}",
  resetPolicy: "yearly",
  next: 1,
};
const VOUCHER_RANGE = {
  key: "voucherInternal",
  name: "Belege (intern)",
  format: "BE-{YYYY}-{#####}",
  resetPolicy: "yearly",
  next: 1,
};

async function setup(opts: { agreement?: boolean } = {}) {
  const h = apiTest();
  restore = h.restore;
  const t = h.t;
  const { owner } = await setupInvoicing(t);
  await owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE, GS_RANGE, VOUCHER_RANGE] },
  });
  const { id } = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm("Agentur Nord GmbH", { roles: ["supplier"], vatId: "DE136695976" }), {
      address: { street: "Speicherstadt 4", postalCode: "20457", city: "Hamburg", countryCode: "DE" },
      email: "abrechnung@agentur-nord.de",
      phone: "+49 40 123456",
    }),
  });
  if (opts.agreement !== false) {
    await owner.mutation(api.contacts.setSelfBillingAgreement, {
      id: id as Id<"contacts">,
      agreement: {
        agreedOn: "2026-01-02",
        scope: "Provisionsabrechnungen",
        validFrom: "2026-01-01",
        iban: "DE75 5121 0800 1245 1261 99",
      },
    });
  }
  return { t, supplier: `con_${id}` };
}

const commission = (contact: string) => ({
  contact_id: contact,
  supply_date: { kind: "month", month: "2026-09" },
  lines: [
    {
      name: "Provision September 2026",
      quantity: "1",
      unit_price: "5000",
      product_type: "service",
      vat_rate_key: "standard",
    },
  ],
});

let idem = 0;
const idemKey = () => ({ "Idempotency-Key": `sb-${++idem}` });

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

async function finalizedViaRest(t: TestT, key: string, supplier: string) {
  const created = await call("POST", "/self-billing", { key, body: commission(supplier) });
  expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
  const draft = await json(created);
  const fin = await call("POST", `/self-billing/${draft.id}/finalize`, {
    key,
    body: { version: draft.version },
    headers: idemKey(),
  });
  expect(fin.status, JSON.stringify(await fin.clone().json())).toBe(200);
  await settle(t);
  return json(fin);
}

describe("REST /self-billing (05 §4.3, F04 §4.9, INV-16)", () => {
  test("API-025 INV-16 UST-33 draft → finalise (invoices:finalize, Idempotency-Key) → GS- number, title „Gutschrift“, listed and readable with sbc_", async () => {
    const { t, supplier } = await setup();
    const key = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize"])).key;
    const created = await call("POST", "/self-billing", { key, body: commission(supplier) });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const draft = await json(created);
    expect(draft.id).toMatch(/^sbc_/);
    expect(draft).toMatchObject({ type: "self_billing", status: "draft", number: null });
    expect(draft.totals).toMatchObject({ net_cents: 500_000, vat_cents: 95_000, gross_cents: 595_000 });

    const noIdem = await call("POST", `/self-billing/${draft.id}/finalize`, { key, body: { version: draft.version } });
    expect(noIdem.status).toBe(400);
    const fin = await call("POST", `/self-billing/${draft.id}/finalize`, {
      key,
      body: { version: draft.version },
      headers: idemKey(),
    });
    expect(fin.status, JSON.stringify(await fin.clone().json())).toBe(200);
    await settle(t);
    expect(await json(fin)).toMatchObject({ id: draft.id, number: "GS-2026-0001", status: "finalized" });

    const list = await json(await call("GET", "/self-billing", { key }));
    expect(list.data.map((d: Json) => d.id)).toEqual([draft.id]);
    const got = await json(await call("GET", `/self-billing/${draft.id}`, { key }));
    expect(got).toMatchObject({ type: "self_billing", number: "GS-2026-0001" });
    // the invoice resource never serves a Gutschrift, and the sbc_ prefix is not an invoice
    expect((await call("GET", `/invoices/inv_${draft.id.slice(4)}`, { key })).status).toBe(404);
    // no conversions or withdrawal for a Gutschrift
    expect((await call("POST", `/self-billing/${draft.id}/convert`, { key, body: { to: "invoice" } })).status).toBe(
      404,
    );
  });

  test("API-025 UST-33 EC-DOC-103 T-EC-103 without an agreement the finalisation answers 422 and consumes no number", async () => {
    const { t, supplier } = await setup({ agreement: false });
    const key = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize"])).key;
    const draft = await json(await call("POST", "/self-billing", { key, body: commission(supplier) }));
    expect(draft.validation.errors.map((e: Json) => e.code)).toContain("self_billing_agreement_missing");
    const fin = await call("POST", `/self-billing/${draft.id}/finalize`, {
      key,
      body: { version: draft.version },
      headers: idemKey(),
    });
    expect(fin.status).toBe(422);
    const reg = await t.run((ctx) => ctx.db.query("numberRegister").collect());
    expect(reg.filter((r) => r.docType === "self_billing")).toHaveLength(0);
  });

  test("API-025 INV-16 export and mark-sent work on sbc_; the objection (cancel) needs invoices:cancel and records date and text", async () => {
    const { t, supplier } = await setup();
    const key = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize", "invoices:send"])).key;
    const fin = await finalizedViaRest(t, key, supplier);
    const exp = await call("POST", `/self-billing/${fin.id}/export`, { key, body: {} });
    expect(exp.status, JSON.stringify(await exp.clone().json())).toBe(200);
    const files = (await json(exp)).files as Json[];
    expect(files.length).toBeGreaterThan(0);
    const marked = await call("POST", `/self-billing/${fin.id}/mark-sent`, {
      key,
      body: { sent_on: "2026-10-12", channel: "post", artifacts: files.map((f) => f.artifact_id) },
      headers: idemKey(),
    });
    expect(marked.status, JSON.stringify(await marked.clone().json())).toBe(200);
    expect((await json(marked)).send_log_id).toMatch(/^snd_/);

    const objection = { reason: "Provision zu hoch abgerechnet", objection_date: "2026-10-12" };
    const noScope = await call("POST", `/self-billing/${fin.id}/cancel`, {
      key,
      body: objection,
      headers: idemKey(),
    });
    expect(noScope.status).toBe(403);
    const full = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize", "invoices:cancel"])).key;
    const future = await call("POST", `/self-billing/${fin.id}/cancel`, {
      key: full,
      body: { ...objection, objection_date: "2026-10-13" },
      headers: idemKey(),
    });
    expect(future.status).toBe(422);
    const ok = await call("POST", `/self-billing/${fin.id}/cancel`, { key: full, body: objection, headers: idemKey() });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    const body = await json(ok);
    expect(body.cancellation_id).toMatch(/^inv_/);
    expect(body.self_billing).toMatchObject({ id: fin.id, status: "cancelled" });
    const raw = await t.run((ctx) => ctx.db.get(fin.id.slice(4) as Id<"salesDocuments">));
    expect(raw?.objection).toMatchObject({ date: "2026-10-12", text: "Provision zu hoch abgerechnet" });
  });
});

describe("MCP self-billing (06 §3.4)", () => {
  test("MCP-014 INV-16 self_billing_create_draft → document_preview → ⚠ document_finalize with token; document_search type self_billing", async () => {
    const { t, supplier } = await setup();
    const key = (await t.asMcp(["documents:read", "documents:write", "invoices:finalize"])).key;
    const client = await connect(key);
    const created = (await client.callTool({
      name: "self_billing_create_draft",
      arguments: commission(supplier),
    })) as ToolCall;
    expect(created.isError, created.content[0]?.text).toBeFalsy();
    const draft = created.structuredContent as Json;
    expect(draft.id).toMatch(/^sbc_/);
    const preview = (await client.callTool({ name: "document_preview", arguments: { id: draft.id } })) as ToolCall;
    expect(preview.isError, preview.content[0]?.text).toBeFalsy();
    const token = (preview.structuredContent as Json).confirm_token as string;
    expect(token).toMatch(/^ct_/);
    const fin = (await client.callTool({
      name: "document_finalize",
      arguments: { id: draft.id, version: draft.version, confirm_token: token },
    })) as ToolCall;
    expect(fin.isError, fin.content[0]?.text).toBeFalsy();
    expect((fin.structuredContent as Json).number).toBe("GS-2026-0001");
    await settle(t);
    const found = (await client.callTool({
      name: "document_search",
      arguments: { type: "self_billing" },
    })) as ToolCall;
    expect(((found.structuredContent as Json).data as Json[]).map((d) => d.id)).toEqual([draft.id]);
  });

  test("MCP-014 MCP-005 INV-16 the objection is ⚠ invoice_cancel with the sbc_ id: refused without a token, executed with the cancel-preview token", async () => {
    const tool = TOOLS.find((x) => x.name === "invoice_cancel");
    expect(tool?.annotations.destructiveHint).toBe(true);
    expect(tool?.meta["anthropic/requiresUserInteraction"]).toBe(true);
    expect(tool?.confirmIntent).toBe("invoice_cancel");

    const { t, supplier } = await setup();
    const restKey = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize"])).key;
    const fin = await finalizedViaRest(t, restKey, supplier);
    const key = (await t.asMcp(["documents:read", "documents:write", "invoices:finalize", "invoices:cancel"])).key;
    const client = await connect(key);
    const args = { id: fin.id, reason: "Provision zu hoch abgerechnet", document_date: "2026-10-12" };
    const noToken = (await client.callTool({
      name: "invoice_cancel",
      arguments: { ...args, confirm_token: "ct_invalid" },
    })) as ToolCall;
    expect(noToken.isError).toBe(true);
    // a future objection date: the preview explains and issues no token
    const future = (await client.callTool({
      name: "document_preview",
      arguments: { id: fin.id, intent: "cancel", reason: args.reason, document_date: "2026-10-13" },
    })) as ToolCall;
    expect(future.structuredContent).toMatchObject({ allowed: false });
    expect((future.structuredContent as Json).confirm_token).toBeUndefined();
    const noReason = (await client.callTool({
      name: "document_preview",
      arguments: { id: fin.id, intent: "cancel" },
    })) as ToolCall;
    expect(noReason.isError).toBe(true);

    const preview = (await client.callTool({
      name: "document_preview",
      arguments: { id: fin.id, intent: "cancel", reason: args.reason, document_date: args.document_date },
    })) as ToolCall;
    expect(preview.isError, preview.content[0]?.text).toBeFalsy();
    const p = preview.structuredContent as Json;
    expect(p).toMatchObject({ intent: "cancel", allowed: true, number: "GS-2026-0001", objection_date: "2026-10-12" });
    // a token for other values does not fit
    const other = (await client.callTool({
      name: "invoice_cancel",
      arguments: { ...args, reason: "anderer Grund", confirm_token: p.confirm_token },
    })) as ToolCall;
    expect(other.isError).toBe(true);
    expect(other.content[0]?.text).toContain("preview_outdated");
    const preview2 = (await client.callTool({
      name: "document_preview",
      arguments: { id: fin.id, intent: "cancel", reason: args.reason, document_date: args.document_date },
    })) as ToolCall;
    const done = (await client.callTool({
      name: "invoice_cancel",
      arguments: { ...args, confirm_token: (preview2.structuredContent as Json).confirm_token },
    })) as ToolCall;
    expect(done.isError, done.content[0]?.text).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ original_id: fin.id });
    expect((done.structuredContent as Json).id).toMatch(/^inv_/);
    const raw = await t.run((ctx) => ctx.db.get(fin.id.slice(4) as Id<"salesDocuments">));
    expect(raw?.objection).toMatchObject({ date: "2026-10-12", text: "Provision zu hoch abgerechnet" });
  });
});
