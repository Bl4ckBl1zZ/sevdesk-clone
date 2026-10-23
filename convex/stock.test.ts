import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE, productForm } from "./catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/** F03 §3.10 stock (PRD-090…097): settings, manual movements, delivery notes, reorder level, history. */

const NOW = new Date("2026-10-12T10:00:00Z");
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message;
const fail = <T>(p: Promise<T>) => p.then(() => expect.unreachable("expected an error")).catch((e: unknown) => e);

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
    values: productForm("Netzwerkkabel Cat7", {
      type: "good",
      unitCode: "MTR",
      price: "1,50",
      extraUnits: [{ unitCode: "XRO", factor: "100" }],
    }),
  });
  return { ...s, ...buyer, cableId: cable.id as Id<"products"> };
}

const product = (t: TestT, id: Id<"products">) => t.run((ctx) => ctx.db.get(id));
const lowNotices = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.kind === "stock.low"));

function noteValues(contactId: string, productId: string, qty: number, unitCode: string): DraftValues {
  const base = invoiceValues(contactId, {
    lines: [
      {
        kind: "item",
        productId,
        productType: "good",
        name: "Netzwerkkabel Cat7",
        quantityMilli: qty,
        unitCode,
        unitPriceMicros: 15_000,
        vatRateKey: "standard",
      },
    ],
  });
  return { ...base, type: "delivery_note", supplyDate: { kind: "date", date: "2026-10-09" as CalendarDate } };
}

describe("PRD-090…097 stock", () => {
  test("PRD-090 T-PRD-046 stock only for goods; PRD-094 manual movements need a text; the cache is Σ movements", async () => {
    const t = makeT();
    const { owner, cableId } = await setup(t);
    const service = await owner.mutation(api.products.create, { values: productForm("Montage", { type: "service" }) });
    const e = await fail(
      owner.mutation(api.stock.configure, { productId: service.id, values: { enabled: true, reorderLevel: "" } }),
    );
    expect([reasonOf(e), messageOf(e)]).toEqual(["STOCK_SERVICE", "Bestandsführung ist nur für Waren möglich."]);
    const disabled = await fail(
      owner.mutation(api.stock.adjust, { productId: cableId, values: { kind: "manual_in", quantity: "5", text: "x" } }),
    );
    expect(reasonOf(disabled)).toBe("STOCK_DISABLED");
    await owner.mutation(api.stock.configure, { productId: cableId, values: { enabled: true, reorderLevel: "" } });
    const noText = await fail(
      owner.mutation(api.stock.adjust, {
        productId: cableId,
        values: { kind: "manual_in", quantity: "500", text: " " },
      }),
    );
    expect(messageOf(noText)).toBe("Bitte einen Text zur Bestandsbuchung angeben.");
    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_in", quantity: "500", text: "Lieferung Großhandel" },
    });
    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_out", quantity: "20", text: "Bruch" },
    });
    const r = await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "correction", quantity: "-5", text: "Inventur" },
    });
    expect(r.quantityMilli).toBe(475_000);
    expect((await product(t, cableId))?.stock).toMatchObject({ enabled: true, quantityMilli: 475_000 });
    // a good with stock cannot become a service
    const p = await product(t, cableId);
    const toService = await fail(
      owner.mutation(api.products.update, {
        id: cableId,
        version: p?.version ?? 1,
        values: productForm("Netzwerkkabel Cat7", { type: "service", unitCode: "MTR", price: "1,50" }),
      }),
    );
    expect(reasonOf(toService)).toBe("STOCK_SERVICE");
    // PRD-073: stock movements block deleting the product
    expect(reasonOf(await fail(owner.mutation(api.products.remove, { id: cableId })))).toBe("PRODUCT_IN_USE");
  });

  test("PRD-091 PRD-092 PRD-096 QUO-17 T-PRD-029/044 delivery note XRO × 2 → −200 m; one reorder notification; withdrawal reverses", async () => {
    const t = makeT();
    const { owner, personId, cableId } = await setup(t);
    await owner.mutation(api.stock.configure, { productId: cableId, values: { enabled: true, reorderLevel: "300" } });
    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_in", quantity: "450", text: "Erstbestand" },
    });
    expect(await lowNotices(t)).toHaveLength(0);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: noteValues(personId, cableId, 2000, "XRO"),
    });
    const fin = await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await product(t, cableId))?.stock?.quantityMilli).toBe(250_000);
    const low = await lowNotices(t);
    expect(low).toHaveLength(1);
    expect(low[0]?.title).toBe("Mindestbestand unterschritten: Netzwerkkabel Cat7 (250 MTR, Mindestbestand 300)");
    // a further Abgang while below the level opens no second notification
    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_out", quantity: "10", text: "Muster" },
    });
    expect((await lowNotices(t)).filter((n) => n.resolvedAt === undefined)).toHaveLength(1);
    expect((await lowNotices(t))[0]?.count).toBe(1);
    // withdrawing the note books the reversing correction; back above the level → resolved
    await owner.mutation(api.documentFlows.withdraw, { id, values: { reason: "Lieferung storniert" } });
    expect((await product(t, cableId))?.stock?.quantityMilli).toBe(440_000);
    expect((await lowNotices(t))[0]?.resolvedAt).toBeTypeOf("number");
    const h = await owner.query(api.stock.history, { productId: cableId });
    expect(h?.movements.map((m) => [m.reason, m.quantityMilli, m.balanceMilli])).toEqual([
      ["correction", 200_000, 440_000],
      ["manual_out", -10_000, 240_000],
      ["delivery_note", -200_000, 250_000],
      ["manual_in", 450_000, 450_000],
    ]);
    expect(h?.movements[2]?.document?.label).toBe(fin.number);
    // GOBD-06: movements are never edited or deleted
    const movement = h?.movements[0]?.id as Id<"stockMovements">;
    const patch = await fail(
      t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
        ctx.db.patch(movement, { quantityMilli: 1 }),
      ),
    );
    expect(errorCode(patch)).toBe("immutable_record");
  });

  test("PRD-093 PRD-E30 T-PRD-030 invoices do not move stock", async () => {
    const t = makeT();
    const { owner, personId, cableId } = await setup(t);
    await owner.mutation(api.stock.configure, { productId: cableId, values: { enabled: true, reorderLevel: "" } });
    await owner.mutation(api.stock.adjust, {
      productId: cableId,
      values: { kind: "manual_in", quantity: "100", text: "Erstbestand" },
    });
    const v = { ...noteValues(personId, cableId, 5000, "MTR"), type: "invoice" as const };
    const { id } = await owner.mutation(api.invoices.createDraft, { values: v });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await product(t, cableId))?.stock?.quantityMilli).toBe(100_000);
  });
});
