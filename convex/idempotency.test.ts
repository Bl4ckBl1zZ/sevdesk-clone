import { describe, expect, test } from "vitest";
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

describe("Idempotency-Key records (05 §3)", () => {
  test("API-010 first use reserves; the finished response is replayed for the same request hash", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:write"]);
    const first = await key.mutation(api.idempotency.begin, { key: "order-1", requestHash: "h1" });
    expect(first.state).toBe("new");
    if (first.state !== "new") return;
    await key.mutation(api.idempotency.complete, { id: first.id, status: 201, body: '{"id":"con_1"}' });
    await expect(key.mutation(api.idempotency.begin, { key: "order-1", requestHash: "h1" })).resolves.toEqual({
      state: "replay",
      status: 201,
      body: '{"id":"con_1"}',
    });
  });

  test("API-010 the same key with a different body is idempotency_key_reused; a running request is in progress", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:write"]);
    await key.mutation(api.idempotency.begin, { key: "order-2", requestHash: "h1" });
    expect(await codeOf(key.mutation(api.idempotency.begin, { key: "order-2", requestHash: "h1" }))).toBe(
      "idempotency_in_progress",
    );
    expect(await codeOf(key.mutation(api.idempotency.begin, { key: "order-2", requestHash: "h2" }))).toBe(
      "idempotency_key_reused",
    );
  });

  test("API-010 keys are scoped per API key; release frees the key after a server error", async () => {
    const t = makeT();
    const a = await t.asApiKey(["contacts:write"]);
    const b = await t.asApiKey(["contacts:write"]);
    const ra = await a.mutation(api.idempotency.begin, { key: "same", requestHash: "h1" });
    expect((await b.mutation(api.idempotency.begin, { key: "same", requestHash: "h9" })).state).toBe("new");
    if (ra.state !== "new") return;
    expect(await codeOf(b.mutation(api.idempotency.release, { id: ra.id }))).toBe("not_found");
    await a.mutation(api.idempotency.release, { id: ra.id });
    expect((await a.mutation(api.idempotency.begin, { key: "same", requestHash: "h2" })).state).toBe("new");
  });

  test("API-010 records expire after 24 hours and are purged; invalid keys are refused", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:write"]);
    const r = await key.mutation(api.idempotency.begin, { key: "old", requestHash: "h1" });
    if (r.state !== "new") throw new Error("expected new");
    await t.run((ctx) => ctx.db.patch(r.id, { expiresAt: Date.now() - 1 }));
    expect((await key.mutation(api.idempotency.begin, { key: "old", requestHash: "h2" })).state).toBe("new");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("idempotencyKeys").collect()) await ctx.db.patch(row._id, { expiresAt: 1 });
    });
    expect((await t.mutation(internal.apiKeys.cleanupCron, { force: true })).idempotency).toBe(1);
    expect(await codeOf(key.mutation(api.idempotency.begin, { key: "mit leerzeichen", requestHash: "h" }))).toBe(
      "invalid_input",
    );
  });
});
