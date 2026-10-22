import { describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { internal } from "./_generated/api";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { lockMonths } from "./model/periodLock";
import { makeT } from "./test.setup";

describe("ACC-020 journal integrity in integrity.verify", () => {
  test("ACC-020 TST-ACC-23 RI-13 EC-182 an entry recorded after its period's lock (out-of-band write) is reported", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "doc-1", "2026-03-10", 100_000));
    const clean = await t.action(internal.integrity.verify, {});
    expect(clean.findings.filter((f) => f.kind.startsWith("journal_"))).toEqual([]);

    await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-01", "2026-02", "2026-03"], "manual"));
    // Tamper: a raw insert (bypassing the model layer) into the locked March, recorded after the lock.
    await t.run(async (ctx) => {
      const head = await ctx.db.query("journalEntries").withIndex("by_seq").order("desc").first();
      const lock = (await ctx.db.query("periods").collect()).find((p) => p.period === "2026-03");
      if (!head) throw new Error("no entry");
      const { _id, _creationTime, ...copy } = head;
      await ctx.db.insert("journalEntries", {
        ...copy,
        seq: head.seq + 2,
        recordedAt: (lock?.lockedAt ?? 0) + 1_000,
      });
    });
    const r = await t.action(internal.integrity.verify, {});
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["journal_seq_gap", "journal_after_lock"]));
    clearInvariantTarget(); // tampered on purpose
  });

  test("E-ACC-27 GOBD-22 clock skew > 2 s: postings continue with server time, integrity.verify reports a warning", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    expect(
      await t.mutation(internal.system.recordClock, { offsetMs: 5_000, reference: "https://time.example.test" }),
    ).toBe("warning");
    const before = Date.now();
    await post(t, invoiceEvent(customer, "doc-1", "2026-03-10", 100_000));
    const entry = await t.run((ctx) => ctx.db.query("journalEntries").first());
    expect(entry?.recordedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.recordedAt).toBeLessThanOrEqual(Date.now());
    const r = await t.action(internal.integrity.verify, {});
    const skew = r.findings.filter((f) => f.kind === "clock_skew");
    expect(skew).toHaveLength(1);
    expect(skew[0]?.severity).toBe("warning");
    expect(skew[0]?.detail).toMatch(/^Serverzeit weicht ab: 1 Messung\(en\) über 2 s, größte Abweichung 5 s/);
    expect(r.findings.filter((f) => f.kind.startsWith("journal_"))).toEqual([]);
  });
});
