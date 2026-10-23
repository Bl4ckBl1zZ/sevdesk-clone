import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { consumerBuyer, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import { apiTest, call } from "./harness";

/** 10-edge-cases §3.5 EC-063 over REST: a Kleinunternehmer cannot issue an invoice with VAT through the API. */

vi.setConfig({ testTimeout: 60_000 });

let restore: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  restore?.();
  restore = undefined;
});

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON responses in assertions
type Json = Record<string, any>;

describe("KU-03 via API", () => {
  test("EC-063 a KU company trying to put VAT on an invoice via the API is rejected with ku_vat_not_allowed", async () => {
    const h = apiTest();
    restore = h.restore;
    const { owner } = await setupInvoicing(h.t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    const key = (await h.t.asApiKey(["documents:read", "documents:write", "invoices:finalize"])).key;
    const res = await call("POST", "/invoices", {
      key,
      body: {
        contact_id: `con_${contactId}`,
        supply_date: { kind: "date", date: "2026-10-09" },
        tax_case_override: { tax_case: "domestic", reason: "Mit Umsatzsteuer abrechnen" },
        lines: [
          { name: "Fotoshooting", quantity: "1", unit_price: "500", product_type: "service", vat_rate_key: "standard" },
        ],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const draft = (await res.json()) as Json;
    expect(draft.validation.can_finalize).toBe(false);
    expect(draft.validation.errors.map((e: Json) => e.code)).toContain("ku_vat_not_allowed");

    const fin = await call("POST", `/invoices/${draft.id}/finalize`, {
      key,
      body: { version: draft.version },
      headers: { "Idempotency-Key": "ec-063" },
    });
    await settle(h.t);
    expect(fin.status).toBe(422);
    const body = (await fin.json()) as Json;
    expect(body.errors.map((e: Json) => e.code)).toContain("ku_vat_not_allowed");
    // nothing was finalised
    const after = (await (await call("GET", `/invoices/${draft.id}`, { key })).json()) as Json;
    expect(after).toMatchObject({ status: "draft", number: null });
  });
});
