import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "./catalog.fixtures";
import { b2bBuyer, consumerBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * UST-01 / F04 QUO-14 (T-QUO-009, EC-026): `deadlines.notify` warns about uninvoiced delivery notes at day 150 and
 * escalates at day 180 after the delivery date for B2B/legal-person customers; consumers get none; invoicing resolves.
 */

vi.setConfig({ testTimeout: 60_000 });

const DELIVERED = "2026-04-01";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-04-02T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (isoDate: string) => vi.setSystemTime(new Date(`${isoDate}T07:00:00Z`));

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
  return { ...s, ...buyer };
}

type Owner = Awaited<ReturnType<typeof setup>>["owner"];

function note(contactId: string): DraftValues {
  const base = invoiceValues(contactId, {
    lines: [
      {
        kind: "item",
        productType: "good",
        name: "Schreibtisch",
        quantityMilli: 1000,
        unitCode: "C62",
        unitPriceMicros: 5_000_000,
        vatRateKey: "standard",
      } as DraftValues["lines"][number],
    ],
  });
  return { ...base, type: "delivery_note", supplyDate: { kind: "date", date: DELIVERED as CalendarDate } };
}

async function finalizedNote(t: TestT, owner: Owner, contactId: string) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: note(contactId) });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return id;
}

const todosOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("notifications")
        .withIndex("by_entity", (q) => q.eq("entity.table", "salesDocuments").eq("entity.id", id))
        .collect()
    )
      .filter((n) => n.kind.startsWith("ust01_"))
      .map((n) => ({ kind: n.kind, severity: n.severity, open: n.resolvedAt === undefined, title: n.title })),
  );

const run = (t: TestT) => t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });

describe("UST-01 QUO-14 uninvoiced delivery notes in deadlines.notify", () => {
  test("QUO-14 T-QUO-009 UST-01 B2B note: T−151 warning to-do, T−181 escalation; consumer none; invoicing resolves", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const b2b = await finalizedNote(t, owner, personId);
    const consumer = await finalizedNote(t, owner, await consumerBuyer(owner));
    const toInvoice = await finalizedNote(t, owner, personId);

    at("2026-08-28"); // day 149
    await run(t);
    expect(await todosOf(t, b2b)).toEqual([]);

    at("2026-08-30"); // T−151 … day 151 after the delivery (Berlin date, 07:00 UTC)
    await run(t);
    const warn = await todosOf(t, b2b);
    expect(warn).toMatchObject([{ kind: "ust01_warning", severity: "warning", open: true }]);
    expect(warn[0]?.title).toContain("seit 151 Tagen nicht abgerechnet");
    expect(await todosOf(t, consumer)).toEqual([]);
    // Idempotent: the second run of the day opens nothing new.
    expect(await run(t)).toEqual({ created: 0 });

    // Five months later the first session has expired: sign in again as the same owner.
    const later = await t.asUser("owner", { existingUserId: owner.userId });
    // The list badge shows the same state (delivery note list, QUO-14).
    const list = await later.query(api.invoices.list, {
      paginationOpts: { numItems: 10, cursor: null },
      type: "delivery_note",
    });
    const byId = new Map(list.page.map((r) => [r._id, r.invoicingDeadline]));
    expect(byId.get(b2b)).toBe("warning");
    expect(byId.get(consumer)).toBeNull();

    // Invoicing the other note resolves its to-do on the next run.
    const r = await later.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: [toInvoice] } });
    const inv = await t.run((ctx) => ctx.db.get(r.id));
    await later.action(api.invoices.finalize, { id: r.id, version: inv?.version ?? 1 });
    await settle(t);
    await run(t);
    expect(await todosOf(t, toInvoice)).toMatchObject([{ kind: "ust01_warning", open: false }]);

    at("2026-09-29"); // T−181
    await run(t);
    expect(await todosOf(t, b2b)).toEqual([
      expect.objectContaining({ kind: "ust01_warning", open: false }),
      expect.objectContaining({ kind: "ust01_escalation", severity: "error", open: true }),
    ]);
    expect(await todosOf(t, consumer)).toEqual([]);
  });
});
