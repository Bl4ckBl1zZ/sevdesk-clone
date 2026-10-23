import { describe, expect, test } from "vitest";
import {
  cashTransferArgs,
  combinedPaymentArgs,
  differenceArgs,
  invoicePaymentArgs,
  markArgs,
  matchArgs,
  serializeOpenItem,
  serializePaymentPreview,
  sourceArgs,
  wireMatchTarget,
} from "./payments";

/**
 * 05 §4.4/§4.6 and 06 §2.3: one mapping wire → Convex arguments for REST, the MCP tool and its preview_action, so the
 * confirm token's params hash is computed over identical arguments. Optional wire fields must appear only when set.
 */

const RAW = "k57f3x2m9q8w1e4r6t";
const RAW2 = "a1b2c3d4e5f6g7h8i9";

describe("payment wire → Convex arguments (05 §4.4)", () => {
  test("PAY-012 sources: bank needs a btx_ transaction, clearing a bac_ account, cash nothing; a foreign prefix is null", () => {
    expect(sourceArgs({ kind: "cash" })).toEqual({ kind: "cash" });
    expect(sourceArgs({ kind: "bank", transaction_id: `btx_${RAW}` })).toEqual({ kind: "bank", transactionId: RAW });
    expect(sourceArgs({ kind: "clearing", account_id: `bac_${RAW}` })).toEqual({ kind: "clearing", accountId: RAW });
    expect(sourceArgs({ kind: "bank", transaction_id: `bac_${RAW}` })).toBeNull();
    expect(sourceArgs({ kind: "clearing", account_id: `btx_${RAW}` })).toBeNull();
  });

  test("PAY-020 PAY-021 a difference carries sub reason, account, text and with_vat only when given", () => {
    expect(differenceArgs({ reason: "skonto", amount_cents: 2_380 })).toEqual({ reason: "skonto", amountCents: 2_380 });
    expect(
      differenceArgs({
        reason: "other",
        amount_cents: 500,
        sub_reason: "waiver",
        account: "4730",
        text: "Kulanz wegen Lieferverzug",
        with_vat: false,
      }),
    ).toEqual({
      reason: "other",
      amountCents: 500,
      subReason: "waiver",
      account: "4730",
      text: "Kulanz wegen Lieferverzug",
      withVat: false,
    });
  });

  test("PAY-030 PAY-061 an invoice payment maps differences, excess, backdate reason, note and acknowledged warnings", () => {
    expect(
      invoicePaymentArgs(`inv_${RAW}`, {
        date: "2026-10-13",
        amount_cents: 116_620,
        source: { kind: "cash" },
        differences: [{ reason: "skonto", amount_cents: 2_380 }],
        excess: { mode: "credit" },
        backdate_reason: "Beleg nachgereicht",
        note: "bar im Laden",
        acknowledge_warnings: ["cash_daily_recording"],
      }),
    ).toEqual({
      documentId: RAW,
      source: { kind: "cash" },
      date: "2026-10-13",
      amountCents: 116_620,
      differences: [{ reason: "skonto", amountCents: 2_380 }],
      excess: { mode: "credit" },
      backdateReason: "Beleg nachgereicht",
      note: "bar im Laden",
      acknowledgeWarnings: ["cash_daily_recording"],
    });
    const plain = invoicePaymentArgs(`inv_${RAW}`, {
      date: "2026-10-13",
      amount_cents: 1,
      source: { kind: "cash" },
      differences: [],
      acknowledge_warnings: [],
    });
    expect(plain).toEqual({ documentId: RAW, source: { kind: "cash" }, date: "2026-10-13", amountCents: 1 });
    expect(
      invoicePaymentArgs(`quo_${RAW}`, { date: "2026-10-13", amount_cents: 1, source: { kind: "cash" } }),
    ).toBeNull();
    expect(
      invoicePaymentArgs(`inv_${RAW}`, {
        date: "2026-10-13",
        amount_cents: 1,
        source: { kind: "bank", transaction_id: `inv_${RAW}` },
      }),
    ).toBeNull();
  });

  test("PAY-013 a combined payment maps invoice, opening item and credit targets; one unknown target voids it", () => {
    const args = combinedPaymentArgs({
      source: { kind: "bank", transaction_id: `btx_${RAW}` },
      date: "2026-10-13",
      allocations: [
        {
          target: { kind: "invoice", id: `inv_${RAW}` },
          amount_cents: 100,
          differences: [{ reason: "bank_fees", amount_cents: 5 }],
        },
        { target: { kind: "opening_item", id: `opi_${RAW2}` }, amount_cents: 200 },
        { target: { kind: "credit", id: `con_${RAW2}` }, amount_cents: 300 },
      ],
      backdate_reason: "Auszug verspätet",
      note: "Sammelzahlung",
      acknowledge_warnings: ["late"],
    });
    expect(args).toEqual({
      source: { kind: "bank", transactionId: RAW },
      date: "2026-10-13",
      allocations: [
        {
          target: { kind: "salesDocument", id: RAW },
          amountCents: 100,
          differences: [{ reason: "bank_fees", amountCents: 5 }],
        },
        { target: { kind: "opening_item", id: RAW2 }, amountCents: 200 },
        { target: { kind: "contactCredit", id: RAW2 }, amountCents: 300 },
      ],
      backdateReason: "Auszug verspätet",
      note: "Sammelzahlung",
      acknowledgeWarnings: ["late"],
    });
    const base = { source: { kind: "cash" as const }, date: "2026-10-13" };
    expect(
      combinedPaymentArgs({
        ...base,
        allocations: [{ target: { kind: "credit", id: `inv_${RAW}` }, amount_cents: 1 }],
      }),
    ).toBeNull();
    expect(
      combinedPaymentArgs({
        source: { kind: "clearing", account_id: `con_${RAW}` },
        date: "2026-10-13",
        allocations: [{ target: { kind: "invoice", id: `inv_${RAW}` }, amount_cents: 1 }],
      }),
    ).toBeNull();
  });
});

describe("bank matching, marks and cash transfers (05 §4.6)", () => {
  test("BNK-046 PAY-033 match targets map to salesDocument (invoice, correction), opening item, credit and payment", () => {
    const args = matchArgs(`btx_${RAW}`, {
      targets: [
        { kind: "invoice", id: `inv_${RAW}`, amount_cents: 100, differences: [{ reason: "skonto", amount_cents: 2 }] },
        { kind: "correction", id: `cor_${RAW2}`, amount_cents: -50 },
        { kind: "opening_item", id: `opi_${RAW}`, amount_cents: 10 },
        { kind: "credit", id: `con_${RAW}`, amount_cents: 20 },
        { kind: "payment", id: `pay_${RAW}`, amount_cents: 30 },
      ],
      remainder: "credit",
      acknowledge_warnings: ["amount_mismatch"],
    });
    expect(args).toEqual({
      transactionId: RAW,
      allocations: [
        {
          target: { kind: "salesDocument", id: RAW },
          amountCents: 100,
          differences: [{ reason: "skonto", amountCents: 2 }],
        },
        { target: { kind: "salesDocument", id: RAW2 }, amountCents: -50 },
        { target: { kind: "opening_item", id: RAW }, amountCents: 10 },
        { target: { kind: "contactCredit", id: RAW }, amountCents: 20 },
        { target: { kind: "payment", id: RAW }, amountCents: 30 },
      ],
      remainder: "credit",
      acknowledgeWarnings: ["amount_mismatch"],
    });
    expect(matchArgs(`pay_${RAW}`, { targets: [{ kind: "invoice", id: `inv_${RAW}`, amount_cents: 1 }] })).toBeNull();
    expect(matchArgs(`btx_${RAW}`, { targets: [{ kind: "payment", id: `inv_${RAW}`, amount_cents: 1 }] })).toBeNull();
    expect(matchArgs(`btx_${RAW}`, { targets: [{ kind: "invoice", id: `inv_${RAW}`, amount_cents: 1 }] })).toEqual({
      transactionId: RAW,
      allocations: [{ target: { kind: "salesDocument", id: RAW }, amountCents: 1 }],
    });
  });

  test("PAY-033 a Convex match target is wired back with the prefix of its kind; a correction document becomes cor_", () => {
    expect(wireMatchTarget({ kind: "salesDocument", id: RAW })).toEqual({ kind: "invoice", id: `inv_${RAW}` });
    expect(wireMatchTarget({ kind: "salesDocument", id: RAW }, "correction")).toEqual({
      kind: "correction",
      id: `cor_${RAW}`,
    });
    expect(wireMatchTarget({ kind: "opening_item", id: RAW })).toEqual({ kind: "opening_item", id: `opi_${RAW}` });
    expect(wireMatchTarget({ kind: "contactCredit", id: RAW })).toEqual({ kind: "credit", id: `con_${RAW}` });
    expect(wireMatchTarget({ kind: "payment", id: RAW })).toEqual({ kind: "payment", id: `pay_${RAW}` });
    expect(wireMatchTarget({ kind: "voucher", id: RAW })).toEqual({ kind: "voucher", id: RAW });
  });

  test("CSH-024 CSH-026 a cash transfer maps the bank account, note, backdate reason and shareholder; a wrong account prefix is null", () => {
    expect(
      cashTransferArgs({
        kind: "deposit_to_bank",
        date: "2026-10-13",
        amount_cents: 50_000,
        bank_account_id: `bac_${RAW}`,
        note: "Einzahlung Filiale",
        backdate_reason: "Nachtrag",
      }),
    ).toEqual({
      kind: "deposit_to_bank",
      date: "2026-10-13",
      amountCents: 50_000,
      bankAccountId: RAW,
      note: "Einzahlung Filiale",
      backdateReason: "Nachtrag",
    });
    expect(
      cashTransferArgs({
        kind: "private_withdrawal",
        date: "2026-10-13",
        amount_cents: 2_000,
        shareholder: { name: "Max Muster", note: "Gesellschafterentnahme" },
      }),
    ).toEqual({
      kind: "private_withdrawal",
      date: "2026-10-13",
      amountCents: 2_000,
      shareholder: { name: "Max Muster", note: "Gesellschafterentnahme" },
    });
    expect(
      cashTransferArgs({ kind: "deposit_to_bank", date: "2026-10-13", amount_cents: 1, bank_account_id: `btx_${RAW}` }),
    ).toBeNull();
  });

  test("BNK-060 BNK-063 a mark maps reason, link and shareholder; an unknown transaction or link is null", () => {
    expect(markArgs(`btx_${RAW}`, { as: "private" })).toEqual({ transactionId: RAW, as: "private" });
    expect(
      markArgs(`btx_${RAW}`, {
        as: "ignored",
        reason: "neutralised_pair",
        link_id: `btx_${RAW2}`,
        shareholder: { name: "Max", note: "x" },
      }),
    ).toEqual({
      transactionId: RAW,
      as: "ignored",
      reason: "neutralised_pair",
      linkId: RAW2,
      shareholder: { name: "Max", note: "x" },
    });
    expect(markArgs(`pay_${RAW}`, { as: "transfer" })).toBeNull();
    expect(markArgs(`btx_${RAW}`, { as: "ignored", link_id: `pay_${RAW}` })).toBeNull();
  });
});

describe("serialisers (05 §4.4)", () => {
  const item = {
    id: RAW,
    number: "RE-2026-0001",
    contactName: "Beispiel GmbH",
    documentDate: "2026-10-01",
    payableCents: 119_000,
    paidCents: 0,
    openCents: 119_000,
    daysOverdue: 0,
    overdue: false,
    bucket: "not_due",
  };

  test("PAY-001 PAY-033 open items: invoice, correction (cor_) and opening item; contact and due date are nullable", () => {
    expect(serializeOpenItem({ ...item, kind: "salesDocument", contactId: RAW2, dueDate: "2026-10-31" })).toMatchObject(
      {
        id: `inv_${RAW}`,
        kind: "invoice",
        contact_id: `con_${RAW2}`,
        due_date: "2026-10-31",
      },
    );
    expect(
      serializeOpenItem({ ...item, kind: "salesDocument", docType: "correction", openCents: -5_000 }),
    ).toMatchObject({
      id: `cor_${RAW}`,
      kind: "correction",
      contact_id: null,
      due_date: null,
      open_cents: -5_000,
    });
    expect(serializeOpenItem({ ...item, kind: "opening_item" })).toMatchObject({
      id: `opi_${RAW}`,
      kind: "opening_item",
    });
  });

  test("PAY-019 the payment preview carries booking lines, skipped/error postings and unacknowledged warning codes", () => {
    const out = serializePaymentPreview({
      plan: {
        date: "2026-10-13",
        totalCents: 119_000,
        rows: [
          {
            target: { kind: "salesDocument", id: RAW },
            number: "RE-2026-0001",
            amountCents: 116_620,
            settlesCents: 119_000,
            openAfterCents: 0,
            differences: [
              {
                reason: "skonto",
                amountCents: 2_380,
                vatCorrection: [{ rateBp: 1_900, netCents: 2_000, vatCents: 380 }],
              },
            ],
          },
          {
            target: { kind: "opening_item", id: RAW2 },
            amountCents: 1_000,
            settlesCents: 1_000,
            openAfterCents: 0,
            differences: [{ reason: "bank_fees", amountCents: 0 }],
          },
          {
            target: { kind: "contactCredit", id: RAW2 },
            amountCents: 1_380,
            settlesCents: 1_380,
            openAfterCents: 0,
            differences: [],
          },
        ],
        warnings: [{ code: "cash_daily_recording", message: "Bar nicht taggleich erfasst.", ack: true }],
      },
      postings: [
        {
          status: "lines",
          text: "Zahlung RE-2026-0001",
          lines: [{ account: "1800", debitCents: 116_620, creditCents: 0 }],
        },
        { status: "error", message: "Zeitraum festgeschrieben" },
      ],
      unacknowledged: [{ code: "cash_daily_recording" }],
    });
    expect(out.unallocated_cents).toBeNull();
    expect(out.allocations[0]).toMatchObject({
      target: { kind: "invoice", id: `inv_${RAW}` },
      number: "RE-2026-0001",
      differences: [{ reason: "skonto", vat_correction: [{ rate_bp: 1_900, net_cents: 2_000, vat_cents: 380 }] }],
      booking: {
        status: "lines",
        text: "Zahlung RE-2026-0001",
        lines: [{ account: "1800", debit_cents: 116_620, credit_cents: 0 }],
      },
    });
    expect(out.allocations[1]).toMatchObject({
      number: null,
      differences: [{ reason: "bank_fees", vat_correction: [] }],
      booking: { status: "error", text: "Zeitraum festgeschrieben", lines: [] },
    });
    expect(out.allocations[2]?.booking).toEqual({ status: "skipped", text: null, lines: [] });
    expect(out.warnings).toEqual([
      { code: "cash_daily_recording", message: "Bar nicht taggleich erfasst.", requires_ack: true },
    ]);
    expect(out.unacknowledged).toEqual(["cash_daily_recording"]);
  });
});
