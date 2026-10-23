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

  test("E-AUD-11 E-AUD-12 the banner data carries the F12 texts; > 60 s refuses with „Fertigstellen gesperrt: …“", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await t.mutation(internal.system.recordClock, { offsetMs: 4_200, reference: REF });
    expect(await owner.query(api.system.clock, {})).toMatchObject({
      status: "warning",
      detail: "Die Serverzeit weicht um 4,2 s ab. Bitte Zeitsynchronisation (NTP) prüfen.",
    });
    await t.mutation(internal.system.recordClock, { offsetMs: 75_000, reference: REF });
    const e = await owner.mutation(api.corrections.cancel, { id }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("clock_skew");
    expect((e as { data: { message: string } }).data.message).toBe(
      "Fertigstellen gesperrt: Die Serverzeit weicht um 75 s ab.",
    );
  });

  test("E-AUD-13 an unreachable reference does not block; after 1 h without a good reading it warns", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    expect(await t.mutation(internal.system.recordClock, { offsetMs: 300, reference: REF })).toBe("ok");
    for (const min of [10, 20, 30, 40, 50]) {
      vi.setSystemTime(new Date(NOW.getTime() + min * 60_000));
      expect(await t.mutation(internal.system.recordClock, { offsetMs: null, reference: REF })).toBe("unknown");
    }
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    expect(await t.mutation(internal.system.recordClock, { offsetMs: null, reference: REF })).toBe("warning");
    expect(await owner.query(api.system.clock, {})).toMatchObject({
      status: "warning",
      offsetMs: null,
      detail: "Zeitquelle nicht erreichbar – Abweichung kann nicht geprüft werden.",
    });
    const account = await t.run((ctx) => defaultInvoiceAccount(ctx));
    if (!account) throw new Error("no account");
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: account._id },
      date: "2026-10-12",
      amountCents: 1_000,
    }); // not blocked
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
