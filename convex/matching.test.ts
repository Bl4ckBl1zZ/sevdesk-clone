import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { autoApplyMatches } from "./model/matching";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * F07 matching (BNK-040…BNK-048) on top of F05 payments: suggestions on read, confirmation through payments.record,
 * rejection, unmatch, bank reversals (BNK-121, EC-PAY-24), reconciliation of manual payments (PAY-047), refunds.
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

const docOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"salesDocuments">);
const txOf = (t: TestT, id: Id<"bankTransactions">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"bankTransactions">);

async function jump(t: TestT, iso: string) {
  vi.setSystemTime(new Date(iso));
  return t.asUser("owner");
}

async function setup() {
  const t = makeT();
  const f = await finalizedInvoice(t);
  const id = f.id as Id<"salesDocuments">;
  const d = await docOf(t, id);
  return { t, ...f, id, name: d.contactName ?? "" };
}

describe("BNK-040…BNK-045 suggestions", () => {
  test("BNK-041 BNK-042 M1 number + exact amount + name → a single candidate scoring 1.00, chips in German", async () => {
    const { t, owner, bankAccount, number, id, name } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: `Rechnung ${number}`,
      counterpartyName: name.toUpperCase(),
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: tx });
    const [best] = s.candidates;
    expect(best?.score).toBe(1);
    expect(best?.safe).toBe(true);
    expect(best?.labels).toEqual(expect.arrayContaining(["Rechnungsnr. im Verwendungszweck", "Betrag exakt"]));
    expect(best?.allocations[0]).toMatchObject({
      target: { kind: "salesDocument", id },
      amountCents: 119_000,
      label: number,
    });
  });

  test("BNK-041 the invoice number with a „RE “ prefix and without dashes is found", async () => {
    const { t, owner, bankAccount, number } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: `Zahlung RE ${number.replace(/^RE-/, "").replace(/-/g, " ")}`,
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: tx });
    expect(s.candidates[0]?.reasons).toContain("number_in_purpose");
  });
});

describe("BNK-046 confirm and reject", () => {
  test("BNK-046 BNK-045 confirming a Skonto suggestion books the payment with the Skonto difference (PAY-021)", async () => {
    const { t, owner, bankAccount, number, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 116_620,
      purpose: number,
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: tx });
    const best = s.candidates[0];
    expect(best?.reasons).toContain("skonto_amount");
    await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: (best?.allocations ?? []).map((a) => ({
        target: a.target,
        amountCents: a.amountCents,
        ...(a.differences ? { differences: a.differences as never } : {}),
      })),
      score: best?.score,
      reasons: best?.reasons,
    });
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    expect((await txOf(t, tx)).status).toBe("matched");
    const pays = await owner.query(api.payments.forDocument, { documentId: id });
    expect(pays.payments[0]?.differences[0]).toMatchObject({ reason: "skonto", amountCents: 2_380 });
    expect(pays.payments[0]?.match?.reasons).toContain("skonto_amount");
  });

  test("BNK-045 PAY-012 a partial payment with the number → partially paid; EC-BNK-64 an overpayment → credit balance", async () => {
    const { t, owner, bankAccount, number, id, personId } = await setup();
    const partial = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 50_000,
      purpose: number,
    });
    const p = (await owner.query(api.matching.suggestions, { transactionId: partial })).candidates[0];
    expect(p?.kind).toBe("partial");
    await owner.mutation(api.matching.confirm, {
      transactionId: partial,
      allocations: [{ target: { kind: "salesDocument", id }, amountCents: 50_000 }],
    });
    expect((await docOf(t, id)).paymentStatus).toBe("partially_paid");
    const over = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 80_000,
      purpose: number,
    });
    await owner.mutation(api.matching.confirm, {
      transactionId: over,
      allocations: [{ target: { kind: "salesDocument", id }, amountCents: 69_000 }],
      remainder: "credit",
    });
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    expect((await txOf(t, over)).status).toBe("matched");
    expect(
      (await owner.query(api.payments.contactCredit, { contactId: personId as Id<"contacts"> })).balanceCents,
    ).toBe(11_000);
  });

  test("BNK-046 a rejected pair is not suggested again", async () => {
    const { t, owner, bankAccount, number, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
    });
    await owner.mutation(api.matching.reject, { transactionId: tx, target: { kind: "salesDocument", id } });
    expect((await owner.query(api.matching.suggestions, { transactionId: tx })).candidates).toEqual([]);
  });

  test("BNK-048 confirming learns the counterparty IBAN as an alias (known_iban next time)", async () => {
    const { t, owner, bankAccount, number, id, personId } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 50_000,
      purpose: number,
      counterpartyName: "Kunde Zahlt GmbH",
      counterpartyIban: "DE89 3704 0044 0532 0130 00",
    });
    await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "salesDocument", id }, amountCents: 50_000 }],
    });
    const aliases = await t.run((ctx) =>
      ctx.db
        .query("contactAliases")
        .withIndex("by_contact", (q) => q.eq("contactId", personId as Id<"contacts">))
        .collect(),
    );
    expect(aliases[0]).toMatchObject({ iban: "DE89370400440532013000", source: "match_confirmed" });
    const next = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 69_000,
      purpose: "Restzahlung",
      counterpartyIban: "DE89370400440532013000",
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: next });
    expect(s.candidates[0]?.reasons).toEqual(expect.arrayContaining(["known_iban", "exact_amount"]));
  });

  test("BNK-043 PAY-019 an MCP actor needs a bank_match_confirm token", async () => {
    const { t, bankAccount, number, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
    });
    const mcp = await t.asMcp(["banking:write", "banking:read"]);
    const e = await mcp
      .mutation(api.matching.confirm, {
        transactionId: tx,
        allocations: [{ target: { kind: "salesDocument", id }, amountCents: 119_000 }],
      })
      .catch((x) => x);
    expect(errorCode(e)).toBe("confirm_token_required");
  });
});

describe("BNK-043 auto-apply and BNK-047 unmatch", () => {
  test("BNK-043 a unique number + exact amount match is auto-applied; „Rückgängig“ is the F05 reversal", async () => {
    const { t, owner, bankAccount, number, id, name } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: `${number} Danke`,
      counterpartyName: name,
    });
    const other = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 1_000,
      purpose: "Zinsen",
    });
    const applied = await t.model(OWNER, (ctx) => autoApplyMatches(ctx, [tx, other]));
    expect(applied).toEqual([tx]);
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    const review = await owner.query(api.matching.review, {});
    expect(review.autoApplied[0]?.match?.auto).toBe(true);
    expect(review.withoutSuggestion.map((r) => r.id)).toContain(other);
    await owner.mutation(api.matching.unmatch, { transactionId: tx, reason: "Falsche Zuordnung durch Automatik" });
    expect((await docOf(t, id)).paymentStatus).toBe("open");
    expect((await txOf(t, tx)).status).toBe("open");
  });

  test("BNK-047 PAY-041 „Zuordnung aufheben“ reverses the allocation, dated today when the original period is locked", async () => {
    let { t, owner, bankAccount, number, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
    });
    await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "salesDocument", id }, amountCents: 119_000 }],
    });
    expect((await docOf(t, id)).paymentStatus).toBe("paid");
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        { period: "2026-10", status: "locked", lockedAt: Date.now(), lockedBy: "user:test-owner", reason: "manual" },
        { action: "period.lock" },
      ),
    );
    owner = await jump(t, "2026-11-03T10:00:00Z");
    await owner.mutation(api.matching.unmatch, { transactionId: tx, reason: "Zahlung gehört zu anderem Kunden" });
    const pays = await owner.query(api.payments.forDocument, { documentId: id });
    const reversal = pays.payments.find((p) => p.reversalOfId);
    expect(reversal?.date).toBe("2026-11-03");
    expect((await docOf(t, id)).paymentStatus).toBe("open");
    expect((await txOf(t, tx)).status).toBe("open");
    // the original allocation stays (GoBD): one payment plus its reversal
    expect(pays.payments).toHaveLength(2);
  });

  test("BNK-043 a Skonto or partial candidate is never auto-applied", async () => {
    const { t, bankAccount, number, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 116_620,
      purpose: number,
    });
    expect(await t.model(OWNER, (ctx) => autoApplyMatches(ctx, [tx]))).toEqual([]);
    expect((await docOf(t, id)).paymentStatus).toBe("open");
  });
});

describe("BNK-121 EC-PAY-24 bank reversals", () => {
  test("EC-PAY-24 confirming the counter-entry reverses the payment dated the counter-entry; the invoice reopens", async () => {
    let { t, owner, bankAccount, number, id } = await setup();
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: number,
      endToEndId: "E2E-1",
    });
    await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "salesDocument", id }, amountCents: 119_000 }],
    });
    owner = await jump(t, "2026-10-16T10:00:00Z");
    const counter = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-15",
      amountCents: -119_000,
      purpose: `Rücklastschrift ${number}`,
      endToEndId: "E2E-1",
      reversal: true,
    });
    await owner.mutation(api.banking.linkReversalTo, { counterId: counter, originalId: tx });
    const d = await docOf(t, id);
    expect(d.paymentStatus).toBe("open");
    expect(d.openAmountCents).toBe(119_000);
    const pays = await owner.query(api.payments.forDocument, { documentId: id });
    const reversal = pays.payments.find((p) => p.reversalOfId);
    expect(reversal).toMatchObject({
      date: "2026-10-15",
      reason: "Rückbuchung durch die Bank",
      bankTransactionId: counter,
    });
    expect((await txOf(t, counter)).status).toBe("matched");
    expect((await txOf(t, counter)).reversalOfId).toBe(tx);
    expect((await txOf(t, tx)).status).toBe("matched");
  });
});

describe("PAY-047 PAY-033 manual payments and refunds", () => {
  test("PAY-047 EC-PAY-41 an imported transaction reconciles the manual payment instead of a second payment", async () => {
    const { t, owner, bankAccount, number, id } = await setup();
    const manual = await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const tx = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: `Überweisung ${number}`,
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: tx });
    expect(s.candidates[0]?.reasons[0]).toBe("existing_manual_payment");
    await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "payment", id: manual.paymentIds[0] as string }, amountCents: 119_000 }],
    });
    const p = await t.run(async (ctx) => ctx.db.get(manual.paymentIds[0] as Id<"payments">));
    expect(p?.reconciledTransactionId).toBe(tx);
    expect((await txOf(t, tx)).status).toBe("matched");
    const all = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(all).toHaveLength(1);
  });

  test("PAY-033 an outgoing transaction refunds a credit balance", async () => {
    const { t, owner, bankAccount, id, personId, name } = await setup();
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 129_000,
      excess: { mode: "credit" },
    });
    const out = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: -10_000,
      purpose: "Erstattung Guthaben",
      counterpartyName: name,
    });
    const s = await owner.query(api.matching.suggestions, { transactionId: out });
    expect(s.candidates[0]?.allocations[0]?.target).toEqual({ kind: "contactCredit", id: personId });
    await owner.mutation(api.matching.confirm, {
      transactionId: out,
      allocations: [{ target: { kind: "contactCredit", id: personId as string }, amountCents: 10_000 }],
    });
    expect(
      (await owner.query(api.payments.contactCredit, { contactId: personId as Id<"contacts"> })).balanceCents,
    ).toBe(0);
    expect((await txOf(t, out)).status).toBe("matched");
  });
});
