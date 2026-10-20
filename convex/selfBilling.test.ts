import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { CONTACT_RANGE, createValues, orgForm } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

describe("Gutschriftsvereinbarung on the supplier contact (F04 §4.9, INV-16, UST-33)", () => {
  test("INV-16 UST-33 an agreement is stored and removed audited; an incomplete one is refused", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [CONTACT_RANGE] } });
    const { id } = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Agentur Nord GmbH", { vatId: "DE811907980" })),
    });
    const agreement = { agreedOn: "2026-01-02", scope: "Provisionsabrechnungen", validFrom: "2026-01-01" };
    await owner.mutation(api.contacts.setSelfBillingAgreement, { id, agreement });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored?.selfBillingAgreement).toEqual(agreement);
    const err = await owner
      .mutation(api.contacts.setSelfBillingAgreement, { id, agreement: { ...agreement, scope: "" } })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
    await owner.mutation(api.contacts.setSelfBillingAgreement, { id, agreement: null });
    expect((await t.run((ctx) => ctx.db.get(id)))?.selfBillingAgreement).toBeUndefined();
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((e) => e.action).filter((a) => a.includes("self_billing"))).toEqual([
      "contact.self_billing_agreement",
      "contact.self_billing_agreement_removed",
    ]);
    const viewer = await t.asUser("viewer");
    const denied = await viewer
      .mutation(api.contacts.setSelfBillingAgreement, { id, agreement })
      .catch((e: unknown) => e);
    expect(errorCode(denied)).toBe("forbidden_role");
  });
});
