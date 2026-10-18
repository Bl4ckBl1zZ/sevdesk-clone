import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { displayStatus } from "../src/domain/documents/display-status";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { b2bBuyer, finalizedInvoice, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { recordCashTransfer } from "./model/cash";
import { patchCompanyProfile } from "./model/companyProfile";
import { openItemsAsOf } from "./model/payments";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * F05 PAY-033 (b) / PAY-062: refunds against credit corrections. A Rechnungskorrektur with a negative total has a
 * negative open amount („Erstattung offen“) until outgoing money (negative bank transaction, „Bar erstattet“,
 * clearing) is allocated to it; a refund above the open refund is rejected (EC-PAY-33); a cash refund keeps the till
 * ≥ 0 at every date (RI-11, EC-PAY-28). T-GLD-01 invoice: 1.190,00; the credit (8 instead of 10 hours) is −238,00.
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

type Owner = Awaited<ReturnType<typeof finalizedInvoice>>["owner"];

/** Invoice paid with `paidCents` (clearing), then a credit correction of −238,00 finalised. */
async function creditOf(t: TestT, paidCents: number) {
  const f = await finalizedInvoice(t);
  const owner: Owner = f.owner;
  const id = f.id as Id<"salesDocuments">;
  await owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        { ...INVOICE_RANGE, next: 2 },
        { key: "correction", name: "Rechnungskorrekturen", format: "RK-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
      ],
    },
  });
  const account = await t.run(async (ctx) => defaultInvoiceAccount(ctx));
  if (!account) throw new Error("no invoice bank account");
  if (paidCents > 0) {
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: account._id },
      date: "2026-10-12",
      amountCents: paidCents,
    });
  }
  const { id: cid } = await owner.mutation(api.corrections.createCorrection, {
    originalId: id,
    kind: "credit",
    changes: [{ position: 1, quantityMilli: 8_000 }],
  });
  const draft = await docOf(t, cid as Id<"salesDocuments">);
  await owner.action(api.invoices.finalize, { id: cid, version: draft.version });
  await settle(t);
  return { ...f, owner, id, cid: cid as Id<"salesDocuments">, accountId: account._id };
}

describe("PAY-033 (b) refunds against credit corrections", { timeout: 30_000 }, () => {
  test("T05-053 PAY-033 clearing and an outgoing bank transaction refund the correction: Erstattung offen → erstattet", async () => {
    const t = makeT();
    const { owner, id, cid, accountId } = await creditOf(t, 119_000);
    const c0 = await docOf(t, cid);
    expect(c0).toMatchObject({ openAmountCents: -23_800, paymentStatus: "open" });
    expect(displayStatus(c0, "2026-10-12").label).toBe("Erstattung offen");

    const first = await owner.mutation(api.payments.refundCorrection, {
      documentId: cid,
      amountCents: 10_000,
      source: { kind: "clearing", accountId },
      date: "2026-10-12",
    });
    expect(await docOf(t, cid)).toMatchObject({ openAmountCents: -13_800, paymentStatus: "partially_paid" });
    const [entry] = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", first.paymentId))
        .collect(),
    );
    expect(entry?.explanation).toBe("P11");
    expect(entry?.lines.map((l) => [l.account, l.debitCents, l.creditCents]).sort()).toEqual([
      ["1200", 0, 10_000],
      ["1400", 10_000, 0],
    ]);

    // The rest leaves through the bank: a −138,00 statement line matched to the correction (BNK-046).
    const tx = await bookedTransaction(t, accountId, {
      bookingDate: "2026-10-12",
      amountCents: -13_800,
      purpose: "Gutschrift RK-2026-0001",
    });
    const r = await owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "salesDocument", id: cid }, amountCents: 13_800 }],
    });
    expect("refunded" in r).toBe(true);
    const done = await docOf(t, cid);
    expect(done).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    expect(displayStatus(done, "2026-10-12").label).toBe("Erstattet");
    const btx = await t.run((ctx) => ctx.db.get(tx));
    expect(btx).toMatchObject({ allocatedCents: 13_800, status: "matched" });
    // The corrected invoice is untouched by the refunds.
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    // INV-15: with a refund allocated the correction can no longer be cancelled.
    const storno = await owner.query(api.corrections.cancelPreview, { id: cid });
    expect(storno.guard?.code).toBe("correction_refund_allocated");
  });

  test("PAY-033 credits keep flowing: 100,00 absorbed by the invoice, 138,00 refunded; reversal reopens the refund", async () => {
    const t = makeT();
    const { owner, id, cid, accountId } = await creditOf(t, 109_000);
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0 });
    expect(await docOf(t, cid)).toMatchObject({ creditAppliedCents: 10_000, openAmountCents: -13_800 });
    const asOf = await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2026-10-12" }));
    expect(asOf.items.map((i) => [i.number, i.openCents])).toEqual([["RK-2026-0001", -13_800]]);

    const r = await owner.mutation(api.payments.refundCorrection, {
      documentId: cid,
      amountCents: 13_800,
      source: { kind: "clearing", accountId },
      date: "2026-10-12",
    });
    expect(await docOf(t, cid)).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0 });
    expect((await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2026-10-12" }))).items).toEqual([]);

    await owner.mutation(api.payments.reverse, { paymentId: r.paymentId, reason: "Falsches Konto gewählt" });
    expect(await docOf(t, cid)).toMatchObject({ openAmountCents: -13_800, paymentStatus: "open" });
    expect(await docOf(t, id)).toMatchObject({ openAmountCents: 0 });
  });

  test("T05-054 EC-PAY-33 a refund above the open refund is rejected (also via the bank match)", async () => {
    const t = makeT();
    const { owner, cid, accountId } = await creditOf(t, 109_000);
    const e = await catching(
      owner.mutation(api.payments.refundCorrection, {
        documentId: cid,
        amountCents: 15_000,
        source: { kind: "clearing", accountId },
        date: "2026-10-12",
      }),
    );
    expect(String(dataOf(e).message)).toMatch(
      /^Die Erstattung übersteigt den offenen Erstattungsbetrag \(138,00\s€\)\.$/,
    );
    const tx = await bookedTransaction(t, accountId, { bookingDate: "2026-10-12", amountCents: -20_000, purpose: "x" });
    const viaBank = await catching(
      owner.mutation(api.matching.confirm, {
        transactionId: tx,
        allocations: [{ target: { kind: "salesDocument", id: cid }, amountCents: 20_000 }],
      }),
    );
    expect(dataOf(viaBank).reason).toBe("REFUND_EXCEEDS");
    // Not a correction, or an incoming transaction: rejected.
    const notCredit = await catching(
      owner.mutation(api.payments.refundCorrection, {
        documentId: (await t.run((ctx) => ctx.db.query("salesDocuments").first()))?._id as Id<"salesDocuments">,
        amountCents: 100,
        source: { kind: "clearing", accountId },
        date: "2026-10-12",
      }),
    );
    expect(errorCode(notCredit)).toBe("invalid_input");
    const incoming = await bookedTransaction(t, accountId, {
      bookingDate: "2026-10-12",
      amountCents: 5_000,
      purpose: "y",
    });
    const wrongWay = await catching(
      owner.mutation(api.payments.refundCorrection, {
        documentId: cid,
        amountCents: 5_000,
        source: { kind: "bank", transactionId: incoming },
        date: "2026-10-12",
      }),
    );
    expect(dataOf(wrongWay).reason).toBe("TX_DIRECTION");
  });

  test("T05-163 PAY-062 EC-PAY-28 RI-11 a backdated cash refund that dips the till on a later date is rejected", async () => {
    const t = makeT();
    const { owner, cid, personId, bankAccount } = await creditOf(t, 119_000);
    // Cash receipt of 100,00 on 09.10., deposited on 11.10.: the till is 0 from 11.10.
    const second = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: second.id, version: 1 });
    await settle(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: second.id as Id<"salesDocuments">,
      source: { kind: "cash" },
      date: "2026-10-09",
      amountCents: 10_000,
      acknowledgeWarnings: ["cash_daily_recording", "before_document_date"],
    });
    await t.model(OWNER, (ctx) =>
      recordCashTransfer(ctx, {
        kind: "deposit_to_bank",
        date: "2026-10-11",
        amountCents: 10_000,
        bankAccountId: bankAccount,
        acknowledgeWarnings: ["cash_daily_recording"],
      } as never),
    );
    // „Bar erstattet“ on 10.10.: 100 − 50 = 50 that day, but −50 on 11.10. after the deposit.
    const e = await catching(
      owner.mutation(api.payments.refundCorrection, {
        documentId: cid,
        amountCents: 5_000,
        source: { kind: "cash" },
        date: "2026-10-10",
        acknowledgeWarnings: ["cash_daily_recording"],
      }),
    );
    expect(errorCode(e)).toBe("cash_negative");
    expect(String(dataOf(e).message)).toContain("11.10.2026");
    expect(await docOf(t, cid)).toMatchObject({ openAmountCents: -23_800 });
  });

  test("PAY-033 UVA-06 Ist: the refund releases the correction's parked VAT (P11-ist, LEGAL-OPEN F08 §4.2.2)", async () => {
    const t = makeT();
    const setup = await setupInvoicing(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] },
        { action: "settings.company.update" },
      ),
    );
    const { personId } = await b2bBuyer(setup.owner);
    const { id } = await setup.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await setup.owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    await setup.owner.mutation(api.settings.saveNumberRanges, {
      values: {
        ranges: [
          { ...INVOICE_RANGE, next: 2 },
          {
            key: "correction",
            name: "Rechnungskorrekturen",
            format: "RK-{YYYY}-{####}",
            resetPolicy: "yearly",
            next: 1,
          },
        ],
      },
    });
    await setup.owner.mutation(api.payments.recordForInvoice, {
      documentId: id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: setup.bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const { id: cid } = await setup.owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "credit",
      changes: [{ position: 1, quantityMilli: 8_000 }],
    });
    await setup.owner.action(api.invoices.finalize, { id: cid, version: (await docOf(t, cid)).version });
    await settle(t);
    const r = await setup.owner.mutation(api.payments.refundCorrection, {
      documentId: cid,
      amountCents: 23_800,
      source: { kind: "clearing", accountId: setup.bankAccount },
      date: "2026-10-12",
    });
    const [entry] = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", r.paymentId))
        .collect(),
    );
    expect(entry?.explanation).toBe("P11-ist");
    const byRole = (role: string) => entry?.lines.find((l) => l.role === role);
    expect(byRole("vat.output.19")).toMatchObject({ debitCents: 3_800, taxPointDate: "2026-10-12" });
    expect(byRole("vat.output.notdue.19")).toMatchObject({ creditCents: 3_800 });
  });

  test("PAY-019 MCP-004 an MCP actor needs a payment_record token for a correction refund", async () => {
    const t = makeT();
    const { cid, accountId } = await creditOf(t, 119_000);
    const mcp = await t.asMcp(["payments:write"]);
    const args = {
      documentId: cid,
      amountCents: 1_000,
      source: { kind: "clearing" as const, accountId },
      date: "2026-10-12",
    };
    expect(errorCode(await catching(mcp.mutation(api.payments.refundCorrection, args)))).toBe("confirm_token_required");
    const token = "ct_test-refund";
    await mcp.mutation(api.confirmTokens.issue, {
      intent: "payment_record",
      args,
      entities: [{ table: "salesDocuments", id: cid }],
      tokenHash: await sha256Hex(token),
    });
    await mcp.mutation(api.payments.refundCorrection, { ...args, confirmToken: token });
    expect(await docOf(t, cid)).toMatchObject({ openAmountCents: -22_800 });
  });
});
