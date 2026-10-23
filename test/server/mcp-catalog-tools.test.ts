import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";
import { setupCatalog } from "../../convex/catalog.fixtures";
import type { TestT } from "../../convex/test.setup";
import type { Scope } from "../../src/domain/schemas/scopes";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { apiTest } from "./harness";

/**
 * 06 §3.2 / F02 §7.2 / F03 §7 contact and product MCP tools beyond mcp.test.ts: search filters, upsert by id (version,
 * validation), addresses, channels, notes, customer prices and price resolution, categories and archiving.
 */

let restore: (() => void) | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  restore?.();
  restore = undefined;
});

const MCP_URL = "https://api.test.local/api/mcp";
async function connect(t: TestT, scopes: Scope[]): Promise<Client> {
  const { key } = await t.asMcp(scopes);
  const client = new Client({ name: "vitest", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => handleMcpRequest(new Request(input as string | URL, init as RequestInit)),
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed tool output in assertions
type Json = Record<string, any>;
type ToolCall = { isError?: boolean; structuredContent?: Json; content: { text?: string }[] };
const errorOf = (r: ToolCall) => JSON.parse(r.content[0]?.text ?? "{}").error as { code: string; hint?: string };

async function tool(client: Client, name: string, args: Json): Promise<ToolCall> {
  return (await client.callTool({ name, arguments: args })) as ToolCall;
}
async function ok(client: Client, name: string, args: Json): Promise<Json> {
  const r = await tool(client, name, args);
  expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
  return r.structuredContent as Json;
}

async function setup(scopes: Scope[]) {
  const h = apiTest();
  restore = h.restore;
  await setupCatalog(h.t);
  return { t: h.t, client: await connect(h.t, scopes) };
}

const ORG = {
  kind: "organization",
  organization_name: "Beispiel Bau GmbH",
  roles: ["customer", "supplier"],
  channels: [{ type: "email", value: "info@bau.example", is_primary: true }],
  billing_address: { street: "Hauptstr. 1", postal_code: "10115", city: "Berlin", country_code: "DE" },
};

describe("MCP contact tools (06 §3.2)", () => {
  test("MCP-007 CON-004 contact_search filters by role, status, e-mail and number and returns city and primary e-mail", async () => {
    const { client } = await setup(["contacts:read", "contacts:write"]);
    const created = await ok(client, "contact_upsert", { contact: ORG });
    await ok(client, "contact_upsert", {
      contact: { kind: "person", last_name: "Muster", first_name: "Max", roles: ["prospect"] },
    });
    const number = created.contact.number as string;

    const byRole = await ok(client, "contact_search", { role: "supplier" });
    expect(byRole.data).toEqual([
      expect.objectContaining({ name: "Beispiel Bau GmbH", city: "Berlin", email: "info@bau.example" }),
    ]);
    expect((await ok(client, "contact_search", { email: "info@bau.example" })).data).toHaveLength(1);
    expect((await ok(client, "contact_search", { number })).data).toHaveLength(1);
    expect((await ok(client, "contact_search", { status: "archived" })).data).toEqual([]);
    expect((await ok(client, "contact_search", { vat_id: "DE999999999" })).data).toEqual([]);
    const page = await ok(client, "contact_search", { status: "all", limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toEqual(expect.any(String));
    const rest = await ok(client, "contact_search", { status: "all", limit: 1, cursor: page.next_cursor });
    expect(rest.data[0].id).not.toBe(page.data[0].id);
  });

  test("MCP-010 CON-007 contact_upsert with id needs a version, validates the fields and patches", async () => {
    const { client } = await setup(["contacts:read", "contacts:write"]);
    const { contact } = await ok(client, "contact_upsert", { contact: ORG });

    const noVersion = await tool(client, "contact_upsert", { id: contact.id, contact: { notes: "neu" } });
    expect(noVersion.isError).toBe(true);
    expect(errorOf(noVersion).code).toBe("validation_failed");
    expect(noVersion.content[0]?.text).toContain("version_required");

    const badField = await tool(client, "contact_upsert", {
      id: contact.id,
      version: contact.version,
      contact: { payment_terms: { due_days: -1 } },
    });
    expect(badField.isError).toBe(true);
    expect(errorOf(badField).code).toBe("validation_failed");

    const badCreate = await tool(client, "contact_upsert", { contact: { kind: "spaceship" } });
    expect(errorOf(badCreate).code).toBe("validation_failed");

    const patched = await ok(client, "contact_upsert", {
      id: contact.id,
      version: contact.version,
      contact: { notes: "Stammkunde seit 2020" },
    });
    expect(patched).toMatchObject({
      matched_existing: true,
      contact: { id: contact.id, notes: "Stammkunde seit 2020" },
    });
    const stale = await tool(client, "contact_upsert", {
      id: contact.id,
      version: contact.version,
      contact: { notes: "x" },
    });
    expect(stale.isError).toBe(true);
  });

  test("MCP-007 CON-020 CON-030 address, channel and task are added to a visible contact; an unknown contact is not_found", async () => {
    const { client } = await setup(["contacts:read", "contacts:write"]);
    const { contact } = await ok(client, "contact_upsert", { contact: ORG });

    const address = await ok(client, "contact_add_address", {
      id: contact.id,
      type: "delivery",
      is_default: true,
      address: { name: "Baustelle Nord", street: "Werkstr. 5", postal_code: "20095", city: "Hamburg" },
    });
    expect(address.address_id).toMatch(/^adr_/);
    expect(address.contact.addresses).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "delivery", is_default: true })]),
    );
    const plain = await ok(client, "contact_add_address", {
      id: contact.id,
      type: "other",
      address: { street: "Nebenweg 2", postal_code: "10117", city: "Berlin" },
    });
    expect(plain.contact.addresses).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "other", street: "Nebenweg 2", city: "Berlin" })]),
    );

    const channel = await ok(client, "contact_add_channel", {
      id: contact.id,
      channel: { type: "phone", value: "+49 30 123456", label: "Zentrale" },
    });
    expect(channel.contact.channels).toEqual(expect.arrayContaining([expect.objectContaining({ type: "phone" })]));

    const task = await ok(client, "contact_add_note", {
      id: contact.id,
      kind: "task",
      text: "Angebot nachfassen",
      due_on: "2026-11-02",
    });
    expect(task.activity_id).toEqual(expect.any(String));
    const note = await ok(client, "contact_add_note", { id: contact.id, kind: "note", text: "Rückruf erwünscht" });
    expect(note.activity_id).toEqual(expect.any(String));

    const unknown = "con_k57f3x2m9q8w1e4r6t";
    for (const [name, args] of [
      ["contact_add_address", { id: unknown, type: "billing", address: { city: "Berlin" } }],
      ["contact_add_channel", { id: unknown, channel: { type: "email", value: "a@b.de" } }],
      ["contact_add_note", { id: unknown, kind: "note", text: "x" }],
    ] as const) {
      expect(errorOf(await tool(client, name, args)).code, name).toBe("not_found");
    }
  });

  test("MCP-007 CON-004 contact_archive archives (reversible) and the contact leaves the active search", async () => {
    const { client } = await setup(["contacts:read", "contacts:write"]);
    const { contact } = await ok(client, "contact_upsert", { contact: ORG });
    const archived = await ok(client, "contact_archive", { id: contact.id });
    expect(archived.status).toBe("archived");
    expect((await ok(client, "contact_search", {})).data).toEqual([]);
    expect((await ok(client, "contact_search", { status: "archived" })).data).toHaveLength(1);
    expect((await ok(client, "contact_find_duplicates", {})).data).toEqual([]);
  });
});

describe("MCP product tools (06 §3.3)", () => {
  test("MCP-007 PRD-032 a customer price wins in product_resolve_price; the base price applies to others", async () => {
    const { client } = await setup(["contacts:read", "contacts:write", "products:read", "products:write"]);
    const { product } = await ok(client, "product_upsert", {
      product: { name: "Wartung", unit_price: "100.00", unit_code: "HUR" },
    });
    const { contact } = await ok(client, "contact_upsert", { contact: ORG });

    const set = await ok(client, "product_set_customer_price", {
      id: product.id,
      contact_id: contact.id,
      unit_price: "80.00",
      price_mode: "net",
      valid_from: "2026-01-01",
    });
    expect(set.customer_price_id).toEqual(expect.any(String));
    const plainPrice = await ok(client, "product_set_customer_price", {
      id: product.id,
      contact_id: contact.id,
      unit_price: "85.5",
    });
    expect(plainPrice.customer_price_id).not.toBe(set.customer_price_id);

    const forCustomer = await ok(client, "product_resolve_price", {
      id: product.id,
      contact_id: contact.id,
      date: "2026-10-12",
      unit_code: "HUR",
      price_mode: "net",
    });
    expect(forCustomer).toMatchObject({
      source: expect.stringMatching(/customer/),
      price_mode: "net",
      unit_code: "HUR",
    });
    expect(["80.0000", "85.5000"]).toContain(forCustomer.unit_price);
    const base = await ok(client, "product_resolve_price", { id: product.id });
    expect(base).toMatchObject({ unit_price: "100.0000", unit_price_micros: 1_000_000 });

    const unknownContact = await tool(client, "product_set_customer_price", {
      id: product.id,
      contact_id: "con_k57f3x2m9q8w1e4r6t",
      unit_price: "1.00",
    });
    expect(errorOf(unknownContact).code).toBe("not_found");
  });

  test("MCP-010 PRD-001 product_upsert with id needs a version and validates; search by type and archived", async () => {
    const { client } = await setup(["products:read", "products:write"]);
    const { product } = await ok(client, "product_upsert", {
      product: { name: "Kabel", unit_price: "2.50", unit_code: "C62", type: "good" },
    });
    await ok(client, "product_upsert", { product: { name: "Beratung", unit_price: "120.00", unit_code: "HUR" } });

    const noVersion = await tool(client, "product_upsert", { id: product.id, product: { name: "Kabel 2" } });
    expect(noVersion.content[0]?.text).toContain("version_required");
    const badField = await tool(client, "product_upsert", {
      id: product.id,
      version: 1,
      product: { unit_price: "abc" },
    });
    expect(errorOf(badField).code).toBe("validation_failed");
    const badCreate = await tool(client, "product_upsert", { product: { unit_price: "1.00" } });
    expect(errorOf(badCreate).code).toBe("validation_failed");

    const got = await ok(client, "product_get", { id: product.id });
    const patched = await ok(client, "product_upsert", {
      id: product.id,
      version: got.version,
      product: { name: "Kabel 3 m" },
    });
    expect(patched).toMatchObject({ created: false, product: { name: "Kabel 3 m" } });

    const goods = await ok(client, "product_search", { type: "good" });
    expect(goods.data.map((p: Json) => p.name)).toEqual(["Kabel 3 m"]);
    const first = await ok(client, "product_search", { limit: 1 });
    expect(first.next_cursor).toEqual(expect.any(String));

    await ok(client, "product_archive", { id: product.id });
    expect((await ok(client, "product_search", { query: "Kabel" })).data).toEqual([]);
    expect((await ok(client, "product_search", { query: "Kabel", include_archived: true })).data).toHaveLength(1);
    expect((await ok(client, "product_list_categories", {})).data).toEqual(expect.any(Array));
  });
});
