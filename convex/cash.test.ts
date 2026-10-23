/// <reference types="vite/client" />
import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, test } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { postJournalEntry } from "./model/journal";
import inventory from "./mutation-inventory.json";
import { bookedTransaction } from "./payments.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";
import { header, setupCompany, upload } from "./vouchers.fixtures";

/**
 * F07 simple cash (CSH-020…030) edge cases EC-CSH-01…34 through the public functions: never negative now, backdated
 * and on reversal (AO-05, RI-11), immutability, a Beleg for every movement, no cash income without an invoice (AO-04),
 * locked periods and the Quittung reprint. Dates are relative to the real Berlin today (vouchers use it too).
 */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const TODAY = berlinCalendarDate(Date.now());
const day = (n: number) => addDays(TODAY as CalendarDate, n);
const de = (d: string) => formatGermanDate(d as CalendarDate);
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

async function setup() {
  const t = makeT();
  const f = await finalizedInvoice(t);
  return { t, ...f, id: f.id as Id<"salesDocuments"> };
}

async function openingCash(t: TestT, cents: number) {
  await t.model(OWNER, (ctx) =>
    postJournalEntry(ctx, {
      kind: "opening_balance",
      fiscalYear: Number(TODAY.slice(0, 4)),
      date: `${TODAY.slice(0, 4)}-01-01`,
      part: { kind: "cash", amountCents: cents },
    }),
  );
}

const transfers = (t: TestT) => t.run((ctx) => ctx.db.query("cashTransfers").collect());
const payments = (t: TestT) => t.run((ctx) => ctx.db.query("payments").collect());

const deposit = (bankAccountId: Id<"bankAccounts">, date: string, amountCents: number) => ({
  kind: "deposit_to_bank" as const,
  date,
  amountCents,
  bankAccountId,
  ...(date < day(-10) ? { backdateReason: "Nachtrag aus den Belegen" } : {}),
});

describe("CSH-026 never negative (AO-05, RI-11)", () => {
  test("EC-CSH-01 CSH-026 a deposit that would make the till negative today is blocked with the exact message; nothing stored", async () => {
    const { t, owner, bankAccount } = await setup();
    await openingCash(t, 10_000);
    const e = await owner.action(api.cash.recordTransfer, deposit(bankAccount, TODAY, 15_000)).catch((x) => x);
    expect(errorCode(e)).toBe("cash_negative");
    expect(messageOf(e)).toBe(
      `Der Kassenbestand würde negativ werden (−50,00 € am ${de(TODAY)}). Bitte zuerst fehlende Bareinnahmen erfassen oder ‚privat bezahlt‘ wählen.`,
    );
    expect(await transfers(t)).toHaveLength(0);
    expect((await owner.query(api.cash.overview, {})).balanceCents).toBe(10_000);
  });

  test("EC-CSH-02 EC-CSH-03 EC-149 a backdated deposit that dips a later date is blocked; a later inflow does not cure it", async () => {
    const { t, owner, bankAccount } = await setup();
    await openingCash(t, 10_000);
    await owner.action(api.cash.recordTransfer, deposit(bankAccount, day(-5), 8_000));
    // A later inflow (ATM withdrawal into the till, CSH-025) of 100,00 on day −1.
    const atm = await bookedTransaction(t, bankAccount, {
      bookingDate: day(-1),
      amountCents: -10_000,
      purpose: "ATM Berlin Alexanderplatz",
    });
    await owner.action(api.banking.mark, { transactionId: atm, as: "cash_withdrawal" });
    expect((await owner.query(api.cash.overview, {})).balanceCents).toBe(12_000);
    const e = await owner.action(api.cash.recordTransfer, deposit(bankAccount, day(-7), 5_000)).catch((x) => x);
    expect(errorCode(e)).toBe("cash_negative");
    expect(messageOf(e)).toBe(
      `Nicht möglich: Durch die Buchung zum ${de(day(-7))} wäre der Kassenbestand am ${de(day(-5))} negativ (−30,00 €).`,
    );
    expect(await transfers(t)).toHaveLength(2);
  });

  test("EC-CSH-04 CSH-027 reversing a cash receipt whose cash was already deposited is blocked with the Storno message", async () => {
    const { t, owner, bankAccount, id } = await setup();
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: TODAY,
      amountCents: 10_000,
    });
    await owner.action(api.cash.recordTransfer, deposit(bankAccount, TODAY, 8_000));
    const e = await owner
      .mutation(api.payments.reverse, { paymentId: r.paymentIds[0] as Id<"payments">, reason: "Irrtum korrigieren" })
      .catch((x) => x);
    expect(errorCode(e)).toBe("cash_negative");
    expect(messageOf(e)).toBe(`Storno nicht möglich: Der Kassenbestand würde am ${de(TODAY)} negativ werden.`);
    expect((await payments(t)).filter((p) => p.reversalOfId)).toHaveLength(0);
    // Reversing the deposit first (CSH-027, the till goes up again) is fine.
    const [dep] = await transfers(t);
    await owner.mutation(api.cash.reverseTransfer, { id: dep?._id as Id<"cashTransfers">, reason: "zu früh erfasst" });
    expect((await owner.query(api.cash.overview, {})).balanceCents).toBe(10_000);
  });

  test("EC-CSH-08 EC-151 CSH-026 two deposits that are each fine but jointly negative: exactly one is stored, the other gets „Kassenbestand hat sich geändert“", async () => {
    const { t, owner, bankAccount } = await setup();
    await openingCash(t, 10_000);
    const args = deposit(bankAccount, TODAY, 6_000);
    // Both requests pass the pre-check (the action's `transferContext`) before either posts …
    await owner.query(api.cash.transferContext, args);
    await owner.query(api.cash.transferContext, args);
    const eigenbeleg = async (seed: string) => ({
      storageId: await t.run((ctx) => ctx.storage.store(new Blob([`%PDF-1.7 ${seed}`], { type: "application/pdf" }))),
      sha256: "0".repeat(63) + seed,
      bytes: 12,
      mime: "application/pdf",
      name: `Eigenbeleg-${seed}.pdf`,
    });
    // … then the serialisable postings run one after the other: the first wins, the second re-checks and aborts.
    const post = async (seed: string) =>
      t.mutation(internal.cash.recordTransferInternal, {
        actorContext: OWNER,
        ...args,
        eigenbeleg: await eigenbeleg(seed),
        prechecked: true,
      });
    await post("1");
    const e = await post("2").catch((x) => x);
    expect(errorCode(e)).toBe("cash_negative");
    expect(messageOf(e)).toBe("Der Kassenbestand hat sich geändert. Bitte erneut versuchen.");
    expect(await transfers(t)).toHaveLength(1);
    expect((await owner.query(api.cash.overview, {})).balanceCents).toBe(4_000);
    // Through the action (no concurrency) the second attempt is refused by the pre-check with EC-CSH-01.
    const again = await owner.action(api.cash.recordTransfer, args).catch((x) => x);
    expect(messageOf(again)).toMatch(/^Der Kassenbestand würde negativ werden/);
  });
});

describe("CSH-027 immutability, CSH-024 Belege, CSH-029 no POS", () => {
  test("EC-CSH-07 CSH-027 GOBD-06 cash transfers and cash payments are never edited or deleted (model guard, no such function)", async () => {
    const { t, owner, bankAccount, id } = await setup();
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: TODAY,
      amountCents: 10_000,
    });
    const tr = await owner.action(api.cash.recordTransfer, deposit(bankAccount, TODAY, 5_000));
    const patchTransfer = await t
      .model(OWNER, (ctx) => auditedPatch(ctx, "cashTransfers", tr.id, { amountCents: 1 }, { action: "cash.transfer" }))
      .catch(errorCode);
    expect(patchTransfer).toBe("immutable_record");
    const patchPayment = await t
      .model(OWNER, (ctx) =>
        auditedPatch(
          ctx,
          "payments",
          r.paymentIds[0] as Id<"payments">,
          { amountCents: 1 },
          { action: "payment.record" },
        ),
      )
      .catch(errorCode);
    expect(patchPayment).toBe("immutable_record");
    const del = await t
      .run(async (ctx) => {
        const { guardedDb, newWriteStats } = await import("./model/db");
        await guardedDb(ctx.db, newWriteStats()).delete(tr.id);
      })
      .catch(errorCode);
    expect(del).toBe("immutable_record");
    // No public function edits or deletes cash movements or payments — corrections are reversals only.
    const names = Object.keys(inventory as Record<string, unknown>).filter((n) => /^(cash|payments):/.test(n));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => /:(update|edit|patch|delete|remove)/i.test(n))).toEqual([]);
  });

  test("EC-CSH-09 CSH-024 GOBD-07 every cash transfer carries its Eigenbeleg; a movement without one is refused", async () => {
    const { t, owner, bankAccount } = await setup();
    await openingCash(t, 10_000);
    const tr = await owner.action(api.cash.recordTransfer, deposit(bankAccount, TODAY, 5_000));
    const row = await t.run((ctx) => ctx.db.get(tr.id));
    expect(row?.eigenbelegFile?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.journalEntryIds).toHaveLength(1);
    const e = await t
      .mutation(internal.cash.recordTransferInternal, {
        actorContext: OWNER,
        ...deposit(bankAccount, TODAY, 1_000),
      })
      .catch((x) => x);
    expect(messageOf(e)).toBe("Jede Kassenbewegung braucht einen Beleg (Rechnung, Beleg oder Eigenbeleg).");
    expect(await transfers(t)).toHaveLength(1);
  });

  test("EC-CSH-10 CSH-029 AO-04 cash income without an invoice is refused (cash only to a contact's credit)", async () => {
    const { t, owner, personId } = await setup();
    const e = await owner
      .mutation(api.payments.record, {
        source: { kind: "cash" },
        date: TODAY,
        allocations: [{ target: { kind: "contactCredit", id: personId }, amountCents: 5_000 }],
      })
      .catch((x) => x);
    expect(messageOf(e)).toBe(
      "Bareinnahmen ohne Rechnung sind nicht vorgesehen (keine Kassenfunktion). Bitte zuerst eine Rechnung erstellen.",
    );
    expect(await payments(t)).toHaveLength(0);
    // The cash API has no income kind at all: only deposits and private withdrawals (both outflows).
    const sale = await owner
      .action(api.cash.recordTransfer, { kind: "cash_sale" as never, date: TODAY, amountCents: 5_000 })
      .catch((x) => x);
    expect(String(sale)).toMatch(/Validator error|cash_sale/);
  });
});

describe("dating and locked periods (CSH-021, EC-170)", () => {
  test("EC-CSH-18 CSH-021 a cash receipt and a cash transfer dated in a locked period are blocked", async () => {
    const { t, owner, bankAccount, id } = await setup();
    await openingCash(t, 50_000);
    const locked = day(-3);
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        { period: locked.slice(0, 7), status: "locked", lockedAt: Date.now(), lockedBy: OWNER.actor, reason: "manual" },
        { action: "period.lock" },
      ),
    );
    const mm = `${locked.slice(5, 7)}/${locked.slice(0, 4)}`;
    const pay = await owner
      .mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "cash" },
        date: locked,
        amountCents: 10_000,
        acknowledgeWarnings: ["cash_daily_recording"],
      })
      .catch((x) => x);
    // F05 EC-PAY-08 owns the wording (it adds the hint to pick an open period).
    expect(messageOf(pay)).toMatch(new RegExp(`^Der Zeitraum ${mm} ist festgeschrieben\\.`));
    const tr = await owner.action(api.cash.recordTransfer, deposit(bankAccount, locked, 1_000)).catch((x) => x);
    expect(errorCode(tr)).toBe("period_locked");
    expect(await payments(t)).toHaveLength(0);
    expect(await transfers(t)).toHaveLength(0);
  });

  test("EC-CSH-33 CSH-022 a voucher „bar“ with too little cash is blocked with the hint to choose „privat bezahlt“", async () => {
    const t = makeT();
    await setupCompany(t);
    await openingCash(t, 5_000);
    const owner = await t.asUser("owner");
    const { voucherId: id } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, { id, input: header() });
    const e = await owner.mutation(api.vouchers.finalize, { id, payment: { method: "cash" } }).catch((x) => x);
    expect(errorCode(e)).toBe("cash_negative");
    // F06 EC-VOU-39 owns the voucher wording (F07 §12: one message source per rule).
    expect(messageOf(e)).toContain("Wurde der Beleg privat bezahlt? Dann bitte ‚Privat bezahlt‘ wählen.");
    expect(await payments(t)).toHaveLength(0);
    // „Privat bezahlt“ instead books without touching the till (CSH-023).
    await owner.mutation(api.vouchers.finalize, { id, payment: { method: "private" } });
    expect((await owner.query(api.cash.overview, {})).balanceCents).toBe(5_000);
  });

  test("EC-CSH-34 CSH-028 a reprinted Quittung is stamped „Kopie“; the archived original keeps its hash", async () => {
    const { t, owner, id } = await setup();
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: TODAY,
      amountCents: 10_000,
    });
    const paymentId = r.paymentIds[0] as Id<"payments">;
    const first = await owner.action(api.payments.receipt, { paymentId });
    const archived = await t.run(async (ctx) => (await ctx.db.get(paymentId))?.receiptFile);
    const reprint = await owner.action(api.payments.receipt, { paymentId });
    const title = async (b64: string) =>
      (await PDFDocument.load(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).getTitle();
    expect(first.copy).toBe(false);
    expect(await title(first.pdfBase64)).not.toMatch(/Kopie/);
    expect(reprint.copy).toBe(true);
    expect(reprint.name).toMatch(/-Kopie\.pdf$/);
    expect(await title(reprint.pdfBase64)).toMatch(/\(Kopie\)$/);
    const after = await t.run(async (ctx) => (await ctx.db.get(paymentId))?.receiptFile);
    expect(after).toEqual(archived);
  });
});
