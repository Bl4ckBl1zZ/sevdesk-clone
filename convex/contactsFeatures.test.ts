import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm } from "./catalog.fixtures";
import { invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";

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
