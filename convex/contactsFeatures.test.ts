import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm } from "./catalog.fixtures";
import { invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";
import { header, line, setupCompany, upload } from "./vouchers.fixtures";

/** F02 contacts — gap rows (CON-094, CON-124, CON-152, CON-153, CON-085, CON-103, CON-144). */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

describe("CON-094 default payment method per contact", () => {
  test("CON-094 the contact's payment method is the default of new drafts (UI defaults and API drafts); unknown ids are rejected", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const methods = await t.run((ctx) => ctx.db.query("paymentMethods").collect());
    const paypal = methods.find((m) => m.kind === "paypal");
    const transfer = methods.find((m) => m.isDefault);
    expect(paypal && transfer).toBeTruthy();

    const { id } = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("PayPal-Kunde GmbH", { paymentMethodId: paypal?._id ?? "" }), { address: BERLIN }),
    });
    const contactId = id as Id<"contacts">;
    expect((await t.run((ctx) => ctx.db.get(contactId)))?.paymentMethodId).toBe(paypal?._id);

    // UI: draftDefaults for the chosen contact
    expect((await owner.query(api.invoices.draftDefaults, { contactId })).paymentMethodId).toBe(paypal?._id);
    // a contact without a default gets the company default method
    const { id: plain } = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Standard GmbH"), { address: BERLIN }),
    });
    expect(
      (await owner.query(api.invoices.draftDefaults, { contactId: plain as Id<"contacts"> })).paymentMethodId,
    ).toBe(transfer?._id);

    // REST/MCP-style draft without a payment method → the contact's default
    const { id: draftId } = await owner.mutation(api.invoices.createDraft, {
      values: { ...invoiceValues(contactId), paymentMethodId: undefined },
    });
    expect((await t.run((ctx) => ctx.db.get(draftId as Id<"salesDocuments">)))?.paymentMethodId).toBe(paypal?._id);

    const bad = await owner
      .mutation(api.contacts.create, {
        values: createValues(orgForm("Falsch GmbH", { paymentMethodId: "not-an-id" }), { address: BERLIN }),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(JSON.stringify(dataOf(bad))).toContain("Unbekannte Zahlungsart.");
  });
});

describe("CON-153 sortable Offen / Umsatz (Jahr)", () => {
  test("CON-153 contacts.ranking sorts all matching contacts by open amount or year revenue; list rows carry both figures", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const contact = async (name: string) =>
      (await owner.mutation(api.contacts.create, { values: createValues(orgForm(name), { address: BERLIN }) }))
        .id as Id<"contacts">;
    const a = await contact("Alpha GmbH");
    const b = await contact("Beta GmbH");
    const c = await contact("Gamma GmbH");
    const invoice = async (contactId: Id<"contacts">, hours: number) => {
      const { id } = await owner.mutation(api.invoices.createDraft, {
        values: invoiceValues(contactId, {
          lines: [
            {
              kind: "item",
              productType: "service",
              name: "Beratung",
              quantityMilli: hours * 1000,
              unitCode: "HUR",
              unitPriceMicros: 1_000_000, // 100,00 €
              vatRateKey: "standard",
            },
          ],
        }),
      });
      await owner.action(api.invoices.finalize, { id, version: 1 });
    };
    await invoice(a, 10); // 1.000,00 net, 1.190,00 open
    await invoice(b, 30); // 3.000,00 net, 3.570,00 open
    await owner.mutation(api.invoices.createDraft, { values: invoiceValues(c) }); // a draft counts for nothing

    const byRevenue = await owner.query(api.contacts.ranking, { sortBy: "revenueYear", dir: "desc" });
    expect(byRevenue.map((r) => [r.displayName, r.revenueYearCents, r.openCents])).toEqual([
      ["Beta GmbH", 300_000, 357_000],
      ["Alpha GmbH", 100_000, 119_000],
      ["Gamma GmbH", 0, 0],
    ]);
    const byOpenAsc = await owner.query(api.contacts.ranking, { sortBy: "open", dir: "asc", limit: 2 });
    expect(byOpenAsc.map((r) => r.displayName)).toEqual(["Gamma GmbH", "Alpha GmbH"]);
    // list filters apply to the ranking as well
    const filtered = await owner.query(api.contacts.ranking, { sortBy: "open", dir: "desc", q: "Alpha" });
    expect(filtered.map((r) => r.displayName)).toEqual(["Alpha GmbH"]);
    // the paginated list shows the same figures
    const page = await owner.query(api.contacts.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page.find((r) => r._id === b)).toMatchObject({ openCents: 357_000, revenueYearCents: 300_000 });
  });
});

describe("CON-152 supplier view", () => {
  test("CON-152 contacts.get returns spend this year/all time and open payables from the supplier's booked vouchers", async () => {
    vi.useRealTimers(); // voucher fixtures date the vouchers today
    const t = makeT();
    const { supplier } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const draftFor = async (amountCents: number) => {
      const { voucherId } = await upload(t, owner);
      await owner.mutation(api.vouchers.updateDraft, {
        id: voucherId,
        input: header({ supplierContactId: supplier, lines: [line({ amountCents })] }),
      });
      return voucherId;
    };
    await owner.mutation(api.vouchers.finalize, { id: await draftFor(11_900) }); // 100,00 net
    await owner.mutation(api.vouchers.finalize, { id: await draftFor(23_800) }); // 200,00 net
    await draftFor(99_900); // a draft counts for nothing
    const bundle = await owner.query(api.contacts.get, { id: supplier });
    expect(bundle?.supplierStats).toEqual({
      spendThisYearCents: 30_000,
      spendAllTimeCents: 30_000,
      openPayablesCents: 35_700,
      voucherCount: 2,
    });
  });
});
