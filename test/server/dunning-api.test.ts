import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dunningSetup } from "../../convex/dunning.fixtures";
import { settle } from "../../convex/invoices.fixtures";
import { computeInterest } from "../../src/domain/dunning/interest";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { REQUIRES_USER_INTERACTION } from "../../src/server/mcp/tool";
import { apiTest, call } from "./harness";

/**
 * F05 §7.1 dunning REST endpoints (05 §4.4) and the 06 §3.5 MCP tools over convex-test. The invoice (1.190,00) is
 * due on 2026-10-12 and marked sent that day; level 1 is due on 2026-10-19 (B2B policy: 7 days).
 */

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

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

/** Invoice marked sent on 2026-10-12; the clock then moves to the level-1 date 2026-10-19. */
async function setup(opts: { markSent?: boolean } = {}) {
  const h = apiTest();
  restore = h.restore;
  const s = await dunningSetup(h.t, opts);
  vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
  return { t: h.t, ...s, inv: `inv_${s.invoiceId}` };
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

const ALL = ["payments:read", "documents:read", "dunning:write", "invoices:finalize", "invoices:send"] as const;

describe("REST dunning run (05 §4.4, F05 §7.1)", () => {
  test("DUN-031 DUN-030 the preview's confirm_token binds the plan: run once, a repeat answers 409 preview_outdated", async () => {
    const { t, inv } = await setup();
    const key = (await t.asApiKey(["payments:read", "documents:read", "dunning:write"])).key;

    const res = await call("GET", "/dunning/preview", { key });
    expect(res.status).toBe(200);
    const preview = await json(res);
    expect(preview).toMatchObject({
      date: "2026-10-19",
      actions: [{ invoice_id: inv, kind: "create_draft", level: 1, claim: { open_amount_cents: 119_000 } }],
      summary: { drafts: 1, finalize: 0, skipped: 0 },
    });
    const token = preview.confirm_token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Another date can be previewed but never confirmed (the run always evaluates today).
    const later = await json(await call("GET", "/dunning/preview?date=2026-11-30", { key }));
    expect(later.confirm_token).toBeNull();

    const dry = await call("POST", "/dunning/run", { key, body: { mode: "drafts", dry_run: true } });
    expect(dry.status).toBe(200);
    expect((await json(await call("GET", "/reminders", { key }))).data).toEqual([]);

    const missing = await call("POST", "/dunning/run", { key, body: { mode: "drafts" } });
    expect(missing.status).toBe(422);
    expect(await json(missing)).toMatchObject({ errors: [{ field: "confirm_token" }] });

    const run = await call("POST", "/dunning/run", { key, body: { mode: "drafts", confirm_token: token } });
    expect(run.status).toBe(201);
    expect(await json(run)).toMatchObject({ run_id: expect.stringMatching(/^drn_/), drafts: 1, finalized_ids: [] });

    const again = await call("POST", "/dunning/run", { key, body: { mode: "drafts", confirm_token: token } });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("preview_outdated");

    const list = await json(await call("GET", `/reminders?invoice_id=${inv}`, { key }));
    expect(list.data).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^rem_/), status: "draft", level: 1, invoice_id: inv }),
    ]);
  });

  test("DUN-031 mode finalize needs invoices:finalize in addition to dunning:write", async () => {
    const { t } = await setup();
    const key = (await t.asApiKey(["payments:read", "dunning:write"])).key;
    const token = (await json(await call("GET", "/dunning/preview", { key }))).confirm_token as string;
    const res = await call("POST", "/dunning/run", { key, body: { mode: "finalize", confirm_token: token } });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "insufficient_scope", required_scope: "invoices:finalize" });
  });
});

describe("REST reminders (05 §4.4)", () => {
  test("DUN-008 DUN-004 SND-16 SND-17 PAY-052 create → finalize → export → mark sent → Zugang; withdraw with reason", async () => {
    const { t, inv } = await setup();
    const key = (await t.asApiKey([...ALL])).key;
    const readOnly = (await t.asApiKey(["documents:read", "dunning:write"])).key;

    const created = await call("POST", `/invoices/${inv}/reminders`, {
      key,
      body: { fee_cents: 500, acknowledge_warnings: ["not_in_default"] },
    });
    expect(created.status).toBe(201);
    const draft = await json(created);
    expect(draft).toMatchObject({ status: "draft", level: 1, fee_cents: 500, invoice_id: inv, number: null });
    const rem = draft.id as string;
    expect(created.headers.get("Location")).toBe(`/api/v1/reminders/${rem}`);

    const noScope = await call("POST", `/reminders/${rem}/finalize`, {
      key: readOnly,
      body: {},
      headers: { "Idempotency-Key": "f-0" },
    });
    expect(noScope.status).toBe(403);

    const fin = await call("POST", `/reminders/${rem}/finalize`, {
      key,
      body: { version: draft.version, acknowledge_warnings: ["not_in_default"] },
      headers: { "Idempotency-Key": "f-1" },
    });
    expect(fin.status).toBe(200);
    expect(await json(fin)).toMatchObject({ status: "finalized", number: "MA-2026-0001", total_cents: 119_500 });
    await settle(t);

    const exp = await call("POST", `/reminders/${rem}/export`, { key, body: {} });
    expect(exp.status).toBe(200);
    const files = (await json(exp)).files as { artifact_id: string }[];
    expect(files[0]?.artifact_id).toMatch(/^art_/);

    const mark = await call("POST", `/reminders/${rem}/mark-sent`, {
      key,
      body: { sent_on: "2026-10-19", channel: "post", artifacts: files.map((f) => f.artifact_id) },
    });
    expect(mark.status).toBe(200);
    expect(await json(mark)).toMatchObject({ send_log_id: expect.stringMatching(/^snd_/), first_effective: true });

    const got = await json(await call("GET", `/reminders/${rem}`, { key }));
    expect(got).toMatchObject({ status: "sent", sent_on: "2026-10-19", zugang: "2026-10-22" });

    const zugang = await call("POST", `/reminders/${rem}/zugang`, {
      key,
      body: { date: "2026-10-19", reason: "Persönlich übergeben am 19.10." },
    });
    expect(zugang.status).toBe(200);
    expect(await json(zugang)).toMatchObject({ zugang: "2026-10-19" });

    const short = await call("POST", `/reminders/${rem}/withdraw`, { key, body: { reason: "x" } });
    expect(short.status).toBe(422);
    const wd = await call("POST", `/reminders/${rem}/withdraw`, { key, body: { reason: "Zahlung vor Mahnung" } });
    expect(wd.status).toBe(200);
    expect(await json(wd)).toMatchObject({ status: "cancelled", cancellation_reason: "Zahlung vor Mahnung" });
  });

  test("DUN-034 DUN-043 dispute via POST /invoices/{id}/dunning stops the next run; a wrong prefix is 404", async () => {
    const { t, inv, invoiceId } = await setup();
    const key = (await t.asApiKey(["payments:read", "dunning:write"])).key;
    expect((await call("POST", `/invoices/rem_${invoiceId}/dunning`, { key, body: { action: "resume" } })).status).toBe(
      404,
    );
    const res = await call("POST", `/invoices/${inv}/dunning`, {
      key,
      body: { action: "dispute", reason: "Kunde bestreitet die Leistung" },
    });
    expect(res.status).toBe(200);
    const preview = await json(await call("GET", "/dunning/preview", { key }));
    expect(preview.actions).toEqual([expect.objectContaining({ kind: "skip", reason: "disputed" })]);
  });
});

describe("REST dunning policies and interest (DUN-001, DUN-022)", () => {
  test("DUN-001 the defaults are listed before the first save; writes need dunning:manage; PATCH checks the version", async () => {
    const { t } = await setup();
    const reader = (await t.asApiKey(["payments:read", "dunning:write"])).key;
    const manager = (await t.asApiKey(["payments:read", "dunning:manage"])).key;

    const list = await json(await call("GET", "/dunning-policies", { key: reader }));
    const seeded = list.data as Json[];
    expect(seeded.map((p) => [p.id, p.seeded, p.name])).toEqual([
      [null, true, expect.any(String)],
      [null, true, expect.any(String)],
    ]);

    const body = {
      ...(seeded[0] as Json),
      name: "Großkunden",
      is_default: false,
    };
    for (const k of ["id", "seeded", "version", "warnings"]) delete (body as Json)[k];
    expect((await call("POST", "/dunning-policies", { key: reader, body })).status).toBe(403);
    const created = await call("POST", "/dunning-policies", { key: manager, body });
    expect(created.status).toBe(201);
    const policy = await json(created);
    expect(policy).toMatchObject({ id: expect.stringMatching(/^dpo_/), version: 1, name: "Großkunden" });

    const stale = await call("PATCH", `/dunning-policies/${policy.id}`, {
      key: manager,
      body: { ...body, name: "Großkunden B2B", version: 7 },
    });
    expect(stale.status).toBe(409);
    const ok = await call("PATCH", `/dunning-policies/${policy.id}`, {
      key: manager,
      body: { ...body, name: "Großkunden B2B", version: 1 },
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ name: "Großkunden B2B", version: 2 });

    const after = await json(await call("GET", "/dunning-policies", { key: reader }));
    expect((after.data as Json[]).every((p) => typeof p.id === "string")).toBe(true);
  });

  test("DUN-022 MAHN-02 GET /dunning/interest uses the § 288 calculator (one implementation)", async () => {
    const { t } = await setup();
    const key = (await t.asApiKey(["payments:read"])).key;
    const res = await call("GET", "/dunning/interest?amount_cents=1000000&from=2026-03-01&to=2026-09-30&margin=b2b", {
      key,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    const expected = computeInterest({
      principalCents: 1_000_000,
      from: "2026-03-01" as never,
      to: "2026-09-30" as never,
      margin: "b2b",
    });
    expect(expected.ok).toBe(true);
    if (expected.ok) expect(body.total_cents).toBe(expected.value.totalCents);
    expect((body.segments as Json[]).length).toBeGreaterThanOrEqual(1);
    const bad = await call("GET", "/dunning/interest?amount_cents=100&from=2026-09-30&to=2026-03-01", { key });
    expect(bad.status).toBe(422);
  });
});

describe("MCP dunning tools (06 §3.5)", () => {
  test("MCP-005 dunning_run is ⚠ (destructive, user interaction, intent dunning_run); reminder_create is a draft tool", () => {
    const run = TOOLS.find((x) => x.name === "dunning_run");
    expect(run?.annotations.destructiveHint).toBe(true);
    expect(run?.meta[REQUIRES_USER_INTERACTION]).toBe(true);
    expect(run?.confirmIntent).toBe("dunning_run");
    const create = TOOLS.find((x) => x.name === "reminder_create");
    expect(create?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(TOOLS.find((x) => x.name === "dunning_preview")?.scopes).toEqual(["payments:read"]);
  });

  test("MCP-004 MCP-006 DUN-031 dunning_run needs the dunning_preview token; other parameters or a changed plan → preview_outdated", async () => {
    const { t, inv } = await setup();
    const client = await connect((await t.asMcp(["payments:read", "dunning:write", "documents:read"])).key);

    const noToken = (await client.callTool({ name: "dunning_run", arguments: { mode: "drafts" } })) as ToolCall;
    expect(noToken.isError).toBe(true);

    const finalizePreview = (await client.callTool({
      name: "dunning_preview",
      arguments: { mode: "finalize" },
    })) as ToolCall;
    expect(errorOf(finalizePreview).code).toBe("insufficient_scope");

    const preview = (await client.callTool({
      name: "dunning_preview",
      arguments: { mode: "drafts", invoice_ids: [inv] },
    })) as ToolCall;
    expect(preview.isError).toBeFalsy();
    expect(preview.structuredContent).toMatchObject({
      actions: [{ invoice_id: inv, kind: "create_draft", level: 1 }],
      confirm_token: expect.stringMatching(/^ct_/),
    });
    const token = preview.structuredContent?.confirm_token as string;

    const other = (await client.callTool({
      name: "dunning_run",
      arguments: { mode: "drafts", confirm_token: token },
    })) as ToolCall;
    expect(errorOf(other).code).toBe("preview_outdated");

    const ok = (await client.callTool({
      name: "dunning_run",
      arguments: { mode: "drafts", invoice_ids: [inv], confirm_token: token },
    })) as ToolCall;
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ drafts: 1 });

    // A second preview sees the draft (draft_pending); a token for the old plan cannot be replayed.
    const reused = (await client.callTool({
      name: "dunning_run",
      arguments: { mode: "drafts", invoice_ids: [inv], confirm_token: token },
    })) as ToolCall;
    expect(["confirm_token_used", "preview_outdated"]).toContain(errorOf(reused).code);
  });

  test("DUN-008 reminder_create creates a draft without a token; the app never sends", async () => {
    const { t, inv } = await setup();
    const client = await connect((await t.asMcp(["payments:read", "dunning:write", "documents:read"])).key);
    const r = (await client.callTool({ name: "reminder_create", arguments: { invoice_id: inv } })) as ToolCall;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "draft", level: 1, id: expect.stringMatching(/^rem_/) });
    expect(TOOLS.some((x) => /send/.test(x.name) && !/mark_sent/.test(x.name))).toBe(false);
  });
});
