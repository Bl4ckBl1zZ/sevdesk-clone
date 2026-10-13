import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { createValues, orgForm, productForm, setupCatalog } from "./catalog.fixtures";
import { makeT } from "./test.setup";

async function reasonOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const d = (e as { data?: { reason?: string; code?: string } }).data;
    return d?.reason ?? d?.code;
  }
}

const page = { numItems: 25, cursor: null };

describe("products via REST/MCP (05 §4.2, F03 §7)", () => {
  test("API-018 list returns the price views of today; filters by active and type", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const g = await owner.mutation(api.products.create, {
      values: productForm("Kabel", { type: "good", unitCode: "C62" }),
    });
    await owner.mutation(api.products.archive, { id: g.id });
    const key = await t.asApiKey(["products:read"]);
    const active = await key.query(api.productsApi.list, { paginationOpts: page, active: true });
    expect(active.page.map((r) => r.product._id)).toEqual([p.id]);
    expect(active.page[0]?.today).toEqual({ netMicros: 950_000, grossMicros: 1_130_500, rateBp: 1900 });
    const goods = await key.query(api.productsApi.list, { paginationOpts: page, type: "good" });
    expect(goods.page.map((r) => r.product._id)).toEqual([g.id]);
  });

  test("API-015 PATCH changes only the given fields and checks the version", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const key = await t.asApiKey(["products:read", "products:write"]);
    await key.mutation(api.productsApi.patch, { id: p.id, version: 1, values: { price: "99,00" } });
    const got = await key.query(api.productsApi.get, { id: p.id });
    expect(got?.product).toMatchObject({ name: "Beratung", unitPriceMicros: 990_000, version: 2 });
    expect(await reasonOf(key.mutation(api.productsApi.patch, { id: p.id, version: 1, values: {} }))).toBe(
      "VERSION_CONFLICT",
    );
    expect(await key.query(api.productsApi.get, { id: "nonsense" })).toBeNull();
  });

  test("API-018 resolvePrice applies the customer price of the contact (PRD-032)", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const c = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Kunde GmbH")) });
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: p.id,
      values: { contactId: c.id, price: "80,00", priceMode: "net", validFrom: "" },
    });
    const key = await t.asApiKey(["products:read"]);
    const base = await key.query(api.productsApi.resolvePrice, { id: p.id, date: "2026-10-12" });
    expect(base).toMatchObject({ unitPriceMicros: 950_000, source: "base", rateBp: 1900 });
    const customer = await key.query(api.productsApi.resolvePrice, { id: p.id, contactId: c.id });
    expect(customer).toMatchObject({ unitPriceMicros: 800_000, source: "customer" });
    expect(await reasonOf(key.query(api.productsApi.resolvePrice, { id: p.id, unitCode: "XYZ" }))).toBe("UNIT_INVALID");
  });

  test("API-018 categories come with their path", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await owner.mutation(api.products.saveCategory, { values: { name: "Dienstleistungen", parentId: "" } });
    const key = await t.asApiKey(["products:read"]);
    const cats = await key.query(api.productsApi.categories, {});
    expect(cats.map((c) => c.path)).toEqual(["Dienstleistungen"]);
  });
});
