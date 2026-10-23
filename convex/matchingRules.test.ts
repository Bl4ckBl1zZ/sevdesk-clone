import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, setupCompany, TODAY, upload } from "./vouchers.fixtures";

/**
 * F07 BNK-049…054, BNK-065: matching rules (conditions, preview, rule vouchers, API/MCP suggest-only), vouchers from
 * transactions and voucher candidates for outgoing debits.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`));
});
afterEach(() => vi.useRealTimers());

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
const txOf = (t: TestT, id: Id<"bankTransactions">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"bankTransactions">);
const vouchersOf = (t: TestT, txId: Id<"bankTransactions">) =>
  t.run((ctx) =>
    ctx.db
      .query("vouchers")
      .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", txId))
      .collect(),
  );

/** A booked card row as the CAMT/Revolut mapper writes it (merchant, instructed amount, fee field). */
let cardN = 0;
const cardTx = (
  s: { t: TestT; bank: Id<"bankAccounts"> },
  tx: { bookingDate: string; amountCents: number; purpose: string; merchantName: string } & Partial<
    Pick<Doc<"bankTransactions">["source"], "feeCents" | "instructedAmount">
  >,
) => {
  const ref = `ER-CARD-${++cardN}`;
  const { bookingDate, amountCents, purpose, merchantName, ...extra } = tx;
  return s.t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        accountId: s.bank,
        bookingDate,
        amountCents,
        currency: "EUR",
        counterpartyName: merchantName,
        counterpartySource: "statement" as const,
        purpose,
        source: { kind: "camt053", entryReference: ref, rawSha256: ref, merchantName, ...extra },
        sources: [],
        dedupeKey: `${s.bank}:er:${ref}`,
        contentHash: ref,
        status: "open",
        allocatedCents: 0,
        recordedAt: Date.now(),
      },
      { action: "bank.import", label: `${bookingDate} ${amountCents} EUR` },
    ),
  );
};

async function setup(opts: { ku?: boolean } = {}) {
  const t = makeT();
  const s = await setupCompany(t, { ku: opts.ku ?? true });
  const owner = await t.asUser("owner");
  return { t, owner, ...s };
}

const feeRule = (over: Record<string, unknown> = {}) => ({
  name: "Kontoführung Revolut",
  priority: 10,
  enabled: true,
  when: { purposeContains: "plan fee", direction: "out" as const },
  apply: { action: "categorize" as const, account: "6855", taxRule: "no_input_vat", statementSufficesAsVoucher: true },
  ...over,
});

describe("rules (BNK-050, BNK-051)", () => {
  test("BNK-051 the preview counts the hits of the last 90 days without side effects", async () => {
    const s = await setup();
    const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    await bookedTransaction(s.t, s.bank, { bookingDate: day(5), amountCents: -1500, purpose: "Monthly plan fee" });
    await bookedTransaction(s.t, s.bank, { bookingDate: day(35), amountCents: -1500, purpose: "Monthly plan fee" });
    await bookedTransaction(s.t, s.bank, { bookingDate: day(120), amountCents: -1500, purpose: "Monthly plan fee" });
    await bookedTransaction(s.t, s.bank, { bookingDate: day(3), amountCents: 5000, purpose: "plan fee refund" });
    const before = await s.t.run((ctx) => ctx.db.query("auditLog").collect());
    const p = await s.owner.query(api.matchingRules.preview, { when: feeRule().when });
    expect(p.count).toBe(2);
    expect(p.message).toBe("Diese Regel würde 2 Umsätze der letzten 90 Tage treffen");
    expect(p.hits.map((h) => h.amountCents)).toEqual([-1500, -1500]);
    expect(await s.t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(before.length);
    expect(await s.t.run((ctx) => ctx.db.query("vouchers").collect())).toEqual([]);
  });

  test("EC-BNK-70 BNK-050 a catastrophic regex is rejected at save", async () => {
    const s = await setup();
    const e = await s.owner
      .mutation(api.matchingRules.create, { ...feeRule(), when: { purposeRegex: "(a+)+$" } })
      .catch((x: unknown) => x);
    expect(messageOf(e)).toBe("Ungültiger regulärer Ausdruck: verschachtelte Wiederholungen sind nicht erlaubt.");
  });

  test("BNK-050 the first rule by priority wins; rules act before the auto-apply", async () => {
    const s = await setup();
    await s.owner.mutation(api.matchingRules.create, {
      ...feeRule({ name: "Später", priority: 20, apply: { action: "categorize", account: "6300" } }),
      mode: "auto",
    });
    await s.owner.mutation(api.matchingRules.create, { ...feeRule(), mode: "auto" });
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -1500,
      purpose: "Monthly plan fee",
    });
    expect((await s.owner.query(api.matchingRules.forTransaction, { transactionId: tx }))?.name).toBe(
      "Kontoführung Revolut",
    );
    await s.t.action(internal.matchingRules.afterImport, { transactionIds: [tx] });
    const [v] = await vouchersOf(s.t, tx);
    const lines = await s.t.run((ctx) => ctx.db.query("voucherLines").collect());
    expect(lines.map((l) => l.account)).toEqual(["6855"]);
    expect(v?.ruleId).toBeDefined();
  });

  test("EC-BNK-71 BNK-050 a rule never acts on a pending feed row — only on the booked row", async () => {
    const s = await setup();
    await s.owner.mutation(api.matchingRules.create, { ...feeRule(), mode: "auto" });
    // pending rows live in bankPendingTransactions and are never handed to the rules
    await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankPendingTransactions",
        {
          accountId: s.bank,
          amountCents: -1500,
          currency: "EUR",
          purpose: "Monthly plan fee",
          fetchedAt: Date.now(),
          rawSha256: "x",
        },
        { action: "bank.feed_pending" },
      ),
    );
    const unmatched = await s.owner.query(api.banking.unmatched, {});
    expect(unmatched).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("vouchers").collect())).toEqual([]);
  });
});

describe("rule vouchers (BNK-052)", () => {
  test("EC-BNK-72 BNK-052 auto + „Kontoauszug genügt als Beleg“ → finalised voucher, allocated to the transaction", async () => {
    const s = await setup();
    await s.owner.mutation(api.matchingRules.create, { ...feeRule(), mode: "auto" });
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -1500,
      purpose: "Monthly plan fee",
    });
    await s.t.action(internal.matchingRules.afterImport, { transactionIds: [tx] });
    const [v] = await vouchersOf(s.t, tx);
    expect(v).toMatchObject({
      status: "paid",
      statementIsBeleg: true,
      openAmountCents: 0,
      supplierName: "Revolut EUR",
    });
    expect(v?.internalNumber).toMatch(/^BE-/);
    expect(v?.originalFiles).toEqual([]);
    expect((await txOf(s.t, tx)).status).toBe("matched");
  });

  test("EC-BNK-72 BNK-052 an auto rule without the flag creates a draft „Beleg fehlt“ listed under missing receipts", async () => {
    const s = await setup();
    await s.owner.mutation(api.matchingRules.create, {
      ...feeRule({ name: "Software", when: { counterpartyContains: "adobe" } }),
      apply: { action: "categorize", account: "6815" },
      mode: "auto",
    });
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -4990,
      purpose: "Creative Cloud",
      counterpartyName: "Adobe Systems",
    });
    await s.t.action(internal.matchingRules.afterImport, { transactionIds: [tx] });
    const [v] = await vouchersOf(s.t, tx);
    expect(v).toMatchObject({
      status: "draft",
      receiptMissing: true,
      supplierName: "Adobe Systems",
      documentDate: TODAY,
    });
    const n = await s.t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((x) => x.kind === "bank.rule_receipt_missing"),
    );
    expect(n[0]?.title).toMatch(/^Beleg fehlt für automatisch kategorisierten Umsatz \d{2}\.\d{2}\.\d{4} −49,90 €\.$/);
    const missing = await s.owner.query(api.vouchers.missing, {});
    expect(missing.transactions.map((r: { id: string }) => r.id)).toContain(tx);
    expect((await txOf(s.t, tx)).status).toBe("open");
  });

  test("BNK-052 a suggest rule does not act automatically", async () => {
    const s = await setup();
    await s.owner.mutation(api.matchingRules.create, feeRule());
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -1500,
      purpose: "Monthly plan fee",
    });
    await s.t.action(internal.matchingRules.afterImport, { transactionIds: [tx] });
    expect(await vouchersOf(s.t, tx)).toEqual([]);
    // BNK-051: the explicit „Auf offene Umsätze anwenden“ acts (suggest rule → draft, statement flag only for auto)
    const rule = (await s.owner.query(api.matchingRules.list, {}))[0] as { _id: Id<"matchingRules">; hits90: number };
    expect(rule.hits90).toBe(1);
    const r = await s.owner.action(api.matchingRules.applyToExisting, { ruleId: rule._id, transactionIds: [tx] });
    expect(r.applied).toBe(1);
    expect((await vouchersOf(s.t, tx))[0]).toMatchObject({ status: "draft", receiptMissing: true });
  });
});

describe("API/MCP rules (BNK-054)", () => {
  test("EC-BNK-73 BNK-054 rules created via MCP/API are stored as suggest; switching to auto needs the UI", async () => {
    const s = await setup();
    const mcp = await s.t.asMcp(["banking:write", "banking:read"]);
    const created = await mcp.mutation(api.matchingRules.create, { ...feeRule(), mode: "auto" });
    expect(created).toMatchObject({
      mode: "suggest",
      warning:
        "Regeln aus API/MCP werden als Vorschlagsregel gespeichert. Automatik bitte in der Oberfläche aktivieren.",
    });
    const key = await s.t.asApiKey(["banking:write"]);
    const upd = await key.mutation(api.matchingRules.update, { id: created.id, mode: "auto" });
    expect(upd.mode).toBe("suggest");
    expect((await s.owner.mutation(api.matchingRules.update, { id: created.id, mode: "auto" })).mode).toBe("auto");
    const row = await s.t.run((ctx) => ctx.db.get(created.id));
    expect(row).toMatchObject({ mode: "auto", createdVia: "mcp" });
    // an API edit of the conditions drops the automation again
    expect(
      (await key.mutation(api.matchingRules.update, { id: created.id, when: { purposeContains: "fee" } })).mode,
    ).toBe("suggest");
    // applying rules to existing transactions is UI-only
    expect(
      errorCode(
        await key
          .action(api.matchingRules.applyToExisting, { ruleId: created.id, transactionIds: [] })
          .catch((x: unknown) => x),
      ),
    ).toBe("forbidden_scope");
  });
});

describe("voucher from transaction (BNK-065)", () => {
  test("BNK-065 T07-094 „+ Neuer Beleg“ creates a prefilled draft; finalising allocates the transaction", async () => {
    const s = await setup();
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -11_900,
      purpose: "Rechnung 2026-4711",
      reference: "2026-4711",
      counterpartyName: "Büro Schmidt GmbH",
      counterpartyIban: "DE02120300000000202051",
    });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, {
      transactionId: tx,
      account: "6815",
    });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v).toMatchObject({
      status: "draft",
      direction: "expense",
      documentDate: TODAY,
      supplierName: "Büro Schmidt GmbH",
      supplierIban: "DE02120300000000202051",
      documentNumber: "2026-4711",
      currency: "EUR",
      bankTransactionId: tx,
    });
    const lines = await s.t.run((ctx) =>
      ctx.db
        .query("voucherLines")
        .withIndex("by_voucher", (q) => q.eq("voucherId", id))
        .collect(),
    );
    expect(lines[0]).toMatchObject({ account: "6815" });
    // a second click returns the same draft
    expect(await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, { transactionId: tx })).toBe(id);
    await upload(s.t, s.owner, { voucherId: id });
    const r = await s.owner.mutation(api.vouchers.finalize, { id });
    expect(r.paymentId).toBeDefined();
    expect((await txOf(s.t, tx)).status).toBe("matched");
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.status).toBe("paid");
  });

  test("BNK-065 a matched transaction cannot get a new voucher", async () => {
    const s = await setup();
    const tx = await bookedTransaction(s.t, s.bank, { bookingDate: TODAY, amountCents: -1500, purpose: "x" });
    await s.t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankTransactions", tx, { status: "private" }, { action: "bank.mark" }),
    );
    const e = await s.owner
      .mutation(api.matchingRules.createVoucherFromTransaction, { transactionId: tx })
      .catch((x: unknown) => x);
    expect(messageOf(e)).toBe("Der Umsatz ist bereits zugeordnet oder markiert.");
  });
});

describe("matching vouchers (BNK-049)", () => {
  test("BNK-049 T07-072 an outgoing debit is suggested for the open voucher by number + amount and confirmed as voucher payment", async () => {
    const s = await setup();
    const draft = await s.owner.mutation(api.vouchers.create, {
      input: {
        direction: "expense",
        supplierContactId: s.supplier,
        supplierName: "Büro Schmidt GmbH",
        documentNumber: "RS-99812",
        documentDate: TODAY,
        lines: [line({ vatRateBp: 0 })],
      },
    });
    const voucherId = (typeof draft === "string" ? draft : (draft as { id: Id<"vouchers"> }).id) as Id<"vouchers">;
    await upload(s.t, s.owner, { voucherId });
    await s.owner.mutation(api.vouchers.finalize, { id: voucherId });
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -11_900,
      purpose: "RS-99812 Büromaterial",
      counterpartyName: "Buero Schmidt GmbH",
    });
    const sug = await s.owner.query(api.matching.suggestions, { transactionId: tx });
    const [best] = sug.candidates;
    expect(best?.allocations[0]).toMatchObject({ target: { kind: "voucher", id: voucherId }, amountCents: 11_900 });
    expect(best?.labels).toEqual(expect.arrayContaining(["Rechnungsnr. im Verwendungszweck", "Betrag exakt"]));
    await s.owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "voucher", id: voucherId }, amountCents: 11_900 }],
    });
    expect((await txOf(s.t, tx)).status).toBe("matched");
    expect((await s.t.run((ctx) => ctx.db.get(voucherId)))?.status).toBe("paid");
  });

  test("EC-BNK-76 T07-073 a USD card payment from the EUR account settles the USD voucher; the FX difference is booked", async () => {
    const s = await setup();
    const { voucherId } = await upload(s.t, s.owner);
    await s.owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({
        supplierContactId: s.supplier,
        supplierName: "Acme Corp.",
        currency: "USD",
        fxRateToEur: { rate: "1.19", source: "ecb_daily", date: TODAY },
        lines: [line({ amountCents: 11_900, vatRateBp: 0 })],
      }),
    });
    await s.owner.mutation(api.vouchers.finalize, { id: voucherId });
    const tx = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankTransactions",
        {
          accountId: s.bank,
          bookingDate: TODAY,
          amountCents: -10_250,
          currency: "EUR",
          counterpartyName: "Acme Corp.",
          counterpartySource: "statement" as const,
          purpose: "Card payment Acme Corp.",
          source: {
            kind: "camt053",
            entryReference: "ER-FX-1",
            rawSha256: "fx-1",
            merchantName: "Acme Corp.",
            instructedAmount: { amountMinor: 11_900, currency: "USD" },
          },
          sources: [],
          dedupeKey: `${s.bank}:er:ER-FX-1`,
          contentHash: "fx-1",
          status: "open",
          allocatedCents: 0,
          recordedAt: Date.now(),
        },
        { action: "bank.import", label: `${TODAY} -10250 EUR` },
      ),
    );
    const sug = await s.owner.query(api.matching.suggestions, { transactionId: tx });
    expect(sug.candidates[0]?.allocations[0]).toMatchObject({
      target: { kind: "voucher", id: voucherId },
      amountCents: 10_250,
    });
    expect(sug.candidates[0]?.reasons).toContain("bill_amount");
    await s.owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [{ target: { kind: "voucher", id: voucherId }, amountCents: 10_250 }],
    });
    expect((await txOf(s.t, tx)).status).toBe("matched");
    expect((await s.t.run((ctx) => ctx.db.get(voucherId)))?.status).toBe("paid");
    const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
    // SKR04 6880 Aufwendungen aus Kursdifferenzen: 102,50 € paid for a 100,00 € (119,00 USD @ 1.19) claim.
    expect(lines.filter((l) => l.account === "6880").map((l) => l.debitCents - l.creditCents)).toEqual([250]);
    // Stored and labelled as a realised Kursdifferenz, not as „Sonstige Differenz“ with a hand-picked account.
    const payment = await s.t.run(async (ctx) =>
      (await ctx.db.query("payments").collect()).find((p) => p.bankTransactionId === tx),
    );
    expect(payment?.differences).toEqual([{ reason: "fx_difference", amountCents: -250 }]);
    // Unmatching reverses the Kursdifferenz with the payment; the voucher is open again.
    await s.owner.mutation(api.matching.unmatch, { transactionId: tx, reason: "Falsche Zuordnung" });
    const after = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(after.filter((l) => l.account === "6880").reduce((sum, l) => sum + l.debitCents - l.creditCents, 0)).toBe(0);
    expect((await s.t.run((ctx) => ctx.db.get(voucherId)))?.status).toBe("open");
  });

  test("EC-BNK-25 T07-024 a fee field: principal pays the voucher, the fee is its own bank-fee line without VAT", async () => {
    const s = await setup();
    const draft = await s.owner.mutation(api.vouchers.create, {
      input: {
        direction: "expense",
        supplierContactId: s.supplier,
        supplierName: "Büro Schmidt GmbH",
        documentNumber: "RS-99813",
        documentDate: TODAY,
        lines: [line({ vatRateBp: 0 })],
      },
    });
    const voucherId = (typeof draft === "string" ? draft : (draft as { id: Id<"vouchers"> }).id) as Id<"vouchers">;
    await upload(s.t, s.owner, { voucherId });
    await s.owner.mutation(api.vouchers.finalize, { id: voucherId });
    // CAMT card payment: the entry amount includes the charge (BNK-023, mapper keeps the fee as a field).
    const tx = await s.t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankTransactions",
        {
          accountId: s.bank,
          bookingDate: TODAY,
          amountCents: -12_050,
          currency: "EUR",
          counterpartyName: "Buero Schmidt GmbH",
          counterpartySource: "statement" as const,
          purpose: "RS-99813 Büromaterial",
          source: { kind: "camt053", entryReference: "ER-FEE-1", rawSha256: "fee-1", feeCents: 150 },
          sources: [],
          dedupeKey: `${s.bank}:er:ER-FEE-1`,
          contentHash: "fee-1",
          status: "open",
          allocatedCents: 0,
          recordedAt: Date.now(),
        },
        { action: "bank.import", label: `${TODAY} -12050 EUR` },
      ),
    );
    const sug = await s.owner.query(api.matching.suggestions, { transactionId: tx });
    const [best] = sug.candidates;
    expect(best?.allocations[0]).toMatchObject({
      target: { kind: "voucher", id: voucherId },
      amountCents: 12_050,
      differences: [{ reason: "bank_fees", amountCents: -150 }],
    });
    await s.owner.mutation(api.matching.confirm, {
      transactionId: tx,
      allocations: [
        {
          target: { kind: "voucher", id: voucherId },
          amountCents: 12_050,
          differences: [{ reason: "bank_fees", amountCents: -150 }],
        },
      ],
    });
    expect((await txOf(s.t, tx)).status).toBe("matched");
    expect((await s.t.run((ctx) => ctx.db.get(voucherId)))?.status).toBe("paid");
    const lines = await s.t.run((ctx) => ctx.db.query("journalLines").collect());
    const fee = lines.filter((l) => l.account === "6855");
    expect(fee.map((l) => l.debitCents - l.creditCents)).toEqual([150]);
  });
  test("EC-BNK-27 a card refund without a link is suggested for the original by merchant + amount; linking reopens the voucher", async () => {
    const s = await setup();
    const draft = await s.owner.mutation(api.vouchers.create, {
      input: {
        direction: "expense",
        supplierContactId: s.supplier,
        supplierName: "Büro Schmidt GmbH",
        documentNumber: "RS-99814",
        documentDate: TODAY,
        lines: [line({ vatRateBp: 0 })],
      },
    });
    const voucherId = (typeof draft === "string" ? draft : (draft as { id: Id<"vouchers"> }).id) as Id<"vouchers">;
    await upload(s.t, s.owner, { voucherId });
    await s.owner.mutation(api.vouchers.finalize, { id: voucherId });
    const pay = await cardTx(s, {
      bookingDate: TODAY,
      amountCents: -11_900,
      purpose: "Card payment",
      merchantName: "BUERO SCHMIDT",
    });
    await s.owner.mutation(api.matching.confirm, {
      transactionId: pay,
      allocations: [{ target: { kind: "voucher", id: voucherId }, amountCents: 11_900 }],
    });
    const refund = await cardTx(s, {
      bookingDate: TODAY,
      amountCents: 11_900,
      purpose: "Refund",
      merchantName: "Buero Schmidt",
    });
    const d = await s.owner.query(api.banking.transaction, { id: refund });
    expect(d?.reversalCandidates).toEqual([expect.objectContaining({ originalId: pay, reasons: ["merchant"] })]);
    expect(d?.reversalCandidates[0]?.label).toMatch(/^Kartenerstattung von /);
    // Suggestion only: nothing is linked or booked until the owner confirms.
    expect((await txOf(s.t, refund)).reversalOfId).toBeUndefined();
    expect((await s.t.run((ctx) => ctx.db.get(voucherId)))?.status).toBe("paid");
    await s.owner.mutation(api.banking.linkReversalTo, { counterId: refund, originalId: pay });
    expect((await txOf(s.t, refund)).reversalOfId).toBe(pay);
    expect((await s.t.run((ctx) => ctx.db.get(voucherId)))?.openAmountCents).toBe(11_900);
    // The reversal says what happened: a card refund by the merchant, not a return by the bank. Booking unchanged.
    const reversal = await s.t.run(async (ctx) =>
      (await ctx.db.query("payments").collect()).find((p) => p.reversalOfId !== undefined),
    );
    expect(reversal?.reason).toBe("Kartenerstattung durch den Händler");
    const notes = await s.t.run((ctx) => ctx.db.query("notifications").collect());
    const voucher = await s.t.run((ctx) => ctx.db.get(voucherId));
    expect(notes.map((n) => n.title)).toContain(
      `Kartenerstattung zur Zahlung vom ${TODAY.split("-").reverse().join(".")} – Zahlung storniert, Beleg ${voucher?.internalNumber} wieder offen.`,
    );
    expect(notes.some((n) => n.title.includes("von der Bank zurückgebucht"))).toBe(false);
  });
});

describe("rule suggestions (BNK-053)", () => {
  test("BNK-053 T07-086 after 3 identical manual classifications of one counterparty a rule is proposed; a saved rule ends it", async () => {
    const s = await setup();
    const classify = async (n: number) => {
      const tx = await bookedTransaction(s.t, s.bank, {
        bookingDate: TODAY,
        amountCents: -2_990 - n * 100,
        purpose: `Rechnung 2026-90${n}`,
        counterpartyName: "Büro Schmidt GmbH",
        counterpartyIban: "DE02120300000000202051",
      });
      const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, {
        transactionId: tx,
        account: "6815",
      });
      await upload(s.t, s.owner, { voucherId: id });
      await s.owner.mutation(api.vouchers.finalize, { id });
      return tx;
    };
    await classify(1);
    await classify(2);
    expect(await s.owner.query(api.matchingRules.suggestions, {})).toEqual([]);
    await classify(3);
    const [sug, ...rest] = await s.owner.query(api.matchingRules.suggestions, {});
    expect(rest).toEqual([]);
    expect(sug).toMatchObject({
      count: 3,
      when: { ibanEquals: "DE02120300000000202051", direction: "out" },
      apply: { action: "categorize", account: "6815" },
      message: "3 Umsätze von „Büro Schmidt GmbH“ wurden gleich zugeordnet – Regel anlegen?",
    });
    // Read-only: nothing is created until the owner saves the proposed rule.
    expect(await s.t.run((ctx) => ctx.db.query("matchingRules").collect())).toEqual([]);
    await s.owner.mutation(api.matchingRules.create, {
      name: sug?.name ?? "",
      priority: 10,
      enabled: true,
      when: sug?.when ?? {},
      apply: { action: "categorize", account: "6815" },
    });
    expect(await s.owner.query(api.matchingRules.suggestions, {})).toEqual([]);
  });
});

describe("tax payments (BNK-064)", () => {
  test("BNK-064 TAX-018 a transfer to the Finanzamt becomes a tax_payment voucher with subtype and period; finalising posts X1", async () => {
    const s = await setup({ ku: false });
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: -50_000,
      purpose: "StNr 12/345/67890 USt 09/26",
      counterpartyName: "Finanzamt Berlin-Mitte",
    });
    const d = await s.owner.query(api.banking.transaction, { id: tx });
    expect(d?.taxPayment).toEqual({
      subtype: "ust_prepayment",
      period: "2026-09",
      hint: "Steuerzahlung: USt-Vorauszahlung 2026-09",
    });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, { transactionId: tx });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v).toMatchObject({
      kind: "tax_payment",
      status: "draft",
      taxRule: "no_input_vat",
      taxPayment: { subtype: "ust_prepayment", period: "2026-09" },
      supplierName: "Finanzamt Berlin-Mitte",
      bankTransactionId: tx,
    });
    await upload(s.t, s.owner, { voucherId: id });
    await s.owner.mutation(api.vouchers.finalize, { id });
    expect((await txOf(s.t, tx)).status).toBe("matched");
    const entry = await s.t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").collect()).find((e) => e.source.kind === "voucher"),
    );
    expect(entry?.explanation).toBe("X1");
  });

  test("BNK-064 the period can be chosen when creating the voucher; a refund from the Finanzamt is offered too", async () => {
    const s = await setup({ ku: false });
    const tx = await bookedTransaction(s.t, s.bank, {
      bookingDate: TODAY,
      amountCents: 12_000,
      purpose: "Erstattung",
      counterpartyName: "Finanzamt Berlin-Mitte",
    });
    expect((await s.owner.query(api.banking.transaction, { id: tx }))?.taxPayment).toEqual({
      hint: "Steuerzahlung – Art und Zeitraum bitte auswählen",
    });
    const id = await s.owner.mutation(api.matchingRules.createVoucherFromTransaction, {
      transactionId: tx,
      taxPayment: { subtype: "ust_annual", period: "2025" },
    });
    const v = await s.t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"vouchers">);
    expect(v).toMatchObject({
      kind: "tax_payment",
      direction: "income",
      taxPayment: { subtype: "ust_annual", period: "2025" },
    });
  });
});
