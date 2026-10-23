/**
 * F06 §5.2/§5.3 edge cases that need the database (locks, payments, versions, approvals, recurring templates, inbox
 * links). One test per ID with the exact German message of the spec table.
 */
import { describe, expect, test } from "vitest";
import { formatEuro } from "../src/domain/money";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ingest, installInboxFakes, item, settleInbox } from "./inbox.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { postJournalEntry } from "./model/journal";
import { generateDueRecurringVouchers } from "./model/recurringVouchers";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, pdfBytes, setupCompany, TODAY, upload, YEAR } from "./vouchers.fixtures";

installInboxFakes();

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string; data: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e) ?? "unknown", message: String(data.message ?? (e as Error).message), data };
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<TestT["asUser"]>>;
const voucher = (t: TestT, id: Id<"vouchers">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"vouchers">>;
const entriesOf = (t: TestT, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", id))
      .collect(),
  );

async function draft(t: TestT, owner: Owner, over: Record<string, unknown> = {}) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header(over) });
  return voucherId;
}

async function lockPeriod(t: TestT, period: string) {
  await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "periods",
      { period, status: "locked", lockedAt: Date.now(), lockedBy: "user:test-owner", reason: "ustva_submitted" },
      { action: "period.lock" },
    ),
  );
}

describe("F06 §5.2 voucher edge cases with the database", () => {
  test("EC-VOU-18 GOBD-06 editing a booked voucher in a locked period is refused (409) — voucher lock and period lock", async () => {
    const msg = "Der Beleg ist festgeschrieben und kann nicht geändert werden. Bitte stornieren und neu erfassen.";
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const a = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id: a });
    await lockPeriod(t, TODAY.slice(0, 7));
    const byPeriod = await errorOf(
      owner.mutation(api.vouchers.correct, { id: a, input: { internalNote: "x" }, reason: "Konto falsch" }),
    );
    expect(byPeriod).toMatchObject({ code: "period_locked", message: msg });

    const t2 = makeT();
    await setupCompany(t2);
    const owner2 = await t2.asUser("owner");
    const b = await draft(t2, owner2);
    await owner2.mutation(api.vouchers.finalize, { id: b });
    await t2.model(OWNER, (ctx) =>
      auditedPatch(ctx, "vouchers", b, { lockedAt: Date.now() }, { action: "voucher.lock" }),
    );
    const byLock = await errorOf(
      owner2.mutation(api.vouchers.correct, { id: b, input: { internalNote: "x" }, reason: "Konto falsch" }),
    );
    expect(byLock).toMatchObject({ code: "immutable_record", message: msg });
    expect((await voucher(t2, b)).internalNote).toBeUndefined();
  });

  test("EC-VOU-19 GOBD-06 a correction without reason is blocked and changes nothing", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id });
    const before = await voucher(t, id);
    for (const reason of ["", "   "]) {
      const e = await errorOf(
        owner.mutation(api.vouchers.correct, { id, input: { lines: [line({ account: "6815" })] }, reason }),
      );
      expect(e).toMatchObject({ code: "invalid_input", message: "Bitte einen Grund für die Korrektur angeben." });
    }
    const after = await voucher(t, id);
    expect(after.version).toBe(before.version);
    expect((await entriesOf(t, id)).map((e) => e.explanation)).toEqual(["V1"]);
  });

  test("EC-VOU-20 GOBD-06 a voucher with payments cannot be cancelled until the payment is reversed", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id, payment: { method: "private" } });
    const e = await errorOf(owner.mutation(api.vouchers.cancel, { id, reason: "Doppelt erfasst" }));
    expect(e).toMatchObject({
      code: "invalid_input",
      message: "Der Beleg hat Zahlungen. Bitte zuerst die Zahlungszuordnung stornieren.",
    });
    expect((await voucher(t, id)).status).toBe("paid");
  });

  test("EC-VOU-21 GOBD-06 deleting a booked voucher is refused with immutable_record (409); drafts can be deleted", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const booked = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id: booked });
    const e = await errorOf(owner.mutation(api.vouchers.deleteDraft, { id: booked }));
    expect(e).toMatchObject({ code: "immutable_record", message: "Gebuchte Belege können nicht gelöscht werden." });
    expect((await voucher(t, booked)).status).toBe("open");
    const d = await draft(t, owner);
    await owner.mutation(api.vouchers.deleteDraft, { id: d });
    expect(await voucher(t, d)).toBeNull();
  });

  test("EC-VOU-26 GOBD-06 two parallel finalisations of the same draft: one books, the other fails on the version", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    const { version } = await voucher(t, id);
    const results = await Promise.allSettled([
      owner.mutation(api.vouchers.finalize, { id, version }),
      owner.mutation(api.vouchers.finalize, { id, version }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(errorCode(lost.reason)).toBe("conflict");
    expect((lost.reason as { data?: { message?: string } }).data?.message).toBe(
      "Der Beleg wurde inzwischen geändert. Bitte neu laden.",
    );
    // One number, one booking.
    expect(await t.run((ctx) => ctx.db.query("numberRegister").collect())).toHaveLength(1);
    expect(await entriesOf(t, id)).toHaveLength(1);
    expect((await voucher(t, id)).version).toBe(version + 1);
  });

  test("EC-VOU-34 GOBD-06 editing a recurring template changes only vouchers generated afterwards", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const monthAgo = new Date(Date.UTC(YEAR, Number(TODAY.slice(5, 7)) - 2, 1));
    const first = monthAgo.toISOString().slice(0, 10);
    const rid = await owner.mutation(api.vouchers.createRecurring, {
      name: "Miete Büro",
      template: {
        direction: "expense",
        kind: "standard",
        supplierName: "Vermieter GmbH",
        currency: "EUR",
        priceMode: "gross",
        taxRule: "no_input_vat",
        lines: [line({ account: "6310", description: "Miete", amountCents: 80_000, vatRateBp: 0 })],
      },
      interval: "P1M",
      firstDate: first,
      createAs: "draft",
    });
    // The first occurrence was generated on its date (before the edit).
    const early = await t.model(OWNER, (ctx) =>
      generateDueRecurringVouchers(ctx, Date.UTC(YEAR, Number(TODAY.slice(5, 7)) - 2, 1, 12), rid),
    );
    expect(early.created).toHaveLength(1);
    const old = early.created[0] as Id<"vouchers">;
    const tpl = await t.run((ctx) => ctx.db.get(rid));
    await owner.mutation(api.vouchers.updateRecurring, {
      id: rid,
      version: tpl?.version,
      patch: {
        template: {
          direction: "expense",
          kind: "standard",
          supplierName: "Vermieter GmbH",
          currency: "EUR",
          priceMode: "gross",
          taxRule: "no_input_vat",
          lines: [line({ account: "6310", description: "Miete neu", amountCents: 85_000, vatRateBp: 0 })],
        },
      },
    });
    const later = await owner.mutation(api.vouchers.generateRecurringNow, { id: rid });
    expect(later.created.length).toBeGreaterThan(0);
    expect((await voucher(t, old)).totals.grossCents).toBe(80_000);
    for (const id of later.created) expect((await voucher(t, id)).totals.grossCents).toBe(85_000);
  });

  test("EC-VOU-36 GOBD-02 deleting a draft removes it from the bank-transaction receipt suggestions; the inbox item returns to review", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const tx = await bookedTransaction(t, bank, {
      bookingDate: TODAY,
      amountCents: -11_900,
      purpose: "Rechnung Büro Schmidt",
      counterpartyName: "Büro Schmidt GmbH",
    });
    const r = await ingest(t, owner, [{ bytes: pdfBytes(), name: "schmidt.pdf" }]);
    await settleInbox(t);
    const it = await item(t, r.id);
    const draftId = it.voucherId as Id<"vouchers">;
    await owner.mutation(api.vouchers.updateDraft, { id: draftId, input: header() });
    const suggested = (await owner.query(api.vouchers.missing, {})).transactions.find((x) => x.id === tx);
    expect(suggested?.suggestions.map((s) => s.id)).toEqual([draftId]);

    await owner.mutation(api.vouchers.deleteDraft, { id: draftId });
    const after = (await owner.query(api.vouchers.missing, {})).transactions.find((x) => x.id === tx);
    expect(after?.suggestions).toEqual([]);
    const back = await item(t, r.id);
    expect(back.status).toBe("needs_review");
    expect(back.voucherId).toBeUndefined();
  });

  test("EC-VOU-39 CSH-026 „Bar bezahlt“ beyond the cash balance is refused with the „Privat bezahlt“ hint; nothing is booked", async () => {
    const t = makeT();
    await setupCompany(t);
    await t.model(OWNER, (ctx) =>
      postJournalEntry(ctx, {
        kind: "opening_balance",
        fiscalYear: YEAR,
        date: `${YEAR}-01-01`,
        part: { kind: "cash", amountCents: 5000 },
      }),
    );
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { lines: [line({ amountCents: 8000 })] });
    const preview = await owner.query(api.vouchers.preview, { id, payment: { method: "cash" } });
    const [y, m, d] = TODAY.split("-");
    const msg = `Der Kassenbestand reicht nicht aus: am ${d}.${m}.${y} wären es ${formatEuro(-3000)}. Wurde der Beleg privat bezahlt? Dann bitte ‚Privat bezahlt‘ wählen.`;
    expect(preview.errors).toContainEqual({ code: "cash_negative", message: msg });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id, payment: { method: "cash" } }));
    expect(e).toMatchObject({ code: "cash_negative", message: msg });
    const v = await voucher(t, id);
    expect(v.status).toBe("draft");
    expect(v.internalNumber).toBeUndefined();
    expect(await entriesOf(t, id)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toEqual([]);
    // „Privat bezahlt“ books the same voucher.
    expect((await owner.mutation(api.vouchers.finalize, { id, payment: { method: "private" } })).status).toBe("paid");
  });
});

describe("F06 §5.3 approved Bewirtung and Eigenbeleg are immutable", () => {
  const bewirtung = {
    occasionType: "geschaeftlich" as const,
    occasion: "Projektbesprechung Website-Relaunch mit Müller GmbH",
    participants: ["Anna Müller (Müller GmbH)", "Max Mustermann"],
    host: "Max Mustermann",
    place: "Restaurant Adler, Berlin",
    date: TODAY,
    tipCents: 1000,
    tseConfirmed: true,
  };

  test("EC-BEW-05 MISC-05 editing an approved Bewirtungsbeleg is refused (409); only a superseding version may change it", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      kind: "bewirtung",
      priceMode: "net",
      lines: [
        line({ account: "6640", description: "Speisen", amountCents: 10_000, vatRateBp: 700 }),
        line({ account: "6640", description: "Trinkgeld", amountCents: 1000, vatRateBp: 0 }),
      ],
    });
    await owner.action(api.vouchers.approveBewirtungBeleg, { id, data: bewirtung });
    const e = await errorOf(
      owner.mutation(api.vouchers.updateDraft, {
        id,
        input: { bewirtung: { ...bewirtung, occasion: "Projektbesprechung Shop mit Müller GmbH" } },
      }),
    );
    expect(e).toMatchObject({
      code: "immutable_record",
      message: "Der Bewirtungsbeleg ist freigegeben und unveränderbar. Bitte eine berichtigte Fassung erstellen.",
    });
    expect((await voucher(t, id)).bewirtung?.occasion).toBe(bewirtung.occasion);
  });

  test("EC-EIG-04 GOBD-06 an approved Eigenbeleg cannot be edited or approved again", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await owner.mutation(api.vouchers.create, {
      input: {
        kind: "eigenbeleg",
        documentDate: TODAY,
        taxRule: "no_input_vat",
        priceMode: "gross",
        lines: [line({ account: "6673", description: "Parkautomat", amountCents: 400, vatRateBp: 0 })],
      },
    });
    const data = { reason: "not_obtainable" as const, recipient: "Parkhaus Mitte", purpose: "Kundentermin Müller" };
    await owner.action(api.vouchers.approveEigenbelegBeleg, { id, data });
    const msg = "Der Eigenbeleg ist freigegeben und unveränderbar.";
    const edit = await errorOf(
      owner.mutation(api.vouchers.updateDraft, { id, input: { eigenbeleg: { ...data, purpose: "Anderer Zweck" } } }),
    );
    expect(edit).toMatchObject({ code: "immutable_record", message: msg });
    const again = await errorOf(owner.action(api.vouchers.approveEigenbelegBeleg, { id, data }));
    expect(again.message).toBe(msg);
    expect((await voucher(t, id)).eigenbeleg?.purpose).toBe("Kundentermin Müller");
  });
});
