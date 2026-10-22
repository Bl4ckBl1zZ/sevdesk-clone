import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { finalizedInvoice, settle } from "../../convex/invoices.fixtures";
import { patchCompanyProfile } from "../../convex/model/companyProfile";
import type { TestT } from "../../convex/test.setup";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { TOOLS } from "../../src/server/mcp/server";
import { REQUIRES_USER_INTERACTION } from "../../src/server/mcp/tool";
import { apiTest } from "./harness";

/**
 * F09 §7 / 06 §3 MCP `export_datev` (TST-EXP-15, E-EXP-19, CLAUDE.md rule 8): ⚠ with scope `exports:run`,
 * destructiveHint and requiresUserInteraction; the token comes from `preview_action { action: "export_datev" }`, which
 * runs the DATEV validation and issues no token while the report blocks; the token binds the arguments incl. the lock.
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
const errorOf = (r: ToolCall) =>
  JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; message?: string; errors?: { message: string }[] };

async function withDatev(t: TestT, actor: `user:${string}`) {
  await t.model({ actor, role: "owner", channel: "ui" } as const, (ctx) =>
    patchCompanyProfile(
      ctx,
      { datev: { consultantNumber: 1234567, clientNumber: 12345, accountLength: 4, personalAccounts: true } },
      { action: "settings.company.update" },
    ),
  );
}

const PARAMS = { from: "2026-10-01", to: "2026-10-31" };

describe("MCP export_datev (06 §3, F09 §7)", { timeout: 180_000 }, () => {
  test("MCP-013 E-EXP-19 TST-EXP-15 export_datev is ⚠: scope exports:run, destructiveHint, requiresUserInteraction, confirm_token required", async () => {
    const tool = TOOLS.find((x) => x.name === "export_datev");
    expect(tool).toMatchObject({ kind: "danger", confirmIntent: "export_datev", scopes: ["exports:run"] });
    expect(tool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tool?.meta[REQUIRES_USER_INTERACTION]).toBe(true);
    expect(tool?.input.safeParse(PARAMS).success).toBe(false);
    const t = setup();
    const safe = await connect((await t.asMcp(["reports:read", "documents:read"])).key);
    expect((await safe.listTools()).tools.map((x) => x.name)).not.toContain("export_datev");
    const full = await connect((await t.asMcp(["exports:run"])).key);
    const listed = (await full.listTools()).tools.find((x) => x.name === "export_datev");
    expect(listed?._meta?.[REQUIRES_USER_INTERACTION]).toBe(true);
    expect((listed?.inputSchema as { required?: string[] } | undefined)?.required).toContain("confirm_token");
  });

  test("MCP-013 E-EXP-19 TST-EXP-15 EXP-007 a blocking report issues no token; without a token no job; with the token the job runs and export_job_status returns the link", async () => {
    const t = setup();
    const f = await finalizedInvoice(t);
    const mcp = await t.asMcp(["exports:run"]);
    const client = await connect(mcp.key);

    // E-EXP-01 blocks: the preview answers with the report's errors and no token
    const blocked = (await client.callTool({
      name: "preview_action",
      arguments: { action: "export_datev", params: PARAMS },
    })) as ToolCall;
    expect(blocked.isError).toBe(true);
    expect(errorOf(blocked).errors?.map((e) => e.message)).toContain(
      "Für den DATEV-Export fehlen Berater- und/oder Mandantennummer (Einstellungen › Unternehmen › DATEV).",
    );
    expect(await t.run((ctx) => ctx.db.query("confirmTokens").collect())).toHaveLength(0);

    await withDatev(t, f.owner.actor);
    // no token → refused, nothing started
    const without = (await client.callTool({
      name: "export_datev",
      arguments: { ...PARAMS, confirm_token: "ct_invalid" },
    })) as ToolCall;
    expect(without.isError).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toHaveLength(0);

    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "export_datev", params: PARAMS },
    })) as ToolCall;
    expect(preview.isError).toBeFalsy();
    const effect = preview.structuredContent?.effect as Json;
    expect(effect).toMatchObject({ range: PARAMS, mode: "new", lock_period: false, lock: null });
    expect(effect.row_count).toBeGreaterThan(0);
    const token = String(preview.structuredContent?.confirm_token);
    expect(token).toMatch(/^ct_/);

    // the token binds the arguments: the same token with lock_period: true is refused (E-EXP-19)
    const locked = (await client.callTool({
      name: "export_datev",
      arguments: { ...PARAMS, lock_period: true, confirm_token: token },
    })) as ToolCall;
    expect(locked.isError).toBe(true);
    expect(errorOf(locked).code).toBe("preview_outdated");
    expect((await t.run((ctx) => ctx.db.query("periods").collect())).some((p) => p.status === "locked")).toBe(false);

    const run = (await client.callTool({
      name: "export_datev",
      arguments: { ...PARAMS, confirm_token: token },
    })) as ToolCall;
    expect(run.isError).toBeFalsy();
    const jobId = String(run.structuredContent?.job_id);
    expect(jobId).toMatch(/^job_/);
    // single use
    const again = (await client.callTool({
      name: "export_datev",
      arguments: { ...PARAMS, confirm_token: token },
    })) as ToolCall;
    expect(errorOf(again).code).toBe("confirm_token_used");

    await settle(t);
    const status = (await client.callTool({ name: "export_job_status", arguments: { job_id: jobId } })) as ToolCall;
    expect(status.structuredContent).toMatchObject({
      id: jobId,
      kind: "datev_export",
      status: "done",
      actor: mcp.actor,
    });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((e) => e.action === "export.datev")).toMatchObject({ actor: mcp.actor, channel: "mcp" });
  });

  test("E-EXP-19 EXP-011 with lock_period the preview names the lock and its token locks the months before the export", async () => {
    const t = setup();
    const f = await finalizedInvoice(t);
    await withDatev(t, f.owner.actor);
    const client = await connect((await t.asMcp(["exports:run"])).key);
    const params = { ...PARAMS, lock_period: true };
    const preview = (await client.callTool({
      name: "preview_action",
      arguments: { action: "export_datev", params },
    })) as ToolCall;
    const effect = preview.structuredContent?.effect as Json;
    expect(String(effect.lock)).toContain(
      "bis einschließlich 10/2026 werden vor dem Export unumkehrbar festgeschrieben",
    );
    const token = String(preview.structuredContent?.confirm_token);
    // a token previewed with the lock cannot start an export without it
    const plain = (await client.callTool({
      name: "export_datev",
      arguments: { ...PARAMS, confirm_token: token },
    })) as ToolCall;
    expect(errorOf(plain).code).toBe("preview_outdated");
    const run = (await client.callTool({
      name: "export_datev",
      arguments: { ...params, confirm_token: token },
    })) as ToolCall;
    expect(run.isError).toBeFalsy();
    await settle(t);
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.find((p) => p.period === "2026-10")).toMatchObject({ status: "locked", reason: "datev_export" });
    const [row] = await t.run((ctx) => ctx.db.query("datevExports").collect());
    expect(row?.festschreibung).toBe(true);
  });
});
