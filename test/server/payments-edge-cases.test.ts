import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { finalizedInvoice } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { apiTest, call } from "./harness";

/** F05 §5.1 REST edge cases of the payment endpoints (EC-PAY-30, EC-PAY-40). Invoice T-GLD-01 (1.190,00). */

let restore: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
});
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

async function setup() {
  const h = apiTest();
  restore = h.restore;
  const t: TestT = h.t;
  const f = await finalizedInvoice(t);
  const key = (await t.asApiKey(["payments:read", "payments:write"])).key;
  return {
    t,
    key,
    inv: `inv_${f.id as Id<"salesDocuments">}`,
    clearing: { kind: "clearing", account_id: `bac_${f.bankAccount}` },
  };
}

describe("F05 §5.1 REST payment edge cases", () => {
  test("EC-PAY-30 PATCH and DELETE /payments/{id} answer 405 with Allow; the payment is unchanged", async () => {
    const { key, inv, clearing } = await setup();
    const res = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 50_000, source: clearing },
    });
    expect(res.status).toBe(201);
    const [payment] = (await json(res)).data as Json[];
    const id = payment?.id as string;
    for (const method of ["PATCH", "DELETE", "PUT"]) {
      const r = await call(method, `/payments/${id}`, { key, body: { amount_cents: 1 } });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("Allow"), method).toContain("GET");
      expect((await json(r)).code, method).toBe("method_not_allowed");
    }
    const after = await json(await call("GET", `/payments/${id}`, { key }));
    expect(after).toMatchObject({ id, amount_cents: 50_000 });
  });

  test("EC-PAY-40 replaying an Idempotency-Key with a different body → 422 idempotency_key_reused, nothing recorded twice", async () => {
    const { key, inv, clearing } = await setup();
    const headers = { "Idempotency-Key": "pay-2026-10-13-001" };
    const first = await call("POST", `/invoices/${inv}/payments`, {
      key,
      headers,
      body: { date: "2026-10-13", amount_cents: 50_000, source: clearing },
    });
    expect(first.status).toBe(201);
    const replay = await call("POST", `/invoices/${inv}/payments`, {
      key,
      headers,
      body: { date: "2026-10-13", amount_cents: 50_000, source: clearing },
    });
    expect(replay.status).toBe(201);
    expect(((await json(replay)).data as Json[])[0]?.id).toBe(((await json(first)).data as Json[])[0]?.id);
    const other = await call("POST", `/invoices/${inv}/payments`, {
      key,
      headers,
      body: { date: "2026-10-13", amount_cents: 60_000, source: clearing },
    });
    expect(other.status).toBe(422);
    expect(await json(other)).toMatchObject({ code: "idempotency_key_reused" });
    const list = await json(await call("GET", `/payments?target_id=${inv}`, { key }));
    expect(list.data).toHaveLength(1);
  });
});
