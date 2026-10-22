import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, line, setupCompany, upload } from "./vouchers.fixtures";

const entryOf = (t: TestT, kind: "salesDocument" | "voucher", id: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", kind).eq("source.id", id))
      .first(),
  );

describe("ACC-019 cost centres reach the journal (DATEV KOST1)", { timeout: 30_000 }, () => {
  test("ACC-019 an invoice with a document cost centre posts its revenue line with costCenterId; VAT and receivable stay without", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z")); // invoice fixtures are dated around 09.10.2026
    try {
      const t = makeT();
      const { owner } = await setupInvoicing(t);
      const { personId } = await b2bBuyer(owner);
      await owner.mutation(api.lookups.saveCostCenter, {
        values: { number: "100", name: "Webdesign", isDefault: false },
      });
      const cc = (await owner.query(api.lookups.listCostCenters, {})).find((c) => c.number === "100")
        ?.costCenterId as string;
      const { id } = await owner.mutation(api.invoices.createDraft, {
        values: { ...invoiceValues(personId), costCenterId: cc },
      });
      await owner.action(api.invoices.finalize, { id, version: 1 });
      await settle(t);
      const entry = await entryOf(t, "salesDocument", id);
      const tagged = (entry?.lines ?? []).filter((l) => l.costCenterId);
      expect(tagged.length).toBe(1);
      expect(tagged[0]?.costCenterId).toBe(cc);
      expect(tagged[0]?.creditCents).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ACC-019 a voucher line's cost centre is on its expense journal line", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await owner.mutation(api.lookups.saveCostCenter, { values: { number: "200", name: "Hosting", isDefault: false } });
    const cc = (await owner.query(api.lookups.listCostCenters, {})).find((c) => c.number === "200")
      ?.costCenterId as string;
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({ lines: [line({ costCenterId: cc }), line({ account: "6815", description: "Papier" })] }),
    });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    const entry = await entryOf(t, "voucher", voucherId);
    const tagged = (entry?.lines ?? []).filter((l) => l.costCenterId);
    expect(tagged.map((l) => [l.account, l.debitCents, l.costCenterId])).toEqual([["6805", 10_000, cc]]);
  });
});
