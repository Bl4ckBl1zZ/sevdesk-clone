import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { consumerBuyer, finalizedInvoice, INVOICE_RANGE, invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { attachReceipt, documentSettlement, openItemsAsOf } from "./model/payments";
import { bookedTransaction } from "./payments.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 payment branches not reached by payments.test.ts / paymentEdgeCases.test.ts: refusals of unknown or unusable
 * targets and sources, opening items as targets, the list/open-item filters, refunds, recovery and the Quittung
 * guards. The invoice is T-GLD-01 (1.190,00, dated 2026-10-12, 30 days, 2 % Skonto 14 days).
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
const reasonOf = (e: unknown) => dataOf(e).reason;
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

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

async function invoice(t: TestT) {
  const f = await finalizedInvoice(t);
  return { ...f, id: f.id as Id<"salesDocuments"> };
}

type Owner = Awaited<ReturnType<typeof invoice>>["owner"];

/** An id of the table that no longer exists (inserted and deleted in one raw transaction, nothing remains). */
const goneBankAccount = (t: TestT) =>
  t.run(async (ctx) => {
    const id = await ctx.db.insert("bankAccounts", {
      kind: "bank",
      name: "Weg",
      currency: "EUR",
      accountHolder: "Muster GmbH",
      ledgerAccount: "1200",
      showOnInvoices: false,
      isDefaultForInvoices: false,
      autoApplyMatches: false,
    });
    await ctx.db.delete(id);
    return id;
  });

const gonePayment = (t: TestT) =>
  t.run(async (ctx) => {
    const id = await ctx.db.insert("payments", {
      target: { kind: "contactCredit", id: "x" },
      date: "2026-10-12",
      amountCents: 1,
      currency: "EUR",
      source: { kind: "cash" },
      differences: [],
      journalEntryIds: [],
      actor: "user:test-owner",
      recordedAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });

/** A deleted draft: a sales-document id that no longer exists. */
async function goneDocument(owner: Owner, contactId: string) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId) });
  await owner.mutation(api.invoices.deleteDraft, { id });
  return id as Id<"salesDocuments">;
}

const usdAccount = (t: TestT) =>
  t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: "Revolut USD",
        currency: "USD",
        accountHolder: "Muster GmbH",
        ledgerAccount: "1210",
        showOnInvoices: false,
        isDefaultForInvoices: false,
        autoApplyMatches: false,
      },
      { action: "settings.bank_account.create" },
    ),
  );

const archivedAccount = (t: TestT) =>
  t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: "Altes Konto",
        currency: "EUR",
        accountHolder: "Muster GmbH",
        ledgerAccount: "1210",
        showOnInvoices: false,
        isDefaultForInvoices: false,
        autoApplyMatches: false,
        archivedAt: Date.now(),
      },
      { action: "settings.bank_account.create" },
    ),
  );

// ── unknown ids ─────────────────────────────────────────────────────────────────────────────────────────

describe("PAY-010 unknown payments, documents and targets", () => {
  test("PAY-010 an unknown payment or invoice is not_found in every read and act", async () => {
    const t = makeT();
    const { owner, personId } = await invoice(t);
    const paymentId = await gonePayment(t);
    const e1 = await catching(owner.query(api.payments.get, { id: paymentId }));
    expect(errorCode(e1)).toBe("not_found");
    expect(messageOf(e1)).toBe("Die Zahlung existiert nicht.");
    expect(errorCode(await catching(owner.query(api.payments.receiptContext, { paymentId })))).toBe("not_found");

    const docId = await goneDocument(owner, personId);
    const e2 = await catching(owner.query(api.payments.forDocument, { documentId: docId }));
    expect(messageOf(e2)).toBe("Die Rechnung existiert nicht.");
    const e3 = await catching(t.run((ctx) => documentSettlement(ctx, docId)));
    expect(messageOf(e3)).toBe("Das Dokument existiert nicht.");
    const e4 = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: docId,
        source: { kind: "cash" },
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(errorCode(e4)).toBe("not_found");
    const e5 = await catching(
      owner.mutation(api.payments.recordRecoveryPayment, {
        documentId: docId,
        source: { kind: "cash" },
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(messageOf(e5)).toBe("Die Rechnung existiert nicht.");
    const e6 = await catching(
      owner.mutation(api.payments.refundCorrection, {
        documentId: docId,
        amountCents: 100,
        source: { kind: "cash" },
        date: "2026-10-12",
      }),
    );
    expect(messageOf(e6)).toBe("Die Rechnungskorrektur existiert nicht.");
    // the live preview of the refund dialog turns a structured error into ok:false
    const preview = await owner.query(api.payments.previewCorrectionRefund, {
      documentId: docId,
      amountCents: 100,
      source: { kind: "cash" },
      date: "2026-10-12",
    });
    expect(preview).toEqual({ ok: false, message: "Die Rechnungskorrektur existiert nicht.", reason: null });
  });

  test("PAY-015 a preview against an unknown target (document, opening item, contact) is refused", async () => {
    const t = makeT();
    const { owner, bankAccount, personId } = await invoice(t);
    const docId = await goneDocument(owner, personId);
    const source = { kind: "clearing" as const, accountId: bankAccount };
    for (const target of [
      { kind: "salesDocument" as const, id: "kein-dokument" },
      { kind: "salesDocument" as const, id: docId },
      { kind: "opening_item" as const, id: "kein-posten" },
      { kind: "contactCredit" as const, id: "kein-kontakt" },
    ]) {
      const e = await catching(
        owner.query(api.payments.preview, { source, date: "2026-10-12", allocations: [{ target, amountCents: 100 }] }),
      );
      expect(reasonOf(e)).toBe("TARGET_UNKNOWN");
      expect(messageOf(e)).toBe("Die Rechnung wurde nicht gefunden.");
    }
  });
});

// ── sources ─────────────────────────────────────────────────────────────────────────────────────────────

describe("PAY-011 PAY-018 unusable payment sources", () => {
  test("PAY-018 a foreign-currency bank transaction or clearing account is deferred; an unknown account is not_found", async () => {
    const t = makeT();
    const { owner, id } = await invoice(t);
    const usd = await usdAccount(t);
    const tx = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankTransactions",
        {
          accountId: usd,
          bookingDate: "2026-10-12",
          amountCents: 10_000,
          currency: "USD",
          purpose: "Zahlung in USD",
          source: { kind: "camt053", entryReference: "USD-1", rawSha256: "usd-1" },
          sources: [],
          dedupeKey: `${usd}:er:USD-1`,
          contentHash: "usd-1",
          status: "open",
          allocatedCents: 0,
          recordedAt: Date.now(),
        },
        { action: "bank.import", label: "USD" },
      ),
    );
    const base = { documentId: id, date: "2026-10-12", amountCents: 10_000 };
    const e1 = await catching(
      owner.mutation(api.payments.recordForInvoice, { ...base, source: { kind: "bank", transactionId: tx } }),
    );
    expect(reasonOf(e1)).toBe("FX_DEFERRED");
    const e2 = await catching(
      owner.mutation(api.payments.recordForInvoice, { ...base, source: { kind: "clearing", accountId: usd } }),
    );
    expect(reasonOf(e2)).toBe("FX_DEFERRED");
    expect(messageOf(e2)).toContain("Zahlungen in Fremdwährung können erst mit der EUR-Bewertung gebucht werden.");
    const gone = await goneBankAccount(t);
    const e3 = await catching(
      owner.mutation(api.payments.recordForInvoice, { ...base, source: { kind: "clearing", accountId: gone } }),
    );
    expect(errorCode(e3)).toBe("not_found");
    expect(messageOf(e3)).toBe("Das Bankkonto existiert nicht.");
    expect((await docOf(t, id)).paymentStatus).toBe("open");
  });

  test("PAY-015 the preview of a payment from an archived clearing account plans one row with its booking", async () => {
    const t = makeT();
    const { owner, id } = await invoice(t);
    const archived = await archivedAccount(t);
    const r = await owner.query(api.payments.previewInvoicePayment, {
      documentId: id,
      source: { kind: "clearing", accountId: archived },
      date: "2026-10-12",
      amountCents: 10_000,
      note: "Teilzahlung laut Telefonat",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.plan.totalCents).toBe(10_000);
    expect(r.postings).toHaveLength(1);
  });

  test("PAY-015 previewInvoicePayment returns ok:false with the excess for an overpayment without a choice", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.query(api.payments.previewInvoicePayment, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 120_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected an error");
    expect(r.message).toMatch(/^Der Betrag übersteigt den offenen Betrag um 10,00\s€\. Bitte den Mehrbetrag zuordnen/);
    expect(r.reason).toBe("EXCESS");
    expect(r.excessCents).toBe(1_000);
  });

  test("PAY-013 a cash payment cannot be split over invoices of different customers", async () => {
    const t = makeT();
    const { owner, id } = await invoice(t);
    const consumer = await consumerBuyer(owner);
    const { id: other } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(consumer) });
    await owner.action(api.invoices.finalize, { id: other, version: 1 });
    await settle(t);
    const e = await catching(
      owner.mutation(api.payments.record, {
        source: { kind: "cash" },
        date: "2026-10-12",
        allocations: [
          { target: { kind: "salesDocument", id }, amountCents: 10_000 },
          { target: { kind: "salesDocument", id: other }, amountCents: 10_000 },
        ],
      }),
    );
    expect(reasonOf(e)).toBe("CONTACT_MISMATCH");
    expect(messageOf(e)).toBe("Alle Zuordnungen einer Zahlung müssen zum selben Kunden gehören.");
  });

  test("PAY-027 an „other“ difference keeps its account and text on the row; the note is stored trimmed", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 118_000,
      differences: [
        { reason: "other", amountCents: 1_000, account: "8736", text: "Kulanz wegen Verzug", withVat: false },
      ],
      note: "  Kulanz vereinbart  ",
    });
    const row = await t.run(async (ctx) => ctx.db.get(r.paymentIds[0] as Id<"payments">));
    expect(row?.note).toBe("Kulanz vereinbart");
    expect(row?.differences).toEqual([
      expect.objectContaining({ reason: "other", amountCents: 1_000, account: "8736", text: "Kulanz wegen Verzug" }),
    ]);
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
  });
});

// ── opening items (F08 ACC-013 receivables as payment targets) ──────────────────────────────────────────

async function openingItems(owner: Owner, contactId: Id<"contacts">) {
  await owner.mutation(api.accounting.postOpeningBalancePart, {
    fiscalYear: 2026,
    part: {
      kind: "receivables",
      items: [
        {
          number: "SD-1001",
          documentDate: "2025-12-10",
          dueDate: "2026-01-09",
          counterpartyName: "Beispiel GmbH",
          contactId,
          grossCents: 59_500,
          openCents: 59_500,
          taxedAs: "ist",
          notDueVat: [{ rateBp: 1900, vatCents: 9_500 }],
        },
        {
          number: "SD-1002",
          documentDate: "2025-12-20",
          counterpartyName: "Laufkunde ohne Kontakt",
          grossCents: 11_900,
          openCents: 11_900,
          taxedAs: "soll",
        },
      ],
    },
  });
  const status = await owner.query(api.accounting.openingBalanceStatus, { fiscalYear: 2026 });
  const byNumber = (n: string) => status.openingItems.find((i) => i.number === n)?.id as Id<"openingItems">;
  return { withContact: byNumber("SD-1001"), withoutContact: byNumber("SD-1002") };
}

describe("PAY-001 PAY-003 opening items", () => {
  test("PAY-001 PAY-003 an opening item is paid through the payment API and listed per contact and as-of date", async () => {
    const t = makeT();
    const { owner, bankAccount, orgId } = await invoice(t);
    const { withContact, withoutContact } = await openingItems(owner, orgId);
    const source = { kind: "clearing" as const, accountId: bankAccount };
    const e1 = await catching(
      owner.mutation(api.payments.record, {
        source,
        date: "2026-10-12",
        allocations: [{ target: { kind: "opening_item", id: withContact }, amountCents: 60_000 }],
      }),
    );
    expect(reasonOf(e1)).toBe("EXCESS");
    const r = await owner.mutation(api.payments.record, {
      source,
      date: "2026-10-12",
      allocations: [{ target: { kind: "opening_item", id: withContact }, amountCents: 20_000 }],
    });
    const row = await t.run(async (ctx) => ctx.db.get(r.paymentIds[0] as Id<"payments">));
    expect(row).toMatchObject({
      target: { kind: "opening_item", id: withContact },
      contactId: orgId,
      number: "SD-1001",
    });
    const item = await t.run(async (ctx) => ctx.db.get(withContact));
    expect(item?.openAmountCents).toBe(39_500);
    // the Ist part releases the parked VAT pro rata in the payment period
    const [entry] = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", r.paymentIds[0] as string))
        .collect(),
    );
    expect(entry?.lines.some((l) => l.taxPeriod === "2026-10")).toBe(true);

    // PAY-003: as of 2025-12-15 only SD-1001 exists; per contact only the item of that contact
    const early = await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2025-12-15" }));
    expect(early.items.map((i) => i.number)).toEqual(["SD-1001"]);
    const perContact = await owner.query(api.payments.openItems, { contactId: orgId });
    expect(perContact.items.map((i) => i.number)).toEqual(["SD-1001"]);
    expect(perContact.items[0]?.openCents).toBe(39_500);
    const all = await owner.query(api.payments.openItems, { asOf: "kein-datum" });
    expect(all.items.map((i) => i.number).sort()).toEqual(["RE-2026-0001", "SD-1001", "SD-1002"]);
    const overdue = await owner.query(api.payments.openItems, { overdueOnly: true });
    expect(overdue.items.map((i) => i.number)).toEqual(["SD-1001"]);
    const bucket = await owner.query(api.payments.openItems, { bucket: "gibt-es-nicht" });
    expect(bucket.items).toEqual([]);

    // an item without a contact cannot be booked (no Debitor for the receivable posting)
    const e2 = await catching(
      owner.mutation(api.payments.record, {
        source,
        date: "2026-10-12",
        allocations: [{ target: { kind: "opening_item", id: withoutContact }, amountCents: 11_900 }],
      }),
    );
    expect(messageOf(e2)).toBe("Die Zahlung braucht einen Kunden (Debitor).");
    const list = await owner.query(api.payments.list, { targetId: withContact });
    expect(list.map((p) => [p.target.kind, p.targetType, p.amountCents])).toEqual([["opening_item", null, 20_000]]);
  });
});

// ── list filters and views ──────────────────────────────────────────────────────────────────────────────

describe("PAY-010 payment list and views (05 §4.4)", () => {
  test("PAY-010 GET /payments filters by contact, source, date range and reversal; the limit is clamped", async () => {
    const t = makeT();
    const f = await invoice(t);
    let owner = f.owner;
    const { id, bankAccount, personId } = f;
    const clearing = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    const cash = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 5_000,
    });
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    owner = await t.asUser("owner");
    await owner.mutation(api.payments.reverse, {
      paymentId: clearing.paymentIds[0] as Id<"payments">,
      reason: "Falsch erfasst",
    });
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    const byContact = await owner.query(api.payments.list, { contactId: personId as Id<"contacts"> });
    expect(byContact).toHaveLength(3);
    const cashOnly = await owner.query(api.payments.list, { sourceKind: "cash" });
    expect(ids(cashOnly)).toEqual([cash.paymentIds[0]]);
    expect(cashOnly[0]).toMatchObject({ sourceLabel: "Bar", canPrintReceipt: true, accountName: null });
    const reversed = await owner.query(api.payments.list, { reversed: true });
    expect(reversed).toHaveLength(2);
    const notReversed = await owner.query(api.payments.list, { reversed: false, limit: 0 });
    expect(ids(notReversed)).toEqual([cash.paymentIds[0]]);
    // PAY-041: the reversal carries the original date (October is open)
    const day13 = await owner.query(api.payments.list, { dateFrom: "2026-10-13", dateTo: "2026-10-13" });
    expect(day13).toEqual([]);
    const day12 = await owner.query(api.payments.list, { dateFrom: "2026-10-12", dateTo: "2026-10-12" });
    expect(day12.filter((p) => p.reversalOfId === clearing.paymentIds[0])).toHaveLength(1);
    const filteredContact = await owner.query(api.payments.list, {
      contactId: personId as Id<"contacts">,
      dateFrom: "2026-10-13",
      dateTo: "2026-10-31",
      limit: 9999,
    });
    expect(filteredContact).toEqual([]);
    const clearingRow = await owner.query(api.payments.get, { id: clearing.paymentIds[0] as Id<"payments"> });
    expect(clearingRow).toMatchObject({ sourceLabel: "Konto (manuell)", canPrintReceipt: false, receipt: null });
    expect(clearingRow.accountName).not.toBeNull();
  });

  test("PAY-031 contactCredit rows are listed with their balance; a credit row has no document type", async () => {
    const t = makeT();
    const { owner, id, bankAccount, personId } = await invoice(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 120_000,
      excess: { mode: "credit" },
    });
    const credit = await owner.query(api.payments.contactCredit, { contactId: personId as Id<"contacts"> });
    expect(credit.balanceCents).toBe(1_000);
    expect(credit.rows.map((r) => [r.target.kind, r.targetType, r.amountCents])).toEqual([
      ["contactCredit", null, 1_000],
    ]);
    const open = await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2026-10-12", edges: [10, 20] }));
    expect(open.items).toEqual([]);
  });

  test("PAY-015 forDocument lists the active EUR accounts only and no Skonto for an invoice without terms", async () => {
    const t = makeT();
    const { owner, personId } = await invoice(t);
    await usdAccount(t);
    await archivedAccount(t);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { paymentTerms: { dueDays: 14 } }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const r = await owner.query(api.payments.forDocument, { documentId: id as Id<"salesDocuments"> });
    expect(r.skonto).toBeNull();
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]?.isDefault).toBe(true);
  });

  test("PAY-043 the settlement of a draft has no open amount stored and is never fully settled", async () => {
    const t = makeT();
    const { owner, personId } = await invoice(t);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const s = await t.run((ctx) => documentSettlement(ctx, id as Id<"salesDocuments">));
    expect(s).toMatchObject({ payableCents: 119_000, settledCents: 0, openAmountCents: 119_000, fullySettled: false });
    expect(s).not.toHaveProperty("paymentStatus");
    expect(s).not.toHaveProperty("paidOn");
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id as Id<"salesDocuments">,
        source: { kind: "cash" },
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(reasonOf(e)).toBe("DRAFT");
  });
});

// ── reversals, credit balance and refunds ───────────────────────────────────────────────────────────────

async function secondInvoice(t: TestT, owner: Owner, contactId: string) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId) });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return id as Id<"salesDocuments">;
}

const paymentOf = (t: TestT, id: Id<"payments">) => t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"payments">);

describe("PAY-032 PAY-033 PAY-040 credit balance: application, reversal and refund", () => {
  test("PAY-032 PAY-040 EC-PAY-32 PAY-033 a credit application is reversed as a pair; a used credit cannot be reversed", async () => {
    const t = makeT();
    const { owner, id, bankAccount, personId } = await invoice(t);
    const contactId = personId as Id<"contacts">;
    const over = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 120_000,
      excess: { mode: "credit" },
    });
    const second = await secondInvoice(t, owner, personId);
    const applied = await owner.mutation(api.payments.applyCredit, {
      contactId,
      documentId: second,
      amountCents: 300,
      date: "2026-10-12",
    });
    expect(applied.paymentIds).toHaveLength(2);
    const docRow = applied.paymentIds[1] as Id<"payments">;
    const rev = await owner.mutation(api.payments.reverse, { paymentId: docRow, reason: "Verrechnung irrtümlich" });
    expect(rev.reversalIds).toHaveLength(2);
    const reversals = await Promise.all(rev.reversalIds.map((r) => paymentOf(t, r)));
    expect(reversals.map((r) => r.allocationGroupId)).toEqual([applied.allocationGroupId, applied.allocationGroupId]);
    expect(reversals.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-300, 300]);
    expect(await owner.query(api.payments.contactCredit, { contactId })).toMatchObject({ balanceCents: 1_000 });
    expect((await docOf(t, second)).openAmountCents).toBe(119_000);
    // cash in the till for the cash refund (RI-11 never negative)
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: second,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 1_000,
    });

    // refunds: cash 3 days back needs the acknowledgement; the reason and note are kept
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    const later = await t.asUser("owner");
    const refundBase = { contactId, amountCents: 500, source: { kind: "cash" as const }, date: "2026-10-12" };
    const warn = await catching(later.mutation(api.payments.refund, refundBase));
    expect(reasonOf(warn)).toBe("WARNINGS_UNACKNOWLEDGED");
    expect(dataOf(warn).warnings).toBe("cash_daily_recording");
    const cash = await later.mutation(api.payments.refund, {
      ...refundBase,
      backdateReason: "Kunde holte das Geld am Freitag ab",
      note: " bar ausgezahlt ",
      acknowledgeWarnings: ["cash_daily_recording"],
    });
    expect(await paymentOf(t, cash.paymentId)).toMatchObject({
      amountCents: -500,
      backdateReason: "Kunde holte das Geld am Freitag ab",
      note: "bar ausgezahlt",
    });
    const clearing = await later.mutation(api.payments.refund, {
      contactId,
      amountCents: 200,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-15",
    });
    const [entry] = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", clearing.paymentId))
        .collect(),
    );
    expect(entry?.lines.map((l) => [l.account, l.debitCents, l.creditCents]).sort()).toEqual([
      ["1200", 0, 200],
      ["1400", 200, 0],
    ]);
    // EC-PAY-32: the overpayment's credit row (1.000,00) cannot be reversed while only 3,00 are left
    const creditRow = (
      await t.run((ctx) => Promise.all(over.paymentIds.map((p) => ctx.db.get(p as Id<"payments">))))
    ).find((p) => p?.target.kind === "contactCredit");
    const e = await catching(
      later.mutation(api.payments.reverse, {
        paymentId: creditRow?._id as Id<"payments">,
        reason: "Irrtum korrigieren",
      }),
    );
    expect(reasonOf(e)).toBe("CREDIT_IN_USE");
    expect(messageOf(e)).toBe(
      "Das Guthaben wurde bereits verwendet (3,00 € übrig). Bitte zuerst die Verrechnung bzw. Erstattung stornieren.",
    );
  });

  test("PAY-033 a refund needs an existing contact and an allocatable outgoing transaction", async () => {
    const t = makeT();
    const { owner, bankAccount, personId } = await invoice(t);
    const contactId = await t.run(async (ctx) => {
      const c = await ctx.db.get(personId as Id<"contacts">);
      if (!c) throw new Error("no contact");
      const { _id, _creationTime, ...rest } = c;
      const gone = await ctx.db.insert("contacts", { ...rest, number: "99999", numberNormalized: "99999" });
      await ctx.db.delete(gone);
      return gone;
    });
    const e1 = await catching(
      owner.mutation(api.payments.refund, {
        contactId,
        amountCents: 100,
        source: { kind: "cash" },
        date: "2026-10-12",
      }),
    );
    expect(errorCode(e1)).toBe("not_found");
    expect(messageOf(e1)).toBe("Der Kontakt existiert nicht.");
    const tx = await bookedTransaction(t, bankAccount, { bookingDate: "2026-10-12", amountCents: -100, purpose: "x" });
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankTransactions", tx, { status: "ignored" }, { action: "bank.mark" }),
    );
    const e2 = await catching(
      owner.mutation(api.payments.refund, {
        contactId: personId as Id<"contacts">,
        amountCents: 100,
        source: { kind: "bank", transactionId: tx },
        date: "2026-10-12",
      }),
    );
    expect(reasonOf(e2)).toBe("TX_NOT_ALLOCATABLE");
    expect(messageOf(e2)).toBe("Dieser Umsatz kann nicht zugeordnet werden (bereits markiert oder ignoriert).");
  });
});

// ── bank unmatch and reconciliation (BNK-047, PAY-047) ──────────────────────────────────────────────────

describe("PAY-047 BNK-047 unmatch and manual-payment reconciliation", () => {
  test("BNK-047 unmatching reverses every active bank allocation; an unallocated transaction is refused", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 50_000,
      purpose: "RE-2026-0001 Teil",
    });
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "bank", transactionId: tx },
      date: "2026-10-12",
      amountCents: 50_000,
    });
    const r = await owner.mutation(api.matching.unmatch, { transactionId: tx, reason: "Falsche Rechnung" });
    expect(r.reversalIds).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(tx))).toMatchObject({ allocatedCents: 0 });
    expect((await docOf(t, id)).openAmountCents).toBe(119_000);
    const e = await catching(owner.mutation(api.matching.unmatch, { transactionId: tx, reason: "Noch einmal" }));
    expect(reasonOf(e)).toBe("NOT_MATCHED");
    expect(messageOf(e)).toBe("Dieser Umsatz ist keiner Zahlung zugeordnet.");
  });

  test("PAY-047 EC-PAY-41 a manual payment is reconciled once with its bank line; unmatching it is refused", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const manual = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 40_000,
    });
    const cash = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 1_000,
    });
    const paymentId = manual.paymentIds[0] as Id<"payments">;
    const wrong = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 39_000,
      purpose: "x",
    });
    const e1 = await catching(
      owner.mutation(api.matching.confirm, {
        transactionId: wrong,
        allocations: [{ target: { kind: "payment", id: paymentId }, amountCents: 39_000 }],
      }),
    );
    expect(reasonOf(e1)).toBe("RECONCILE_MISMATCH");
    expect(messageOf(e1)).toBe("Konto oder Betrag des Umsatzes passen nicht zur erfassten Zahlung.");
    const e2 = await catching(
      owner.mutation(api.matching.confirm, {
        transactionId: wrong,
        allocations: [{ target: { kind: "payment", id: cash.paymentIds[0] as string }, amountCents: 1_000 }],
      }),
    );
    expect(reasonOf(e2)).toBe("NOT_RECONCILABLE");
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-13",
      amountCents: 40_000,
      purpose: "y",
    });
    const ok = await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "payment", id: paymentId }, amountCents: 40_000 }],
    });
    expect(ok).toEqual({ reconciled: true });
    expect((await paymentOf(t, paymentId)).reconciledTransactionId).toBe(tx);
    expect(await t.run((ctx) => ctx.db.get(tx))).toMatchObject({ allocatedCents: 40_000 });
    const e3 = await catching(owner.mutation(api.matching.unmatch, { transactionId: tx, reason: "Rückgängig machen" }));
    expect(reasonOf(e3)).toBe("RECONCILED_MANUAL_PAYMENT");
    expect((await owner.query(api.payments.get, { id: paymentId })).reconciledTransactionId).toBe(tx);
  });
});

// ── write-off recovery (PAY-026) ────────────────────────────────────────────────────────────────────────

describe("PAY-026 recovery on a written-off receivable", () => {
  test("PAY-026 recovery needs a written-off invoice; the remainder is written off again when asked", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const source = { kind: "clearing" as const, accountId: bankAccount };
    const e1 = await catching(
      owner.mutation(api.payments.recordRecoveryPayment, {
        documentId: id,
        source,
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(reasonOf(e1)).toBe("NOT_WRITTEN_OFF");
    expect(messageOf(e1)).toBe("Die Rechnung ist nicht abgeschrieben.");
    await owner.mutation(api.payments.writeOff, {
      documentId: id,
      date: "2026-10-12",
      amountCents: 119_000,
      subReason: "insolvency",
    });
    expect((await docOf(t, id)).paymentStatus).toBe("written_off");
    const r = await owner.mutation(api.payments.recordRecoveryPayment, {
      documentId: id,
      source,
      date: "2026-10-12",
      amountCents: 50_000,
      writeOffRest: "insolvency",
    });
    expect(r.reversalIds).toHaveLength(1);
    expect(r.writeOff?.paymentIds).toHaveLength(1);
    const wo = await paymentOf(t, r.writeOff?.paymentIds[0] as Id<"payments">);
    expect(wo.differences).toEqual([
      expect.objectContaining({ reason: "write_off", amountCents: 69_000, subReason: "insolvency" }),
    ]);
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0, paymentStatus: "written_off" });
  });

  test("PAY-026 a recovery that pays the whole amount writes nothing off", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    await owner.mutation(api.payments.writeOff, {
      documentId: id,
      date: "2026-10-12",
      amountCents: 119_000,
      subReason: "uncollectible",
    });
    const r = await owner.mutation(api.payments.recordRecoveryPayment, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
      writeOffRest: "uncollectible",
    });
    expect(r.writeOff).toBeUndefined();
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
  });
});

// ── Quittung guards (PAY-063) ───────────────────────────────────────────────────────────────────────────

describe("PAY-063 Quittung only for cash receipts", () => {
  test("PAY-063 a Quittung is refused for a non-cash payment; the archive is set once", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const clearing = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    const clearingId = clearing.paymentIds[0] as Id<"payments">;
    const e1 = await catching(owner.query(api.payments.receiptContext, { paymentId: clearingId }));
    expect(reasonOf(e1)).toBe("NOT_CASH");
    expect(messageOf(e1)).toBe("Eine Quittung gibt es nur für Barzahlungen.");
    const file = {
      storageId: await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4"]))),
      sha256: "a".repeat(64),
      bytes: 8,
      mime: "application/pdf",
      name: "Quittung.pdf",
    };
    const e2 = await catching(t.model(OWNER, (ctx) => attachReceipt(ctx, { paymentId: clearingId, file })));
    expect(reasonOf(e2)).toBe("NOT_CASH");
    const cash = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 5_000,
    });
    const cashId = cash.paymentIds[0] as Id<"payments">;
    const ctx0 = await owner.query(api.payments.receiptContext, { paymentId: cashId });
    expect(ctx0.archived).toBeNull();
    expect(ctx0.content.rows).toContainEqual(["Quittungsnummer", cashId]);
    await t.model(OWNER, (ctx) => attachReceipt(ctx, { paymentId: cashId, file }));
    await t.model(OWNER, (ctx) => attachReceipt(ctx, { paymentId: cashId, file: { ...file, sha256: "b".repeat(64) } }));
    expect((await paymentOf(t, cashId)).receiptFile?.sha256).toBe("a".repeat(64));
    const view = await owner.query(api.payments.get, { id: cashId });
    expect(view.receipt).toEqual({ name: "Quittung.pdf", sha256: "a".repeat(64) });
    const ctx1 = await owner.query(api.payments.receiptContext, { paymentId: cashId });
    expect(ctx1.archived?.sha256).toBe("a".repeat(64));
    expect(ctx1.archivedUrl).not.toBeNull();
  });
});

// ── refunds of credit corrections (PAY-033 b) ───────────────────────────────────────────────────────────

/** Invoice paid in full (clearing), then a −238,00 credit correction finalised (correctionRefunds.test.ts shape). */
async function paidCredit(t: TestT, opts: { finalize?: boolean } = {}) {
  const f = await invoice(t);
  const { owner, id, bankAccount } = f;
  await owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        { ...INVOICE_RANGE, next: 2 },
        { key: "correction", name: "Rechnungskorrekturen", format: "RK-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
      ],
    },
  });
  await owner.mutation(api.payments.recordForInvoice, {
    documentId: id,
    source: { kind: "clearing", accountId: bankAccount },
    date: "2026-10-12",
    amountCents: 119_000,
  });
  const { id: cid } = await owner.mutation(api.corrections.createCorrection, {
    originalId: id,
    kind: "credit",
    changes: [{ position: 1, quantityMilli: 8_000 }],
  });
  if (opts.finalize !== false) {
    const draft = await docOf(t, cid as Id<"salesDocuments">);
    await owner.action(api.invoices.finalize, { id: cid, version: draft.version });
    await settle(t);
  }
  return { ...f, cid: cid as Id<"salesDocuments"> };
}

describe("PAY-033 PAY-062 correction refund guards", { timeout: 30_000 }, () => {
  test("PAY-033 a draft correction cannot be refunded", async () => {
    const t = makeT();
    const { owner, cid } = await paidCredit(t, { finalize: false });
    const e = await catching(
      owner.mutation(api.payments.refundCorrection, {
        documentId: cid,
        amountCents: 100,
        source: { kind: "cash" },
        date: "2026-10-12",
      }),
    );
    expect(reasonOf(e)).toBe("DRAFT");
    expect(messageOf(e)).toBe("Zahlungen können nur auf fertiggestellte Rechnungen gebucht werden.");
  });

  test("PAY-033 PAY-018 the refund source must exist, be EUR and allocatable", async () => {
    const t = makeT();
    const { owner, cid, bankAccount } = await paidCredit(t);
    const base = { documentId: cid, amountCents: 1_000, date: "2026-10-12" };
    const gone = await goneBankAccount(t);
    const e1 = await catching(
      owner.mutation(api.payments.refundCorrection, { ...base, source: { kind: "clearing", accountId: gone } }),
    );
    expect(messageOf(e1)).toBe("Das Bankkonto existiert nicht.");
    const usd = await usdAccount(t);
    const e2 = await catching(
      owner.mutation(api.payments.refundCorrection, { ...base, source: { kind: "clearing", accountId: usd } }),
    );
    expect(reasonOf(e2)).toBe("FX_DEFERRED");
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: -1_000,
      purpose: "x",
    });
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankTransactions", tx, { status: "ignored" }, { action: "bank.mark" }),
    );
    const e3 = await catching(
      owner.mutation(api.payments.refundCorrection, { ...base, source: { kind: "bank", transactionId: tx } }),
    );
    expect(reasonOf(e3)).toBe("TX_NOT_ALLOCATABLE");
    const preview = await owner.query(api.payments.previewCorrectionRefund, {
      ...base,
      source: { kind: "clearing", accountId: usd },
    });
    expect(preview).toMatchObject({ ok: false, reason: "FX_DEFERRED" });
    expect((await docOf(t, cid)).openAmountCents).toBe(-23_800);
  });

  test("PAY-062 a backdated cash refund needs the acknowledgement and keeps its reason", async () => {
    const t = makeT();
    const { owner, cid, id } = await paidCredit(t);
    // cash in the till first (RI-11), from a second invoice of the same customer
    const doc = await docOf(t, id);
    const second = await secondInvoice(t, owner, doc.contactId as string);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: second,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 50_000,
    });
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    const later = await t.asUser("owner");
    const base = { documentId: cid, amountCents: 23_800, source: { kind: "cash" as const }, date: "2026-10-12" };
    const preview = await later.query(api.payments.previewCorrectionRefund, base);
    expect(preview).toMatchObject({ ok: true, date: "2026-10-12", openRefundCents: 23_800, openAfterCents: 0 });
    const e = await catching(later.mutation(api.payments.refundCorrection, base));
    expect(reasonOf(e)).toBe("WARNINGS_UNACKNOWLEDGED");
    const r = await later.mutation(api.payments.refundCorrection, {
      ...base,
      backdateReason: "Erstattung an der Kasse am Montag",
      note: "Quittung liegt bei",
      acknowledgeWarnings: ["cash_daily_recording"],
    });
    expect(await paymentOf(t, r.paymentId)).toMatchObject({
      amountCents: -23_800,
      backdateReason: "Erstattung an der Kasse am Montag",
      note: "Quittung liegt bei",
      number: "RK-2026-0001",
    });
    expect(await docOf(t, cid)).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "payment.refund" && a.reason === "Erstattung an der Kasse am Montag")).toBe(
      true,
    );
  });
});

// ── receivables view, cash on an opening item, letters ──────────────────────────────────────────────────

describe("PAY-004 PAY-063 PAY-005 contact receivables, Quittung of an opening item, letters", () => {
  test("PAY-004 an organisation sees its opening items (by due date) and the paid invoices of its persons", async () => {
    const t = makeT();
    const { owner, id, bankAccount, orgId } = await invoice(t);
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: {
        kind: "receivables",
        items: [
          {
            number: "SD-2001",
            documentDate: "2025-12-01",
            counterpartyName: "Beispiel GmbH",
            contactId: orgId,
            grossCents: 10_000,
            openCents: 10_000,
            taxedAs: "soll",
          },
          {
            number: "SD-2002",
            documentDate: "2025-11-01",
            dueDate: "2025-11-15",
            counterpartyName: "Beispiel GmbH",
            contactId: orgId,
            grossCents: 20_000,
            openCents: 20_000,
            taxedAs: "soll",
          },
        ],
      },
    });
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const r = await owner.query(api.payments.contactReceivables, { contactId: orgId });
    expect(r.items.map((i) => i.number)).toEqual(["SD-2002", "SD-2001"]);
    expect(r.totals.openCents).toBe(30_000);
    expect(r.paidInvoices).toBe(1);
    expect(r.averageDaysToPay).toBe(0);
    expect(r.payments).toEqual([
      expect.objectContaining({ number: "RE-2026-0001", amountCents: 119_000, source: "clearing", reversed: false }),
    ]);
    expect(r.truncated).toBe(false);
  });

  test("PAY-063 a cash receipt on an opening item names the contact as payer and no invoice", async () => {
    const t = makeT();
    const { owner, orgId } = await invoice(t);
    const { withContact } = await openingItems(owner, orgId);
    const r = await owner.mutation(api.payments.record, {
      source: { kind: "cash" },
      date: "2026-10-12",
      allocations: [{ target: { kind: "opening_item", id: withContact }, amountCents: 5_000 }],
    });
    const c = await owner.query(api.payments.receiptContext, { paymentId: r.paymentIds[0] as Id<"payments"> });
    const rows = Object.fromEntries(c.content.rows);
    expect(rows.Verwendungszweck).toBeUndefined();
    const org = await t.run(async (ctx) => ctx.db.get(orgId));
    expect(rows["Erhalten von"]).toBe(org?.displayName);
    expect(c.content.fileName).toBe(`Quittung-${r.paymentIds[0]}.pdf`);
  });

  test("PAY-005 an archived letter marked as sent is listed with its dispatch", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const p = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 50_000,
    });
    const letter = await owner.action(api.payments.letter, {
      request: { kind: "payment_confirmation", paymentId: p.paymentIds[0] as Id<"payments"> },
    });
    await owner.mutation(api.payments.markLetterSent, {
      id: letter.letterId,
      sentOn: "2026-10-12",
      channel: "post",
      note: "Einschreiben",
    });
    const rows = await owner.query(api.payments.letters, { documentId: id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sent).toEqual({ sentOn: "2026-10-12", channel: "post", note: "Einschreiben" });
    expect(rows[0]?.hasData).toBe(false);
  });
});
