import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { finalizedInvoice, INVOICE_RANGE, settle } from "../../convex/invoices.fixtures";
import { auditedPatch } from "../../convex/model/audit";
import type { TestT } from "../../convex/test.setup";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { apiTest, call } from "./harness";

/** F04 §7.1/§7.2: Storno and corrections over REST and MCP (⚠ invoice_cancel with the document_preview token). */

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
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string };
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function paid(t: TestT, id: Id<"salesDocuments">) {
  await t.model({ actor: "user:test-owner", role: "owner", channel: "ui" }, (ctx) =>
    auditedPatch(
      ctx,
      "salesDocuments",
      id,
      { openAmountCents: 0, paymentStatus: "paid" },
      { action: "payment.record" },
    ),
  );
}

async function withCorrectionRange(owner: Awaited<ReturnType<typeof finalizedInvoice>>["owner"]) {
  await owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        { ...INVOICE_RANGE, next: 2 },
        { key: "correction", name: "Rechnungskorrekturen", format: "RK-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
      ],
    },
  });
}

describe("REST Storno and corrections (F04 §7.1)", { timeout: 30_000 }, () => {
  test("INV-10 POST /invoices/{id}/cancel: dry run, Idempotency-Key and invoices:finalize required, Storno with 201", async () => {
    const t = setup();
    const { id, number } = await finalizedInvoice(t);
    const key = (await t.asApiKey(["documents:read", "invoices:cancel", "invoices:finalize"])).key;
    const dry = await call("POST", `/invoices/inv_${id}/cancel`, { key, body: { dry_run: true } });
    expect(dry.status).toBe(200);
    expect(await json(dry)).toMatchObject({
      allowed: true,
      original: { id: `inv_${id}`, number },
      mirror: { totals: { gross_cents: -119_000 } },
    });
    const cancelOnly = (await t.asApiKey(["documents:read", "invoices:cancel"])).key;
    const noFinalize = await call("POST", `/invoices/inv_${id}/cancel`, {
      key: cancelOnly,
      body: {},
      headers: { "Idempotency-Key": "storno-0" },
    });
    expect(noFinalize.status).toBe(403); // the Storno is finalised in the same step (+ invoices:finalize)
    expect((await json(noFinalize)).code).toBe("insufficient_scope");
    const noKey = await call("POST", `/invoices/inv_${id}/cancel`, { key, body: { reason: "Doppelt" } });
    expect(noKey.status).toBe(400);
    expect((await json(noKey)).code).toBe("idempotency_key_required");
    const res = await call("POST", `/invoices/inv_${id}/cancel`, {
      key,
      body: { reason: "Doppelt" },
      headers: { "Idempotency-Key": "storno-1" },
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ number: "RE-2026-0002", original_id: `inv_${id}` });
    expect(String(body.id)).toMatch(/^inv_/);
    const again = await call("POST", `/invoices/inv_${id}/cancel`, {
      key,
      body: { reason: "Doppelt" },
      headers: { "Idempotency-Key": "storno-2" },
    });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("already_cancelled");
    await settle(t);
  });

  test("INV-11 a paid invoice answers 409 storno_paid_invoice; POST /correct creates a credit draft (INV-12)", async () => {
    const t = setup();
    const { id, owner } = await finalizedInvoice(t);
    await withCorrectionRange(owner);
    await paid(t, id);
    const key = (await t.asApiKey(["documents:read", "documents:write", "invoices:cancel", "invoices:finalize"])).key;
    const res = await call("POST", `/invoices/inv_${id}/cancel`, {
      key,
      body: {},
      headers: { "Idempotency-Key": "s" },
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      code: "storno_paid_invoice",
      detail: expect.stringContaining("Rechnungskorrektur"),
    });
    const c = await call("POST", `/invoices/inv_${id}/correct`, {
      key,
      body: { kind: "credit", changes: [{ position: 1, quantity: "8" }] },
    });
    expect(c.status).toBe(201);
    expect(await json(c)).toMatchObject({
      correction_kind: "credit",
      corrects_id: `inv_${id}`,
      totals: { gross_cents: -23_800 },
      validation: { errors: [] },
    });
  });
});

describe("MCP ⚠ invoice_cancel (06 §3.4)", { timeout: 30_000 }, () => {
  test("MCP-004 INV-10 document_preview intent cancel issues the token; invoice_cancel uses it once", async () => {
    const t = setup();
    const { id } = await finalizedInvoice(t);
    const client = await connect((await t.asMcp(["documents:read", "invoices:cancel", "invoices:finalize"])).key);
    const params = { id: `inv_${id}`, reason: "Falscher Kunde" };
    const noToken = (await client.callTool({ name: "invoice_cancel", arguments: params })) as ToolCall;
    expect(noToken.isError).toBe(true);
    const preview = (await client.callTool({
      name: "document_preview",
      arguments: { ...params, intent: "cancel" },
    })) as ToolCall;
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({ allowed: true, mirror: { totals: { gross_cents: -119_000 } } });
    const token = preview.structuredContent?.confirm_token as string;
    expect(token).toMatch(/^ct_/);
    const other = (await client.callTool({
      name: "invoice_cancel",
      arguments: { ...params, reason: "anderer Grund", confirm_token: token },
    })) as ToolCall;
    expect(errorOf(other).code).toBe("preview_outdated");
    const ok = (await client.callTool({
      name: "invoice_cancel",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ number: "RE-2026-0002", original_id: `inv_${id}` });
    const again = (await client.callTool({
      name: "invoice_cancel",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(errorOf(again).code).toBe("confirm_token_used");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.action === "document.cancel" && e.actor.startsWith("mcp:"))).toBe(true);
    await settle(t);
  });

  test("INV-11 the preview of a paid invoice is blocked without a token; invoice_create_correction drafts a credit", async () => {
    const t = setup();
    const { id, owner } = await finalizedInvoice(t);
    await withCorrectionRange(owner);
    await paid(t, id);
    const client = await connect(
      (await t.asMcp(["documents:read", "documents:write", "invoices:cancel", "invoices:finalize"])).key,
    );
    const preview = (await client.callTool({
      name: "document_preview",
      arguments: { id: `inv_${id}`, intent: "cancel" },
    })) as ToolCall;
    expect(preview.structuredContent).toMatchObject({ allowed: false, blocked: { code: "storno_paid_invoice" } });
    expect(preview.structuredContent?.confirm_token).toBeUndefined();
    const draft = (await client.callTool({
      name: "invoice_create_correction",
      arguments: { id: `inv_${id}`, kind: "credit" },
    })) as ToolCall;
    expect(draft.structuredContent).toMatchObject({ correction_kind: "credit", totals: { gross_cents: -119_000 } });
    expect(String(draft.structuredContent?.id)).toMatch(/^cor_/);
  });
});
