import { describe, expect, test } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, orgForm, productForm, setupCatalog } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { seedUnits } from "./model/lookups";
import { seedCategories } from "./model/products";
import { makeT, type TestT } from "./test.setup";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const page = { numItems: 50, cursor: null };

async function seeded(t: TestT) {
  const owner = await setupCatalog(t);
  // Only the seeds products need (units SET-090, categories PRD-060) — the full defaults are slow under load.
  await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
    await seedUnits(ctx);
    await seedCategories(ctx);
  });
  return owner;
}

const product = (t: TestT, id: Id<"products">) =>
  t.run(async (ctx) => {
    const p = await ctx.db.get(id);
    if (!p) throw new Error("missing");
    return p;
  });

describe("PRD-001…009 product master data", () => {
  test("PRD-002 T-PRD-014 numbers from the product range; manual numbers unique case-insensitively incl. archived", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const a = await owner.mutation(api.products.create, { values: productForm("Webdesign Stunde") });
    expect(a.number).toBe("ART-00001");
    const b = await owner.mutation(api.products.create, { values: productForm("Kabel Cat7", { number: "kab-7" }) });
    await owner.mutation(api.products.archive, { id: b.id });
    const dup = await owner
      .mutation(api.products.create, { values: productForm("Kabel", { number: "KAB-7" }) })
      .catch(reasonOf);
    expect(dup).toBe("PRODUCT_NUMBER_TAKEN");
    expect(await owner.query(api.products.nextNumber, {})).toBe("ART-00002");
  });

  test("PRD-006 the unit must be an active unit; PRD-024 exempt needs a reason", async () => {
    const t = makeT();
    const owner = await seeded(t);
    expect(
      await owner.mutation(api.products.create, { values: productForm("X", { unitCode: "ZZZ" }) }).catch(reasonOf),
    ).toBe("UNIT_INVALID");
    expect(
      await owner
        .mutation(api.products.create, { values: productForm("Heilbehandlung", { vatRateKey: "exempt" }) })
        .catch(reasonOf),
    ).toBe("EXEMPTION_REASON_REQUIRED");
    await owner.mutation(api.products.create, {
      values: productForm("Heilbehandlung", { vatRateKey: "exempt", exemptionReasonCode: "VATEX-EU-132-1C" }),
    });
  });

  test("PRD-004 T-PRD-026 a generic name is saved with a warning", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const r = await owner.mutation(api.products.create, { values: productForm("Pauschale.") });
    expect(r.warnings[0]).toMatch(/zu allgemein/);
  });

  test("PRD-007 stale writes → VERSION_CONFLICT; PRD-012 the detail shows net and gross at today's rate", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const a = await owner.mutation(api.products.create, { values: productForm("Beratung", { price: "100,00" }) });
    const detail = await owner.query(api.products.get, { id: a.id });
    expect(detail).toMatchObject({ netMicros: 1_000_000, grossMicros: 1_190_000, rateBp: 1900 });
    await owner.mutation(api.products.update, {
      id: a.id,
      version: 1,
      values: productForm("Beratung", { price: "110,00" }),
    });
    const stale = await owner
      .mutation(api.products.update, { id: a.id, version: 1, values: productForm("Beratung") })
      .catch((e: unknown) => errorCode(e));
    expect(stale).toBe("version_conflict");
  });

  test("T-PRD-013 PRD-035 changing the base unit with extra units needs confirmation and clears them", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const a = await owner.mutation(api.products.create, {
      values: productForm("Kabel Cat7", {
        type: "good",
        unitCode: "MTR",
        price: "1,2345",
        extraUnits: [{ unitCode: "XRO", factor: "100" }],
      }),
    });
    const values = productForm("Kabel Cat7", {
      type: "good",
      unitCode: "C62",
      price: "1,2345",
      extraUnits: [{ unitCode: "XRO", factor: "100" }],
    });
    expect(await owner.mutation(api.products.update, { id: a.id, version: 1, values }).catch(reasonOf)).toBe(
      "EXTRA_UNITS_CLEAR_CONFIRM",
    );
    await owner.mutation(api.products.update, { id: a.id, version: 1, values, confirmClearExtraUnits: true });
    expect((await product(t, a.id)).extraUnits).toEqual([]);
  });

  test("SET-090 a unit used by a product cannot be deleted", async () => {
    const t = makeT();
    const owner = await seeded(t);
    await owner
      .mutation(api.lookups.createUnit, { values: { code: "XRO", labelDe: "Rolle", labelEn: "Roll" } })
      .catch(() => null);
    await owner.mutation(api.products.create, { values: productForm("Rolle", { type: "good", unitCode: "XRO" }) });
    const unit = (await owner.query(api.lookups.listUnits, {})).find((u) => u.code === "XRO");
    if (!unit) throw new Error("no unit");
    const r = await owner.mutation(api.lookups.deleteUnit, { unitId: unit.unitId }).catch((e: unknown) => e);
    expect(errorCode(r)).toBe("invalid_input");
  });
});

describe("PRD-030…031 customer and scheduled prices", () => {
  test("PRD-030 customer prices per contact and date; duplicates refused; restricted contacts hidden", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const c = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Kunde GmbH")) });
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: p.id,
      values: { contactId: c.id, priceMode: "net", price: "85", validFrom: "" },
    });
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: p.id,
      values: { contactId: c.id, priceMode: "net", price: "80", validFrom: "2027-01-01" },
    });
    const dup = await owner
      .mutation(api.products.saveCustomerPrice, {
        productId: p.id,
        values: { contactId: c.id, priceMode: "net", price: "70", validFrom: "2027-01-01" },
      })
      .catch(reasonOf);
    expect(dup).toBe("CUSTOMER_PRICE_DUPLICATE");
    const detail = await owner.query(api.products.get, { id: p.id });
    expect(detail?.customerPrices.map((r) => r.unitPriceMicros)).toEqual([850_000, 800_000]);
  });

  test("T-PRD-016 PRD-073 an unreferenced product is deleted with its customer prices", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const c = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Kunde GmbH")) });
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: p.id,
      values: { contactId: c.id, priceMode: "net", price: "85", validFrom: "" },
    });
    await owner.mutation(api.products.remove, { id: p.id });
    const left = await t.run(async (ctx) => ({
      products: (await ctx.db.query("products").collect()).length,
      prices: (await ctx.db.query("customerPrices").collect()).length,
    }));
    expect(left).toEqual({ products: 0, prices: 0 });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "product.delete"))
        .first(),
    );
    expect(audit?.entity.id).toBe(p.id);
  });

  test("T-PRD-023 CON-132 after a merge the loser's customer prices belong to the winner", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const w = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Alpha GmbH")) });
    const l = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Alpha G.m.b.H.")) });
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: p.id,
      values: { contactId: l.id, priceMode: "net", price: "85", validFrom: "" },
    });
    await owner.mutation(api.contacts.merge, {
      values: { winnerId: w.id, loserIds: [l.id], fieldChoices: {}, confirmVatConflict: false },
    });
    const detail = await owner.query(api.products.get, { id: p.id });
    expect(detail?.customerPrices.map((r) => r.contactId)).toEqual([w.id]);
  });

  test("T-PRD-039 PRD-031 a scheduled price becomes the product price on its date (cron, audited)", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const p = await owner.mutation(api.products.create, { values: productForm("Beratung") });
    const today = berlinCalendarDate(Date.now());
    expect(
      await owner
        .mutation(api.products.setScheduledPrice, {
          id: p.id,
          values: { validFrom: today, priceMode: "net", price: "99" },
        })
        .catch(reasonOf),
    ).toBe("DATE_NOT_IN_FUTURE");
    const tomorrow = addDays(today, 1);
    await owner.mutation(api.products.setScheduledPrice, {
      id: p.id,
      values: { validFrom: tomorrow, priceMode: "net", price: "99" },
    });
    expect(await t.mutation(internal.products.applyScheduledPricesCron, { force: true, today })).toBe(0);
    expect(await t.mutation(internal.products.applyScheduledPricesCron, { force: true, today: tomorrow })).toBe(1);
    const after = await product(t, p.id);
    expect(after.unitPriceMicros).toBe(990_000);
    expect(after.scheduledPrice).toBeUndefined();
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "product.price_apply"))
        .first(),
    );
    expect(audit?.actor).toBe("system:cron.products.applyScheduledPrices");
  });
});

describe("PRD-060 PRD-061 categories", () => {
  test("PRD-060 seeded categories; depth ≤ 3; sibling names unique", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const cats = await owner.query(api.products.categories, {});
    expect(cats.map((c) => c.path)).toEqual(["Dienstleistungen", "Waren"]);
    const waren = cats.find((c) => c.name === "Waren")?._id as Id<"productCategories">;
    const kabel = await owner.mutation(api.products.saveCategory, { values: { name: "Kabel", parentId: waren } });
    const cat7 = await owner.mutation(api.products.saveCategory, { values: { name: "Cat7", parentId: kabel } });
    expect(
      await owner.mutation(api.products.saveCategory, { values: { name: "Extra", parentId: cat7 } }).catch(reasonOf),
    ).toBe("CATEGORY_DEPTH");
    expect(
      await owner.mutation(api.products.saveCategory, { values: { name: "kabel", parentId: waren } }).catch(reasonOf),
    ).toBe("CATEGORY_DUPLICATE");
  });

  test("T-PRD-043 PRD-061 deleting a category with products needs a target; products move, none orphaned", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const waren = (await owner.query(api.products.categories, {})).find((c) => c.name === "Waren")
      ?._id as Id<"productCategories">;
    const kabel = await owner.mutation(api.products.saveCategory, { values: { name: "Kabel", parentId: waren } });
    const p = await owner.mutation(api.products.create, { values: productForm("Kabel Cat7", { categoryId: kabel }) });
    expect(await owner.mutation(api.products.deleteCategory, { categoryId: kabel }).catch(reasonOf)).toBe(
      "CATEGORY_NOT_EMPTY",
    );
    await owner.mutation(api.products.deleteCategory, { categoryId: kabel, target: "parent" });
    expect((await product(t, p.id)).categoryId).toBe(waren);
  });
});

describe("PRD-072 PRD-080…085 list, archive, import and export", () => {
  test("PRD-072 archived products are hidden from the list and the picker", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const a = await owner.mutation(api.products.create, { values: productForm("Alt") });
    await owner.mutation(api.products.create, { values: productForm("Neu") });
    await owner.mutation(api.products.archive, { id: a.id });
    expect((await owner.query(api.products.list, { paginationOpts: page })).page.map((r) => r.name)).toEqual(["Neu"]);
    expect((await owner.query(api.products.options, {})).map((r) => r.name)).toEqual(["Neu"]);
    expect(
      (await owner.query(api.products.list, { paginationOpts: page, status: "archived" })).page.map((r) => r.name),
    ).toEqual(["Alt"]);
    expect((await owner.query(api.products.list, { paginationOpts: page, q: "neu" })).page.map((r) => r.name)).toEqual([
      "Neu",
    ]);
  });

  test("T-PRD-040 PRD-080…084 CSV import: units mapped, 0 % without reason → error, dry run writes nothing, re-run idempotent", async () => {
    const t = makeT();
    const owner = await seeded(t);
    const mapping = ["number", "name", "unit", "netPrice", "vat", "category"];
    const rows = [
      { rowNumber: 2, cells: ["K-1", "Kabel", "Stk", "1,50", "19", "Waren > Kabel"] },
      { rowNumber: 3, cells: ["K-2", "Fliesen", "qm", "30,00", "19", ""] },
      { rowNumber: 4, cells: ["K-3", "Ohne", "Stk", "1", "0", ""] },
    ];
    const preview = await owner.query(api.products.importPreview, { rows, mapping });
    expect(preview.map((r) => r.status)).toEqual(["new", "new", "error"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("products").collect()).length)).toBe(0);
    const first = await owner.mutation(api.products.importCommit, { rows, mapping, mode: "create_and_update" });
    expect(first.map((r) => r.status)).toEqual(["created", "created", "error"]);
    const again = await owner.mutation(api.products.importCommit, { rows, mapping, mode: "create_and_update" });
    expect(again.map((r) => r.status)).toEqual(["updated", "updated", "error"]);
    const all = await t.run((ctx) => ctx.db.query("products").collect());
    expect(all.map((p) => p.unitCode).sort()).toEqual(["C62", "MTK"]);
    const cats = await owner.query(api.products.categories, {});
    expect(cats.map((c) => c.path)).toContain("Waren > Kabel");
  });

  test("T-PRD-042 PRD-085 export contains net and gross at today's rate", async () => {
    const t = makeT();
    const owner = await seeded(t);
    await owner.mutation(api.products.create, { values: productForm("Beratung", { price: "100,00" }) });
    const rows = await owner.query(api.products.exportRows, {});
    expect(rows[1]?.slice(0, 7)).toEqual([
      "ART-00001",
      "Beratung",
      "Dienstleistung",
      "HUR",
      "netto",
      "100,00",
      "119,00",
    ]);
  });
});
