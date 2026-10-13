import { afterEach, describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { setupCatalog } from "../../convex/catalog.fixtures";
import type { TestT } from "../../convex/test.setup";
import { emptyAddress, emptyContactForm } from "../../src/domain/schemas/contacts";
import { apiTest, call } from "./harness";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function setup() {
  const h = apiTest();
  restore = h.restore;
  return h.t;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function keyFor(t: TestT, scopes: Parameters<TestT["asApiKey"]>[0], opts = {}) {
  return (await t.asApiKey(scopes, opts)).key;
}

describe("REST pipeline (05 §3, §7)", () => {
  test("API-004 API-009 no key → 401 problem+json with WWW-Authenticate; a key in the query → 400", async () => {
    const t = setup();
    const res = await call("GET", "/contacts");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = await json(res);
    expect(body).toMatchObject({
      type: "https://api.test.local/problems/unauthorized",
      status: 401,
      code: "unauthorized",
      title: expect.any(String),
      request_id: res.headers.get("x-request-id"),
    });
    const key = await keyFor(t, ["contacts:read"]);
    const inQuery = await call("GET", `/contacts?api_key=${key}`, { key });
    expect(inQuery.status).toBe(400);
    expect((await json(inQuery)).code).toBe("key_in_query_not_allowed");
    const garbage = await call("GET", "/contacts", { key: "sk_live_nope" });
    expect(garbage.status).toBe(401);
  });

  test("API-003 revoked and expired keys are refused with 401", async () => {
    const t = setup();
    const revoked = await keyFor(t, ["contacts:read"], { revokedAt: Date.now() - 1 });
    expect((await call("GET", "/me", { key: revoked })).status).toBe(401);
    const expired = await keyFor(t, ["contacts:read"], { expiresAt: Date.now() - 1 });
    expect((await call("GET", "/me", { key: expired })).status).toBe(401);
  });

  test("API-005 a key without the scope gets 403 insufficient_scope with required_scope", async () => {
    const t = setup();
    const key = await keyFor(t, ["products:read"]);
    const res = await call("GET", "/contacts", { key });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: "insufficient_scope", required_scope: "contacts:read" });
  });

  test("API-009 X-Request-Id is echoed, English titles with Accept-Language: en, unknown routes 404, wrong method 405", async () => {
    const t = setup();
    const key = await keyFor(t, ["contacts:read"]);
    const res = await call("GET", "/nope", { key, headers: { "X-Request-Id": "abc-123", "Accept-Language": "en" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe("abc-123");
    expect(await json(res)).toMatchObject({ code: "not_found", title: "Not found.", request_id: "abc-123" });
    const wrong = await call("DELETE", "/me", { key });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });

  test("API-007 every response carries RateLimit-* headers; the burst is per key and answers 429 with Retry-After", async () => {
    const t = setup();
    const key = await keyFor(t, ["contacts:read"], { rateLimitPerMinute: 4 });
    const other = await keyFor(t, ["contacts:read"], { rateLimitPerMinute: 4 });
    const first = await call("GET", "/me", { key });
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-limit")).toBe("1");
    expect(first.headers.get("ratelimit-remaining")).toBe("0");
    const limited = await call("GET", "/me", { key });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await json(limited)).code).toBe("rate_limited");
    expect((await call("GET", "/me", { key: other })).status).toBe(200);
  });

  test("API-016 /health needs no key; /me returns the key's name, scopes and rate limit", async () => {
    const t = setup();
    const health = await call("GET", "/health");
    expect(health.status).toBe(200);
    expect(Object.keys(await json(health)).sort()).toEqual(["status", "version"]);
    const seeded = await t.asApiKey(["contacts:read", "products:read"], { name: "Website" });
    const me = await json(await call("GET", "/me", { key: seeded.key }));
    expect(me).toMatchObject({
      object: "api_key",
      id: seeded.prefix,
      name: "Website",
      scopes: ["contacts:read", "products:read"],
      rate_limit: { per_minute: 120, limit: 30 },
    });
  });

  test("API-008 each request is written to the access log (method, path, status, request id, code; no body)", async () => {
    const t = setup();
    const seeded = await t.asApiKey(["products:read"]);
    await call("GET", "/me", { key: seeded.key, headers: { "X-Request-Id": "r1" } });
    await call("GET", "/contacts", { key: seeded.key, headers: { "X-Request-Id": "r2" } });
    const rows = await t.run((ctx) => ctx.db.query("apiRequestLog").collect());
    expect(rows.map((r) => [r.method, r.target, r.status, r.requestId, r.code ?? null])).toEqual([
      ["GET", "/me", 200, "r1", null],
      ["GET", "/contacts", 403, "r2", "insufficient_scope"],
    ]);
  });
});

describe("contacts endpoints (05 §4.1)", () => {
  test("API-017 API-011 create → get → list round-trip with prefixed IDs and snake_case", async () => {
    const t = setup();
    await setupCatalog(t);
    const key = await keyFor(t, ["contacts:read", "contacts:write"]);
    const created = await call("POST", "/contacts", {
      key,
      body: {
        kind: "organization",
        organization_name: "Muster GmbH",
        payment_terms: { due_days: 14 },
        billing_address: { street: "Hauptstr. 1", postal_code: "10115", city: "Berlin", country_code: "DE" },
        channels: [{ type: "email", value: "info@muster.de", is_invoice_email: true }],
      },
    });
    expect(created.status).toBe(201);
    const c = await json(created);
    expect(c).toMatchObject({ object: "contact", organization_name: "Muster GmbH", payment_terms: { due_days: 14 } });
    expect(String(c.id)).toMatch(/^con_/);
    expect(created.headers.get("location")).toBe(`/api/v1/contacts/${c.id}`);
    const got = await json(await call("GET", `/contacts/${c.id}?expand=addresses,channels,vat_status`, { key }));
    expect((got.addresses as { city: string }[])[0]?.city).toBe("Berlin");
    expect((got.channels as { id: string }[])[0]?.id).toMatch(/^chn_/);
    expect(got.vat_status).toMatchObject({ status: "unchecked" });
    const list = await json(await call("GET", "/contacts?limit=10", { key }));
    expect((list.data as { id: string }[]).map((x) => x.id)).toEqual([c.id]);
    expect(list.next_cursor).toBeNull();
  });

  test("API-013 an unknown expand value is 400 invalid_expand; a foreign ID prefix is 404", async () => {
    const t = setup();
    const key = await keyFor(t, ["contacts:read"]);
    const bad = await call("GET", "/contacts?expand=secrets", { key });
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("invalid_expand");
    expect((await call("GET", "/contacts/prd_k57f3x2m9q8w1e4r6t", { key })).status).toBe(404);
    expect((await call("GET", "/contacts/con_k57f3x2m9q8w1e4r6t", { key })).status).toBe(404);
  });

  test("API-009 validation errors are 422 with snake_case fields from the shared schema", async () => {
    const t = setup();
    await setupCatalog(t);
    const key = await keyFor(t, ["contacts:write"]);
    const wire = await call("POST", "/contacts", { key, body: { kind: "organization", unknown_field: 1 } });
    expect(wire.status).toBe(422);
    const domain = await call("POST", "/contacts", {
      key,
      body: { kind: "organization", organization_name: "X GmbH", vat_id: "DE123456789" },
    });
    expect(domain.status).toBe(422);
    expect(await json(domain)).toMatchObject({
      code: "validation_failed",
      errors: [expect.objectContaining({ code: "vat_id_checksum", field: "vat_id" })],
    });
    const media = await call("POST", "/contacts", {
      key,
      rawBody: "kind=person",
      headers: { "Content-Type": "text/plain" },
    });
    expect(media.status).toBe(415);
  });

  test("API-015 PATCH needs a version; a stale version is 409 version_conflict", async () => {
    const t = setup();
    await setupCatalog(t);
    const key = await keyFor(t, ["contacts:read", "contacts:write"]);
    const c = await json(
      await call("POST", "/contacts", { key, body: { kind: "person", first_name: "Eva", last_name: "Muster" } }),
    );
    const noVersion = await call("PATCH", `/contacts/${c.id}`, { key, body: { notes: "x" } });
    expect(noVersion.status).toBe(422);
    expect((await json(noVersion)).errors).toEqual([expect.objectContaining({ field: "version" })]);
    const ok = await call("PATCH", `/contacts/${c.id}`, {
      key,
      body: { notes: "VIP" },
      headers: { "If-Match": '"1"' },
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ notes: "VIP", version: 2, last_name: "Muster" });
    const stale = await call("PATCH", `/contacts/${c.id}`, { key, body: { notes: "y", version: 1 } });
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("version_conflict");
  });

  test("API-017 POST ?match=email returns the existing contact (200) instead of a duplicate; ambiguous → 409", async () => {
    const t = setup();
    const owner = await setupCatalog(t);
    const key = await keyFor(t, ["contacts:read", "contacts:write"]);
    const body = {
      kind: "person",
      first_name: "Max",
      last_name: "Website",
      channels: [{ type: "email", value: "max@example.de" }],
    };
    const first = await call("POST", "/contacts?match=email", { key, body });
    expect(first.status).toBe(201);
    const again = await call("POST", "/contacts?match=email", { key, body: { ...body, notes: "zweite Anfrage" } });
    expect(again.status).toBe(200);
    const a = await json(first);
    expect(await json(again)).toMatchObject({ id: a.id, notes: "zweite Anfrage", meta: { matched_by: "email" } });
    await owner.mutation(api.contacts.create, {
      values: {
        contact: { ...emptyContactForm(), kind: "person", lastName: "Zwilling" },
        billingAddress: emptyAddress(),
        channels: [{ type: "email", value: "max@example.de", label: "", isPrimary: true, isInvoiceEmail: false }],
      },
    });
    const ambiguous = await call("POST", "/contacts?match=email", { key, body });
    expect(ambiguous.status).toBe(409);
    expect((await json(ambiguous)).code).toBe("upsert_ambiguous");
    expect((await call("POST", "/contacts?match=name", { key, body })).status).toBe(400);
  });

  test("API-010 Idempotency-Key replays the stored response; the same key with another body is 422", async () => {
    const t = setup();
    await setupCatalog(t);
    const key = await keyFor(t, ["contacts:read", "contacts:write"]);
    const body = { kind: "organization", organization_name: "Shop GmbH" };
    const headers = { "Idempotency-Key": "order-4711" };
    const first = await call("POST", "/contacts", { key, body, headers });
    const replay = await call("POST", "/contacts", { key, body, headers });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await json(replay)).toEqual(await json(first));
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(1);
    const conflict = await call("POST", "/contacts", { key, body: { ...body, organization_name: "Andere" }, headers });
    expect(conflict.status).toBe(422);
    expect((await json(conflict)).code).toBe("idempotency_key_reused");
  });

  test("API-017 archive and the audit trail name the API key as actor", async () => {
    const t = setup();
    await setupCatalog(t);
    const seeded = await t.asApiKey(["contacts:read", "contacts:write"]);
    const c = await json(
      await call("POST", "/contacts", { key: seeded.key, body: { kind: "organization", organization_name: "A GmbH" } }),
    );
    const archived = await json(await call("POST", `/contacts/${c.id}/archive`, { key: seeded.key }));
    expect(archived.status).toBe("archived");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((e) => e.actor === seeded.actor).map((e) => e.channel)).toContain("api");
  });
});

describe("products and settings endpoints (05 §4.2, §4.8)", () => {
  test("API-018 products: decimal-string prices in, integer micros and today's price block out", async () => {
    const t = setup();
    await setupCatalog(t);
    const key = await keyFor(t, ["products:read", "products:write"]);
    const created = await call("POST", "/products", {
      key,
      body: { name: "Beratung", unit_price: "95.00", unit_code: "HUR" },
    });
    expect(created.status).toBe(201);
    const p = await json(created);
    expect(p).toMatchObject({
      price: { mode: "net", unit_price: "95.0000", unit_price_micros: 950_000, gross_micros_today: 1_130_500 },
    });
    const patched = await json(
      await call("PATCH", `/products/${p.id}`, { key, body: { unit_price: "99.5", version: 1 } }),
    );
    expect(patched.price).toMatchObject({ unit_price: "99.5000" });
    const price = await json(await call("GET", `/products/${p.id}/price?date=2026-10-12`, { key }));
    expect(price).toMatchObject({ unit_price: "99.5000", source: "base", rate_bp: 1900 });
    const list = await json(await call("GET", "/products", { key }));
    expect((list.data as unknown[]).length).toBe(1);
    const bad = await call("POST", "/products", { key, body: { name: "X", unit_price: 1.5 } });
    expect(bad.status).toBe(422);
    expect((await json(bad)).errors).toEqual([expect.objectContaining({ field: "unit_price" })]);
  });

  test("API-019 settings reads: tax rates by date; the public company subset for company:public keys", async () => {
    const t = setup();
    const key = await keyFor(t, ["settings:read"]);
    const rates = await json(await call("GET", "/settings/tax-rates?date=2026-10-12", { key }));
    expect((rates.data as { key: string; rate_bp: number }[]).find((r) => r.key === "standard")?.rate_bp).toBe(1900);
    const pub = await keyFor(t, ["company:public"]);
    const missing = await call("GET", "/settings/company/public", { key: pub });
    expect(missing.status).toBe(409);
    expect((await json(missing)).code).toBe("setup_incomplete");
    expect((await call("GET", "/settings/company", { key: pub })).status).toBe(403);
    expect((await call("GET", "/settings/units", { key })).status).toBe(200);
  });
});
