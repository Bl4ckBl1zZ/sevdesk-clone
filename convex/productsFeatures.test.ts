import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE, productForm } from "./catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/** F03 gap rows: PRD-074 usage tab, PRD-095 negative stock. */

const NOW = new Date("2026-10-12T10:00:00Z");
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(t: TestT) {
  const s = await setupInvoicing(t);
  await s.owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        CONTACT_RANGE,
        PRODUCT_RANGE,
        INVOICE_RANGE,
        { key: "delivery_note", name: "Lieferscheine", format: "LS-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
      ],
    },
  });
  const buyer = await b2bBuyer(s.owner);
  const cable = await s.owner.mutation(api.products.create, {
    values: productForm("Netzwerkkabel Cat7", { type: "good", unitCode: "MTR", price: "1,50" }),
  });
  return { ...s, ...buyer, cableId: cable.id as Id<"products"> };
}

function values(contactId: string, productId: string, qtyMilli: number, type: DraftValues["type"]): DraftValues {
  const base = invoiceValues(contactId, {
    lines: [
      {
        kind: "item",
        productId,
        productType: "good",
        name: "Netzwerkkabel Cat7",
        quantityMilli: qtyMilli,
        unitCode: "MTR",
        unitPriceMicros: 15_000, // 1,50 €
        vatRateKey: "standard",
      },
    ],
  });
  return { ...base, type, supplyDate: { kind: "date", date: "2026-10-09" as CalendarDate } };
}

describe("PRD-074 products.usage", () => {
  test("PRD-074 documents containing the product; units and revenue this year from finalised invoices only", async () => {
    const t = makeT();
    const { owner, personId, cableId } = await setup(t);
    const inv = await owner.mutation(api.invoices.createDraft, {
      values: values(personId, cableId, 100_000, "invoice"),
    });
    const { number } = await owner.action(api.invoices.finalize, { id: inv.id, version: 1 });
    await owner.mutation(api.invoices.createDraft, { values: values(personId, cableId, 50_000, "invoice") }); // draft
    await settle(t);
    const u = await owner.query(api.products.usage, { id: cableId });
    expect(u.thisYear).toEqual({ unitsMilli: 100_000, revenueCents: 15_000 }); // 100 m × 1,50 €
    expect(u.lastYear).toEqual({ unitsMilli: 0, revenueCents: 0 });
    expect(u.documents).toHaveLength(2);
    expect(u.documents.find((d) => d.number === number)).toMatchObject({ type: "invoice", quantityMilli: 100_000 });
    expect(u.documents.find((d) => d.status === "draft")).toMatchObject({ quantityMilli: 50_000 });
  });
});

describe("PRD-095 negative stock", () => {
  test("PRD-095 allowed by default; with „Negativen Bestand verhindern“ the delivery note is blocked and no number is consumed", async () => {
    const t = makeT();
    const { owner, personId, cableId } = await setup(t);
    await owner.mutation(api.stock.configure, { productId: cableId, values: { enabled: true, reorderLevel: "" } });
    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_in", quantity: "50", text: "Erstbestand" },
    });
    // default: allowed, stock goes to −30
    const first = await owner.mutation(api.invoices.createDraft, {
      values: values(personId, cableId, 80_000, "delivery_note"),
    });
    await owner.action(api.invoices.finalize, { id: first.id, version: 1 });
    await settle(t);
    const stock = () => t.run(async (ctx) => (await ctx.db.get(cableId))?.stock?.quantityMilli);
    expect(await stock()).toBe(-30_000);

    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_in", quantity: "40", text: "Nachlieferung" },
    });
    await owner.mutation(api.stock.setPreventNegative, { enabled: true });
    expect((await owner.query(api.stock.history, { productId: cableId }))?.preventNegativeStock).toBe(true);
    const second = await owner.mutation(api.invoices.createDraft, {
      values: values(personId, cableId, 20_000, "delivery_note"),
    });
    const err = await owner.action(api.invoices.finalize, { id: second.id, version: 1 }).then(
      () => null,
      (e: { data?: Record<string, unknown> }) => e.data ?? {},
    );
    expect(err).toMatchObject({ reason: "STOCK_NEGATIVE" });
    expect(String(err?.message)).toContain("Netzwerkkabel Cat7 (-10 MTR)");
    const doc = await t.run((ctx) => ctx.db.get(second.id as Id<"salesDocuments">));
    expect(doc).toMatchObject({ status: "draft" });
    expect(doc?.number).toBeUndefined();
    expect(await stock()).toBe(10_000);
    // within stock the delivery note finalises
    const third = await owner.mutation(api.invoices.createDraft, {
      values: values(personId, cableId, 10_000, "delivery_note"),
    });
    const ok = await owner.action(api.invoices.finalize, { id: third.id, version: 1 });
    expect(ok.number).toBe("LS-2026-0002");
    await settle(t);
    expect(await stock()).toBe(0);
  });

  test("PRD-095 only the owner (settings.write) switches the option", async () => {
    const t = makeT();
    await setup(t);
    const bookkeeper = await t.asUser("bookkeeper");
    await expect(bookkeeper.mutation(api.stock.setPreventNegative, { enabled: true })).rejects.toThrow();
  });
});
