import { describe, expect, test } from "vitest";
import { journalCsv } from "../src/domain/accounting/journal-search";
import { api } from "./_generated/api";
import { invoiceEvent, post, setupBooks } from "./bookkeeping.fixtures";
import { makeT } from "./test.setup";

describe("ACC-025 RPT-008 journal search and Buchungsjournal", () => {
  test("ACC-025 RPT-008 filters by source, account, contact, amount and reversals; the report keeps reversals", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d1", "2026-05-10", 10_000));
    await post(t, invoiceEvent(customer, "d2", "2026-06-10", 50_000));
    const owner = await t.asUser("owner");
    const file = await t.run((ctx) => ctx.storage.store(new Blob(["beleg"], { type: "application/pdf" })));
    const m = await owner.mutation(api.manualEntries.create, {
      date: "2026-06-15",
      text: "Umbuchung Bürobedarf",
      lines: [
        { account: "4930", debitCents: 2_000, creditCents: 0 },
        { account: "1200", debitCents: 0, creditCents: 2_000 },
      ],
      attachments: [{ storageId: file, name: "beleg.pdf" }],
    });
    await owner.mutation(api.manualEntries.reverse, { entryId: m.entryId, date: "2026-06-16", reason: "doppelt" });

    const all = await owner.query(api.accounting.searchJournal, {});
    expect(all.page.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(all.total).toBe(4);
    const manual = await owner.query(api.accounting.searchJournal, { sourceKind: "manual", sort: "seq_asc" });
    expect(manual.page.map((e) => e.seq)).toEqual([3, 4]);
    expect((await owner.query(api.accounting.searchJournal, { account: "4930" })).total).toBe(2);
    expect((await owner.query(api.accounting.searchJournal, { contactId: customer })).total).toBe(2);
    expect((await owner.query(api.accounting.searchJournal, { minCents: 20_000 })).page.map((e) => e.seq)).toEqual([2]);
    expect((await owner.query(api.accounting.searchJournal, { reversals: "exclude" })).page.map((e) => e.seq)).toEqual([
      2, 1,
    ]);
    expect(
      (await owner.query(api.accounting.searchJournal, { from: "2026-06-01", to: "2026-06-30", text: "büro" })).total,
    ).toBe(2);

    const report = await owner.query(api.accounting.journalReport, { from: "2026-06-01", to: "2026-06-30" });
    expect(report.map((e) => [e.seq, e.reversalOfSeq ?? null, e.reversedBySeq ?? null])).toEqual([
      [2, null, null],
      [3, null, 4],
      [4, 3, null],
    ]);
    const csv = journalCsv(report);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1 + report.reduce((s, e) => s + e.lines.length, 0));
  });
});
