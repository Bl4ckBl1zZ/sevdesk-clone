import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { CONTACT_RANGE, PRODUCT_RANGE } from "../../convex/catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { apiTest, call } from "./harness";

/**
 * 05 §4.3 / F04 §7.1 sales documents over REST: quotes, order confirmations, delivery notes and invoices incl.
 * proforma — drafts, finalisation (Idempotency-Key), acceptance, revisions, conversions and the chain.
 */

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

const range = (key: string, name: string, prefix: string) => ({
  key,
  name,
  format: `${prefix}-{YYYY}-{####}`,
  resetPolicy: "yearly",
  next: 1,
});

async function setup() {
  const h = apiTest();
  restore = h.restore;
  const t = h.t;
  const s = await setupInvoicing(t);
  await s.owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        CONTACT_RANGE,
        PRODUCT_RANGE,
        INVOICE_RANGE,
        range("quote", "Angebote", "AN"),
        range("order_confirmation", "Auftragsbestätigungen", "AB"),
        range("delivery_note", "Lieferscheine", "LS"),
        range("proforma", "Proforma", "PF"),
      ],
    },
  });
  const { personId } = await b2bBuyer(s.owner);
  const key = (await t.asApiKey(["documents:read", "documents:write", "invoices:finalize"])).key;
  return { t, key, contact: `con_${personId}` };
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON responses in assertions
type Json = Record<string, any>;
const json = async (res: Response) => (await res.json()) as Json;

const desk = {
  name: "Schreibtisch",
  quantity: "10",
  unit_price: "500",
  product_type: "good",
  vat_rate_key: "standard",
};

async function create(key: string, path: string, body: Json) {
  const res = await call("POST", `/${path}`, { key, body });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return json(res);
}

let idem = 0;
async function finalize(t: TestT, key: string, path: string, doc: Json) {
  const res = await call("POST", `/${path}/${doc.id}/finalize`, {
    key,
    body: { version: doc.version },
    headers: { "Idempotency-Key": `fin-${++idem}` },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  await settle(t);
  return json(res);
}

describe("REST sales documents (05 §4.3, F04 §7.1)", () => {
  test("API-021 QUO-01 QUO-05 DOC-33 QUO-12 quote → mark-accepted → convert → finalised invoice; the chain shows 100 %", async () => {
    const { t, key, contact } = await setup();
    const quote = await create(key, "quotes", { contact_id: contact, lines: [desk], delivery_terms: "frei Haus" });
    expect(quote).toMatchObject({
      type: "quote",
      status: "draft",
      number: null,
      delivery_terms: "frei Haus",
      totals: { net_cents: 500_000, vat_cents: 95_000, gross_cents: 595_000 },
      validation: { can_finalize: true, errors: [] },
      lines: [{ kind: "item", name: "Schreibtisch", quantity: "10.000", unit_price: "500.0000", net_cents: 500_000 }],
    });
    expect(quote.id).toMatch(/^quo_/);

    const noKey = await call("POST", `/quotes/${quote.id}/finalize`, { key, body: { version: quote.version } });
    expect(noKey.status).toBe(400);
    expect((await json(noKey)).code).toBe("idempotency_key_required");
    const final = await finalize(t, key, "quotes", quote);
    expect(final).toMatchObject({ number: "AN-2026-0001", status: "finalized", valid_until: "2026-11-11" });
    expect(final.payment_status).toBeNull();

    const notAccepted = await call("POST", `/quotes/${quote.id}/convert`, { key, body: { to: "invoice" } });
    expect(notAccepted.status).toBe(409);
    expect((await json(notAccepted)).errors[0].code).toBe("quote_not_accepted");

    const accepted = await call("POST", `/quotes/${quote.id}/mark-accepted`, {
      key,
      body: { date: "2026-10-12", accepted_by: "Max Beispiel", channel: "email" },
    });
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toMatchObject({
      status: "accepted",
      acceptance: { date: "2026-10-12", accepted_by: "Max Beispiel", channel: "email" },
    });

    const converted = await call("POST", `/quotes/${quote.id}/convert`, { key, body: { to: "invoice" } });
    expect(converted.status).toBe(201);
    const { document: invoice } = await json(converted);
    expect(invoice).toMatchObject({ type: "invoice", invoice_type: "standard", status: "draft", origin_id: quote.id });
    expect(invoice.id).toMatch(/^inv_/);
    expect(invoice.lines[0].source_line_id).toBe(final.lines[0].id);
    expect(converted.headers.get("Location")).toBe(`/api/v1/invoices/${invoice.id}`);

    const patched = await call("PATCH", `/invoices/${invoice.id}`, {
      key,
      body: { supply_date: { kind: "date", date: "2026-10-09" }, version: invoice.version },
    });
    expect(patched.status, JSON.stringify(await patched.clone().json())).toBe(200);
    const done = await finalize(t, key, "invoices", await json(patched));
    expect(done).toMatchObject({ status: "finalized", payment_status: "open", open_amount_cents: 595_000 });

    const withChain = await json(await call("GET", `/quotes/${quote.id}?expand=chain`, { key }));
    expect(withChain.status).toBe("invoiced");
    expect(withChain.chain.invoiced_percent).toBe(100);
    expect(withChain.chain.data.map((d: Json) => d.type)).toEqual(["quote", "invoice"]);
    const chain = await json(await call("GET", `/quotes/${quote.id}/chain`, { key }));
    expect(chain.data).toHaveLength(2);
  });

  test("QUO-06 POST /quotes/{id}/revise creates version 2; finalising it supersedes the old quote", async () => {
    const { t, key, contact } = await setup();
    const quote = await finalize(t, key, "quotes", await create(key, "quotes", { contact_id: contact, lines: [desk] }));
    const rejected = await call("POST", `/quotes/${quote.id}/mark-rejected`, {
      key,
      body: { date: "2026-10-12", reason: "zu teuer" },
    });
    expect((await json(rejected)).rejection).toEqual({ date: "2026-10-12", reason: "zu teuer" });
    const revised = await call("POST", `/quotes/${quote.id}/revise`, { key, body: { reason: "Preis gesenkt" } });
    expect(revised.status).toBe(201);
    const v2 = await json(revised);
    expect(v2).toMatchObject({ status: "draft", revision: 2, origin_id: quote.id });
    const patched = await json(
      await call("PATCH", `/quotes/${v2.id}`, {
        key,
        headers: { "If-Match": String(v2.version) },
        body: { lines: [{ ...desk, unit_price: "450" }] },
      }),
    );
    expect(patched.totals.net_cents).toBe(450_000);
    expect((await finalize(t, key, "quotes", patched)).number).toBe("AN-2026-0001-V2");
    expect((await json(await call("GET", `/quotes/${quote.id}`, { key }))).status).toBe("superseded");
    const finalized = await call("PATCH", `/quotes/${quote.id}`, { key, body: { subject: "x", version: 1 } });
    expect(finalized.status).toBe(409);
    expect((await json(finalized)).code).toBe("immutable_record");
  });

  test("QUO-09 QUO-11 delivery notes without prices, „Erhalten“ and the collective invoice", async () => {
    const { t, key, contact } = await setup();
    const note = (date: string) =>
      create(key, "delivery-notes", { contact_id: contact, lines: [desk], supply_date: { kind: "date", date } });
    const a = await finalize(t, key, "delivery-notes", await note("2026-10-05"));
    const b = await finalize(t, key, "delivery-notes", await note("2026-10-08"));
    expect(a).toMatchObject({ number: "LS-2026-0001", show_prices: false });
    expect(a.id).toMatch(/^dln_/);
    const received = await call("POST", `/delivery-notes/${a.id}/mark-received`, {
      key,
      body: { date: "2026-10-06", received_by: "Lager Müller" },
    });
    expect((await json(received)).received).toEqual({ date: "2026-10-06", received_by: "Lager Müller" });
    const collective = await call("POST", `/delivery-notes/${a.id}/convert`, {
      key,
      body: { to: "invoice", delivery_note_ids: [b.id] },
    });
    expect(collective.status, JSON.stringify(await collective.clone().json())).toBe(201);
    const { document: invoice } = await json(collective);
    expect(invoice.source_document_ids.sort()).toEqual([a.id, b.id].sort());
    expect(invoice.lines.filter((l: Json) => l.kind === "item")).toHaveLength(2);
    const wrong = await call("POST", `/quotes/${a.id.replace("dln_", "quo_")}/convert`, {
      key,
      body: { to: "invoice" },
    });
    expect(wrong.status).toBe(404);
  });

  test("DOC-25 proforma under /invoices with invoice_type=proforma: own range, no receivable, own list filter", async () => {
    const { t, key, contact } = await setup();
    const draft = await create(key, "invoices", {
      contact_id: contact,
      invoice_type: "proforma",
      lines: [desk],
      supply_date: { kind: "date", date: "2026-10-09" },
    });
    expect(draft).toMatchObject({ type: "proforma", invoice_type: "proforma" });
    const pf = await finalize(t, key, "invoices", draft);
    expect(pf).toMatchObject({ number: "PF-2026-0001", payment_status: null, open_amount_cents: null });
    const proformas = await json(await call("GET", "/invoices?invoice_type=proforma", { key }));
    expect(proformas.data.map((d: Json) => d.id)).toEqual([pf.id]);
    const standard = await json(await call("GET", "/invoices", { key }));
    expect(standard.data).toHaveLength(0);
    const typeChange = await call("PATCH", `/invoices/${pf.id}`, {
      key,
      body: { invoice_type: "standard", version: 1 },
    });
    expect(typeChange.status).toBe(409);
    const withdrawn = await call("POST", `/invoices/${pf.id}/withdraw`, { key, body: { reason: "Kunde storniert" } });
    expect(withdrawn.status).toBe(200);
    expect((await json(withdrawn)).status).toBe("cancelled");
  });

  test("API-011 API-021 DOC-03 wire validation, prefixes, and documents:write for finalising letters", async () => {
    const { t, key, contact } = await setup();
    const tooPrecise = await call("POST", "/quotes", {
      key,
      body: { contact_id: contact, lines: [{ ...desk, quantity: "1.2345" }] },
    });
    expect(tooPrecise.status).toBe(422);
    expect((await json(tooPrecise)).errors[0].field).toBe("lines[0].quantity");
    const wrongType = await call("POST", "/quotes", {
      key,
      body: { contact_id: contact, invoice_type: "proforma", lines: [] },
    });
    expect(wrongType.status).toBe(422);
    expect((await json(wrongType)).errors[0].field).toBe("invoice_type");
    const draft = await create(key, "order-confirmations", { contact_id: contact, lines: [desk] });
    expect(draft.id).toMatch(/^ord_/);
    expect((await call("GET", `/quotes/${draft.id}`, { key })).status).toBe(404);
    expect((await call("GET", `/order-confirmations/${draft.id.replace("ord_", "quo_")}`, { key })).status).toBe(404);
    const finalizeOnly = (await t.asApiKey(["documents:read", "invoices:finalize"])).key;
    const forbidden = await call("POST", `/order-confirmations/${draft.id}/finalize`, {
      key: finalizeOnly,
      body: { version: draft.version },
      headers: { "Idempotency-Key": "fin-scope" },
    });
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).code).toBe("insufficient_scope");
    const del = await call("DELETE", `/order-confirmations/${draft.id}`, { key });
    expect(del.status).toBe(204);
    expect((await call("GET", `/order-confirmations/${draft.id}`, { key })).status).toBe(404);
  });
});
