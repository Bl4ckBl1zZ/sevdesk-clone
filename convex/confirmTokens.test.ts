import { describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, setupCatalog } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return errorCode(e);
  }
}

let n = 0;
const newToken = () => `ct_test_${Date.now()}_${n++}`;

async function setup(t: TestT) {
  const owner = await setupCatalog(t);
  const a = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm("Alpha GmbH"), { address: BERLIN }),
  });
  const b = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm("Alpha G.m.b.H."), { address: BERLIN }),
  });
  const mcp = await t.asMcp(["contacts:read", "contacts:write"]);
  const values = { winnerId: a.id, loserIds: [b.id], fieldChoices: {}, confirmVatConflict: false };
  const issue = async (args: Record<string, unknown> = { values }, caller = mcp) => {
    const token = newToken();
    await caller.mutation(api.confirmTokens.issue, {
      intent: "contact_merge",
      args,
      entities: [
        { table: "contacts", id: a.id },
        { table: "contacts", id: b.id },
      ],
      tokenHash: await sha256Hex(token),
    });
    return token;
  };
  return { owner, a, b, mcp, values, issue };
}

describe("confirm tokens for ⚠ MCP tools (06 §2.3)", () => {
  test("MCP-004 EC-188 an MCP merge without confirm_token is refused even though the key has the scope", async () => {
    const t = makeT();
    const { mcp, values } = await setup(t);
    expect(await codeOf(mcp.mutation(api.contacts.merge, { values }))).toBe("confirm_token_required");
  });

  test("MCP-004 a token from preview_action for the same params and versions allows the act exactly once", async () => {
    const t = makeT();
    const { mcp, values, issue, b } = await setup(t);
    const token = await issue();
    await expect(mcp.mutation(api.contacts.merge, { values, confirmToken: token })).resolves.toHaveLength(1);
    const loser = await t.run((ctx) => ctx.db.get(b.id as Id<"contacts">));
    expect(loser?.mergedIntoId).toBeDefined();
    expect(await codeOf(mcp.mutation(api.contacts.merge, { values, confirmToken: token }))).toBe("confirm_token_used");
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits.some((e) => e.action === "contact.merge" && e.actor === mcp.actor && e.channel === "mcp")).toBe(true);
  });

  test("MCP-004 a token expires after 10 minutes", async () => {
    vi.useFakeTimers();
    try {
      const t = makeT();
      const { mcp, values, issue } = await setup(t);
      const token = await issue();
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(await codeOf(mcp.mutation(api.contacts.merge, { values, confirmToken: token }))).toBe(
        "confirm_token_expired",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("MCP-004 a token issued for other params fails with preview_outdated", async () => {
    const t = makeT();
    const { mcp, values, issue } = await setup(t);
    const token = await issue({ values: { ...values, fieldChoices: { iban: values.loserIds[0] } } });
    expect(await codeOf(mcp.mutation(api.contacts.merge, { values, confirmToken: token }))).toBe("preview_outdated");
  });

  test("MCP-004 EC-003 a contact edited after the preview invalidates the token (preview_outdated)", async () => {
    const t = makeT();
    const { owner, mcp, values, issue, a } = await setup(t);
    const token = await issue();
    await owner.mutation(api.contacts.update, { id: a.id, version: 1, values: orgForm("Alpha GmbH & Co. KG") });
    expect(await codeOf(mcp.mutation(api.contacts.merge, { values, confirmToken: token }))).toBe("preview_outdated");
  });

  test("MCP-004 a token for another intent fails with confirm_token_intent_mismatch", async () => {
    const t = makeT();
    const { mcp, values } = await setup(t);
    const token = newToken();
    await t.run(async (ctx) =>
      ctx.db.insert("confirmTokens", {
        tokenHash: await sha256Hex(token),
        apiKeyId: mcp.prefix,
        intent: "document_finalize",
        paramsHash: "x",
        entities: [],
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      }),
    );
    expect(await codeOf(mcp.mutation(api.contacts.merge, { values, confirmToken: token }))).toBe(
      "confirm_token_intent_mismatch",
    );
  });

  test("MCP-004 another key's token and unknown tokens are invalid", async () => {
    const t = makeT();
    const { values, issue } = await setup(t);
    const token = await issue();
    const other = await t.asMcp(["contacts:write"]);
    expect(await codeOf(other.mutation(api.contacts.merge, { values, confirmToken: token }))).toBe(
      "confirm_token_invalid",
    );
    expect(await codeOf(other.mutation(api.contacts.merge, { values, confirmToken: "ct_nope" }))).toBe(
      "confirm_token_invalid",
    );
  });

  test("MCP-004 issuing needs the scope of the guarded action and an mcp key", async () => {
    const t = makeT();
    const { issue } = await setup(t);
    const reader = await t.asMcp(["contacts:read"]);
    expect(await codeOf(issue(undefined, reader))).toBe("forbidden_scope");
    const rest = await t.asApiKey(["contacts:write"]);
    expect(await codeOf(issue(undefined, rest as never))).toBe("forbidden_scope");
  });

  test("MCP-004 unknown or not yet available intents are refused", async () => {
    const t = makeT();
    const { mcp } = await setup(t);
    const hash = await sha256Hex("x");
    expect(
      await codeOf(mcp.mutation(api.confirmTokens.issue, { intent: "rm_rf", args: {}, entities: [], tokenHash: hash })),
    ).toBe("invalid_input");
    expect(
      await codeOf(
        mcp.mutation(api.confirmTokens.issue, { intent: "document_finalize", args: {}, entities: [], tokenHash: hash }),
      ),
    ).toBe("invalid_input");
  });

  test("MCP-004 REST keys and the UI merge without a token (the token rule is MCP-only)", async () => {
    const t = makeT();
    const { values } = await setup(t);
    const rest = await t.asApiKey(["contacts:write"]);
    await expect(rest.mutation(api.contacts.merge, { values })).resolves.toHaveLength(1);
  });

  test("MCP-004 expired tokens are purged by the cleanup job", async () => {
    const t = makeT();
    const { issue } = await setup(t);
    await issue();
    await t.run(async (ctx) => {
      const row = await ctx.db.query("confirmTokens").first();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect((await t.mutation(internal.apiKeys.cleanupCron, { force: true })).confirmTokens).toBe(1);
  });
});
