import { afterEach, describe, expect, test, vi } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { enc, ingest } from "./inbox.fixtures";
import { b2bBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { postJournalEntry } from "./model/journal";
import {
  checklistFor,
  closedMonths,
  lockMonths,
  monthEnd,
  notifyPeriodLock,
  periodLockSuggestion,
  previewLock,
} from "./model/periodLock";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, setupCompany, upload } from "./vouchers.fixtures";

/**
 * F08 ACC-015…ACC-018 Festschreibung: the checklist branches (bank statements, inbox, bank rows, Geldtransit,
 * backdated cash, pending artifacts), the planning errors, an existing `open` period row and the stamping of records
 * that have no journal posting.
 */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
const norm = (s: string) => s.replace(/\s/g, " ");

afterEach(() => {
  vi.useRealTimers();
});

function fakeNow(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

async function bankAccount(
  t: TestT,
  name: string,
  ledgerAccount: string,
  o: { currency?: string; archivedAt?: number } = {},
): Promise<Id<"bankAccounts">> {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name,
        currency: o.currency ?? "EUR",
        iban: "DE02120300000000202051",
        accountHolder: "Muster",
        ledgerAccount,
        showOnInvoices: false,
        isDefaultForInvoices: false,
        autoApplyMatches: false,
        ...(o.archivedAt !== undefined ? { archivedAt: o.archivedAt } : {}),
      },
      { action: "settings.bank_account.create" },
    ),
  );
}

async function statement(
  t: TestT,
  accountId: Id<"bankAccounts">,
  periodFrom: string,
  periodTo: string,
  o: { closingBalanceCents?: number; rolledBack?: boolean } = {},
) {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankStatements",
      {
        accountId,
        periodFrom,
        periodTo,
        periodStartUtc: Date.parse(`${periodFrom}T00:00:00Z`),
        periodEndUtc: Date.parse(`${periodTo}T23:59:59Z`),
        format: "camt053",
        ...(o.closingBalanceCents !== undefined
          ? { openingBalanceCents: 0, closingBalanceCents: o.closingBalanceCents }
          : {}),
        reconciled: true,
        ...(o.rolledBack ? { rolledBack: true } : {}),
        uploadedAt: Date.now(),
        retentionUntil: "2036-12-31",
      },
      { action: "bank.import", label: `Kontoauszug ${periodFrom}–${periodTo}` },
    ),
  );
}

describe("pre-lock checklist (ACC-017)", () => {
  test("ACC-017 E-ACC-33 EC-156 TST-ACC-28 a statement closing balance ≠ ledger blocks; a rolled-back statement counts as missing; statements without a closing balance, ending mid-month or in foreign currency are not compared", async () => {
    fakeNow("2026-10-20T10:00:00Z");
    const t = makeT();
    const { bank } = await setupBooks(t, { bookkeepingStartDate: "2026-07-01" });
    await statement(t, bank, "2026-07-01", "2026-07-31", { closingBalanceCents: 0, rolledBack: true });
    await statement(t, bank, "2026-08-01", "2026-08-31", { closingBalanceCents: 5_000 });
    await statement(t, bank, "2026-09-01", "2026-10-15", { closingBalanceCents: 999 });
    const pocket = await bankAccount(t, "Revolut Pocket", "1210");
    await statement(t, pocket, "2026-07-01", "2026-09-30");
    const usd = await bankAccount(t, "Revolut USD", "1220", { currency: "USD" });
    await statement(t, usd, "2026-07-01", "2026-09-30", { closingBalanceCents: 12_345 });
    await bankAccount(t, "Altes Konto", "1230", { archivedAt: Date.now() });
    const savings = await bankAccount(t, "Tagesgeld", "1240");
    await statement(t, savings, "2026-07-01", "2026-09-30", { closingBalanceCents: 0 });

    const owner = await t.asUser("owner");
    const preview = await owner.query(api.periods.lockPreview, { period: "2026-09" });
    expect(preview.months).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(preview.checklist.ok).toBe(false);
    expect(preview.checklist.blockers.map((b) => [b.code, norm(b.message)])).toEqual([
      [
        "bank_balance_mismatch",
        "Kontosaldo 1200 Revolut EUR zum 31.08.2026 weicht vom Kontoauszug ab (-50,00 €). Festschreibung nicht möglich.",
      ],
    ]);
    expect(preview.checklist.warnings.filter((w) => w.code === "missing_statement").map((w) => w.message)).toEqual([
      "Kontoauszug 07/2026 für Revolut EUR fehlt (CAMT.053 + PDF).",
    ]);
    const err = await owner.mutation(api.periods.lock, { period: "2026-09" }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("period_lock_blocked");
    expect(dataOf(err).reasons).toBe("bank_balance_mismatch");
    expect(norm(messageOf(err))).toContain("Kontosaldo 1200 Revolut EUR zum 31.08.2026");
    expect(await t.run((ctx) => ctx.db.query("periods").collect())).toEqual([]);
  });

  test("ACC-017 an empty month list gives an empty checklist; open bank rows and unbooked inbox items of the month are warnings, not blockers", async () => {
    fakeNow("2026-10-20T10:00:00Z");
    const t = makeT();
    const { bank } = await setupBooks(t);
    const empty = await t.run((ctx) => checklistFor(ctx, [], Date.now()));
    expect(empty).toEqual({ ok: true, blockers: [], warnings: [] });

    await bookedTransaction(t, bank, { bookingDate: "2026-10-05", amountCents: -2_500, purpose: "Kartenzahlung" });
    await bookedTransaction(t, bank, { bookingDate: "2026-09-30", amountCents: 1_000, purpose: "Vormonat" });
    const owner = await t.asUser("owner");
    await ingest(t, owner, [{ bytes: enc("%PDF-1.4 inbox beleg"), name: "beleg.pdf" }]);
    const cl = await t.run((ctx) => checklistFor(ctx, ["2026-10"], Date.now()));
    expect(cl.ok).toBe(true);
    const codes = cl.warnings.map((w) => w.code);
    expect(codes).toContain("unbooked_vouchers");
    expect(cl.warnings.find((w) => w.code === "unbooked_vouchers")?.message).toBe(
      "1 Belege im Posteingang sind noch nicht gebucht.",
    );
    expect(cl.warnings.find((w) => w.code === "unmatched_bank_transactions")?.message).toBe(
      "1 Bankumsätze sind noch nicht zugeordnet oder gebucht.",
    );
    expect(cl.warnings.find((w) => w.code === "missing_statement")?.message).toBe(
      "Kontoauszug 10/2026 für Revolut EUR fehlt (CAMT.053 + PDF).",
    );
  });

  test("ACC-017 E-ACC-17 a finalised invoice whose PDF/XML pipeline is still pending blocks the lock of its month", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const doc = await t.run((ctx) => ctx.db.get(id as Id<"salesDocuments">));
    expect(doc?.artifactStatus).toBe("pending");
    const month = (doc?.documentDate ?? "").slice(0, 7);
    const cl = await t.run((ctx) => checklistFor(ctx, [month], Date.now()));
    expect(cl.blockers).toEqual([
      { code: "pending_artifacts", message: "1 Dokumente werden noch verarbeitet. Bitte warten.", count: 1 },
    ]);
    await settle(t);
    const after = await t.run((ctx) => checklistFor(ctx, [month], Date.now()));
    expect(after.blockers).toEqual([]);
  });

  test("ACC-017 E-ACC-18 a cash deposit recorded more than 10 days late is listed as backdated and leaves Geldtransit open until the bank side arrives", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const today = berlinCalendarDate(Date.now()) as CalendarDate;
    const date = addDays(today, -15);
    await t.model(OWNER, (ctx) =>
      postJournalEntry(ctx, {
        kind: "opening_balance",
        fiscalYear: Number(date.slice(0, 4)),
        date: `${date.slice(0, 4)}-01-01`,
        part: { kind: "cash", amountCents: 50_000 },
      }),
    );
    await f.owner.action(api.cash.recordTransfer, {
      kind: "deposit_to_bank",
      date,
      amountCents: 20_000,
      bankAccountId: f.bankAccount,
      backdateReason: "Nachtrag aus den Belegen",
    });
    const cl = await t.run((ctx) => checklistFor(ctx, [date.slice(0, 7)], Date.now()));
    expect(cl.ok).toBe(true);
    expect(norm(cl.warnings.find((w) => w.code === "transit_open")?.message ?? "")).toBe(
      "Geldtransit ist nicht ausgeglichen (200,00 €). Fehlt die Gegenbuchung?",
    );
    expect(cl.warnings.filter((w) => w.code === "backdated_cash").map((w) => w.message)).toEqual([
      `Bargeld eingezahlt vom ${formatGermanDate(date)} wurde erst am ${formatGermanDate(today)} erfasst – bitte prüfen.`,
    ]);
    // a cash payment and a deposit recorded on their day are not listed; other months are ignored
    await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id as Id<"salesDocuments">,
      source: { kind: "cash" },
      date: today,
      amountCents: 10_000,
    });
    await f.owner.action(api.cash.recordTransfer, {
      kind: "deposit_to_bank",
      date: today,
      amountCents: 5_000,
      bankAccountId: f.bankAccount,
    });
    const now = await t.run((ctx) => checklistFor(ctx, [today.slice(0, 7)], Date.now()));
    expect(now.warnings.filter((w) => w.code === "backdated_cash")).toEqual(
      date.slice(0, 7) === today.slice(0, 7) ? [expect.objectContaining({ code: "backdated_cash" })] : [],
    );
    // ACC-015: the lock stamps the cash transfers of the month
    const r = await t.model(OWNER, (ctx) => lockMonths(ctx, [date.slice(0, 7)], "manual"));
    expect(r.months).toEqual([date.slice(0, 7)]);
    const transfers = await t.run((ctx) => ctx.db.query("cashTransfers").collect());
    expect(transfers.find((c) => c.date === date)?.lockedAt).toBeTypeOf("number");
  });
});

describe("records before the Buchungsbeginn (ACC-015, E-ACC-22)", () => {
  test("ACC-015 E-ACC-22 ACC-017 an invoice and a voucher finalised before the Buchungsbeginn have no posting and are stamped by their own date; drafts block", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { supplier } = await setupCompany(t);
    const today = berlinCalendarDate(Date.now()) as CalendarDate;
    const month = today.slice(0, 7);
    const nextMonth = addDays(monthEnd(month), 1);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { bookkeepingStartDate: nextMonth }, { action: "settings.tax.update" }),
    );
    const { personId } = await b2bBuyer(owner);
    const inv = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: inv.id, version: 1 });
    await settle(t);
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({ supplierName: "Büro Schmidt GmbH" }),
    });
    // a voucher draft and an invoice draft dated in the month block the lock
    const blocked = await t.run((ctx) => checklistFor(ctx, [month], Date.now()));
    expect(blocked.blockers.map((b) => b.code)).toEqual(["drafts"]);
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    const ok = await t.run((ctx) => checklistFor(ctx, [month], Date.now()));
    expect(ok.blockers).toEqual([]);
    const posted = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(posted).toEqual([]);
    void supplier;
    const r = await t.model(OWNER, (ctx) => lockMonths(ctx, [month], "manual"));
    expect(r.lockedRecords).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(inv.id as Id<"salesDocuments">)))?.lockedAt).toBeTypeOf("number");
    expect((await t.run((ctx) => ctx.db.get(voucherId)))?.lockedAt).toBeTypeOf("number");
  });
});

describe("lock planning and stamping (ACC-015, ACC-016, ACC-018)", () => {
  test("ACC-015 an invalid period is refused; without a company profile the lock cannot be planned", async () => {
    const t = makeT();
    const none = await t.run((ctx) => previewLock(ctx, "2026-09", Date.now())).catch((e: unknown) => e);
    expect(errorCode(none)).toBe("setup_incomplete");
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const bad = await owner.query(api.periods.lockPreview, { period: "2026-13" }).catch((e: unknown) => e);
    expect(errorCode(bad)).toBe("invalid_input");
    expect(messageOf(bad)).toBe("Ungültiger Zeitraum (JJJJ-MM).");
  });

  test("ACC-016 an existing open period row becomes locked; already locked months are skipped by lockMonths", async () => {
    fakeNow("2026-10-20T10:00:00Z");
    const t = makeT();
    await setupBooks(t);
    await t.model(OWNER, (ctx) =>
      auditedInsert(ctx, "periods", { period: "2026-02", status: "open" }, { action: "period.lock", label: "2026-02" }),
    );
    // E-ACC-20: a month left in `locking` is finished by the next lock
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        { period: "2026-01", status: "locking" },
        { action: "period.lock", label: "2026-01" },
      ),
    );
    const first = await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-01", "2026-02"], "manual"));
    expect(first.months).toEqual(["2026-01", "2026-02"]);
    const again = await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-02", "2026-03"], "datev_export"));
    expect(again.months).toEqual(["2026-03"]);
    const rows = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(rows.map((r) => [r.period, r.status, r.reason]).sort()).toEqual([
      ["2026-01", "locked", "manual"],
      ["2026-02", "locked", "manual"],
      ["2026-03", "locked", "datev_export"],
    ]);
    expect([...(await t.run(async (ctx) => [...(await closedMonths(ctx))]))].sort()).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(
      audit.filter((a) => a.action === "period.lock" && a.entity.label === "2026-02").length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("ACC-015 RI-13 the lock stamps records without a journal posting by their own date: bank rows and an invoice before the Buchungsbeginn", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const doc = await t.run((ctx) => ctx.db.get(f.id as Id<"salesDocuments">));
    const month = (doc?.documentDate ?? "").slice(0, 7);
    const tx = await bookedTransaction(t, f.bankAccount, {
      bookingDate: `${month}-01`,
      amountCents: -1_000,
      purpose: "Gebühr",
    });
    const before = await t.run((ctx) => checklistFor(ctx, [month], Date.now()));
    expect(before.blockers).toEqual([]);
    const r = await t.model(OWNER, (ctx) => lockMonths(ctx, [month], "manual"));
    expect(r.months).toEqual([month]);
    expect(r.lockedRecords).toBeGreaterThanOrEqual(2);
    expect((await t.run((ctx) => ctx.db.get(tx)))?.lockedAt).toBeTypeOf("number");
    expect((await t.run((ctx) => ctx.db.get(f.id as Id<"salesDocuments">)))?.lockedAt).toBeTypeOf("number");
    // a second run stamps nothing again
    const again = await t.model(OWNER, (ctx) => lockMonths(ctx, [month], "manual"));
    expect(again).toEqual({ months: [], lockedRecords: 0 });
  });

  test("ACC-015 a payment and its journal entry are stamped once; posted vouchers and documents follow their journal period", async () => {
    fakeNow("2026-10-20T10:00:00Z");
    const t = makeT();
    const b = await setupBooks(t);
    await post(t, invoiceEvent(b.customer, "d1", "2026-04-10", 10_000));
    const paymentId = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "payments",
        {
          target: { kind: "salesDocument", id: "d1" },
          contactId: b.customer,
          date: "2026-04-20",
          amountCents: 11_900,
          currency: "EUR",
          source: { kind: "cash" },
          differences: [],
          journalEntryIds: [],
          actor: OWNER.actor,
          recordedAt: Date.parse("2026-05-15T10:00:00Z"),
        },
        { action: "payment.record" },
      ),
    );
    await post(t, {
      kind: "payment_received",
      paymentId,
      date: "2026-04-20",
      means: { kind: "cash" },
      amountCents: 11_900,
      target: { kind: "salesDocument", id: "d1" },
      contactId: b.customer,
    });
    // ACC-017 (3): the cash payment recorded on 15.05. for 20.04. is listed as backdated
    const cl = await t.run((ctx) => checklistFor(ctx, ["2026-04"], Date.now()));
    expect(cl.warnings.find((w) => w.code === "backdated_cash")?.message).toBe(
      "Barzahlung vom 20.04.2026 wurde erst am 15.05.2026 erfasst – bitte prüfen.",
    );
    const march = await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-03"], "manual"));
    expect(march).toEqual({ months: ["2026-03"], lockedRecords: 0 });
    const r = await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-04"], "manual"));
    expect(r.lockedRecords).toBe(3);
    expect((await t.run((ctx) => ctx.db.get(paymentId)))?.lockedAt).toBeTypeOf("number");
  });

  test("ACC-018 without any booking the suggestion starts today and no reminder is sent", async () => {
    fakeNow("2026-10-20T10:00:00Z");
    const t = makeT();
    const s = await t.run((ctx) => periodLockSuggestion(ctx, Date.now()));
    expect(s.overdue).toEqual([]);
    expect(s.reminder).toBeNull();
    expect(await t.asSystem("cron.deadlines.notify").model((ctx) => notifyPeriodLock(ctx))).toBe(0);
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const view = await owner.query(api.periods.overview, {});
    expect(view.fiscalYear).toBe(2026);
    expect(view.currentPeriod).toBe("2026-10");
    expect(view.months).toHaveLength(12);
    expect(view.months.every((m) => m.status === "open")).toBe(true);
  });
});
