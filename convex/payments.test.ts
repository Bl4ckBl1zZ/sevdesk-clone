import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { recordCashTransfer } from "./model/cash";
import { documentSettlement } from "./model/payments";
import { bookedTransaction } from "./payments.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 payments in Convex (PAY-010…PAY-063): rows, journal, status and bank allocation in one transaction (PAY-016).
 * The invoice is T-GLD-01: 1.000,00 net + 190,00 VAT = 1.190,00, 30 days, 2 % Skonto within 14 days (23,80).
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

const entriesOf = (t: TestT, paymentId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", paymentId))
      .collect(),
  );

const linesOf = (e: Doc<"journalEntries">) =>
  e.lines.map((l) => [l.account, l.debitCents, l.creditCents] as const).sort((a, b) => a[0].localeCompare(b[0]));

/** Moves the clock; the seeded session would expire after 7 days, so a fresh owner session is returned. */
async function jump(t: TestT, iso: string) {
  vi.setSystemTime(new Date(iso));
  return t.asUser("owner");
}

const lockOctober = (t: TestT) =>
  t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "periods",
      { period: "2026-10", status: "locked", lockedAt: Date.now(), lockedBy: "user:test-owner", reason: "manual" },
      { action: "period.lock" },
    ),
  );

async function invoice(t: TestT) {
  const f = await finalizedInvoice(t);
  return { ...f, id: f.id as Id<"salesDocuments"> };
}

describe("PAY-010 PAY-012 PAY-043 recording payments", () => {
  test("PAY-012 PAY-043 PAY-016 a partial clearing payment leaves the rest open and posts bank S / receivable H", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 50_000,
    });
    expect(r.paymentIds).toHaveLength(1);
    const d = await docOf(t, id);
    expect(d.paymentStatus).toBe("partially_paid");
    expect(d.openAmountCents).toBe(69_000);
    const [entry] = await entriesOf(t, r.paymentIds[0] as string);
    expect(entry && linesOf(entry)).toEqual([
      ["1200", 50_000, 0],
      ["1400", 0, 50_000],
    ]);
    const p = await t.run(async (ctx) => ctx.db.get(r.paymentIds[0] as Id<"payments">));
    expect(p?.journalEntryIds).toEqual([entry?._id]);

    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 69_000,
    });
    const paid = await docOf(t, id);
    expect(paid.paymentStatus).toBe("paid");
    expect(paid.openAmountCents).toBe(0);
  });

  test("EC-PAY-04 a payment on a draft is rejected", async () => {
    const t = makeT();
    const { owner, personId, bankAccount } = await invoice(t);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id as Id<"salesDocuments">,
        source: { kind: "clearing", accountId: bankAccount },
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(reasonOf(e)).toBe("DRAFT");
    expect(messageOf(e)).toBe("Zahlungen können nur auf fertiggestellte Rechnungen gebucht werden.");
  });

  test("EC-PAY-06 EC-PAY-37 future dates and zero amounts are rejected", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const base = { documentId: id, source: { kind: "clearing" as const, accountId: bankAccount } };
    expect(
      reasonOf(
        await catching(
          owner.mutation(api.payments.recordForInvoice, { ...base, date: "2026-10-13", amountCents: 100 }),
        ),
      ),
    ).toBe("FUTURE_DATE");
    expect(
      reasonOf(
        await catching(owner.mutation(api.payments.recordForInvoice, { ...base, date: "2026-10-12", amountCents: 0 })),
      ),
    ).toBe("AMOUNT_POSITIVE");
  });

  test("PAY-045 EC-PAY-08 no payment in a locked period", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    await lockOctober(t);
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "clearing", accountId: bankAccount },
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(errorCode(e)).toBe("period_locked");
    expect(messageOf(e)).toMatch(/10\/2026 ist festgeschrieben/);
  });
});

describe("PAY-021 PAY-022 Skonto", () => {
  test("PAY-021 UST-32 Skonto within the period settles the invoice and posts the VAT correction in the payment period", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 116_620,
      differences: [{ reason: "skonto", amountCents: 2_380 }],
    });
    const d = await docOf(t, id);
    expect(d.paymentStatus).toBe("paid");
    const p = await t.run(async (ctx) => ctx.db.get(r.paymentIds[0] as Id<"payments">));
    expect(p?.differences).toEqual([
      { reason: "skonto", amountCents: 2_380, vatCorrection: [{ rateBp: 1900, netCents: 2_000, vatCents: 380 }] },
    ]);
    const [entry] = await entriesOf(t, r.paymentIds[0] as string);
    expect(entry && linesOf(entry)).toEqual([
      ["1200", 116_620, 0],
      ["1400", 0, 119_000],
      ["1776", 380, 0],
      ["8736", 2_000, 0],
    ]);
  });

  test("EC-122 PAY-022 EC-PAY-09 late Skonto is never booked as Skonto; the remainder stays open", async () => {
    const t = makeT();
    let { owner, id, bankAccount } = await invoice(t);
    owner = await jump(t, "2026-10-30T10:00:00Z");
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "clearing", accountId: bankAccount },
        date: "2026-10-30",
        amountCents: 116_620,
        differences: [{ reason: "skonto", amountCents: 2_380 }],
      }),
    );
    expect(reasonOf(e)).toBe("SKONTO_NOT_ALLOWED");
    expect(messageOf(e)).toMatch(/^Skonto-Frist überschritten \(Zahlung am 30\.10\.2026, Frist bis 26\.10\.2026\)/);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-30",
      amountCents: 116_620,
    });
    const d = await docOf(t, id);
    expect(d.paymentStatus).toBe("partially_paid");
    expect(d.openAmountCents).toBe(2_380);
  });
});

describe("PAY-030 PAY-031 PAY-032 PAY-033 overpayment, credit balance, refund", () => {
  test("EC-PAY-01 PAY-030 an overpayment needs a choice; as credit balance it becomes a contactCredit row (P6)", async () => {
    const t = makeT();
    const { owner, id, bankAccount, personId } = await invoice(t);
    const base = {
      documentId: id,
      source: { kind: "clearing" as const, accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 120_000,
    };
    const e = await catching(owner.mutation(api.payments.recordForInvoice, base));
    expect(reasonOf(e)).toBe("EXCESS");
    expect(messageOf(e)).toMatch(/übersteigt den offenen Betrag um 10,00/);
    const r = await owner.mutation(api.payments.recordForInvoice, { ...base, excess: { mode: "credit" } });
    expect(r.paymentIds).toHaveLength(2);
    expect(r.allocationGroupId).toBeTruthy();
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    const credit = await owner.query(api.payments.contactCredit, { contactId: personId as Id<"contacts"> });
    expect(credit.balanceCents).toBe(1_000);
  });

  test("PAY-032 PAY-033 PAY-062 the credit is applied to the next invoice and a remainder refunded in cash", async () => {
    const t = makeT();
    const { owner, id, bankAccount, personId } = await invoice(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 130_000,
      excess: { mode: "credit" },
    });
    const second = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: second.id, version: 1 });
    await settle(t);
    const contactId = personId as Id<"contacts">;
    const applied = await owner.mutation(api.payments.applyCredit, {
      contactId,
      documentId: second.id as Id<"salesDocuments">,
      amountCents: 8_000,
      date: "2026-10-12",
    });
    expect(applied.paymentIds).toHaveLength(2);
    expect((await docOf(t, second.id as Id<"salesDocuments">)).openAmountCents).toBe(111_000);
    expect((await owner.query(api.payments.contactCredit, { contactId })).balanceCents).toBe(3_000);
    const over = await catching(
      owner.mutation(api.payments.refund, {
        contactId,
        amountCents: 5_000,
        source: { kind: "cash" },
        date: "2026-10-12",
      }),
    );
    expect(messageOf(over)).toMatch(/^Die Erstattung übersteigt den offenen Erstattungsbetrag \(30,00\s€\)\.$/);
    // cash refund needs cash on hand (never negative, PAY-062): a cash receipt first.
    const third = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: third.id, version: 1 });
    await settle(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: third.id as Id<"salesDocuments">,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    const refund = await owner.mutation(api.payments.refund, {
      contactId,
      amountCents: 3_000,
      source: { kind: "cash" },
      date: "2026-10-12",
    });
    const [entry] = await entriesOf(t, refund.paymentId);
    expect(entry && linesOf(entry)).toEqual([
      ["1000", 0, 3_000],
      ["1400", 3_000, 0],
    ]);
    expect((await owner.query(api.payments.contactCredit, { contactId })).balanceCents).toBe(0);
  });
});

describe("PAY-040 PAY-041 PAY-042 reversal", () => {
  test("PAY-040 a reversal row negates the payment, reopens the invoice and mirrors the journal entry", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const paymentId = r.paymentIds[0] as Id<"payments">;
    expect(messageOf(await catching(owner.mutation(api.payments.reverse, { paymentId, reason: "x" })))).toBe(
      "Bitte einen Grund angeben (mindestens 5 Zeichen).",
    );
    const rev = await owner.mutation(api.payments.reverse, { paymentId, reason: "Falsche Rechnung zugeordnet" });
    expect(rev.date).toBe("2026-10-12");
    const d = await docOf(t, id);
    expect(d.paymentStatus).toBe("open");
    expect(d.openAmountCents).toBe(119_000);
    const original = await t.run(async (ctx) => ctx.db.get(paymentId));
    expect(original?.reversedById).toBe(rev.reversalIds[0]);
    const [entry] = await entriesOf(t, rev.reversalIds[0] as string);
    expect(entry && linesOf(entry)).toEqual([
      ["1200", 0, 119_000],
      ["1400", 119_000, 0],
    ]);
    expect(
      messageOf(await catching(owner.mutation(api.payments.reverse, { paymentId, reason: "nochmal stornieren" }))),
    ).toBe("Diese Zahlung wurde bereits storniert.");
    expect(
      messageOf(
        await catching(
          owner.mutation(api.payments.reverse, {
            paymentId: rev.reversalIds[0] as Id<"payments">,
            reason: "Storno vom Storno",
          }),
        ),
      ),
    ).toBe("Eine Stornobuchung kann nicht storniert werden. Bitte die Zahlung neu erfassen.");
  });

  test("PAY-041 EC-PAY-29 a reversal in a locked period is dated today", async () => {
    const t = makeT();
    let { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    owner = await jump(t, "2026-11-05T10:00:00Z");
    await lockOctober(t);
    const rev = await owner.mutation(api.payments.reverse, {
      paymentId: r.paymentIds[0] as Id<"payments">,
      reason: "Zahlung irrtümlich erfasst",
    });
    expect(rev.date).toBe("2026-11-05");
    expect(rev.warnings[0]?.code).toBe("reversal_period_locked");
  });
});

describe("PAY-061 PAY-062 PAY-063 cash („Bar bezahlt“)", () => {
  test("PAY-061 a cash payment posts cash S / receivable H; > 1 day back needs the acknowledgement, > 10 days a reason", async () => {
    const t = makeT();
    let { owner, id } = await invoice(t);
    owner = await jump(t, "2026-10-15T10:00:00Z");
    const base = { documentId: id, source: { kind: "cash" as const }, amountCents: 10_000 };
    const warn = await catching(owner.mutation(api.payments.recordForInvoice, { ...base, date: "2026-10-12" }));
    expect(reasonOf(warn)).toBe("WARNINGS_UNACKNOWLEDGED");
    expect(messageOf(warn)).toBe(
      "Bareinnahmen sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Das Zahlungsdatum liegt 3 Tage zurück – bitte prüfen.",
    );
    const r = await owner.mutation(api.payments.recordForInvoice, {
      ...base,
      date: "2026-10-12",
      acknowledgeWarnings: ["cash_daily_recording"],
    });
    const [entry] = await entriesOf(t, r.paymentIds[0] as string);
    expect(entry && linesOf(entry)).toEqual([
      ["1000", 10_000, 0],
      ["1400", 0, 10_000],
    ]);
    owner = await jump(t, "2026-10-30T10:00:00Z");
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        ...base,
        date: "2026-10-13",
        acknowledgeWarnings: ["cash_daily_recording"],
      }),
    );
    expect(messageOf(e)).toBe(
      "Die Barzahlung liegt mehr als 10 Tage zurück. Bitte begründen, warum sie erst jetzt erfasst wird.",
    );
    const late = await owner.mutation(api.payments.recordForInvoice, {
      ...base,
      date: "2026-10-13",
      backdateReason: "Beleg lag im Auto",
      acknowledgeWarnings: ["cash_daily_recording"],
    });
    const row = await t.run(async (ctx) => ctx.db.get(late.paymentIds[0] as Id<"payments">));
    expect(row?.backdateReason).toBe("Beleg lag im Auto");
  });

  test("EC-PAY-50 a cash excess cannot stay unallocated", async () => {
    const t = makeT();
    const { owner, id } = await invoice(t);
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "cash" },
        date: "2026-10-12",
        amountCents: 120_000,
        excess: { mode: "unallocated" },
      }),
    );
    expect(messageOf(e)).toBe(
      "Ein Mehrbetrag aus einer Barzahlung muss zugeordnet werden (weitere Rechnung, Mahngebühren/Zinsen oder Guthaben).",
    );
  });

  test("PAY-062 EC-PAY-28 RI-11 reversing a cash payment that was already deposited is blocked (never negative)", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    await t.model(OWNER, (ctx) =>
      recordCashTransfer(ctx, {
        kind: "deposit_to_bank",
        date: "2026-10-12",
        amountCents: 119_000,
        bankAccountId: bankAccount,
      }),
    );
    const e = await catching(
      owner.mutation(api.payments.reverse, {
        paymentId: r.paymentIds[0] as Id<"payments">,
        reason: "Irrtum korrigieren",
      }),
    );
    expect(errorCode(e)).toBe("cash_negative");
  });

  test("PAY-063 EC-PAY-51 the Quittung is archived once; a reprint is a copy", async () => {
    const t = makeT();
    const { owner, id } = await invoice(t);
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const paymentId = r.paymentIds[0] as Id<"payments">;
    const first = await owner.action(api.payments.receipt, { paymentId });
    expect(first.copy).toBe(false);
    const stored = await t.run(async (ctx) => (await ctx.db.get(paymentId))?.receiptFile);
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const second = await owner.action(api.payments.receipt, { paymentId });
    expect(second.copy).toBe(true);
    expect(second.pdfBase64?.length).toBeGreaterThan(100);
    expect((await t.run(async (ctx) => (await ctx.db.get(paymentId))?.receiptFile))?.sha256).toBe(stored?.sha256);
  });
});

describe("PAY-025 PAY-026 write-off and recovery", () => {
  test("PAY-025 S3 a Soll write-off of the remainder posts bad debt + output-VAT reduction; status written_off", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 59_500,
    });
    const w = await owner.mutation(api.payments.writeOff, {
      documentId: id,
      date: "2026-10-12",
      amountCents: 59_500,
      subReason: "insolvency",
    });
    expect((await docOf(t, id)).paymentStatus).toBe("written_off");
    const [entry] = await entriesOf(t, w.paymentIds[0] as string);
    expect(entry && linesOf(entry)).toEqual([
      ["1400", 0, 59_500],
      ["1776", 9_500, 0],
      ["2406", 50_000, 0],
    ]);
    // EC-PAY-18: a further payment only through the recovery wizard
    const e = await catching(
      owner.mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "clearing", accountId: bankAccount },
        date: "2026-10-12",
        amountCents: 20_000,
      }),
    );
    expect(reasonOf(e)).toBe("WRITTEN_OFF");
    // PAY-026 S5: reverse the write-off today, record 200,00, write the rest off again
    const rec = await owner.mutation(api.payments.recordRecoveryPayment, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 20_000,
      writeOffRest: "insolvency",
    });
    expect(rec.reversalIds).toHaveLength(1);
    const again = await t.run(async (ctx) => ctx.db.get(rec.writeOff?.paymentIds[0] as Id<"payments">));
    expect(again?.differences[0]?.vatCorrection).toEqual([{ rateBp: 1900, netCents: 33_193, vatCents: 6_307 }]);
    expect((await docOf(t, id)).paymentStatus).toBe("written_off");
  });
});

describe("PAY-011 bank-sourced payments", () => {
  test("PAY-011 PAY-042 BNK-122 a bank payment allocates the transaction; the reversal releases it", async () => {
    const t = makeT();
    const { owner, id, bankAccount, number } = await invoice(t);
    const txId = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: `Rechnung ${number}`,
    });
    const r = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "bank", transactionId: txId },
      date: "2026-10-01",
      amountCents: 119_000,
    });
    const tx = await t.run(async (ctx) => ctx.db.get(txId));
    expect(tx?.status).toBe("matched");
    expect(tx?.allocatedCents).toBe(119_000);
    const row = await t.run(async (ctx) => ctx.db.get(r.paymentIds[0] as Id<"payments">));
    expect(row?.date).toBe("2026-10-12"); // PAY-010: the booking date, fixed
    await owner.mutation(api.payments.reverse, {
      paymentId: r.paymentIds[0] as Id<"payments">,
      reason: "Falsch zugeordnet",
    });
    const after = await t.run(async (ctx) => ctx.db.get(txId));
    expect(after?.status).toBe("open");
    expect(after?.allocatedCents).toBe(0);
  });

  test("EC-PAY-02 allocations above the transaction amount are rejected", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    const txId = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 50_000,
      purpose: "x",
    });
    const e = await catching(
      owner.mutation(api.payments.record, {
        source: { kind: "bank", transactionId: txId },
        date: "2026-10-12",
        allocations: [{ target: { kind: "salesDocument", id }, amountCents: 60_000 }],
      }),
    );
    expect(reasonOf(e)).toBe("SOURCE_EXCEEDED");
  });
});

describe("PAY-019 MCP-004 confirm tokens", () => {
  test("PAY-019 an MCP actor cannot record a payment without a confirm token", async () => {
    const t = makeT();
    const { id, bankAccount } = await invoice(t);
    const mcp = await t.asMcp(["payments:write", "payments:read"]);
    const e = await catching(
      mcp.mutation(api.payments.recordForInvoice, {
        documentId: id,
        source: { kind: "clearing", accountId: bankAccount },
        date: "2026-10-12",
        amountCents: 100,
      }),
    );
    expect(errorCode(e)).toBe("confirm_token_required");
  });
});

describe("RI-08 advances API", () => {
  test("RI-08 documentSettlement reports payable, received, open and the last payment date", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await invoice(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 116_620,
      differences: [{ reason: "skonto", amountCents: 2_380 }],
    });
    const s = await t.run((ctx) => documentSettlement(ctx, id));
    expect(s).toMatchObject({
      payableCents: 119_000,
      receivedCents: 116_620,
      settledCents: 119_000,
      openAmountCents: 0,
      fullySettled: true,
      paidOn: "2026-10-12",
    });
  });
});
