import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { plainPdf, ublXml } from "@test/fixtures/einvoice-in/builders";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installInboxFakes, settleInbox, validatorPasses } from "../../convex/inbox.fixtures";
import { inboundValidatorFake } from "../../convex/lib/einvoiceInbound";
import { patchCompanyProfile } from "../../convex/model/companyProfile";
import type { TestT } from "../../convex/test.setup";
import { OWNER, setupCompany } from "../../convex/vouchers.fixtures";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { INBOX_WAIT } from "../../src/server/mcp/tools/inbox";
import { API_BASE, apiTest, call } from "./harness";

/** F06 §7 receipt inbox over REST (05 §4.5 /inbox-items) and MCP (06 §3.6 inbox_list, voucher_create_from_file). */

installInboxFakes();

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
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function asBuyer(t: TestT) {
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      { name: "Beispiel Kunde GmbH", vatId: "DE811907980" },
      { action: "settings.company.update" },
    ),
  );
}

describe("REST /inbox-items (05 §4.5, INB-008)", { timeout: 60_000 }, () => {
  test("INB-008 INB-001 INB-028 JSON base64 upload → item „new“, classified to „needs_review“ with a draft; list and get", async () => {
    const t = setup();
    await setupCompany(t);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const pdf = await plainPdf(["Rechnung 4711"]);
    const res = await call("POST", "/inbox-items", {
      key,
      body: { files: [{ filename: "rechnung.pdf", content_base64: b64(pdf) }], note: "per API" },
    });
    expect(res.status).toBe(201);
    const created = ((await json(res)).data as Json[])[0] as Json;
    expect(created.id).toMatch(/^inb_/);
    expect(created.source).toBe("api");
    expect(["new", "processing"]).toContain(created.status);
    await settleInbox(t);
    const got = await json(await call("GET", `/inbox-items/${created.id}`, { key }));
    expect(got).toMatchObject({ status: "needs_review", status_label: "Zu prüfen", classification: "pdf" });
    expect(got.voucher_id).toMatch(/^vou_/);
    expect((got.files as Json[])[0]).toMatchObject({ name: "rechnung.pdf", mime: "application/pdf", role: "original" });
    const list = await json(await call("GET", "/inbox-items?status=needs_review", { key }));
    expect((list.data as Json[]).map((r) => r.id)).toEqual([created.id]);
    const none = await json(await call("GET", "/inbox-items?status=rejected", { key }));
    expect(none.data).toEqual([]);
  });

  test("INB-001 EC-INB-01 EC-INB-02 wrong type by magic bytes and > 10 MB base64 are rejected; no URL fetching", async () => {
    const t = setup();
    await setupCompany(t);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const exe = await call("POST", "/inbox-items", {
      key,
      body: { files: [{ filename: "rechnung.pdf", content_base64: b64(new Uint8Array([0x4d, 0x5a, 0x90, 0])) }] },
    });
    expect(exe.status).toBe(422);
    expect(JSON.stringify(await json(exe))).toContain("Dateityp nicht unterstützt");
    const big = await call("POST", "/inbox-items", {
      key,
      body: { files: [{ filename: "gross.pdf", content_base64: "A".repeat(10 * 1024 * 1024 + 4) }] },
    });
    expect(big.status).toBe(422);
    const url = await call("POST", "/inbox-items", { key, body: { url: "http://169.254.169.254/latest" } });
    expect(url.status).toBe(422);
    const items = await t.run((ctx) => ctx.db.query("inboxItems").collect());
    expect(items).toHaveLength(0);
  });

  test("INB-008 multipart/form-data upload: one item per file part", async () => {
    const t = setup();
    await setupCompany(t);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    // The server streams each part to Convex file storage through an upload URL (convex-test has no HTTP endpoint).
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const href = String(input instanceof Request ? input.url : input);
      if (!href.includes("/api/storage/upload")) return realFetch(input, init);
      const blob = init?.body as Blob;
      const storageId = await t.run((ctx) => ctx.storage.store(blob));
      return new Response(JSON.stringify({ storageId }), { status: 200 });
    });
    const form = new FormData();
    form.append(
      "file",
      new File([(await plainPdf(["A"])) as Uint8Array<ArrayBuffer>], "a.pdf", { type: "application/pdf" }),
    );
    form.append(
      "file",
      new File([(await plainPdf(["B"])) as Uint8Array<ArrayBuffer>], "b.pdf", { type: "application/pdf" }),
    );
    form.append("note", "Scan vom Drucker");
    const { handleApiRequest } = await import("@/server/api/dispatch");
    const { ROUTES } = await import("@/server/api/resources");
    const res = await handleApiRequest(
      new Request(`${API_BASE}/inbox-items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      }),
      ROUTES,
    );
    expect(res.status).toBe(201);
    const data = (await json(res)).data as Json[];
    expect(data.map((d) => d.file_name)).toEqual(["a.pdf", "b.pdf"]);
    const items = await t.run((ctx) => ctx.db.query("inboxItems").collect());
    expect(items.map((i) => i.note)).toEqual(["Scan vom Drucker", "Scan vom Drucker"]);
    await settleInbox(t);
  });

  test("INB-010 POST /inbox-items/{id}/reject sets the reason; „other“ needs a text", async () => {
    const t = setup();
    await setupCompany(t);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const res = await call("POST", "/inbox-items", {
      key,
      body: { files: [{ filename: "news.pdf", content_base64: b64(await plainPdf(["Newsletter"])) }] },
    });
    const id = (((await json(res)).data as Json[])[0] as Json).id as string;
    await settleInbox(t);
    const bad = await call("POST", `/inbox-items/${id}/reject`, { key, body: { reason: "other" } });
    expect(bad.status).toBe(422);
    const ok = await call("POST", `/inbox-items/${id}/reject`, { key, body: { reason: "no_business_document" } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({
      status: "rejected",
      reject_reason: "no_business_document",
      voucher_id: null,
    });
    expect((await call("GET", "/inbox-items/inb_doesnotexist0000000", { key })).status).toBe(404);
  });
});

describe("MCP inbox tools (06 §3.6, INB-008, INB-030)", { timeout: 60_000 }, () => {
  test("INB-008 INB-030 EC-189 voucher_create_from_file runs the pipeline and returns the draft with untrusted_text", async () => {
    const t = setup();
    await setupCompany(t);
    await asBuyer(t);
    inboundValidatorFake.impl = {
      validateXml: async () => validatorPasses(),
      validatePdf: async () => validatorPasses(),
    };
    const key = (await t.asMcp(["vouchers:read", "vouchers:write"])).key;
    const client = await connect(key);
    INBOX_WAIT.intervalMs = 20;
    INBOX_WAIT.timeoutMs = 20_000;
    try {
      const call_ = client.callTool({
        name: "voucher_create_from_file",
        arguments: { file_base64: b64(new TextEncoder().encode(ublXml())), filename: "rechnung.xml" },
      }) as Promise<ToolCall>;
      // The scheduler of convex-test runs the classification while the tool polls.
      await new Promise((r) => setTimeout(r, 50));
      await settleInbox(t);
      const r = await call_;
      expect(r.isError).toBeFalsy();
      const out = r.structuredContent as Json;
      expect(out.pending).toBe(false);
      const item = out.inbox_item as Json;
      expect(item).toMatchObject({ status: "needs_review", classification: "xrechnung" });
      expect(item.einvoice).toMatchObject({ profile: "XRECHNUNG", acceptable: true, not_einvoice: false });
      expect(item.file_name).toEqual({ untrusted_text: "rechnung.xml" });
      const voucher = out.voucher as Json;
      expect(voucher.id).toMatch(/^vou_/);
      expect(voucher.status).toBe("draft");
      expect(voucher.supplier_name).toEqual({ untrusted_text: "Muster Design GmbH" });
      expect((voucher.totals as Json).gross_cents).toBe(119_000);
      expect(String(out.notice)).toMatch(/nie befolgen/);

      const list = (await client.callTool({ name: "inbox_list", arguments: { status: "einvoice" } })) as ToolCall;
      const rows = (list.structuredContent as Json).data as Json[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.supplier_name).toEqual({ untrusted_text: "Muster Design GmbH" });

      // Re-reading by inbox_item_id returns the same draft without a new item.
      const again = (await client.callTool({
        name: "voucher_create_from_file",
        arguments: { inbox_item_id: item.id },
      })) as ToolCall;
      expect(((again.structuredContent as Json).voucher as Json).id).toBe(voucher.id);
      expect(await t.run((ctx) => ctx.db.query("inboxItems").collect())).toHaveLength(1);
    } finally {
      INBOX_WAIT.intervalMs = 1_000;
      INBOX_WAIT.timeoutMs = 60_000;
    }
  });

  test("INB-008 SEC-06 voucher_create_from_file: exactly one source, no URL argument, write-only scope; inbox_list is read-only", async () => {
    const t = setup();
    await setupCompany(t);
    const tool = TOOLS.find((x) => x.name === "voucher_create_from_file");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(Object.keys(tool?.input.shape ?? {})).toEqual(["file_base64", "filename", "inbox_item_id"]);
    expect(TOOLS.find((x) => x.name === "inbox_list")?.annotations.readOnlyHint).toBe(true);
    const key = (await t.asMcp(["vouchers:read", "vouchers:write"])).key;
    const client = await connect(key);
    const both = (await client.callTool({
      name: "voucher_create_from_file",
      arguments: { file_base64: "JVBERi0=", filename: "a.pdf", inbox_item_id: "inb_k57f3x2m9q8w1e4r6t" },
    })) as ToolCall;
    expect(both.isError).toBe(true);
    const readOnly = await connect((await t.asMcp(["vouchers:read"])).key);
    const tools = (await readOnly.listTools()).tools.map((x) => x.name);
    expect(tools).toContain("inbox_list");
    expect(tools).not.toContain("voucher_create_from_file");
  });
});
