import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "../../convex/catalog.fixtures";
import { dunningSetup } from "../../convex/dunning.fixtures";
import { b2bBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { REQUIRES_USER_INTERACTION } from "../../src/server/mcp/tool";
import { apiTest, call } from "./harness";

/**
 * F04 §7.1/§7.2, 06 §3.4: the finalise preview, finalisation, export and „Als versendet markieren“ over REST and MCP.
 * ⚠ `document_finalize` needs the `document_preview` token (intent finalize), ⚠ `document_mark_sent` the
 * `preview_action` token; `document_export` writes only the audit entry. The app never sends anything (EC-189).
 */

vi.setConfig({ testTimeout: 60_000 });

let restore: (() => void) | undefined;
const clients: Client[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON responses in assertions
type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; message?: string };

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

/** An invoice draft (1.000,00 net + 19 %) to the B2B buyer. */
async function invoiceDraft() {
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
  const { id } = await s.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
  return { t: h.t, owner: s.owner, id: id as Id<"salesDocuments">, personId };
}

async function finalizedInvoice() {
  const d = await invoiceDraft();
  await d.owner.action(api.invoices.finalize, { id: d.id, version: 1 });
  await settle(d.t);
  return d;
}

let idem = 0;
const idemKey = () => ({ "Idempotency-Key": `k-${++idem}` });

describe("REST preview, export and mark-sent (F04 §7.1)", () => {
  test("API-022 DOC-42 POST /invoices/{id}/preview: findings, totals, tax case, ER-03 — writes nothing, no REST token", async () => {
    const { t, id } = await invoiceDraft();
    const key = (await t.asApiKey(["documents:read"])).key;
    const res = await call("POST", `/invoices/inv_${id}/preview`, { key, body: {} });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      id: `inv_${id}`,
      version: 1,
      allowed: true,
      totals: { net_cents: 100_000, vat_cents: 19_000, gross_cents: 119_000, payable_cents: 119_000 },
      tax_case: { value: "domestic" },
      einvoice: { decision: expect.any(String), format: expect.any(String) },
      confirm_token: null,
    });
    expect(Array.isArray(body.errors)).toBe(true);
    const doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.status).toBe("draft");
  });

  test("API-022 SND-16 SND-07 SND-18 SND-24 export → mark-sent (invoices:send, Idempotency-Key) → retract", async () => {
    const { t, id } = await finalizedInvoice();
    const read = (await t.asApiKey(["documents:read"])).key;
    const key = (await t.asApiKey(["documents:read", "invoices:send"])).key;

    const exp = await call("POST", `/invoices/inv_${id}/export`, { key: read, body: {} });
    expect(exp.status, JSON.stringify(await exp.clone().json())).toBe(200);
    const files = (await json(exp)).files as { artifact_id: string; url: string; sha256: string }[];
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.artifact_id).toMatch(/^art_/);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.action === "document.export" && e.actor.startsWith("api-key:"))).toBe(true);

    const body = { sent_on: "2026-10-12", channel: "email_manual", artifacts: files.map((f) => f.artifact_id) };
    const noScope = await call("POST", `/invoices/inv_${id}/mark-sent`, { key: read, body, headers: idemKey() });
    expect(noScope.status).toBe(403);
    const noIdem = await call("POST", `/invoices/inv_${id}/mark-sent`, { key, body });
    expect(noIdem.status).toBe(400);
    expect((await json(noIdem)).code).toBe("idempotency_key_required");
    const mark = await call("POST", `/invoices/inv_${id}/mark-sent`, { key, body, headers: idemKey() });
    expect(mark.status, JSON.stringify(await mark.clone().json())).toBe(200);
    const marked = await json(mark);
    expect(marked).toMatchObject({ send_log_id: expect.stringMatching(/^snd_/), first_effective: true });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("sent");

    const retract = await call("POST", `/invoices/inv_${id}/mark-sent/${marked.send_log_id}/retract`, {
      key,
      body: { reason: "Falsche Adresse, nicht zugestellt" },
      headers: idemKey(),
    });
    expect(retract.status, JSON.stringify(await retract.clone().json())).toBe(200);
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("finalized");
  });

  test("SND-07 an unknown artifact id is 422; a draft cannot be exported (409)", async () => {
    const { t, id } = await invoiceDraft();
    const key = (await t.asApiKey(["documents:read", "invoices:send"])).key;
    const exp = await call("POST", `/invoices/inv_${id}/export`, { key, body: {} });
    expect(exp.status).toBe(409);
    const bad = await call("POST", `/invoices/inv_${id}/mark-sent`, {
      key,
      body: { sent_on: "2026-10-12", channel: "post", artifacts: ["nope"] },
      headers: idemKey(),
    });
    expect(bad.status).toBe(422);
  });
});

describe("MCP ⚠ document_finalize, document_export, document_mark_sent (06 §3.4)", () => {
  test("MCP-012 MCP-005 EC-DOC-91 T-EC-091 document_finalize and document_mark_sent are ⚠ with their intents; document_export is a W tool; no send tool", () => {
    const byName = new Map(TOOLS.map((x) => [x.name, x]));
    for (const [name, intent] of [
      ["document_finalize", "document_finalize"],
      ["document_mark_sent", "document_mark_sent"],
    ] as const) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations.destructiveHint).toBe(true);
      expect(tool?.meta[REQUIRES_USER_INTERACTION]).toBe(true);
      expect(tool?.confirmIntent).toBe(intent);
    }
    const exp = byName.get("document_export");
    expect(exp?.kind).toBe("write");
    expect(exp?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(exp?.scopes).toEqual(["documents:read"]);
    // EC-189: there is no send tool.
    expect(TOOLS.some((x) => /send/.test(x.name) && !/mark_sent/.test(x.name))).toBe(false);
  });

  test("MCP-012 MCP-004 DOC-24 document_preview (finalize) issues a token bound to id, version and options; finalize uses it", async () => {
    const { t, owner, id, personId } = await invoiceDraft();
    const client = await connect((await t.asMcp(["documents:read", "invoices:finalize"])).key);
    const noToken = (await client.callTool({
      name: "document_finalize",
      arguments: { id: `inv_${id}`, version: 1 },
    })) as ToolCall;
    // The schema requires confirm_token: the call is refused before anything runs.
    expect(noToken.isError).toBe(true);
    expect(noToken.content[0]?.text).toMatch(/confirm_token/);

    const preview = (await client.callTool({ name: "document_preview", arguments: { id: `inv_${id}` } })) as ToolCall;
    expect(preview.isError, JSON.stringify(preview.content)).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      intent: "finalize",
      allowed: true,
      version: 1,
      totals: { gross_cents: 119_000 },
    });
    const token = preview.structuredContent?.confirm_token as string;
    expect(token).toMatch(/^ct_/);

    // Other options than previewed → preview_outdated (and the token is not burned).
    const other = (await client.callTool({
      name: "document_finalize",
      arguments: { id: `inv_${id}`, version: 1, document_date: "2026-10-11", confirm_token: token },
    })) as ToolCall;
    expect(errorOf(other).code).toBe("preview_outdated");

    // The draft changes after the preview → preview_outdated.
    await owner.mutation(api.invoices.updateDraft, {
      id,
      version: 1,
      values: invoiceValues(personId, { headText: "Geändert" }),
    });
    const changed = (await client.callTool({
      name: "document_finalize",
      arguments: { id: `inv_${id}`, version: 1, confirm_token: token },
    })) as ToolCall;
    expect(["preview_outdated", "version_conflict"]).toContain(errorOf(changed).code);

    const fresh = (await client.callTool({ name: "document_preview", arguments: { id: `inv_${id}` } })) as ToolCall;
    const ok = (await client.callTool({
      name: "document_finalize",
      arguments: { id: `inv_${id}`, version: 2, confirm_token: fresh.structuredContent?.confirm_token },
    })) as ToolCall;
    expect(ok.isError, JSON.stringify(ok.content)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ number: "RE-2026-0001", status: "finalized" });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.action === "document.finalize" && e.actor.startsWith("mcp:"))).toBe(true);
    await settle(t);
  });

  test("EC-DOC-04 T-EC-004 a draft edited in the UI after the MCP preview: document_finalize with the old token → preview_outdated, nothing committed", async () => {
    const { t, owner, id, personId } = await invoiceDraft();
    const client = await connect((await t.asMcp(["documents:read", "invoices:finalize"])).key);
    const preview = (await client.callTool({ name: "document_preview", arguments: { id: `inv_${id}` } })) as ToolCall;
    const token = preview.structuredContent?.confirm_token as string;
    await owner.mutation(api.invoices.updateDraft, {
      id,
      version: 1,
      values: invoiceValues(personId, { headText: "Nach der Vorschau geändert" }),
    });
    for (const version of [1, 2]) {
      const r = (await client.callTool({
        name: "document_finalize",
        arguments: { id: `inv_${id}`, version, confirm_token: token },
      })) as ToolCall;
      expect(errorOf(r).code, `version ${version}`).toBe("preview_outdated");
    }
    const d = await t.run((ctx) => ctx.db.get(id));
    expect(d).toMatchObject({ status: "draft", version: 2 });
    expect(d?.number).toBeUndefined();
    const register = await t.run((ctx) => ctx.db.query("numberRegister").collect());
    expect(register.filter((r) => r.docType === "invoice")).toHaveLength(0);
  });

  test("DOC-24 a blocked preview issues no token; the preview needs invoices:finalize", async () => {
    const { t, owner, personId } = await invoiceDraft();
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { supplyDate: undefined }),
    });
    const readOnly = await connect((await t.asMcp(["documents:read"])).key);
    const denied = (await readOnly.callTool({ name: "document_preview", arguments: { id: `inv_${id}` } })) as ToolCall;
    expect(errorOf(denied).code).toBe("insufficient_scope");
    const client = await connect((await t.asMcp(["documents:read", "invoices:finalize"])).key);
    const preview = (await client.callTool({ name: "document_preview", arguments: { id: `inv_${id}` } })) as ToolCall;
    expect(preview.structuredContent).toMatchObject({ allowed: false });
    expect(((preview.structuredContent?.errors ?? []) as unknown[]).length).toBeGreaterThan(0);
    expect(preview.structuredContent?.confirm_token).toBeUndefined();
  });

  test("MCP-012 SND-24 EC-DOC-91 document_export returns tailnet links; document_mark_sent needs the preview_action token", async () => {
    const { t, id } = await finalizedInvoice();
    const client = await connect((await t.asMcp(["documents:read", "invoices:send"])).key);
    const exp = (await client.callTool({ name: "document_export", arguments: { id: `inv_${id}` } })) as ToolCall;
    expect(exp.isError, JSON.stringify(exp.content)).toBeFalsy();
    const files = exp.structuredContent?.files as { artifact_id: string }[];
    expect(files[0]?.artifact_id).toMatch(/^art_/);

    const params = {
      id: `inv_${id}`,
      sent_on: "2026-10-12",
      channel: "email_manual",
      artifacts: files.map((f) => f.artifact_id),
    };
    const noToken = (await client.callTool({ name: "document_mark_sent", arguments: params })) as ToolCall;
    expect(noToken.isError).toBe(true);
    expect(noToken.content[0]?.text).toMatch(/confirm_token/);
    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "document_mark_sent", params },
    })) as ToolCall;
    expect(preview.isError, JSON.stringify(preview.content)).toBeFalsy();
    expect(preview.structuredContent?.effect).toMatchObject({
      first_effective: true,
      status_after: "sent",
      zugang: "2026-10-12",
      errors: [],
    });
    const token = preview.structuredContent?.confirm_token as string;
    const other = (await client.callTool({
      name: "document_mark_sent",
      arguments: { ...params, channel: "upload_portal", confirm_token: token },
    })) as ToolCall;
    expect(errorOf(other).code).toBe("preview_outdated");
    const ok = (await client.callTool({
      name: "document_mark_sent",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(ok.isError, JSON.stringify(ok.content)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ first_effective: true, send_log_id: expect.stringMatching(/^snd_/) });
    const again = (await client.callTool({
      name: "document_mark_sent",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(errorOf(again).code).toBe("confirm_token_used");
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("sent");
  });

  test("SND-11 DUN-004 reminders: document_export and document_mark_sent work with rem_ ids", async () => {
    const h = apiTest();
    restore = h.restore;
    const s = await dunningSetup(h.t);
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const t: TestT = h.t;
    const key = (
      await t.asApiKey(["payments:read", "documents:read", "dunning:write", "invoices:finalize", "invoices:send"])
    ).key;
    const created = await json(
      await call("POST", `/invoices/inv_${s.invoiceId}/reminders`, {
        key,
        body: { acknowledge_warnings: ["not_in_default"], finalize: true },
        headers: idemKey(),
      }),
    );
    const rem = created.id as string;
    expect(created.status).toBe("finalized");
    await settle(t);
    const client = await connect((await t.asMcp(["documents:read", "invoices:send"])).key);
    const exp = (await client.callTool({ name: "document_export", arguments: { id: rem } })) as ToolCall;
    expect(exp.isError, JSON.stringify(exp.content)).toBeFalsy();
    const params = {
      id: rem,
      sent_on: "2026-10-19",
      channel: "post",
      artifacts: ((exp.structuredContent?.files ?? []) as { artifact_id: string }[]).map((f) => f.artifact_id),
    };
    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "document_mark_sent", params },
    })) as ToolCall;
    expect(preview.structuredContent?.effect).toMatchObject({ zugang: "2026-10-22" });
    const ok = (await client.callTool({
      name: "document_mark_sent",
      arguments: { ...params, confirm_token: preview.structuredContent?.confirm_token },
    })) as ToolCall;
    expect(ok.isError, JSON.stringify(ok.content)).toBeFalsy();
    const got = await json(await call("GET", `/reminders/${rem}`, { key }));
    expect(got).toMatchObject({ status: "sent", zugang: "2026-10-22" });
  });
});
