import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { b2bBuyer, finalizedInvoice, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { recordPayment } from "./model/payments";
import { lockMonths } from "./model/periodLock";
import { bookedTransaction } from "./payments.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 §5.1 payment edge cases (EC-PAY-*) in Convex. The invoice is T-GLD-01: 1.000,00 net + 190,00 VAT = 1.190,00,
 * dated 2026-10-12 (the clock), 30 days, 2 % Skonto within 14 days.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
const reasonOf = (e: unknown) => dataOf(e).reason;

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const docOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"salesDocuments">);

const entriesOf = (t: TestT, paymentId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", paymentId))
      .collect(),
  );

type Owner = Awaited<ReturnType<typeof finalizedInvoice>>["owner"];

async function invoice(t: TestT, over: Partial<DraftValues> = {}) {
  const f = await finalizedInvoice(t, over);
  return { ...f, id: f.id as Id<"salesDocuments"> };
}

async function secondInvoice(t: TestT, owner: Owner, contactId: string, over: Partial<DraftValues> = {}) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId, over) });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return id as Id<"salesDocuments">;
}

async function istInvoice(t: TestT, over: Partial<DraftValues> = {}) {
  const setup = await setupInvoicing(t);
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] },
      { action: "settings.company.update" },
    ),
  );
  const { personId } = await b2bBuyer(setup.owner);
  const id = await secondInvoice(t, setup.owner, personId, over);
  return { ...setup, id, personId };
}

const CORRECTION_RANGE = {
  key: "correction",
  name: "Rechnungskorrekturen",
  format: "RK-{YYYY}-{####}",
  resetPolicy: "yearly",
  next: 1,
};

/** An Abschlagsrechnung (3.000,00 net → 3.570,00) to order B-4711 after the T-GLD-01 invoice. */
async function finalizedAdvance(t: TestT) {
  const f = await invoice(t);
  await f.owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [{ ...INVOICE_RANGE, next: 2 }, CORRECTION_RANGE] },
  });
  const { id } = await f.owner.mutation(api.invoices.createDraft, {
    values: invoiceValues(f.personId, {
      type: "advance_invoice",
      supplyDate: { kind: "date", date: "2026-12-15" as CalendarDate },
      chainOrder: { number: "B-4711", date: "2026-09-01" as CalendarDate },
      paymentTerms: { dueDays: 14 },
      lines: [
        {
          kind: "item",
          productType: "service",
          name: "1. Abschlag Website-Relaunch",
          quantityMilli: 1_000,
          unitCode: "C62",
          unitPriceMicros: 30_000_000_000 / 1_000,
          vatRateKey: "standard",
        },
      ],
    }),
  });
  const r = await f.owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { ...f, advanceId: id as Id<"salesDocuments">, advanceNumber: r.number };
}

describe("F05 §5.1 EC-PAY edge cases", { timeout: 30_000 }, () => {
  test("EC-PAY-03 GOBD-02 the second of two allocations of the same transaction fails the re-check", async () => {
    const t = makeT();
    const { owner, id, bankAccount, personId } = await invoice(t);
    const id2 = await secondInvoice(t, owner, personId);
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: "x",
    });
    // Both clients saw the transaction fully open; client A confirms first.
    const allocate = (target: Id<"salesDocuments">) =>
      owner.mutation(api.payments.record, {
        source: { kind: "bank", transactionId: tx },
        date: "2026-10-12",
        allocations: [{ target: { kind: "salesDocument", id: target }, amountCents: 119_000 }],
      });
    await allocate(id);
    const e = await catching(allocate(id2));
    expect(errorCode(e)).toBe("invalid_input");
    expect(reasonOf(e)).toBe("CONCURRENT_ALLOCATION");
    expect(messageOf(e)).toBe("Diese Bankbuchung wurde soeben anderweitig zugeordnet. Bitte neu laden.");
    expect((await docOf(t, id2)).paymentStatus).toBe("open");
    expect(await t.run(async (ctx) => (await ctx.db.get(tx))?.allocatedCents)).toBe(119_000);
  });

  test("EC-PAY-16 UVA-06 a write-off under Ist posts no output-VAT correction: only the parked (not due) VAT is released", async () => {
    const t = makeT();
    const { owner, id } = await istInvoice(t);
    const w = await owner.mutation(api.payments.writeOff, {
      documentId: id,
      date: "2026-10-12",
      amountCents: 119_000,
      subReason: "insolvency",
    });
    expect(w.warnings.map((x) => x.message)).toEqual([
      "Bei Ist-Versteuerung wurde die Umsatzsteuer noch nicht abgeführt – es erfolgt keine USt-Korrektur.",
    ]);
    const [entry] = await entriesOf(t, w.paymentIds[0] as string);
    const roles = (entry?.lines ?? []).map((l) => [l.role, l.debitCents, l.creditCents]);
    expect(roles.filter(([r]) => r === "vat.output.19")).toEqual([]);
    expect(roles).toContainEqual(["vat.output.notdue.19", 19_000, 0]);
    expect(roles).toContainEqual(["receivable", 0, 119_000]);
    expect((await docOf(t, id)).paymentStatus).toBe("written_off");
  });

  test("EC-PAY-25 BNK-111 a pending (provisional) feed row cannot be allocated", async () => {
    const t = makeT();
    const { id, bankAccount } = await invoice(t);
    const pending = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankPendingTransactions",
        {
          accountId: bankAccount,
          bookingDate: "2026-10-12",
          amountCents: 119_000,
          currency: "EUR",
          purpose: "RE-2026-0001",
          fetchedAt: Date.now(),
          rawSha256: "pending-1",
        },
        { action: "bank.feed_pending" },
      ),
    );
    const e = await catching(
      t.model(OWNER, (ctx) =>
        recordPayment(ctx, {
          source: { kind: "bank", transactionId: pending as unknown as Id<"bankTransactions"> },
          date: "2026-10-12",
          allocations: [{ target: { kind: "salesDocument", id }, amountCents: 119_000 }],
        }),
      ),
    );
    expect(reasonOf(e)).toBe("TX_PENDING");
    expect(messageOf(e)).toBe(
      "Die Bankbuchung ist noch nicht gebucht (vorgemerkt). Eine Zuordnung ist erst nach der Buchung möglich.",
    );
    expect((await docOf(t, id)).paymentStatus).toBe("open");
  });

  test("EC-PAY-26 GOBD-03 the booked successor of a pending row is scored fresh with its own amount; nothing was pre-applied", async () => {
    const t = makeT();
    const { owner, id, bankAccount, number } = await invoice(t);
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankPendingTransactions",
        {
          accountId: bankAccount,
          bookingDate: "2026-10-12",
          amountCents: 110_000, // provisional card-FX estimate
          currency: "EUR",
          purpose: number,
          fetchedAt: Date.now(),
          rawSha256: "pending-2",
        },
        { action: "bank.feed_pending" },
      ),
    );
    const unmatched = await owner.query(api.banking.unmatched, {});
    expect(unmatched.some((u: { amountCents: number }) => u.amountCents === 110_000)).toBe(false);
    const booked = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: booked });
    expect(s.transaction).toMatchObject({ amountCents: 119_000 });
    expect(s.candidates[0]).toMatchObject({
      kind: "single",
      allocations: [expect.objectContaining({ amountCents: 119_000 })],
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(booked))?.allocatedCents)).toBe(0);
    expect((await docOf(t, id)).openAmountCents).toBe(119_000);
  });

  test("EC-PAY-30 GOBD-06 a payment row cannot be patched or deleted directly — only reversed", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 50_000,
    });
    const pid = r.paymentIds[0] as Id<"payments">;
    const msg = "Zahlungen können nicht geändert oder gelöscht werden. Bitte stornieren und neu erfassen.";
    const patch = await catching(
      t.model(OWNER, (ctx) => auditedPatch(ctx, "payments", pid, { amountCents: 40_000 }, { action: "x" })),
    );
    expect(errorCode(patch)).toBe("immutable_record");
    expect(messageOf(patch)).toBe(msg);
    const del = await catching(t.model(OWNER, (ctx) => auditedDelete(ctx, "payments", pid, { action: "x" })));
    expect(errorCode(del)).toBe("immutable_record");
    expect(messageOf(del)).toBe(msg);
    expect(await t.run(async (ctx) => (await ctx.db.get(pid))?.amountCents)).toBe(50_000);
  });

  test("EC-PAY-31 UST-30 a Storno of an invoice with non-reversed payments is blocked and names both ways out", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    const preview = await owner.query(api.corrections.cancelPreview, { id });
    expect(preview.guard?.code).toBe("storno_paid_invoice");
    const e = await catching(owner.mutation(api.corrections.cancel, { id }));
    expect(reasonOf(e)).toBe("storno_paid_invoice");
    expect(messageOf(e)).toMatch(/\(teil\)bezahlt/);
    expect(messageOf(e)).toMatch(/Rechnungskorrektur/); // path 1: correction + refund/credit
    expect(messageOf(e)).toMatch(/Zahlungszuordnung/); // path 2: reverse a wrongly booked payment first
    expect((await docOf(t, id)).status).not.toBe("cancelled");
    // a reversed payment no longer blocks
    await owner.mutation(api.payments.reverse, { paymentId: r.paymentIds[0] as Id<"payments">, reason: "Irrtum" });
    expect((await owner.query(api.corrections.cancelPreview, { id })).guard ?? null).toBeNull();
  });

  test("EC-PAY-36 UVA-06 a partial payment on a 19 % + 7 % invoice under Ist releases the VAT pro rata per rate", async () => {
    const t = makeT();
    const base = invoiceValues("x").lines[0] as DraftValues["lines"][number];
    const { owner, id, bankAccount } = await istInvoice(t, {
      lines: [
        base,
        {
          ...base,
          name: "Fachbuch",
          productType: "good",
          unitCode: "C62",
          quantityMilli: 1_000,
          unitPriceMicros: 1_000_000,
          vatRateKey: "reduced",
        },
      ],
    });
    const d = await docOf(t, id);
    expect(d.totals.payableCents).toBe(129_700); // 1.190,00 + 107,00
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 64_850, // exactly half
    });
    const [entry] = await entriesOf(t, r.paymentIds[0] as string);
    const lines = (entry?.lines ?? []).map((l) => [l.role, l.debitCents, l.creditCents]);
    expect(lines).toContainEqual(["vat.output.notdue.19", 9_500, 0]);
    expect(lines).toContainEqual(["vat.output.19", 0, 9_500]);
    expect(lines).toContainEqual(["vat.output.notdue.7", 350, 0]);
    expect(lines).toContainEqual(["vat.output.7", 0, 350]);
    expect((await docOf(t, id)).openAmountCents).toBe(64_850);
  });

  test("EC-PAY-43 AO-04 a cash receipt without an invoice is refused (only a credit balance as target)", async () => {
    const t = makeT();
    const { owner, personId } = await invoice(t);
    const e = await catching(
      owner.mutation(api.payments.record, {
        source: { kind: "cash" },
        date: "2026-10-12",
        allocations: [{ target: { kind: "contactCredit", id: personId }, amountCents: 5_000 }],
      }),
    );
    expect(reasonOf(e)).toBe("CASH_WITHOUT_INVOICE");
    expect(messageOf(e)).toBe(
      "Bareinnahmen ohne Rechnung sind nicht vorgesehen (keine Kassenfunktion). Bitte zuerst eine Rechnung erstellen.",
    );
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toEqual([]);
  });

  test("EC-PAY-44 GOBD-06 a payment on a locked (festgeschriebenes) invoice in an open period changes only the settlement", async () => {
    const t = makeT();
    vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
    const setup = await setupInvoicing(t);
    const { personId } = await b2bBuyer(setup.owner);
    await setup.owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [INVOICE_RANGE] } });
    const id = await secondInvoice(t, setup.owner, personId, {
      supplyDate: { kind: "date", date: "2026-09-15" as CalendarDate },
    });
    vi.setSystemTime(NOW);
    const owner = await t.asUser("owner", { existingUserId: setup.owner.userId });
    await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-09"], "manual"));
    const before = await docOf(t, id);
    expect(before.lockedAt).toBeDefined();
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: setup.bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const after = await docOf(t, id);
    expect(after).toMatchObject({ paymentStatus: "paid", openAmountCents: 0 });
    const changed = Object.keys({ ...before, ...after }).filter(
      (k) => JSON.stringify(before[k as keyof typeof before]) !== JSON.stringify(after[k as keyof typeof after]),
    );
    expect(changed.sort()).toEqual(["openAmountCents", "paymentStatus"]);
  });

  test("EC-PAY-34 UST-41 reversing an advance payment after the final invoice deducted it re-opens the advance with a warning", async () => {
    const t = makeT();
    const { owner, advanceId, advanceNumber, bankAccount } = await finalizedAdvance(t);
    const pay = await owner.mutation(api.payments.recordForInvoice, {
      documentId: advanceId,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 357_000,
    });
    const { id: finalId } = await owner.mutation(api.corrections.createChainDraft, {
      fromId: advanceId,
      type: "final_invoice",
    });
    const draft = await docOf(t, finalId as Id<"salesDocuments">);
    const values = ((await owner.query(api.invoices.get, { id: finalId })) as unknown as { values: DraftValues })
      .values;
    await owner.mutation(api.invoices.updateDraft, {
      id: finalId,
      version: draft.version,
      values: {
        ...values,
        supplyDate: { kind: "date", date: "2026-10-12" as CalendarDate },
        lines: values.lines.map((l) => ({ ...l, unitPriceMicros: 100_000_000 })),
      },
    });
    await owner.action(api.invoices.finalize, {
      id: finalId,
      version: (await docOf(t, finalId as Id<"salesDocuments">)).version,
    });
    await settle(t);
    const finalBefore = await docOf(t, finalId as Id<"salesDocuments">);
    expect(finalBefore.totals.advancesDeductedGrossCents).toBe(357_000);

    const rev = await owner.mutation(api.payments.reverse, {
      paymentId: pay.paymentIds[0] as Id<"payments">,
      reason: "Rücklastschrift der Bank",
    });
    expect(rev.warnings).toContainEqual({
      code: "advance_reopened",
      message: `Die Zahlung auf Abschlagsrechnung ${advanceNumber} wurde zurückgebucht; die Abschlagsrechnung ist wieder offen (3.570,00\u00a0€).`,
      ack: false,
    });
    const advance = await docOf(t, advanceId);
    expect(advance).toMatchObject({ paymentStatus: "open", openAmountCents: 357_000, deductedInId: finalId });
    // the final invoice and its deduction stay as finalised (RI-08); no new final invoice
    const finalAfter = await docOf(t, finalId as Id<"salesDocuments">);
    expect(finalAfter.totals).toEqual(finalBefore.totals);
    expect(finalAfter.status).toBe(finalBefore.status);
  });

  test("PAY-015 GOBD-01 the booking preview shows the journal lines with SKR accounts, S/H and tax key; nothing is written", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const args = {
      documentId: id,
      source: { kind: "clearing" as const, accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 116_620,
      differences: [{ reason: "skonto" as const, amountCents: 2_380 }],
    };
    const p = await owner.query(api.payments.previewInvoicePayment, args);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const posting = p.postings[0];
    expect(posting?.status).toBe("lines");
    if (posting?.status !== "lines") return;
    const lines = posting.lines.map((l) => [l.account, l.debitCents, l.creditCents, l.taxKey ?? null]);
    expect(lines).toEqual(
      expect.arrayContaining([
        ["1200", 116_620, 0, null], // bank (clearing account's ledger account)
        ["1400", 0, 119_000, null], // receivable
        ["8736", 2_000, 0, "USt19"], // Skonto granted 19 % (SKR03)
        ["1776", 380, 0, null], // output VAT correction
      ]),
    );
    expect(posting.lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
    // recomputed live: without Skonto the lines change
    const plain = await owner.query(api.payments.previewInvoicePayment, {
      ...args,
      amountCents: 50_000,
      differences: [],
    });
    expect(plain.ok && plain.postings[0]?.status === "lines" && plain.postings[0].lines.map((l) => l.account)).toEqual([
      "1200",
      "1400",
    ]);
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toEqual([]);
  });
});
