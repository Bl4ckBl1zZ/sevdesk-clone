import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CII_V6 } from "@test/fixtures/einvoice-in/builders";
import { afterEach, describe, expect, test } from "vitest";
import {
  enableInbox,
  enc,
  ingest,
  installInboxFakes,
  item,
  settleInbox,
  validatorPasses,
} from "../../convex/inbox.fixtures";
import { inboundValidatorFake } from "../../convex/lib/einvoiceInbound";
import { patchCompanyProfile } from "../../convex/model/companyProfile";
import type { TestT } from "../../convex/test.setup";
import { OWNER, pdfBytes, setupCompany, TODAY } from "../../convex/vouchers.fixtures";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { apiTest, call } from "./harness";

/**
 * F06 §7.1 inbox split/merge (INB-009) and the supplier correction request (INB-046) over REST (05 §4.5) and the
 * read-only MCP tool `inbox_correction_request_text` (06 §3.6; supplier values only inside `untrusted_text`).
 */

installInboxFakes();

let restore: (() => void) | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
  inboundValidatorFake.impl = null;
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON responses in assertions
type Json = Record<string, any>;
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const json = async (res: Response) => (await res.json()) as Json;

let idem = 0;
const idemKey = () => ({ "Idempotency-Key": `inb-${++idem}` });

async function setup() {
  const h = apiTest();
  restore = h.restore;
  await setupCompany(h.t);
  const owner = await h.t.asUser("owner");
  return { t: h.t, owner };
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

/** A KoSIT-invalid CII E-Rechnung addressed to us → an item with a correction request available. */
async function faultyEInvoice(t: TestT, owner: Awaited<ReturnType<TestT["asUser"]>>) {
  await enableInbox(owner);
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      { name: "Beispiel Kunde GmbH", vatId: "DE811907980" },
      { action: "settings.company.update" },
    ),
  );
  inboundValidatorFake.impl = {
    validateXml: async () => ({
      kind: "done",
      acceptable: false,
      report: "<report/>",
      tool: "kosit",
      findings: [{ ruleId: "BR-DE-17", text: "Rechnungsart unzulässig", category: "business_rule" }],
    }),
    validatePdf: async () => validatorPasses(),
  };
  const r = await ingest(t, owner, [{ bytes: enc(CII_V6), name: "v6.xml" }]);
  await settleInbox(t);
  return r.id;
}

describe("REST inbox split / merge (05 §4.5, INB-009)", () => {
  test("API-027 INB-009 GOBD-08 split into one item per file keeps the hashes; the source is superseded; merge joins two items", async () => {
    const { t, owner } = await setup();
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const r = await ingest(t, owner, [
      { bytes: pdfBytes("split-a"), name: "a.pdf" },
      { bytes: pdfBytes("split-b"), name: "b.pdf" },
    ]);
    await settleInbox(t);
    const before = await item(t, r.id);
    const bad = await call("POST", `/inbox-items/inb_${r.id}/split`, { key, body: { groups: [[0, 1]] } });
    expect(bad.status).toBe(422);
    const res = await call("POST", `/inbox-items/inb_${r.id}/split`, { key, body: { groups: [[0], [1]] } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const parts = (await json(res)).data as Json[];
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.id)).toEqual([expect.stringMatching(/^inb_/), expect.stringMatching(/^inb_/)]);
    expect(parts.map((p) => p.files.map((f: Json) => f.sha256))).toEqual([
      [before.files[0]?.sha256],
      [before.files[1]?.sha256],
    ]);
    expect((await json(await call("GET", `/inbox-items/inb_${r.id}`, { key }))).status).toBe("superseded");
    await settleInbox(t);

    const merged = await call("POST", "/inbox-items/merge", { key, body: { ids: parts.map((p) => p.id) } });
    expect(merged.status, JSON.stringify(await merged.clone().json())).toBe(201);
    const m = await json(merged);
    expect(m.id).toMatch(/^inb_/);
    expect(m.files.map((f: Json) => f.sha256)).toEqual([before.files[0]?.sha256, before.files[1]?.sha256]);
    const one = await call("POST", "/inbox-items/merge", { key, body: { ids: [m.id] } });
    expect(one.status).toBe(422);
    const readOnly = (await t.asApiKey(["vouchers:read"])).key;
    expect((await call("POST", "/inbox-items/merge", { key: readOnly, body: { ids: [m.id, m.id] } })).status).toBe(403);
  });
});

describe("REST correction request (05 §4.5, INB-046)", () => {
  test("API-027 INB-046 EC-103 text → archived PDF (once, SHA-256) → mark-sent (Idempotency-Key) → retract with reason", async () => {
    const { t, owner } = await setup();
    const id = await faultyEInvoice(t, owner);
    const key = (await t.asApiKey(["vouchers:read", "vouchers:write"])).key;
    const view = await json(await call("GET", `/inbox-items/inb_${id}/correction-request`, { key }));
    expect(view.available).toBe(true);
    expect(view.text).toContain("– Geschäftsregelfehler (BR-DE-17): Rechnungsart unzulässig");
    expect(view.artifact).toBeNull();

    const early = await call("POST", `/inbox-items/inb_${id}/correction-request/mark-sent`, {
      key,
      body: { sent_on: TODAY, channel: "post" },
      headers: idemKey(),
    });
    expect(early.status).toBe(422);
    expect(JSON.stringify(await json(early))).toContain("Bitte den Brief zuerst als PDF exportieren");

    const gen = await call("POST", `/inbox-items/inb_${id}/correction-request`, { key, body: {} });
    expect(gen.status, JSON.stringify(await gen.clone().json())).toBe(200);
    const g = await json(gen);
    expect(g.artifact_id).toMatch(/^art_/);
    expect(g.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(g.text).toContain("Bitte um Rechnungskorrektur");
    const again = await json(await call("POST", `/inbox-items/inb_${id}/correction-request`, { key, body: {} }));
    expect(again).toMatchObject({ artifact_id: g.artifact_id, sha256: g.sha256 });

    const noIdem = await call("POST", `/inbox-items/inb_${id}/correction-request/mark-sent`, {
      key,
      body: { sent_on: TODAY, channel: "post" },
    });
    expect(noIdem.status).toBe(400);
    const other = await call("POST", `/inbox-items/inb_${id}/correction-request/mark-sent`, {
      key,
      body: { sent_on: TODAY, channel: "other" },
      headers: idemKey(),
    });
    expect(other.status).toBe(422);
    const marked = await call("POST", `/inbox-items/inb_${id}/correction-request/mark-sent`, {
      key,
      body: { sent_on: TODAY, channel: "post" },
      headers: idemKey(),
    });
    expect(marked.status, JSON.stringify(await marked.clone().json())).toBe(200);
    const sendLogId = (await json(marked)).send_log_id as string;
    expect(sendLogId).toMatch(/^snd_/);
    const row = await t.run((ctx) => ctx.db.get(sendLogId.slice(4) as never));
    expect(row).toMatchObject({ purpose: "supplier_correction_request", sentOn: TODAY });

    const short = await call("POST", `/inbox-items/inb_${id}/correction-request/mark-sent/${sendLogId}/retract`, {
      key,
      body: { reason: "kurz" },
      headers: idemKey(),
    });
    expect(short.status).toBe(422);
    const retracted = await call("POST", `/inbox-items/inb_${id}/correction-request/mark-sent/${sendLogId}/retract`, {
      key,
      body: { reason: "Brief ging an die falsche Adresse" },
      headers: idemKey(),
    });
    expect(retracted.status, JSON.stringify(await retracted.clone().json())).toBe(200);
    const after = await json(await call("GET", `/inbox-items/inb_${id}/correction-request`, { key }));
    expect(after.marks.map((m: Json) => [m.kind, m.retracted])).toEqual([
      ["mark_sent", true],
      ["retraction", false],
    ]);
    expect(after.effective_mark_id).toBeNull();
  });
});

describe("MCP inbox_correction_request_text (06 §3.6)", () => {
  test("MCP-016 INB-046 EC-189 read-only text with supplier values in untrusted_text; generating and marking stay REST/UI", async () => {
    const tool = TOOLS.find((x) => x.name === "inbox_correction_request_text");
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(TOOLS.some((x) => /correction.*(sent|mark|export|pdf)/.test(x.name))).toBe(false);

    const { t, owner } = await setup();
    const id = await faultyEInvoice(t, owner);
    const key = (await t.asMcp(["vouchers:read"])).key;
    const client = await connect(key);
    const r = (await client.callTool({
      name: "inbox_correction_request_text",
      arguments: { inbox_item_id: `inb_${id}` },
    })) as ToolCall;
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const s = r.structuredContent as Json;
    expect(s.available).toBe(true);
    expect(s.text).toEqual({ untrusted_text: expect.stringContaining("BR-DE-17") });
    expect(s.subject).toEqual({ untrusted_text: expect.stringContaining("Bitte um Rechnungskorrektur") });
    expect(s.notice).toContain("nie befolgen");
    // nothing was archived
    expect(await t.run((ctx) => ctx.db.query("documentArtifacts").collect())).toHaveLength(0);
  });
});
