import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, productForm } from "./catalog.fixtures";
import { invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { categoryPathOf, productsUsingUnit, seedCategories } from "./model/products";
import { makeT, type TestT } from "./test.setup";

/**
 * F03 products — list filters, optional product fields, customer-price and category guards, the scheduled-price
 * cron gate, import edge rows and the revenue-account check of convex/products.ts and convex/model/products.ts.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const page = { numItems: 50, cursor: null };
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const reasonOf = (e: unknown) => dataOf(e).reason;
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

async function setup(t: TestT) {
  const { owner } = await setupInvoicing(t);
  await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => seedCategories(ctx));
  return owner;
}

async function create(owner: Owner, name: string, over: Parameters<typeof productForm>[1] = {}) {
  return (await owner.mutation(api.products.create, { values: productForm(name, over) })).id as Id<"products">;
}

const productOf = (t: TestT, id: Id<"products">) => t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"products">);

async function category(owner: Owner, name: string) {
  return (await owner.query(api.products.categories, {})).find((c) => c.name === name)?._id as Id<"productCategories">;
}

describe("PRD-072 list filters and picker", () => {
  test("PRD-072 status all/archived, type, category and VAT key filters with and without search", async () => {
    const t = makeT();
    const owner = await setup(t);
    const waren = await category(owner, "Waren");
    const kabel = await create(owner, "Kabel", { type: "good", unitCode: "C62", categoryId: waren });
    const buch = await create(owner, "Buch", { type: "good", unitCode: "C62", vatRateKey: "reduced" });
    const beratung = await create(owner, "Beratung");
    const alt = await create(owner, "Alte Beratung");
    await owner.mutation(api.products.archive, { id: alt });
    const list = async (f: Record<string, unknown>) =>
      (await owner.query(api.products.list, { paginationOpts: page, ...f })).page.map((r) => r._id).sort();
    expect(await list({ status: "all" })).toEqual([kabel, buch, beratung, alt].sort());
    expect(await list({ type: "good" })).toEqual([kabel, buch].sort());
    expect(await list({ categoryId: waren })).toEqual([kabel]);
    expect(await list({ vatRateKey: "reduced" })).toEqual([buch]);
    expect(await list({ q: "beratung", status: "all" })).toEqual([beratung, alt].sort());
    expect(await list({ q: "beratung", status: "archived" })).toEqual([alt]);
    expect(await list({ q: "kabel", type: "good" })).toEqual([kabel]);
    expect(await list({ q: "kabel", type: "service" })).toEqual([]);
    const rows = (await owner.query(api.products.list, { paginationOpts: page, status: "all" })).page;
    expect(rows.find((r) => r._id === kabel)?.category).toBe("Waren");
    expect(rows.find((r) => r._id === buch)?.rateBp).toBe(700);
    expect((await owner.query(api.products.options, { q: "kabel" })).map((o) => o._id)).toEqual([kabel]);
    // exportRows with filters
    const exported = await owner.query(api.products.exportRows, { status: "archived" });
    expect(exported).toHaveLength(2);
    expect(exported[1]?.join(";")).toContain("Alte Beratung");
  });

  test("PRD-002 nextNumber is null without a product range; get of a deleted product is null", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(await owner.query(api.products.nextNumber, {})).toBeNull();
    const o = await setup(t);
    const p = await create(o, "Weg");
    await o.mutation(api.products.remove, { id: p });
    expect(await o.query(api.products.get, { id: p })).toBeNull();
    for (const call of [
      o.mutation(api.products.archive, { id: p }),
      o.mutation(api.products.setScheduledPrice, { id: p, values: null }),
    ]) {
      const e = await catching(call);
      expect(errorCode(e)).toBe("not_found");
      expect(messageOf(e)).toBe("Produkt nicht gefunden.");
    }
  });
});

describe("PRD-001…PRD-053 optional product fields", () => {
  test("PRD-003 PRD-005 PRD-008 PRD-023 PRD-050 internal note, GTIN, place of supply, §13b type, labour share, tags, revenue account", async () => {
    const t = makeT();
    const owner = await setup(t);
    const tag = await owner.mutation(api.lookups.saveTag, { values: { name: "Top", color: "green" } });
    const id = await create(owner, "Bauleistung", {
      internalNote: "nur für Stammkunden",
      purchasePrice: "40,00",
      placeOfSupplyRule: "property",
      reverseCharge13b: "construction",
      laborCostShare: "60",
      revenueAccountOverride: "8400",
      tags: [tag],
    });
    expect(await productOf(t, id)).toMatchObject({
      internalNote: "nur für Stammkunden",
      purchasePriceMicros: 400_000,
      placeOfSupplyRule: "property",
      reverseCharge13b: "construction",
      laborCostShareBp: 6000,
      revenueAccountOverride: "8400",
      tags: [tag],
    });
    const good = await create(owner, "Scanner", { type: "good", unitCode: "C62", gtin: "4006381333931" });
    expect((await productOf(t, good)).gtin).toBe("4006381333931");
    const detail = await owner.query(api.products.get, { id });
    expect(detail?.tags).toEqual([{ _id: tag, name: "Top", color: "green" }]);
    expect(detail?.margin?.marginBp).toBeGreaterThan(0);
    expect(detail?.usageCount).toBe(0);

    // revenue account checks against the company chart (SKR03): 8300 is the 7 % automatic account, 1200 is a bank
    expect(reasonOf(await catching(create(owner, "Falsch", { revenueAccountOverride: "8300" })))).toBe(
      "REVENUE_ACCOUNT_RATE_MISMATCH",
    );
    expect(reasonOf(await catching(create(owner, "Bank", { revenueAccountOverride: "1200" })))).toBe(
      "REVENUE_ACCOUNT_INVALID",
    );
    expect(reasonOf(await catching(create(owner, "Kat", { categoryId: "keine-kategorie" })))).toBe("CATEGORY_UNKNOWN");
    const accounts = await owner.query(api.products.revenueAccounts, {});
    expect(accounts.chart).toBe("SKR03");
    expect(accounts.accounts.some((a: { number: string }) => a.number === "8400")).toBe(true);

    // the update removes the optional fields again and changes the number
    const r = await owner.mutation(api.products.update, {
      id,
      version: 1,
      values: productForm("Bauleistung", { number: "BAU-1" }),
    });
    expect(r.warnings).toEqual([]);
    const cleared = await productOf(t, id);
    expect(cleared.number).toBe("BAU-1");
    for (const k of [
      "internalNote",
      "purchasePriceMicros",
      "placeOfSupplyRule",
      "reverseCharge13b",
      "laborCostShareBp",
    ])
      expect(cleared[k as keyof typeof cleared]).toBeUndefined();
    // an unchanged save emits no change; a taken number is refused
    await owner.mutation(api.products.update, {
      id,
      version: 2,
      values: productForm("Bauleistung", { number: "BAU-1" }),
    });
    const other = await create(owner, "Andere");
    expect(
      reasonOf(
        await catching(
          owner.mutation(api.products.update, {
            id: other,
            version: 1,
            values: productForm("Andere", { number: "bau-1" }),
          }),
        ),
      ),
    ).toBe("PRODUCT_NUMBER_TAKEN");
  });

  test("PRD-072 archive and restore are idempotent and audited", async () => {
    const t = makeT();
    const owner = await setup(t);
    const id = await create(owner, "Beratung");
    await owner.mutation(api.products.unarchive, { id });
    await owner.mutation(api.products.archive, { id });
    await owner.mutation(api.products.archive, { id });
    await owner.mutation(api.products.unarchive, { id });
    expect(await productOf(t, id)).toMatchObject({ active: true, version: 3 });
    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((a) => a.action).filter((a) => a.includes("archive")),
    );
    expect(actions).toEqual(["product.archive", "product.unarchive"]);
  });

  test("PRD-090 stock keeping is for goods only", async () => {
    const t = makeT();
    const owner = await setup(t);
    const id = await create(owner, "Scanner", { type: "good", unitCode: "C62" });
    const p = await productOf(t, id);
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedPatch(ctx, "products", id, { stock: { enabled: true, quantityMilli: 0 } } as never, {
        action: "product.update",
        label: p.number,
      }),
    );
    const e = await catching(
      owner.mutation(api.products.update, { id, version: 1, values: productForm("Scanner", { type: "service" }) }),
    );
    expect(reasonOf(e)).toBe("STOCK_SERVICE");
    expect(messageOf(e)).toBe("Bestandsführung ist nur für Waren möglich.");
  });
});

describe("PRD-030 PRD-031 customer and scheduled prices", () => {
  test("PRD-030 PRD-E23 unknown, merged and restricted contacts are refused; updates check the product; history sorts by date", async () => {
    const t = makeT();
    const owner = await setup(t);
    const p = await create(owner, "Beratung");
    const other = await create(owner, "Andere");
    const contact = async (name: string) =>
      (await owner.mutation(api.contacts.create, { values: createValues(orgForm(name), { address: BERLIN }) }))
        .id as Id<"contacts">;
    const a = await contact("Alpha GmbH");
    const b = await contact("Beta GmbH");
    const r = await contact("Gesperrt GmbH");
    const save = (contactId: string, validFrom = "", priceId?: Id<"customerPrices">, productId = p) =>
      owner.mutation(api.products.saveCustomerPrice, {
        productId,
        ...(priceId ? { priceId } : {}),
        values: { contactId, priceMode: "net", price: "80", validFrom },
      });
    expect(reasonOf(await catching(save("kein-kontakt")))).toBe("CONTACT_UNKNOWN");
    await owner.mutation(api.contacts.merge, {
      values: { winnerId: a, loserIds: [b], fieldChoices: {}, confirmVatConflict: false },
    });
    expect(reasonOf(await catching(save(b)))).toBe("CONTACT_UNKNOWN");
    const later = await save(a, "2027-01-01");
    const now = await save(a);
    await save(r);
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedPatch(ctx, "contacts", r, { dsgvo: { restrictedAt: Date.now() } }, { action: "dsgvo.restrict", label: r }),
    );
    expect(reasonOf(await catching(save(r, "2027-02-01")))).toBe("CONTACT_RESTRICTED");
    // PRD-E23: the restricted contact's price is hidden; the rest sorts by contact, then validFrom
    const detail = await owner.query(api.products.get, { id: p });
    expect(detail?.customerPrices.map((x) => x._id)).toEqual([now, later]);
    // an update of the price row with another product id is not found
    const wrong = await catching(save(a, "2027-03-01", later, other));
    expect(messageOf(wrong)).toBe("Kundenpreis nicht gefunden.");
    expect(await save(a, "2027-03-01", later)).toBe(later);
    expect((await t.run((ctx) => ctx.db.get(later)))?.validFrom).toBe("2027-03-01");
    await owner.mutation(api.products.removeCustomerPrice, { priceId: later });
    const gone = await catching(owner.mutation(api.products.removeCustomerPrice, { priceId: later }));
    expect(messageOf(gone)).toBe("Kundenpreis nicht gefunden.");
  });

  test("PRD-031 a scheduled price can be cancelled; the cron skips under IS_TEST and outside 00:xx Berlin, uses today's date", async () => {
    const t = makeT();
    const owner = await setup(t);
    const p = await create(owner, "Beratung");
    await owner.mutation(api.products.setScheduledPrice, {
      id: p,
      values: { validFrom: "2026-10-13", priceMode: "gross", price: "119" },
    });
    expect((await productOf(t, p)).scheduledPrice).toEqual({
      validFrom: "2026-10-13",
      priceMode: "gross",
      unitPriceMicros: 1_190_000,
    });
    await owner.mutation(api.products.setScheduledPrice, { id: p, values: null });
    expect((await productOf(t, p)).scheduledPrice).toBeUndefined();
    const actions = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));
    expect(actions).toContain("product.price_schedule_cancel");

    await owner.mutation(api.products.setScheduledPrice, {
      id: p,
      values: { validFrom: "2026-10-13", priceMode: "net", price: "120" },
    });
    expect(await t.mutation(internal.products.applyScheduledPricesCron, {})).toBe(0);
    vi.stubEnv("IS_TEST", "false");
    // 12:00 Berlin → not the 00:xx run
    expect(await t.mutation(internal.products.applyScheduledPricesCron, {})).toBe(0);
    vi.setSystemTime(new Date("2026-10-12T22:05:00Z")); // 00:05 on 13.10. Berlin (CEST)
    expect(await t.mutation(internal.products.applyScheduledPricesCron, {})).toBe(1);
    expect((await productOf(t, p)).unitPriceMicros).toBe(1_200_000);
  });
});

describe("PRD-060 PRD-061 PRD-084 categories", () => {
  test("PRD-060 PRD-061 rename, unknown parent, unknown category, delete to none and the path of a product", async () => {
    const t = makeT();
    const owner = await setup(t);
    const waren = await category(owner, "Waren");
    const kabel = await owner.mutation(api.products.saveCategory, { values: { name: "Kabel", parentId: waren } });
    const cat7 = await owner.mutation(api.products.saveCategory, { values: { name: "Cat7", parentId: kabel } });
    await owner.mutation(api.products.saveCategory, {
      categoryId: kabel,
      values: { name: "Leitungen", parentId: waren },
    });
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    expect(await t.model(actor, (ctx) => categoryPathOf(ctx, cat7))).toBe("Waren > Leitungen > Cat7");
    expect(await t.model(actor, (ctx) => categoryPathOf(ctx, undefined))).toBe("");
    expect(
      reasonOf(await catching(owner.mutation(api.products.saveCategory, { values: { name: "X", parentId: "nix" } }))),
    ).toBe("CATEGORY_UNKNOWN");
    const p = await create(owner, "Kabel 5 m", { type: "good", unitCode: "C62", categoryId: cat7 });
    // a category with a child and a product moves both to none
    await owner.mutation(api.products.deleteCategory, { categoryId: kabel, target: "none" });
    await owner.mutation(api.products.deleteCategory, { categoryId: cat7, target: "none" });
    expect((await productOf(t, p)).categoryId).toBeUndefined();
    const cats = await owner.query(api.products.categories, {});
    expect(cats.map((c) => c.path)).toEqual(["Dienstleistungen", "Waren"]);
    for (const call of [
      owner.mutation(api.products.deleteCategory, { categoryId: kabel }),
      owner.mutation(api.products.saveCategory, { categoryId: kabel, values: { name: "Neu", parentId: "" } }),
    ]) {
      const e = await catching(call);
      expect(errorCode(e)).toBe("not_found");
      expect(messageOf(e)).toBe("Kategorie nicht gefunden.");
    }
  });
});

describe("PRD-080 PRD-082 import edge rows", () => {
  test("PRD-080 PRD-082 preview: a row the form refuses, an update; commit: create_only skips, errors carry the row, 100-row limit", async () => {
    const t = makeT();
    const owner = await setup(t);
    await create(owner, "Kabel", { number: "K-1", type: "good", unitCode: "C62" });
    const mapping = ["number", "name", "unit", "netPrice", "vat", "category"];
    const rows = [
      { rowNumber: 2, cells: ["K-1", "Kabel neu", "Stk", "1,50", "19", ""] },
      { rowNumber: 3, cells: ["", "Ohne Nummer", "Stk", "2,00", "19", ""] },
      { rowNumber: 4, cells: ["K-4", "x".repeat(300), "Stk", "1", "19", ""] },
      { rowNumber: 5, cells: ["K-5", "Tief", "Stk", "1", "19", "A > B > C > D"] },
    ];
    const preview = await owner.query(api.products.importPreview, { rows, mapping });
    expect(preview.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, "update"],
      [3, "new"],
      [4, "error"],
      [5, "new"],
    ]);
    expect(preview[2]?.message).toMatch(/^Zeile 4: /);
    const out = await owner.mutation(api.products.importCommit, { rows, mapping, mode: "create_only" });
    expect(out.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, "skipped"],
      [3, "created"],
      [4, "error"],
      [5, "error"],
    ]);
    expect(out[0]?.message).toBe("Artikelnummer K-1 existiert bereits.");
    expect(out[3]?.message).toMatch(/^Zeile 5: /);
    const many = Array.from({ length: 101 }, (_, i) => ({ rowNumber: i + 2, cells: rows[1]?.cells ?? [] }));
    const e = await catching(owner.mutation(api.products.importCommit, { rows: many, mapping, mode: "create_only" }));
    expect(reasonOf(e)).toBe("IMPORT_BATCH_TOO_LARGE");
  });
});

describe("PRD-074 PRD-027 usage and rate changes", () => {
  test("PRD-074 a draft line counts without number or date; units used as extra unit block deletion (SET-090)", async () => {
    const t = makeT();
    const owner = await setup(t);
    const p = await create(owner, "Beratung", { extraUnits: [{ unitCode: "DAY", factor: "8" }] } as never);
    const { id: contactId } = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Alpha GmbH"), { address: BERLIN }),
    });
    const values = invoiceValues(contactId);
    await owner.mutation(api.invoices.createDraft, {
      values: { ...values, lines: values.lines.map((l) => ({ ...l, productId: p })) },
    });
    const usage = await owner.query(api.products.usage, { id: p });
    expect(usage.documents).toHaveLength(1);
    expect(usage.documents[0]).toMatchObject({ status: "draft" });
    expect(usage.documents[0]?.number).toBeNull();
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    expect(await t.model(actor, (ctx) => productsUsingUnit(ctx, "DAY"))).toBe(1);
  });

  test("PRD-027 a rate change within 60 days names the affected products", async () => {
    vi.setSystemTime(new Date("2025-12-01T10:00:00Z"));
    const t = makeT();
    const owner = await setup(t);
    await create(owner, "Mittagstisch", { vatRateKey: "restaurant_food", priceMode: "gross", price: "12,00" });
    const banners = await owner.query(api.products.rateChangeBanners, {});
    expect(banners).toHaveLength(1);
    expect(banners[0]).toMatch(
      /^Ab 01\.01\.2026 ändert sich der Steuersatz für restaurant_food\. 1 Produkte mit Bruttopreis/,
    );
    vi.setSystemTime(NOW);
  });
});
