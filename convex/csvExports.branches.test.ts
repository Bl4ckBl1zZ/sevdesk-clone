import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, settle } from "./invoices.fixtures";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-021 list CSV exports: date ranges, type and account filters and the row fields of every list. */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Owner = Awaited<ReturnType<typeof finalizedInvoice>>["owner"];
type Params = {
  list: "documents" | "open_items" | "payments" | "bank_transactions" | "journal";
  type?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
};

async function csv(owner: Owner, p: Params) {
  const r = await owner.mutation(api.exports.csv, { variant: "technical", ...p });
  if (r.kind !== "file") throw new Error("expected a direct file");
  return { rows: r.rows, lines: r.content.split("\r\n").filter(Boolean).slice(1) };
}

async function books(t: TestT) {
  const f = await finalizedInvoice(t);
  const paid = await f.owner.mutation(api.payments.recordForInvoice, {
    documentId: f.id as Id<"salesDocuments">,
    source: { kind: "clearing", accountId: f.bankAccount },
    date: "2026-10-12",
    amountCents: 20_000,
    note: "Teilzahlung Oktober",
  });
  await f.owner.mutation(api.payments.reverse, {
    paymentId: paid.paymentIds[0] as Id<"payments">,
    reason: "Falsch zugeordnet",
  });
  await bookedTransaction(t, f.bankAccount, {
    bookingDate: "2026-10-05",
    amountCents: 5_000,
    purpose: "Gutschrift",
    counterpartyName: "Kunde GmbH",
    counterpartyIban: "DE89370400440532013000",
  });
  await bookedTransaction(t, f.bankAccount, { bookingDate: "2026-09-20", amountCents: -1_200, purpose: "Gebühr" });
  await settle(t);
  return f;
}

describe("list CSV export filters (EXP-021)", { timeout: 60_000 }, () => {
  test("EXP-021 documents: the type filter and the date range select the rows; a type without documents gives an empty file", async () => {
    const t = makeT();
    const f = await books(t);
    const all = await csv(f.owner, { list: "documents" });
    expect(all.rows).toBe(1);
    expect(all.lines[0]).toContain(f.number);
    expect((await csv(f.owner, { list: "documents", type: "quote" })).rows).toBe(0);
    expect((await csv(f.owner, { list: "documents", type: "invoice", dateFrom: "2026-10-01" })).rows).toBe(1);
    expect((await csv(f.owner, { list: "documents", dateTo: "2026-09-30" })).rows).toBe(0);
    expect((await csv(f.owner, { list: "documents", dateFrom: "2026-10-01", dateTo: "2026-10-31" })).rows).toBe(1);
  });

  test("EXP-021 payments: range bounds, the reversed flag, the note and the invoice number as target", async () => {
    const t = makeT();
    const f = await books(t);
    const all = await csv(f.owner, { list: "payments" });
    expect(all.rows).toBe(2);
    expect(all.lines.every((l) => l.includes(f.number))).toBe(true);
    expect(all.lines.some((l) => l.includes("Teilzahlung Oktober"))).toBe(true);
    expect(all.lines.every((l) => l.includes(",true,") || l.endsWith(",true"))).toBe(true);
    expect((await csv(f.owner, { list: "payments", dateFrom: "2026-10-13" })).rows).toBe(0);
    expect((await csv(f.owner, { list: "payments", dateTo: "2026-10-12" })).rows).toBe(2);
  });

  test("EXP-021 bank transactions: by account and booking-date range; an unknown account id lists every account", async () => {
    const t = makeT();
    const f = await books(t);
    const all = await csv(f.owner, { list: "bank_transactions" });
    expect(all.rows).toBe(2);
    const byAccount = await csv(f.owner, { list: "bank_transactions", accountId: f.bankAccount });
    expect(byAccount.rows).toBe(2);
    expect(byAccount.lines.some((l) => l.includes("Kunde GmbH") && l.includes("DE89370400440532013000"))).toBe(true);
    expect((await csv(f.owner, { list: "bank_transactions", accountId: "nicht-vorhanden" })).rows).toBe(2);
    const october = await csv(f.owner, { list: "bank_transactions", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(october.rows).toBe(1);
    expect(october.lines[0]).toContain("Gutschrift");
    expect(
      (await csv(f.owner, { list: "bank_transactions", accountId: f.bankAccount, dateTo: "2026-09-30" })).rows,
    ).toBe(1);
  });

  test("EXP-021 journal and open items: the journal by date range (with the reversal flag), open items as of the end date", async () => {
    const t = makeT();
    const f = await books(t);
    const all = await csv(f.owner, { list: "journal" });
    expect(all.rows).toBeGreaterThan(0);
    expect(all.lines.some((l) => l.endsWith(",true"))).toBe(true);
    expect((await csv(f.owner, { list: "journal", dateTo: "2026-09-30" })).rows).toBe(0);
    expect((await csv(f.owner, { list: "journal", dateFrom: "2026-10-01", dateTo: "2026-10-31" })).rows).toBe(all.rows);
    const before = await csv(f.owner, { list: "open_items", dateTo: "2026-09-30" });
    expect(before.rows).toBe(0);
    const now = await csv(f.owner, { list: "open_items", dateTo: "2026-10-12" });
    expect(now.rows).toBe(1);
    expect(now.lines[0]).toContain(f.number);
  });
});

describe("list CSV export rows without optional fields (EXP-021)", { timeout: 60_000 }, () => {
  test("EXP-021 a draft has no number or date (empty cells); a voucher payment names its target kind instead of an invoice number", async () => {
    vi.useRealTimers();
    const t = makeT();
    const { header, setupCompany, upload } = await import("./vouchers.fixtures");
    const { supplier } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header({ supplierContactId: supplier }) });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    await owner.mutation(api.vouchers.recordPayment, { id: voucherId, method: "private" });
    const payments = await csv(owner as never, { list: "payments" });
    expect(payments.rows).toBe(1);
    expect(payments.lines[0]).toContain(",voucher,");
    expect(payments.lines[0]).toContain(",false,");
  });

  test("EXP-021 documents of another type: a draft invoice row keeps number, date and due date empty", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const { invoiceValues } = await import("./invoices.fixtures");
    await f.owner.mutation(api.invoices.createDraft, { values: invoiceValues(f.personId) });
    const all = await csv(f.owner, { list: "documents" });
    expect(all.rows).toBe(2);
    const draft = all.lines.find((l) => !l.includes(f.number));
    expect(draft).toMatch(/^[^,]+,Rechnung,,/);
    // with a date range the undated draft drops out
    expect((await csv(f.owner, { list: "documents", dateFrom: "2026-01-01" })).rows).toBe(1);
  });
});
