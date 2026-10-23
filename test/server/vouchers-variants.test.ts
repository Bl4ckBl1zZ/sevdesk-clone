import { afterEach, describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { TestT } from "../../convex/test.setup";
import { setupCompany, TODAY, upload, YEAR } from "../../convex/vouchers.fixtures";
import { apiTest, call } from "./harness";

/**
 * F06 §7 /vouchers over REST beyond vouchers.test.ts: PATCH of a draft (version from body or If-Match), wire issues
 * on create, list filters, unknown IDs, and later payments (bank needs a transaction, private settles the voucher).
 */

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

let seq = 0;
const draftBody = (over: Json = {}) => ({
  supplier_name: "Büro Schmidt GmbH",
  supplier_vat_id: "DE123456789",
  document_number: `RV-${YEAR}-${++seq}`,
  document_date: TODAY,
  price_mode: "gross",
  lines: [{ account: "6805", description: "Telefon und Internet", amount_cents: 11_900, vat_rate_bp: 1900 }],
  ...over,
});

async function setup() {
  const h = apiTest();
  restore = h.restore;
  await setupCompany(h.t);
  const key = (await h.t.asApiKey(["vouchers:read", "vouchers:write", "payments:write"])).key;
  return { t: h.t, key };
}

async function attachOriginal(t: TestT, publicId: string) {
  const owner = await t.asUser("owner");
  await upload(t, owner, { voucherId: publicId.slice(4) as Id<"vouchers"> });
}

describe("REST /vouchers – variants (05 §4.5)", { timeout: 60_000 }, () => {
  test("VOU-001 a draft is patched with the version from the body or If-Match; a foreign contact ID → 422", async () => {
    const { key } = await setup();
    const draft = await json(await call("POST", "/vouchers", { key, body: draftBody() }));
    const lines = [{ account: "6805", description: "Telefon", amount_cents: 23_800, vat_rate_bp: 1900 }];

    const viaBody = await call("PATCH", `/vouchers/${draft.id}`, {
      key,
      body: { ...draftBody(), lines, version: draft.version },
    });
    expect(viaBody.status, JSON.stringify(await viaBody.clone().json())).toBe(200);
    const v2 = await json(viaBody);
    expect(v2).toMatchObject({ status: "draft", totals: { gross_cents: 23_800 } });

    const viaHeader = await call("PATCH", `/vouchers/${draft.id}`, {
      key,
      headers: { "If-Match": String(v2.version) },
      body: { ...draftBody(), lines: [{ ...lines[0], amount_cents: 5_950 }] },
    });
    expect(viaHeader.status, JSON.stringify(await viaHeader.clone().json())).toBe(200);
    expect((await json(viaHeader)).totals).toMatchObject({ gross_cents: 5_950 });

    const stale = await call("PATCH", `/vouchers/${draft.id}`, {
      key,
      body: { ...draftBody(), version: draft.version },
    });
    expect(stale.status).toBe(409);

    const badContact = await call("POST", "/vouchers", {
      key,
      body: draftBody({ supplier_contact_id: "prd_1234567890abcdef" }),
    });
    expect(badContact.status).toBe(422);
    expect(await json(badContact)).toMatchObject({
      errors: [expect.objectContaining({ field: "supplier_contact_id" })],
    });
    const badPatch = await call("PATCH", `/vouchers/${draft.id}`, {
      key,
      body: { ...draftBody({ credit_note_of_id: "inv_1234567890abcdef" }) },
    });
    expect(badPatch.status).toBe(422);
    expect(await json(badPatch)).toMatchObject({ errors: [expect.objectContaining({ field: "credit_note_of_id" })] });
  });

  test("VOU-111 API-009 API-011 the list filters by tab and by the search text in supplier and numbers; unknown IDs are 404", async () => {
    const { key } = await setup();
    const a = await json(await call("POST", "/vouchers", { key, body: draftBody({ supplier_name: "Telekom AG" }) }));
    await call("POST", "/vouchers", { key, body: draftBody({ supplier_name: "Bäckerei Krume" }) });
    const ids = async (q: string) =>
      ((await json(await call("GET", `/vouchers${q}`, { key }))).data as Json[]).map((r) => r.id);
    expect(await ids("?q=Telekom")).toEqual([a.id]);
    expect(await ids("?status=draft")).toHaveLength(2);
    expect(await ids("?status=paid")).toEqual([]);
    expect(await ids("?limit=1")).toHaveLength(1);
    expect((await call("GET", "/vouchers/vou_k57f3x2m9q8w1e4r6t", { key })).status).toBe(404);
    expect(
      (await call("PATCH", "/vouchers/vou_k57f3x2m9q8w1e4r6t", { key, body: { ...draftBody(), version: 1 } })).status,
    ).toBe(404);
  });

  test("VOU-131 a later bank payment needs the transaction; „Privat bezahlt“ later settles the booked voucher", async () => {
    const { t, key } = await setup();
    const draft = await json(await call("POST", "/vouchers", { key, body: draftBody() }));
    await attachOriginal(t, String(draft.id));
    const booked = await json(
      await call("POST", `/vouchers/${draft.id}/finalize`, { key, body: {}, headers: { "Idempotency-Key": "vv-1" } }),
    );
    expect(booked).toMatchObject({ status: "open", open_amount_cents: 11_900 });

    const noTx = await call("POST", `/vouchers/${draft.id}/payments`, {
      key,
      body: { method: "bank" },
      headers: { "Idempotency-Key": "vv-2" },
    });
    expect(noTx.status).toBe(422);
    expect(await json(noTx)).toMatchObject({ errors: [{ code: "required", field: "transaction_id" }] });

    const paid = await call("POST", `/vouchers/${draft.id}/payments`, {
      key,
      body: { method: "private", date: TODAY, note: "privat überwiesen" },
      headers: { "Idempotency-Key": "vv-3" },
    });
    expect(paid.status, JSON.stringify(await paid.clone().json())).toBe(200);
    expect(await json(paid)).toMatchObject({
      status: "paid",
      open_amount_cents: 0,
      payments: [expect.objectContaining({ source: "private", amount_cents: 11_900 })],
    });
  });
});
