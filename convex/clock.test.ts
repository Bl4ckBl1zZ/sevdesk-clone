import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { makeT } from "./test.setup";

/** F12 AUD-019 / GOBD-22 / EC-027: the 10-minute clock check, its banner data and the > 60 s block. */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const REF = "https://time.example.test";

describe("clock monitoring (AUD-019)", { timeout: 30_000 }, () => {
  test("AUD-019 EC-027 > 2 s warns, > 60 s alerts and blocks payments and Storno until a good reading", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const account = await t.run((ctx) => defaultInvoiceAccount(ctx));
    if (!account) throw new Error("no account");
    const pay = () =>
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "clearing", accountId: account._id },
        date: "2026-10-12",
        amountCents: 1_000,
      });

    expect(await t.mutation(internal.system.recordClock, { offsetMs: 400, reference: REF })).toBe("ok");
    expect(await t.mutation(internal.system.recordClock, { offsetMs: 5_000, reference: REF })).toBe("warning");
    expect(await owner.query(api.system.clock, {})).toMatchObject({ status: "warning", offsetMs: 5_000 });
    await pay(); // a warning does not block

    expect(await t.mutation(internal.system.recordClock, { offsetMs: -90_000, reference: REF })).toBe("error");
    expect(errorCode(await pay().catch((e: unknown) => e))).toBe("clock_skew");
    expect(errorCode(await owner.mutation(api.corrections.cancel, { id }).catch((e: unknown) => e))).toBe("clock_skew");
    const open = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(open.find((n) => n.kind === "clock.skew_critical" && n.resolvedAt === undefined)).toBeDefined();
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits.filter((a) => a.action === "system.clock")).toHaveLength(2);

    await t.mutation(internal.system.recordClock, { offsetMs: 200, reference: REF });
    await pay();
    const after = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(after.find((n) => n.kind === "clock.skew_critical")?.resolvedAt).toBeDefined();
  });

  test("AUD-019 a stale blocking reading (> 30 min, cron stopped) does not block; the cron skips under IS_TEST", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const account = await t.run((ctx) => defaultInvoiceAccount(ctx));
    if (!account) throw new Error("no account");
    await t.mutation(internal.system.recordClock, { offsetMs: 120_000, reference: REF });
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: account._id },
      date: "2026-10-12",
      amountCents: 1_000,
    });
    expect(await t.action(internal.system.clockCron, {})).toBeNull();
  });
});
