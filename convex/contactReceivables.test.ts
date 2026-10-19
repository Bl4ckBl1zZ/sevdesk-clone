import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PAY-004 Kontakt › Offene Posten", { timeout: 30_000 }, () => {
  test("PAY-004 open items, payment history, credit balance and average days to pay of one customer", async () => {
    const t = makeT();
    const { owner, id, personId, orgId } = await finalizedInvoice(t);
    const account = await t.run((ctx) => defaultInvoiceAccount(ctx));
    if (!account) throw new Error("no invoice bank account");
    const pay = (documentId: Id<"salesDocuments">, date: string, amountCents: number) =>
      owner.mutation(api.payments.recordForInvoice, {
        documentId,
        source: { kind: "clearing", accountId: account._id },
        date,
        amountCents,
      });
    // Second invoice of the same customer, paid in full 10 days after its date.
    const second = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: second.id, version: 1 });
    await settle(t);
    const secondDoc = await t.run((ctx) => ctx.db.get(second.id));
    await pay(second.id, "2026-10-12", secondDoc?.totals.payableCents ?? 0);
    await pay(id, "2026-10-12", 50_000);

    const contactId = (await t.run((ctx) => ctx.db.get(id)))?.contactId as Id<"contacts">;
    expect([personId, orgId]).toContain(contactId);
    const view = await owner.query(api.payments.contactReceivables, { contactId });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ id, paidCents: 50_000, openCents: 119_000 - 50_000 });
    expect(view.totals.openCents).toBe(69_000);
    expect(view.payments.map((p) => p.amountCents).sort((a, b) => a - b)).toEqual([
      50_000,
      secondDoc?.totals.payableCents ?? 0,
    ]);
    expect(view.payments.every((p) => p.source === "clearing" && !p.reversed)).toBe(true);
    expect(view.creditCents).toBe(0);
    expect(view.paidInvoices).toBe(1);
    expect(view.averageDaysToPay).toBe(0); // finalised and paid on the same day
    // The organisation's tab includes the documents of its persons (CON-009).
    const other = contactId === personId ? orgId : personId;
    const org = await owner.query(api.payments.contactReceivables, { contactId: orgId });
    expect(org.items.map((i) => i.id)).toEqual([id]);
    expect(other).toBe(orgId);
  });
});
