import { describe, expect, test, vi } from "vitest";
import { hashApiKey, parseApiKey } from "../src/domain/api/keys";
import { presetScopes } from "../src/domain/api/scopes";
import { api, internal } from "./_generated/api";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return errorCode(e);
  }
}

const values = (over: Record<string, unknown> = {}) => ({
  name: "Website",
  channel: "api",
  scopes: presetScopes("website"),
  expiresOn: "",
  rateLimitPerMinute: "",
  ...over,
});

describe("API keys: lifecycle (05 §2.1)", () => {
  test("API-001 API-002 the owner creates a key; it is shown once, stored as SHA-256 and audited without the hash", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const created = await owner.action(api.apiKeys.create, { values: values() });
    const parsed = parseApiKey(created.key);
    expect(parsed?.publicId).toBe(created.publicId);
    const row = await t.run((ctx) =>
      ctx.db
        .query("apiKeys")
        .withIndex("by_prefix", (q) => q.eq("prefix", created.publicId))
        .unique(),
    );
    expect(row).toMatchObject({
      name: "Website",
      channel: "api",
      hash: await hashApiKey(created.key),
      createdBy: owner.actor,
      scopes: presetScopes("website"),
    });
    expect(JSON.stringify(row)).not.toContain(created.key.slice(8));
    const entry = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "apiKeys").eq("entity.id", row?._id ?? ""))
        .first(),
    );
    expect(entry).toMatchObject({ action: "api_key.create", actor: owner.actor });
    expect((entry?.diff as { after: { hash: string } } | undefined)?.after.hash).toBe("[redacted]");
    const list = await owner.query(api.apiKeys.list, {});
    expect(list[0]).toMatchObject({ name: "Website", display: created.display, preset: "website", status: "active" });
  });

  test("API-002 only the owner creates keys, and only with a fresh session", async () => {
    const t = makeT();
    const bookkeeper = await t.asUser("bookkeeper");
    expect(await codeOf(bookkeeper.action(api.apiKeys.create, { values: values() }))).toBe("forbidden_role");
    const stale = await t.asUser("owner", { sessionAgeMs: 15 * 60_000 });
    expect(await codeOf(stale.action(api.apiKeys.create, { values: values() }))).toBe("reauth_required");
    const key = await t.asApiKey([...presetScopes("claude_full")]);
    expect(await codeOf(key.action(api.apiKeys.create, { values: values() }))).toBe("forbidden_scope");
    expect(await codeOf(key.query(api.apiKeys.list, {}))).toBe("forbidden_scope");
  });

  test("API-002 invalid scopes or a past expiry are refused", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(await codeOf(owner.action(api.apiKeys.create, { values: values({ scopes: ["portal:manage"] }) }))).toBe(
      "invalid_input",
    );
    expect(await codeOf(owner.action(api.apiKeys.create, { values: values({ expiresOn: "2020-01-01" }) }))).toBe(
      "invalid_input",
    );
  });

  test("API-003 EC-186 E-AUD-25 a revoked key fails on its very next request; revocation is audited", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const key = await t.asApiKey(["contacts:read"]);
    await expect(key.mutation(api.apiKeys.authorize, {})).resolves.toMatchObject({ publicId: key.prefix });
    const row = await t.run((ctx) =>
      ctx.db
        .query("apiKeys")
        .withIndex("by_prefix", (q) => q.eq("prefix", key.prefix))
        .unique(),
    );
    await owner.mutation(api.apiKeys.revoke, { keyId: row?._id as never, reason: "geleakt" });
    expect(await codeOf(key.mutation(api.apiKeys.authorize, {}))).toBe("key_revoked");
    const list = await owner.query(api.apiKeys.list, {});
    expect(list.find((k) => k.publicId === key.prefix)?.status).toBe("revoked");
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits.some((a) => a.action === "api_key.revoke" && a.reason === "geleakt")).toBe(true);
  });

  test("API-003 an expired key is refused", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:read"], { expiresAt: Date.now() - 1 });
    expect(await codeOf(key.mutation(api.apiKeys.authorize, {}))).toBe("key_revoked");
  });
});

describe("API keys: per-request functions (05 §3, §7)", () => {
  test("API-005 authorize returns the stored scopes and key data for the fail-fast scope check", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:read", "products:read"], { name: "Shop" });
    const r = await key.mutation(api.apiKeys.authorize, {});
    expect(r).toMatchObject({
      publicId: key.prefix,
      name: "Shop",
      channel: "api",
      scopes: ["contacts:read", "products:read"],
      rateLimitPerMinute: 120,
      rateLimit: { ok: true, limit: 30, remaining: 29 },
    });
  });

  test("API-007 the bucket is per key: after the burst the key is limited, another key is not", async () => {
    const t = makeT();
    const small = await t.asApiKey(["contacts:read"], { rateLimitPerMinute: 4 });
    const other = await t.asApiKey(["contacts:read"]);
    const first = await small.mutation(api.apiKeys.authorize, {});
    expect(first.rateLimit).toMatchObject({ ok: true, limit: 1, remaining: 0 });
    const second = await small.mutation(api.apiKeys.authorize, {});
    expect(second.rateLimit.ok).toBe(false);
    expect(second.rateLimit.resetSeconds).toBeGreaterThan(0);
    expect((await other.mutation(api.apiKeys.authorize, {})).rateLimit.ok).toBe(true);
  });

  test("API-008 lastUsedAt is stamped at most once a minute and needs no audit entry", async () => {
    vi.useFakeTimers();
    try {
      const t = makeT();
      const key = await t.asApiKey(["contacts:read"]);
      const read = () =>
        t.run(async (ctx) =>
          ctx.db
            .query("apiKeys")
            .withIndex("by_prefix", (q) => q.eq("prefix", key.prefix))
            .unique(),
        );
      const auditsBefore = (await t.run((ctx) => ctx.db.query("auditLog").collect())).length;
      await key.mutation(api.apiKeys.authorize, {});
      const firstStamp = (await read())?.lastUsedAt;
      expect(firstStamp).toBeDefined();
      vi.advanceTimersByTime(30_000);
      await key.mutation(api.apiKeys.authorize, {});
      expect((await read())?.lastUsedAt).toBe(firstStamp);
      vi.advanceTimersByTime(31_000);
      await key.mutation(api.apiKeys.authorize, {});
      expect((await read())?.lastUsedAt).toBeGreaterThan(firstStamp as number);
      expect((await t.run((ctx) => ctx.db.query("auditLog").collect())).length).toBe(auditsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  test("API-008 every request lands in the access log without bodies; the owner sees it per key", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const mcp = await t.asMcp(["contacts:read"], { client: { name: "claude-code", version: "2.1" } });
    await mcp.mutation(api.apiKeys.logRequest, {
      method: "POST",
      target: "tools/call contact_search",
      status: 200,
      durationMs: 12.4,
      requestId: "req_1",
    });
    const rows = await t.run((ctx) => ctx.db.query("apiRequestLog").collect());
    expect(rows).toEqual([
      expect.objectContaining({
        apiKeyId: mcp.prefix,
        channel: "mcp",
        target: "tools/call contact_search",
        status: 200,
        durationMs: 12,
        requestId: "req_1",
        client: { name: "claude-code", version: "2.1" },
      }),
    ]);
    const keyRow = await t.run((ctx) =>
      ctx.db
        .query("apiKeys")
        .withIndex("by_prefix", (q) => q.eq("prefix", mcp.prefix))
        .unique(),
    );
    const list = await owner.query(api.apiKeys.requests, { keyId: keyRow?._id as never });
    expect(list).toHaveLength(1);
  });

  test("API-008 the cleanup job removes access-log rows older than 90 days", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:read"]);
    await key.mutation(api.apiKeys.logRequest, {
      method: "GET",
      target: "/contacts",
      status: 200,
      durationMs: 1,
      requestId: "r",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("apiRequestLog").first();
      if (row) await ctx.db.patch(row._id, { at: Date.now() - 91 * 86_400_000 });
    });
    const r = await t.mutation(internal.apiKeys.cleanupCron, { force: true });
    expect(r.accessLog).toBe(1);
  });
});
