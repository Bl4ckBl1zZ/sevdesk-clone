import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { CONTACT_RANGE, PRODUCT_RANGE, productForm } from "../../convex/catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, settle, setupInvoicing } from "../../convex/invoices.fixtures";
import type { TestT } from "../../convex/test.setup";
import { apiTest, call } from "./harness";

/**
 * 05 §4.3 / F04 §7.1 sales documents over REST, the paths documents.test.ts leaves out: product lines, list filters,
 * PATCH guards, partial conversions with line quantities and optional lines, and the optional fields of the quote
 * acceptance, rejection and revision.
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
  return { t, s, key, contact: `con_${personId}` };
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
const chair = { name: "Stuhl", quantity: "4", unit_price: "100", product_type: "good", vat_rate_key: "standard" };

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
    headers: { "Idempotency-Key": `fin-v-${++idem}` },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  await settle(t);
  return json(res);
}

describe("REST sales documents – variants (05 §4.3, F04 §7.1)", () => {
  test("DOC-05 DOC-06 a product line takes name, price, unit and tax key from the product; an unknown product ID → 422", async () => {
    const { s, key, contact } = await setup();
    const product = await s.owner.mutation(api.products.create, {
      values: productForm("Wartungspauschale", { price: "95,00" }),
    });
    const prd = `prd_${product.id}`;
    const draft = await create(key, "invoices", {
      contact_id: contact,
      supply_date: { kind: "date", date: "2026-10-09" },
      lines: [{ kind: "item", product_id: prd, quantity: "2" }],
    });
    expect(draft.lines[0]).toMatchObject({
      name: "Wartungspauschale",
      product_id: prd,
      quantity: "2.000",
      unit_price: "95.0000",
      net_cents: 19_000,
    });
    // PATCH with a product line resolves the product the same way (contact and document date from the draft).
    const patched = await call("PATCH", `/invoices/${draft.id}`, {
      key,
      body: { version: draft.version, lines: [{ kind: "item", product_id: prd, quantity: "3" }] },
    });
    expect(patched.status, JSON.stringify(await patched.clone().json())).toBe(200);
    expect((await json(patched)).totals.net_cents).toBe(28_500);

    const unknown = await call("POST", "/invoices", {
      key,
      body: { contact_id: contact, lines: [{ kind: "item", product_id: "con_123", quantity: "1" }] },
    });
    expect(unknown.status).toBe(422);
    expect((await json(unknown)).errors).toEqual([expect.objectContaining({ field: "lines[0].product_id" })]);
  });

  test("API-011 DOC-37 a contact ID with a foreign prefix is refused on create and yields an empty list as a filter", async () => {
    const { key, contact } = await setup();
    const bad = await call("POST", "/quotes", { key, body: { contact_id: "prd_1234567890abcdef", lines: [desk] } });
    expect(bad.status).toBe(422);
    expect((await json(bad)).errors).toEqual([expect.objectContaining({ field: "contact_id" })]);

    const q = await create(key, "quotes", { contact_id: contact, lines: [desk] });
    const list = async (query: string) => (await json(await call("GET", `/quotes${query}`, { key }))).data;
    expect((await list("")).map((d: Json) => d.id)).toEqual([q.id]);
    expect((await list(`?contact_id=${contact}`)).map((d: Json) => d.id)).toEqual([q.id]);
    expect(await list("?contact_id=prd_1234567890abcdef")).toEqual([]);
    expect((await list("?status=draft")).map((d: Json) => d.id)).toEqual([q.id]);
    expect(await list("?status=finalized")).toEqual([]);
  });

  test("API-021 PATCH on a document of another resource is 404; a finalised one is immutable", async () => {
    const { t, key, contact } = await setup();
    const quote = await create(key, "quotes", { contact_id: contact, lines: [desk] });
    const inv = await create(key, "invoices", {
      contact_id: contact,
      lines: [desk],
      supply_date: { kind: "date", date: "2026-10-09" },
    });
    // The quote's raw ID under the order-confirmation prefix: the document exists, but not as this resource.
    const foreign = await call("PATCH", `/order-confirmations/${quote.id.replace("quo_", "ord_")}`, {
      key,
      body: { version: quote.version, subject: "x" },
    });
    expect(foreign.status).toBe(404);
    const typeChange = await call("PATCH", `/invoices/${inv.id}`, {
      key,
      body: { version: inv.version, invoice_type: "proforma" },
    });
    expect(typeChange.status).toBe(422);
    expect((await json(typeChange)).errors[0]).toMatchObject({ field: "invoice_type" });
    const done = await finalize(t, key, "invoices", inv);
    const frozen = await call("PATCH", `/invoices/${done.id}`, { key, body: { version: done.version, subject: "x" } });
    expect(frozen.status).toBe(409);
    expect((await json(frozen)).code).toBe("immutable_record");
  });

  test("DOC-33 QUO-02 QUO-10 partial conversion by line quantities with an optional line; invalid line IDs → 422", async () => {
    const { t, key, contact } = await setup();
    const quote = await finalize(
      t,
      key,
      "quotes",
      await create(key, "quotes", { contact_id: contact, lines: [desk, { ...chair, optional: true }] }),
    );
    await call("POST", `/quotes/${quote.id}/mark-accepted`, {
      key,
      body: { date: "2026-10-12", accepted_by: "Max Beispiel", channel: "phone", note: "telefonisch zugesagt" },
    });
    const [deskLine, chairLine] = quote.lines;

    const badLine = await call("POST", `/quotes/${quote.id}/convert`, {
      key,
      body: { to: "order_confirmation", mode: "quantities", lines: [{ source_line_id: "nope", quantity: "1" }] },
    });
    expect(badLine.status).toBe(422);
    expect((await json(badLine)).errors[0]).toMatchObject({ field: "lines[0]" });
    const badOptional = await call("POST", `/quotes/${quote.id}/convert`, {
      key,
      body: { to: "order_confirmation", optional_line_ids: ["nope"] },
    });
    expect(badOptional.status).toBe(422);
    expect((await json(badOptional)).errors[0]).toMatchObject({ field: "optional_line_ids[0]" });
    const notesOnQuote = await call("POST", `/quotes/${quote.id}/convert`, {
      key,
      body: { to: "invoice", delivery_note_ids: ["dln_1234567890abcdef"] },
    });
    expect(notesOnQuote.status).toBe(422);
    expect((await json(notesOnQuote)).errors[0]).toMatchObject({ field: "delivery_note_ids" });

    const res = await call("POST", `/quotes/${quote.id}/convert`, {
      key,
      body: {
        to: "order_confirmation",
        mode: "quantities",
        // In "quantities" mode an unlisted line is not taken over; a chosen optional line needs its quantity too.
        lines: [
          { source_line_id: deskLine.id, quantity: "4" },
          { source_line_id: chairLine.id, quantity: "2" },
        ],
        optional_line_ids: [chairLine.id],
      },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const { document } = await json(res);
    expect(document).toMatchObject({ type: "order_confirmation", origin_id: quote.id });
    const items = document.lines.filter((l: Json) => l.kind === "item");
    expect(items.map((l: Json) => [l.name, l.quantity])).toEqual([
      ["Schreibtisch", "4.000"],
      ["Stuhl", "2.000"],
    ]);
  });

  test("QUO-11 a collective invoice refuses a non-delivery-note ID in delivery_note_ids", async () => {
    const { t, key, contact } = await setup();
    const note = await finalize(
      t,
      key,
      "delivery-notes",
      await create(key, "delivery-notes", {
        contact_id: contact,
        lines: [desk],
        supply_date: { kind: "date", date: "2026-10-05" },
      }),
    );
    const res = await call("POST", `/delivery-notes/${note.id}/convert`, {
      key,
      body: { to: "invoice", delivery_note_ids: ["quo_1234567890abcdef"] },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).errors[0]).toMatchObject({ field: "delivery_note_ids[0]" });
    const wrongTarget = await call("POST", `/delivery-notes/${note.id}/convert`, {
      key,
      body: { to: "order_confirmation", delivery_note_ids: [note.id] },
    });
    expect(wrongTarget.status).toBe(422);
    expect((await json(wrongTarget)).errors[0]).toMatchObject({ field: "delivery_note_ids" });
  });

  test("QUO-05 QUO-06 late acceptance of an expired quote, rejection without reason, revision without reason", async () => {
    const { t, key, contact } = await setup();
    const quote = await finalize(t, key, "quotes", await create(key, "quotes", { contact_id: contact, lines: [desk] }));
    vi.setSystemTime(new Date("2026-12-20T10:00:00Z")); // valid_until 2026-11-11 has passed
    const late = await call("POST", `/quotes/${quote.id}/mark-accepted`, {
      key,
      body: { date: "2026-12-20", accepted_by: "Max Beispiel", channel: "email", late: true, note: "verspätet" },
    });
    expect(late.status, JSON.stringify(await late.clone().json())).toBe(200);
    expect(await json(late)).toMatchObject({
      status: "accepted",
      acceptance: { date: "2026-12-20", accepted_by: "Max Beispiel", channel: "email" },
    });

    const other = await finalize(
      t,
      key,
      "quotes",
      await create(key, "quotes", { contact_id: contact, lines: [chair] }),
    );
    const rejected = await call("POST", `/quotes/${other.id}/mark-rejected`, { key, body: { date: "2026-12-20" } });
    expect(rejected.status).toBe(200);
    expect((await json(rejected)).rejection).toMatchObject({ date: "2026-12-20" });
    const revised = await call("POST", `/quotes/${other.id}/revise`, { key, body: {} });
    expect(revised.status).toBe(201);
    expect(await json(revised)).toMatchObject({ status: "draft", revision: 2, origin_id: other.id });
  });
});
