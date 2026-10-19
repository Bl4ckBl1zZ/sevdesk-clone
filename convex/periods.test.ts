import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { lockThrough } from "./model/periodLock";
import { makeT } from "./test.setup";

describe("Festschreibung (ACC-015…ACC-017)", () => {
  test("ACC-015 ACC-016 TST-ACC-10 locking 09 with 07–08 open locks 07–09 in one action and stamps lockedAt on every record", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t, { bookkeepingStartDate: "2026-07-01" });
    await post(t, invoiceEvent(customer, "d7", "2026-07-15", 10000));
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 20000));
    await post(t, invoiceEvent(customer, "d10", "2026-10-02", 30000));
    const owner = await t.asUser("owner");
    const preview = await owner.query(api.periods.lockPreview, { period: "2026-09" });
    expect(preview.months).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(preview.gapNotice).toBe(
      "Festschreibung muss lückenlos erfolgen. 07/2026 bis 08/2026 werden mit festgeschrieben.",
    );
    const r = await owner.mutation(api.periods.lock, { period: "2026-09" });
    expect(r.months).toEqual(["2026-07", "2026-08", "2026-09"]);
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.map((p) => [p.period, p.status, p.reason])).toEqual([
      ["2026-07", "locked", "manual"],
      ["2026-08", "locked", "manual"],
      ["2026-09", "locked", "manual"],
    ]);
    expect(periods.every((p) => p.lockedBy === owner.actor && typeof p.lockedAt === "number")).toBe(true);
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").withIndex("by_seq").collect());
    expect(entries.map((e) => [e.period, e.lockedAt !== undefined])).toEqual([
      ["2026-07", true],
      ["2026-09", true],
      ["2026-10", false],
    ]);
    // ACC-006 afterwards: user-dated postings into 09 are refused, external ones move to 10
    expect(await post(t, invoiceEvent(customer, "late", "2026-09-30", 100)).catch(errorCode)).toBe("period_locked");
    // irreversible: locking again is refused
    expect(await owner.mutation(api.periods.lock, { period: "2026-09" }).catch(errorCode)).toBe("period_locked");
    const overview = await owner.query(api.periods.overview, { fiscalYear: 2026 });
    expect(overview.months.filter((m) => m.status === "locked").map((m) => m.period)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  test("ACC-017 E-ACC-16 TST-ACC-11 a draft dated in the period blocks the lock", async () => {
    const t = makeT();
    await setupBooks(t);
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "vouchers",
        {
          direction: "expense",
          kind: "standard",
          status: "draft",
          documentDate: "2026-09-12",
          receivedAt: Date.parse("2026-09-12T10:00:00Z"),
          currency: "EUR",
          priceMode: "net",
          taxRule: "input_vat_deductible",
          totals: { netCents: 0, vatCents: 0, grossCents: 0, selfAssessedVatCents: 0, byRate: [] },
          openAmountCents: 0,
          originalFiles: [],
          renditions: [],
          duplicateDismissals: [],
          tags: [],
          journalEntryIds: [],
          recordedAt: Date.now(),
          retentionClass: "vouchers8",
          actor: OWNER.actor,
          version: 1,
        } as never,
        { action: "voucher.create" },
      ),
    );
    const owner = await t.asUser("owner");
    const preview = await owner.query(api.periods.lockPreview, { period: "2026-09" });
    expect(preview.checklist.blockers.map((b) => b.code)).toEqual(["drafts"]);
    expect(await owner.mutation(api.periods.lock, { period: "2026-09" }).catch(errorCode)).toBe("period_lock_blocked");
    expect(await t.run((ctx) => ctx.db.query("periods").collect())).toEqual([]);
  });

  test("ACC-015 the lock is a bookkeeper/owner action with a fresh session; viewers cannot lock", async () => {
    const t = makeT();
    await setupBooks(t);
    const viewer = await t.asUser("viewer");
    expect(await viewer.mutation(api.periods.lock, { period: "2026-01" }).catch(errorCode)).toBe("forbidden_role");
    const bookkeeper = await t.asUser("bookkeeper");
    expect((await bookkeeper.mutation(api.periods.lock, { period: "2026-01" })).months).toEqual(["2026-01"]);
  });

  test("ACC-016 ACC-015 the model lock records the submission reason (ustva_submitted)", async () => {
    const t = makeT();
    await setupBooks(t);
    await t.model(OWNER, (ctx) => lockThrough(ctx, "2026-03", "ustva_submitted"));
    const rows = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(rows.map((r) => [r.period, r.reason])).toEqual([
      ["2026-01", "ustva_submitted"],
      ["2026-02", "ustva_submitted"],
      ["2026-03", "ustva_submitted"],
    ]);
  });

  test("EC-076 ACC-006 a Storno of an invoice from a locked month is allowed and lands in the first open period", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t, { bookkeepingStartDate: "2026-08-01" });
    await post(t, invoiceEvent(customer, "d8", "2026-08-12", 10000));
    const owner = await t.asUser("owner");
    await owner.mutation(api.periods.lock, { period: "2026-08" });
    await post(t, {
      kind: "invoice_cancelled",
      documentId: "st8",
      documentNumber: "ST-8",
      originalDocumentId: "d8",
      date: "2026-08-20",
    });
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").withIndex("by_seq").collect());
    expect(entries.map((e) => [e.seq, e.period, e.reversalOfId !== undefined])).toEqual([
      [1, "2026-08", false],
      [2, "2026-09", true],
    ]);
    expect(entries[1]?.originalDate).toBe("2026-08-20");
    expect(entries[1]?.latePosting?.reason).toMatch(/08\/2026/);
  });
});
