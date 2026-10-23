import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { finalizedInvoice, invoiceValues, settle } from "../../convex/invoices.fixtures";
import { apiTest, call } from "./harness";

/**
 * F05 §7.1 REST payment endpoints beyond the happy path of payments-api.test.ts: the combined payment with
 * differences, list filters, the preview of a combined payment and of a failing invoice payment, open-item
 * filters, credit application/refund and the "unknown id" mapping of every source kind. The invoice is T-GLD-01
 * (1.190,00 gross, 2 % Skonto within 14 days, dated 2026-10-13).
 */

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
  const f = await finalizedInvoice(h.t);
  const key = (await h.t.asApiKey(["payments:read", "payments:write"])).key;
  return { t: h.t, f, key, inv: `inv_${f.id}`, clearing: { kind: "clearing", account_id: `bac_${f.bankAccount}` } };
}

describe("REST payments – variants (F05 §7.1)", () => {
  test("PAY-013 PAY-020 a combined payment with a Skonto difference settles the invoice; note and backdate reason are kept", async () => {
    const { key, inv, clearing } = await setup();
    const body = {
      source: clearing,
      date: "2026-10-13",
      allocations: [
        {
          target: { kind: "invoice", id: inv },
          amount_cents: 116_620,
          differences: [{ reason: "skonto", amount_cents: 2_380 }],
        },
      ],
      note: "Sammelzahlung Oktober",
      backdate_reason: "Kontoauszug kam verspätet",
    };
    const preview = await call("POST", "/payments/preview", { key, body });
    expect(preview.status).toBe(200);
    expect(await json(preview)).toMatchObject({
      allocations: [{ target: { kind: "invoice", id: inv }, amount_cents: 116_620, open_after_cents: 0 }],
    });
    const res = await call("POST", "/payments", { key, body });
    expect(res.status).toBe(201);
    const out = await json(res);
    const [payment] = out.data as Json[];
    expect(payment).toMatchObject({
      target: { kind: "invoice", id: inv },
      amount_cents: 116_620,
      settles_cents: 119_000,
      note: "Sammelzahlung Oktober",
      differences: [
        {
          reason: "skonto",
          amount_cents: 2_380,
          sub_reason: null,
          vat_correction: [{ rate_bp: 1_900, net_cents: 2_000, vat_cents: 380 }],
        },
      ],
    });
    // One allocation → no allocation group (groups tie several allocations of one source together).
    expect(out).toMatchObject({ allocation_group_id: null, unallocated_cents: null, warnings: [] });
    const open = await json(await call("GET", "/open-items", { key }));
    expect(open.data).toEqual([]);
  });

  test("PAY-013 an unknown or foreign-prefixed target or source maps to 404, never to a write", async () => {
    const { key, inv, clearing } = await setup();
    const alloc = (target: Json) => ({
      source: clearing,
      date: "2026-10-13",
      allocations: [{ target, amount_cents: 100 }],
    });
    for (const target of [
      { kind: "invoice", id: "con_x" },
      { kind: "opening_item", id: "inv_x" },
      { kind: "credit", id: "opi_x" },
    ]) {
      const res = await call("POST", "/payments", { key, body: alloc(target) });
      expect(res.status, JSON.stringify(target)).toBe(404);
    }
    const badBank = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 100, source: { kind: "bank", transaction_id: "btx_" } },
    });
    expect(badBank.status).toBe(422);
    expect(await json(badBank)).toMatchObject({ code: "validation_failed" });
    const previewUnknown = await call("POST", "/payments/preview", {
      key,
      body: {
        invoice_id: inv,
        date: "2026-10-13",
        amount_cents: 100,
        source: { kind: "clearing", account_id: "bac_" },
      },
    });
    expect(previewUnknown.status).toBe(422);
    expect((await json(await call("GET", "/payments", { key }))).data).toEqual([]);
  });

  test("PAY-030 the invoice preview reports a refused payment (excess without a mode) as 422 validation_failed", async () => {
    const { key, inv, clearing } = await setup();
    const res = await call("POST", "/payments/preview", {
      key,
      body: { invoice_id: inv, date: "2026-10-13", amount_cents: 150_000, source: clearing },
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: "validation_failed", errors: [{ code: "excess" }] });
  });

  test("PAY-012 GET /payments filters by target, contact, source, date range and reversal state", async () => {
    const { key, inv, clearing } = await setup();
    const first = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 10_000, source: clearing, note: "Teil 1" },
    });
    const [p1] = (await json(first)).data as Json[];
    await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: {
        date: "2026-10-13",
        amount_cents: 20_000,
        source: { kind: "cash" },
        acknowledge_warnings: ["cash_daily_recording"],
      },
    });
    await call("POST", `/payments/${p1?.id}/reverse`, { key, body: { reason: "Doppelt erfasst" } });
    const list = async (q: string) =>
      ((await json(await call("GET", `/payments${q}`, { key }))).data as Json[]).map((p) => p.amount_cents);

    expect((await list("")).sort()).toEqual([-10_000, 10_000, 20_000].sort());
    expect(await list("?source_kind=cash")).toEqual([20_000]);
    expect((await list(`?contact_id=${p1?.contact_id}&target_id=${inv}`)).length).toBe(3);
    expect((await list("?date_from=2026-10-13&date_to=2026-10-13")).length).toBe(3);
    expect(await list("?date_from=2026-10-14")).toEqual([]);
    expect(await list("?date_to=2026-10-12")).toEqual([]);
    expect(await list("?reversed=false&source_kind=cash")).toEqual([20_000]);
    // "reversed" covers both sides of a Storno: the reversed payment and its reversal row.
    expect((await list("?reversed=true")).sort()).toEqual([-10_000, 10_000].sort());
    expect(await list("?limit=1")).toHaveLength(1);

    const bad = await call("GET", "/payments?target_id=xyz_1", { key });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ errors: [{ field: "target_id" }] });
  });

  test("PAY-001 PAY-005 open items honour as_of, overdue_only, bucket and the contact filter", async () => {
    const { key, inv } = await setup();
    const all = await json(await call("GET", "/open-items", { key }));
    expect(all).toMatchObject({ as_of: "2026-10-13", data: [{ id: inv, open_cents: 119_000 }] });
    const contactId = ((all.data as Json[])[0] as Json).contact_id as string;

    expect((await json(await call("GET", "/open-items?overdue_only=true", { key }))).data).toEqual([]);
    const later = await json(await call("GET", "/open-items?as_of=2026-12-31&overdue_only=true", { key }));
    expect(later).toMatchObject({ as_of: "2026-12-31", data: [{ id: inv }] });
    expect((later.totals as Json).overdue_cents).toBe(119_000);
    expect((await json(await call("GET", "/open-items?bucket=not_due", { key }))).data).toHaveLength(1);
    expect((await json(await call("GET", "/open-items?bucket=61-90", { key }))).data).toEqual([]);

    const byContact = await json(await call("GET", `/open-items?contact_id=${contactId}`, { key }));
    expect(byContact.data).toHaveLength(1);
    const scoped = await json(await call("GET", `/contacts/${contactId}/open-items?as_of=2026-10-20`, { key }));
    expect(scoped).toMatchObject({ as_of: "2026-10-20", data: [{ id: inv }] });
  });

  test("PAY-030 PAY-033 PAY-062 an overpayment becomes credit, is applied to a new invoice and the rest is refunded in cash", async () => {
    const { t, f, key, inv, clearing } = await setup();
    const over = await call("POST", `/invoices/${inv}/payments`, {
      key,
      body: { date: "2026-10-13", amount_cents: 129_000, source: clearing, excess: { mode: "credit" } },
    });
    expect(over.status).toBe(201);
    const contactId = ((await json(over)).data as Json[])[0]?.contact_id as string;
    const open = await json(await call("GET", "/open-items", { key }));
    expect(open.credits).toEqual([expect.objectContaining({ contact_id: contactId, balance_cents: 10_000 })]);

    // A second invoice for the same buyer takes 4.000 of the credit.
    const { id: draft2 } = await f.owner.mutation(api.invoices.createDraft, { values: invoiceValues(f.personId) });
    await f.owner.action(api.invoices.finalize, { id: draft2, version: 1 });
    await settle(t);
    const inv2 = `inv_${draft2}`;
    const applied = await call("POST", `/contacts/${contactId}/credit/apply`, {
      key,
      body: { invoice_id: inv2, amount_cents: 4_000, date: "2026-10-13" },
    });
    expect(applied.status).toBe(201);
    // Two rows: the credit is drawn down on the contact and the invoice is settled by the same amount.
    expect((await json(applied)).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount_cents: -4_000, target: expect.objectContaining({ id: contactId }) }),
        expect.objectContaining({ amount_cents: 4_000, target: expect.objectContaining({ id: inv2 }) }),
      ]),
    );
    const afterApply = await json(await call("GET", `/contacts/${contactId}/open-items`, { key }));
    expect(afterApply.data).toEqual([expect.objectContaining({ id: inv2, open_cents: 115_000 })]);

    // PAY-062: the empty cash register can't pay out — refused before anything is written.
    const cash = await call("POST", `/contacts/${contactId}/credit/refund`, {
      key,
      body: {
        amount_cents: 1_000,
        source: { kind: "cash" },
        date: "2026-10-13",
        acknowledge_warnings: ["cash_daily_recording"],
      },
    });
    expect(cash.status).toBe(422);
    expect(await json(cash)).toMatchObject({ code: "cash_negative" });

    const refund = await call("POST", `/contacts/${contactId}/credit/refund`, {
      key,
      body: { amount_cents: 1_000, source: clearing, date: "2026-10-13", note: "Überwiesen" },
    });
    expect(refund.status).toBe(201);
    expect(((await json(refund)).data as Json[])[0]).toMatchObject({
      note: "Überwiesen",
      amount_cents: -1_000,
      source: { kind: "clearing" },
    });
    const credits = (await json(await call("GET", "/open-items", { key }))).credits;
    expect(credits).toEqual([expect.objectContaining({ contact_id: contactId, balance_cents: 5_000 })]);
  });
});
