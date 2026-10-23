import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { dunningSetup } from "../../convex/dunning.fixtures";
import { finalizedInvoice } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { sha256Hex } from "../../src/domain/audit/chain";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { pdfText } from "../golden/pdf-text";
import { apiTest, call } from "./harness";

/**
 * F05 receivables letters over REST (05 §4.4 `/receivable-letters`, prefix `rlt_`) and MCP (06 §3.5): Kontoauszug
 * (PAY-005), Zahlungsbestätigung (PAY-048), Zinsforderung (DUN-028) and Mahnbescheid-Datenblatt (DUN-044). Generated,
 * archived with SHA-256, never sent by the app (B2); „Als versendet markieren“ is REST/UI only.
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
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const json = async (res: Response) => (await res.json()) as Json;
const textOf = (b64: string) => pdfText(new Uint8Array(Buffer.from(b64, "base64")));

let idem = 0;
const idemKey = () => ({ "Idempotency-Key": `rl-${++idem}` });

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

async function partlyPaid(t: TestT) {
  const f = await finalizedInvoice(t);
  const id = f.id as Id<"salesDocuments">;
  const r = await f.owner.mutation(api.payments.recordForInvoice, {
    documentId: id,
    source: { kind: "cash" },
    date: "2026-10-12",
    amountCents: 50_000,
  });
  return { ...f, id, paymentId: r.paymentIds[0] as Id<"payments"> };
}

function setup() {
  const h = apiTest();
  restore = h.restore;
  return h.t;
}

describe("REST /receivable-letters (05 §4.4, F05 PAY-005/PAY-048/DUN-028/DUN-044)", () => {
  test("API-026 PAY-005 statement: preview writes nothing → create archives the PDF with SHA-256 → listed per contact → marked sent once", async () => {
    const t = setup();
    const { personId } = await partlyPaid(t);
    const key = (await t.asApiKey(["payments:read", "dunning:write"])).key;
    const request = { kind: "account_statement", contact_id: `con_${personId}`, from: "2026-10-01", to: "2026-10-12" };

    const preview = await call("POST", "/receivable-letters/preview", { key, body: request });
    expect(preview.status, JSON.stringify(await preview.clone().json())).toBe(200);
    const p = await json(preview);
    expect(p).toMatchObject({ kind: "account_statement", title: "Kontoauszug", date: "2026-10-12" });
    expect(p.subject).toContain("Kontoauszug vom 01.10.2026 bis 12.10.2026");
    expect(await t.run((ctx) => ctx.db.query("receivableLetters").collect())).toHaveLength(0);

    const future = await call("POST", "/receivable-letters/preview", { key, body: { ...request, to: "2026-10-13" } });
    expect(future.status).toBe(422);

    const created = await call("POST", "/receivable-letters", { key, body: request });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const c = await json(created);
    expect(c.id).toMatch(/^rlt_/);
    expect(c.content_type).toBe("application/pdf");
    const bytes = new Uint8Array(Buffer.from(c.content_base64, "base64"));
    expect(c.sha256).toBe(await sha256Hex(bytes));
    expect(await textOf(c.content_base64)).toMatch(/offener Saldo zu unseren Gunsten von 690,00/);

    const noFilter = await call("GET", "/receivable-letters", { key });
    expect(noFilter.status).toBe(422);
    const list = await json(await call("GET", `/receivable-letters?contact_id=con_${personId}`, { key }));
    expect(list.data).toEqual([
      expect.objectContaining({
        id: c.id,
        kind: "account_statement",
        title: "Kontoauszug",
        sha256: c.sha256,
        sent: null,
      }),
    ]);

    const markBody = { sent_on: "2026-10-12", channel: "post" };
    const noIdem = await call("POST", `/receivable-letters/${c.id}/mark-sent`, { key, body: markBody });
    expect(noIdem.status).toBe(400);
    const early = await call("POST", `/receivable-letters/${c.id}/mark-sent`, {
      key,
      body: { ...markBody, sent_on: "2026-10-11" },
      headers: idemKey(),
    });
    expect(early.status).toBe(422);
    expect(JSON.stringify(await json(early))).toContain("zwischen dem Datum des Schreibens");
    const marked = await call("POST", `/receivable-letters/${c.id}/mark-sent`, {
      key,
      body: markBody,
      headers: idemKey(),
    });
    expect(marked.status, JSON.stringify(await marked.clone().json())).toBe(200);
    expect(await json(marked)).toMatchObject({ id: c.id, sent: { sent_on: "2026-10-12", channel: "post" } });
    const again = await call("POST", `/receivable-letters/${c.id}/mark-sent`, {
      key,
      body: markBody,
      headers: idemKey(),
    });
    expect(again.status).toBe(409);

    // marking needs dunning:write; generating only payments:read
    const readOnly = (await t.asApiKey(["payments:read"])).key;
    const denied = await call("POST", `/receivable-letters/${c.id}/mark-sent`, {
      key: readOnly,
      body: markBody,
      headers: idemKey(),
    });
    expect(denied.status).toBe(403);
  });

  test("API-026 PAY-048 the payment confirmation links payment and invoice; listed under the invoice", async () => {
    const t = setup();
    const { id, paymentId } = await partlyPaid(t);
    const key = (await t.asApiKey(["payments:read"])).key;
    const created = await call("POST", "/receivable-letters", {
      key,
      body: { kind: "payment_confirmation", payment_id: `pay_${paymentId}` },
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const c = await json(created);
    expect(await textOf(c.content_base64)).toMatch(/Zahlung über 500,00\s€ vom 12\.10\.2026/);
    const list = await json(await call("GET", `/receivable-letters?invoice_id=inv_${id}`, { key }));
    expect(list.data.map((l: Json) => [l.id, l.kind])).toEqual([[c.id, "payment_confirmation"]]);
  });

  test("API-026 DUN-044 DUN-028 Mahnbescheid sheet returns the JSON data; an interest claim on an open invoice is refused", async () => {
    const t = setup();
    const s = await dunningSetup(t);
    const key = (await t.asApiKey(["payments:read"])).key;
    const claim = await call("POST", "/receivable-letters/preview", {
      key,
      body: { kind: "interest_claim", invoice_id: `inv_${s.invoiceId}` },
    });
    expect(claim.status).toBe(422);
    expect(JSON.stringify(await json(claim))).toContain("Die Hauptforderung ist noch offen.");
    vi.setSystemTime(new Date("2026-12-01T08:00:00Z"));
    const created = await call("POST", "/receivable-letters", {
      key,
      body: { kind: "mahnbescheid_sheet", invoice_id: `inv_${s.invoiceId}` },
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const c = await json(created);
    expect(c.data.anspruch).toMatchObject({ hauptforderungCents: 119_000, faelligAm: "2026-10-12" });
    expect(await textOf(c.content_base64)).toContain("Daten für den Antrag auf Erlass eines Mahnbescheids");
  });
});

describe("MCP receivables letters (06 §3.5)", () => {
  test("MCP-015 PAY-005 receivable_letter_preview (R) and receivable_letter_create (W) archive the letter; no MCP tool marks it sent", async () => {
    expect(TOOLS.find((x) => x.name === "receivable_letter_preview")?.annotations.readOnlyHint).toBe(true);
    const create = TOOLS.find((x) => x.name === "receivable_letter_create");
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(TOOLS.some((x) => /letter.*(sent|mark)/.test(x.name))).toBe(false);

    const t = setup();
    const { personId } = await partlyPaid(t);
    const key = (await t.asMcp(["payments:read"])).key;
    const client = await connect(key);
    const request = { kind: "account_statement", contact_id: `con_${personId}`, from: "2026-10-01", to: "2026-10-12" };
    const preview = (await client.callTool({ name: "receivable_letter_preview", arguments: request })) as ToolCall;
    expect(preview.isError, preview.content[0]?.text).toBeFalsy();
    expect((preview.structuredContent as Json).title).toBe("Kontoauszug");
    const created = (await client.callTool({ name: "receivable_letter_create", arguments: request })) as ToolCall;
    expect(created.isError, created.content[0]?.text).toBeFalsy();
    const c = created.structuredContent as Json;
    expect(c.id).toMatch(/^rlt_/);
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.content_base64).toBeUndefined(); // MCP returns a short-lived link, not the bytes
    const list = (await client.callTool({
      name: "receivable_letter_list",
      arguments: { contact_id: `con_${personId}` },
    })) as ToolCall;
    expect(((list.structuredContent as Json).data as Json[]).map((l) => l.id)).toEqual([c.id]);
  });
});
