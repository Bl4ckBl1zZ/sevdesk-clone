import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { auditedDelete, auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { postJournalEntry } from "./model/journal";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, setupCompany, TODAY, upload, YEAR } from "./vouchers.fixtures";

/**
 * F06 voucher payments (VOU-131…139, CSH-022/023/026, EC-VOU-39…44): guards of `recordVoucherPayment`,
 * „Zahlung umbuchen“ and the bank suggestions of convex/model/voucherPayments.ts.
 */

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string; data: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e) ?? "unknown", message: String(data.message ?? (e as Error).message), data };
  }
  throw new Error("expected an error");
}

const voucher = (t: TestT, id: Id<"vouchers">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"vouchers">>;
const paymentsOf = (t: TestT) => t.run((ctx) => ctx.db.query("payments").collect());

async function draft(t: TestT, owner: Owner, over: Record<string, unknown> = {}) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header(over) });
  return voucherId;
}

async function booked(t: TestT, owner: Owner, over: Record<string, unknown> = {}) {
  const id = await draft(t, owner, over);
  await owner.mutation(api.vouchers.finalize, { id });
  return id;
}

async function openingCash(t: TestT, cents: number, date = `${YEAR}-01-01`) {
  await t.model(OWNER, (ctx) =>
    postJournalEntry(ctx, {
      kind: "opening_balance",
      fiscalYear: YEAR,
      date,
      part: { kind: "cash", amountCents: cents },
    }),
  );
}

/** A booked debit in USD (stored like the statement import; the currency is frozen after the insert). */
async function usdTransaction(t: TestT, accountId: Id<"bankAccounts">) {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        accountId,
        bookingDate: TODAY,
        amountCents: -11_900,
        currency: "USD",
        purpose: "USD Rechnung",
        source: { kind: "camt053", entryReference: "ER-USD", rawSha256: "usd" },
        sources: [],
        dedupeKey: `${accountId}:er:ER-USD`,
        contentHash: "usd",
        status: "open",
        allocatedCents: 0,
        recordedAt: Date.now(),
      },
      { action: "bank.import", label: "USD" },
    ),
  );
}

const daysAgo = (n: number) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

describe("recordVoucherPayment guards (VOU-131, VOU-136…138)", () => {
  test("VOU-131 a payment on a voucher that no longer exists is refused (not_found)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    await t.run(async (ctx) => {
      for (const l of await ctx.db
        .query("voucherLines")
        .withIndex("by_voucher", (q) => q.eq("voucherId", id))
        .collect())
        await ctx.db.delete(l._id);
      await ctx.db.delete(id);
    });
    const e = await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "private" }));
    expect(e.code).toBe("not_found");
    expect(e.message).toBe("Der Beleg existiert nicht.");
    const s = await errorOf(owner.query(api.vouchers.bankSuggestions, { id }));
    expect(s.code).toBe("not_found");
  });

  test("VOU-131 without a company profile the payment is refused (setup_incomplete)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const profile = (await t.run((ctx) => ctx.db.query("companyProfile").first())) as Doc<"companyProfile">;
    await t.model(OWNER, (ctx) =>
      auditedDelete(ctx, "companyProfile", profile._id, { action: "settings.company.update" }),
    );
    const e = await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "private" }));
    expect(e.code).toBe("setup_incomplete");
    expect(await paymentsOf(t)).toEqual([]);
    // Restore the profile so the journal invariants (chart of accounts) can be checked after the test.
    const { _id, _creationTime, ...rest } = profile;
    await t.model(OWNER, (ctx) => auditedInsert(ctx, "companyProfile", rest, { action: "settings.company.update" }));
  });

  test("VOU-131 a bank payment needs the transaction", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const e = await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "bank" }));
    expect(e).toMatchObject({ code: "invalid_input", message: "Bitte den Bankumsatz angeben." });
  });

  test("VOU-131 a foreign-currency bank transaction is not allocated yet (FX_DEFERRED)", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await usdTransaction(t, bank);
    const e = await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx }));
    expect(e.data.reason).toBe("FX_DEFERRED");
    expect(e.message).toBe("Fremdwährungsumsätze werden noch nicht zugeordnet.");
  });

  test("VOU-131 a credit (incoming) transaction cannot pay an expense voucher (DIRECTION)", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: 11_900, purpose: "Gutschrift" });
    const e = await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx }));
    expect(e.data.reason).toBe("DIRECTION");
    expect(e.message).toContain("Ausgabe = Abbuchung");
  });

  test("VOU-131 the amount may not exceed the unallocated part of the transaction (ALLOCATION_EXCEEDS)", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -5_000, purpose: "Teil" });
    const e = await errorOf(
      owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx, amountCents: 6_000 }),
    );
    expect(e.data.reason).toBe("ALLOCATION_EXCEEDS");
    expect((await voucher(t, id)).status).toBe("open");
  });

  test("VOU-131 a bank amount of zero or above the open amount is refused (PAYMENT_AMOUNT_INVALID)", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -20_000, purpose: "Sammel" });
    const zero = await errorOf(
      owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx, amountCents: 0 }),
    );
    expect(zero.data.reason).toBe("PAYMENT_AMOUNT_INVALID");
    const over = await errorOf(
      owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx, amountCents: 15_000 }),
    );
    expect(over.message).toBe("Der Betrag darf den offenen Betrag nicht übersteigen.");
  });

  test("VOU-131 a partial bank payment with a note and an „other“ difference on an account stores both; the voucher is partially paid", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -5_000, purpose: "Teilzahlung" });
    const r = await owner.mutation(api.vouchers.recordPayment, {
      id,
      method: "bank",
      transactionId: tx,
      amountCents: 4_900,
      note: "  Rest folgt  ",
      differences: [{ reason: "other", amountCents: 100, account: "6855" }],
    });
    const p = await t.run((ctx) => ctx.db.get(r.paymentId));
    expect(p).toMatchObject({
      note: "Rest folgt",
      amountCents: 4_900,
      differences: [{ reason: "other", amountCents: 100, account: "6855" }],
      source: { kind: "bank", transactionId: tx },
    });
    expect(p?.differences[0]?.vatCorrection).toBeUndefined();
    const v = await voucher(t, id);
    expect(v.status).toBe("partially_paid");
    expect(v.openAmountCents).toBe(11_900 - 5_000);
    expect(await t.run((ctx) => ctx.db.get(tx))).toMatchObject({ allocatedCents: 4_900 });
  });

  test("VOU-138 EC-VOU-44 „Privat bezahlt“ is not available for income vouchers", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      direction: "income",
      taxRule: "output_vat",
      supplierName: "Versicherung AG",
      lines: [line({ account: "4830", description: "Erstattung", amountCents: 11_900 })],
    });
    await owner.mutation(api.vouchers.finalize, { id, acknowledgeWarnings: ["income_own_sales"] });
    const e = await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "private" }));
    expect(e.data.reason).toBe("PAYMENT_PRIVATE_INCOME");
    expect(e.message).toBe("Einnahmen können nicht privat bezahlt werden. Bitte Bank oder Bar wählen.");
  });

  test("CSH-022 a cash payment dated before the cash opening balance is refused", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner, { documentDate: daysAgo(20) });
    // No cash opening balance: the Buchungsbeginn is the earliest cash date.
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { bookkeepingStartDate: daysAgo(5) }, { action: "settings.company.update" }),
    );
    const e = await errorOf(
      owner.mutation(api.vouchers.recordPayment, {
        id,
        method: "cash",
        date: daysAgo(15),
        backdateReason: "Beleg lag im Auto",
        acknowledgeWarnings: ["cash_backdated"],
      }),
    );
    expect(e.code).toBe("invalid_input");
    expect(e.data.reason).toBe("CASH_DATE");
    expect(await paymentsOf(t)).toEqual([]);
  });

  test("EC-VOU-40 a backdated cash payment needs the acknowledgement; with it the reason is stored and audited", async () => {
    const t = makeT();
    await setupCompany(t);
    await openingCash(t, 50_000);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner, { documentDate: daysAgo(20) });
    const missing = await errorOf(
      owner.mutation(api.vouchers.recordPayment, {
        id,
        method: "cash",
        date: daysAgo(12),
        backdateReason: "Beleg lag im Auto",
      }),
    );
    expect(missing.data).toMatchObject({ reason: "WARNINGS_UNACKNOWLEDGED", warnings: "cash_backdated" });
    expect(missing.message).toContain("§ 146 Abs. 1 S. 2 AO");
    const r = await owner.mutation(api.vouchers.recordPayment, {
      id,
      method: "cash",
      date: daysAgo(12),
      backdateReason: "  Beleg lag im Auto ",
      acknowledgeWarnings: ["cash_backdated"],
    });
    expect(r.warnings.map((w) => w.code)).toEqual(["cash_backdated"]);
    const p = await t.run((ctx) => ctx.db.get(r.paymentId));
    expect(p).toMatchObject({ backdateReason: "Beleg lag im Auto", source: { kind: "cash" }, date: daysAgo(12) });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "payments").eq("entity.id", r.paymentId))
        .collect(),
    );
    expect(audit.find((a) => a.action === "payment.record")?.reason).toBe("Beleg lag im Auto");
    expect((await voucher(t, id)).status).toBe("paid");
  });

  test("CSH-022 VOU-130 a cash receipt on an income voucher under Ist-Versteuerung releases the not-due VAT", async () => {
    const t = makeT();
    await setupCompany(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] },
        { action: "settings.tax.update" },
      ),
    );
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      direction: "income",
      taxRule: "output_vat",
      supplierName: "Versicherung AG",
      lines: [line({ account: "4830", description: "Erstattung", amountCents: 11_900 })],
    });
    await owner.mutation(api.vouchers.finalize, { id, acknowledgeWarnings: ["income_own_sales"] });
    const before = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", id))
        .collect(),
    );
    const notDue = before.flatMap((e) => e.lines).filter((l) => l.role === "vat.output.notdue.19");
    expect(notDue.length).toBeGreaterThan(0);
    const r = await owner.mutation(api.vouchers.recordPayment, { id, method: "cash" });
    const [entry] = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", r.paymentId))
        .collect(),
    );
    const roles = entry?.lines.map((l) => l.role) ?? [];
    expect(roles).toContain("vat.output.notdue.19");
    expect(roles).toContain("cash");
    expect((await voucher(t, id)).status).toBe("paid");
  });

  test("VOU-138 without a Kleinunternehmer history the input VAT of a private payment is deducted (regular taxation)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { kleinunternehmer: [] }, { action: "settings.tax.update" }),
    );
    const r = await owner.mutation(api.vouchers.recordPayment, { id, method: "private" });
    const p = await t.run((ctx) => ctx.db.get(r.paymentId));
    expect(p).toMatchObject({ source: { kind: "private" }, amountCents: 11_900 });
    expect(p?.journalEntryIds.length).toBe(1);
    expect((await voucher(t, id)).status).toBe("paid");
  });
});

describe("„Zahlung umbuchen“ (VOU-139, EC-VOU-43)", () => {
  test("VOU-139 the reason needs at least 5 characters", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -11_900, purpose: "Karte" });
    const e = await errorOf(owner.mutation(api.vouchers.rebookPayment, { id, transactionId: tx, reason: " ab " }));
    expect(e).toMatchObject({ code: "invalid_input", message: "Bitte einen Grund angeben (mindestens 5 Zeichen)." });
  });

  test("EC-VOU-43 a voucher that is not settled bar/privat has nothing to rebook (NOTHING_TO_REBOOK)", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -11_900, purpose: "Karte" });
    const e = await errorOf(
      owner.mutation(api.vouchers.rebookPayment, { id, transactionId: tx, reason: "War Kartenzahlung" }),
    );
    expect(e.data.reason).toBe("NOTHING_TO_REBOOK");
    expect(e.message).toBe("Der Beleg ist nicht als bar oder privat bezahlt erfasst.");
  });

  test("VOU-139 a voucher paid privately shows „Bereits als privat bezahlt erfasst“ and is rebooked to the bank", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    await owner.mutation(api.vouchers.recordPayment, { id, method: "private" });
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -11_900, purpose: "Lastschrift" });
    const s = await owner.query(api.vouchers.bankSuggestions, { id });
    expect(s.alreadySettled).toBe("private");
    expect(s.alreadySettledLabel).toBe("Bereits als privat bezahlt erfasst");
    expect(s.suggestions[0]).toMatchObject({ transactionId: tx, reasons: ["Betrag", "Datum"] });
    const r = await owner.mutation(api.vouchers.rebookPayment, { id, transactionId: tx, reason: "War Lastschrift" });
    expect(r.reversalIds).toHaveLength(1);
    expect((await paymentsOf(t)).map((p) => [p.source.kind, p.amountCents])).toEqual([
      ["private", 11_900],
      ["private", -11_900],
      ["bank", 11_900],
    ]);
  });
});

describe("bank suggestions (VOU-131)", () => {
  test("VOU-131 the scorer skips unsuitable transactions and ranks by amount, date, voucher and invoice number", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner, { documentNumber: "RE 2026 4711" });
    const v = await voucher(t, id);
    const internal = v.internalNumber as string;
    // Skipped: wrong direction, foreign currency, more than 60 days away, too weak a score.
    await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: 11_900, purpose: "Gutschrift" });
    await usdTransaction(t, bank);
    await bookedTransaction(t, bank, { bookingDate: daysAgo(90), amountCents: -11_900, purpose: "alt" });
    await bookedTransaction(t, bank, { bookingDate: daysAgo(30), amountCents: -50_000, purpose: "anderes" });
    // Kept: similar amount + invoice number (spaces ignored), weeks away; exact amount + internal number.
    const similar = await bookedTransaction(t, bank, {
      bookingDate: daysAgo(20),
      amountCents: -11_800,
      purpose: "Zahlung RE20264711",
    });
    const partial = await bookedTransaction(t, bank, {
      bookingDate: daysAgo(3),
      amountCents: -20_000,
      purpose: `Beleg ${internal}`,
    });
    // Another voucher of 81,00 takes part of that debit → partially matched, 119,00 still free.
    const other = await booked(t, owner, { lines: [line({ amountCents: 8_100 })] });
    await owner.mutation(api.vouchers.recordPayment, {
      id: other,
      method: "bank",
      transactionId: partial,
      amountCents: 8_100,
    });
    expect(await t.run((ctx) => ctx.db.get(partial))).toMatchObject({
      status: "partially_matched",
      allocatedCents: 8_100,
    });
    const s = await owner.query(api.vouchers.bankSuggestions, { id });
    expect(s.alreadySettled).toBeNull();
    expect(s.alreadySettledLabel).toBeNull();
    expect(s.suggestions.map((x) => x.transactionId)).toEqual([partial, similar]);
    expect(s.suggestions[0]).toMatchObject({
      openCents: 11_900,
      reasons: ["Betrag", "Datum", "Belegnummer"],
      score: 1,
    });
    expect(s.suggestions[1]).toMatchObject({
      openCents: 11_800,
      reasons: ["Betrag ähnlich", "Rechnungsnummer"],
      score: 0.5,
      counterpartyName: null,
    });
  });

  test("VOU-131 a voucher without a document date is scored against today", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -50, purpose: "Kleinbetrag" });
    const s = await owner.query(api.vouchers.bankSuggestions, { id: voucherId });
    expect(s.suggestions).toHaveLength(1);
    expect(s.suggestions[0]).toMatchObject({ transactionId: tx, reasons: ["Betrag ähnlich", "Datum"] });
  });
});

describe("income vouchers and private payments (VOU-131, VOU-138)", () => {
  test("VOU-131 an income voucher is suggested credits (equal scores by date) and settled by a bank credit", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      direction: "income",
      taxRule: "output_vat",
      supplierName: "Versicherung AG",
      lines: [line({ account: "4830", description: "Erstattung", amountCents: 11_900 })],
    });
    await owner.mutation(api.vouchers.finalize, { id, acknowledgeWarnings: ["income_own_sales"] });
    await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -11_900, purpose: "Abbuchung" });
    const later = await bookedTransaction(t, bank, {
      bookingDate: daysAgo(1),
      amountCents: 11_900,
      purpose: "Eingang",
    });
    const earlier = await bookedTransaction(t, bank, {
      bookingDate: daysAgo(2),
      amountCents: 11_900,
      purpose: "Eingang",
    });
    const s = await owner.query(api.vouchers.bankSuggestions, { id });
    expect(s.suggestions.map((x) => x.transactionId)).toEqual([earlier, later]);
    expect(s.suggestions.map((x) => x.score)).toEqual([0.8, 0.8]);
    await owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: later });
    expect((await voucher(t, id)).status).toBe("paid");
    expect(await t.run((ctx) => ctx.db.get(later))).toMatchObject({ status: "matched", allocatedCents: 11_900 });
  });

  test("VOU-138 a backdate reason is kept only for cash: a private payment stores none", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const r = await owner.mutation(api.vouchers.recordPayment, {
      id,
      method: "private",
      backdateReason: "Auslage nachgereicht",
    });
    const p = await t.run((ctx) => ctx.db.get(r.paymentId));
    expect(p?.source.kind).toBe("private");
    expect(p?.backdateReason).toBeUndefined();
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "payments").eq("entity.id", r.paymentId))
        .collect(),
    );
    expect(audit.find((a) => a.action === "payment.record")?.reason).toBeUndefined();
  });
});
