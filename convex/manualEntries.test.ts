import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

async function failure(p: Promise<unknown>): Promise<{ code: string; message: string; reason?: string }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return {
      code: String(data.code ?? errorCode(e)),
      message: String(data.message ?? (e as Error).message),
      ...(data.reason ? { reason: String(data.reason) } : {}),
    };
  }
  throw new Error("expected an error");
}

const beleg = async (t: TestT): Promise<{ storageId: Id<"_storage">; name: string }> => ({
  storageId: await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4 Eigenbeleg"], { type: "application/pdf" }))),
  name: "eigenbeleg.pdf",
});

describe("ACC-011 manual journal entries", () => {
  test("ACC-011 E-ACC-01 E-ACC-02 a balanced entry with a Beleg is posted with the VAT split, cost centre and attachment", async () => {
    const t = makeT();
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const lines = [
      { account: "4930", debitCents: 11_900, creditCents: 0, taxKey: "VSt19" },
      { account: "1200", debitCents: 0, creditCents: 11_900 },
    ];
    const noBeleg = await failure(
      owner.mutation(api.manualEntries.create, { date: "2026-09-10", text: "Bürobedarf bar", lines, attachments: [] }),
    );
    expect(noBeleg.reason).toBe("E-ACC-02");
    const unbalanced = await failure(
      owner.mutation(api.manualEntries.create, {
        date: "2026-09-10",
        text: "Bürobedarf",
        lines: [lines[0] as (typeof lines)[number], { account: "1200", debitCents: 0, creditCents: 11_000 }],
        attachments: [await beleg(t)],
      }),
    );
    expect(unbalanced.message).toBe("Soll und Haben sind nicht ausgeglichen (Differenz: 9,00 €).");

    const r = await owner.mutation(api.manualEntries.create, {
      date: "2026-09-10",
      text: "Bürobedarf",
      lines,
      attachments: [await beleg(t)],
    });
    const entry = await t.run((ctx) => ctx.db.get(r.entryId));
    expect(entry?.source).toEqual({ kind: "manual", id: r.manualEntryId });
    expect(entry?.explanation).toBe("M1");
    expect(entry?.attachments).toHaveLength(1);
    expect(entry?.lines.map((l) => [l.account, l.debitCents, l.creditCents, l.taxKey ?? null])).toEqual([
      ["4930", 10_000, 0, "VSt19"],
      ["1576", 1_900, 0, null],
      ["1200", 0, 11_900, null],
    ]);
    expect(entry?.lines[1]?.taxPeriod).toBe("2026-09");
    const stored = await t.run((ctx) => ctx.db.get(r.manualEntryId));
    expect(stored?.lines[0]).toMatchObject({ account: "4930", debitCents: 11_900, taxKey: "VSt19" });
  });

  test("ACC-011 E-ACC-10 a direct posting on a VAT account needs confirmation", async () => {
    const t = makeT();
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const args = {
      date: "2026-09-10",
      text: "Korrektur Vorsteuer",
      lines: [
        { account: "1576", debitCents: 500, creditCents: 0 },
        { account: "1200", debitCents: 0, creditCents: 500 },
      ],
      attachments: [await beleg(t)],
    };
    const warn = await failure(owner.mutation(api.manualEntries.create, args));
    expect(warn).toMatchObject({ reason: "WARNINGS_UNACKNOWLEDGED" });
    const r = await owner.mutation(api.manualEntries.create, { ...args, acknowledgedWarnings: ["E-ACC-10"] });
    expect(r.seq).toBe(1);
  });

  test("ACC-011 E-ACC-04 E-ACC-05 the Gegenbuchung is refused in a locked period, posts once in an open one", async () => {
    const t = makeT();
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const r = await owner.mutation(api.manualEntries.create, {
      date: "2026-08-20",
      text: "Darlehensauszahlung",
      templateKey: "loan_payout",
      lines: [
        { account: "1200", debitCents: 500_000, creditCents: 0 },
        { account: "0630", debitCents: 0, creditCents: 500_000 },
      ],
      attachments: [await beleg(t)],
    });
    await owner.mutation(api.periods.lock, { period: "2026-08" });
    const locked = await failure(
      owner.mutation(api.manualEntries.reverse, { entryId: r.entryId, date: "2026-08-31", reason: "Falsches Konto" }),
    );
    expect(locked.code).toBe("period_locked");
    // a new manual entry into the locked month is refused as well (user-dated)
    const lockedNew = await failure(
      owner.mutation(api.manualEntries.create, {
        date: "2026-08-21",
        text: "Nachtrag",
        lines: [
          { account: "4930", debitCents: 100, creditCents: 0 },
          { account: "1200", debitCents: 0, creditCents: 100 },
        ],
        attachments: [await beleg(t)],
      }),
    );
    expect(lockedNew.code).toBe("period_locked");

    const back = await owner.mutation(api.manualEntries.reverse, {
      entryId: r.entryId,
      date: "2026-09-01",
      reason: "Falsches Konto",
    });
    const rev = await t.run((ctx) => ctx.db.get(back.entryId));
    expect(rev).toMatchObject({ reversalOfId: r.entryId, explanation: "M-storno", date: "2026-09-01" });
    expect(rev?.text).toBe("Gegenbuchung: Darlehensauszahlung");
    expect(rev?.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([
      ["1200", 0, 500_000],
      ["0630", 500_000, 0],
    ]);
    const twice = await failure(
      owner.mutation(api.manualEntries.reverse, { entryId: r.entryId, date: "2026-09-02", reason: "nochmal" }),
    );
    expect(twice.code).toBe("already_reversed");
  });

  test("ACC-011 templates resolve accounts per chart, the default bank account and roles", async () => {
    const t = makeT();
    await setupBooks(t);
    const viewer = await t.asUser("viewer");
    const templates = await viewer.query(api.manualEntries.templates, { date: "2026-09-01" });
    const payout = templates.find((x) => x.key === "loan_payout");
    expect(payout?.lines).toEqual([
      { side: "debit", account: "1200" },
      { side: "credit", account: "0630" },
    ]);
    const car = templates.find((x) => x.key === "car_private_use");
    expect(car?.lines).toEqual([
      { side: "debit", account: "1800" },
      { side: "credit", account: expect.any(String), taxKey: "USt19" },
    ]);
    // viewers cannot post
    expect(
      (
        await failure(
          viewer.mutation(api.manualEntries.create, { date: "2026-09-01", text: "x", lines: [], attachments: [] }),
        )
      ).code,
    ).toBe("forbidden_role");
  });
});
