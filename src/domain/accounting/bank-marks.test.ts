import { describe, expect, test } from "vitest";
import type { BankTransactionMarkedEvent } from "./events";
import { type PostingContext, postEvent, type RoleLine, reversalPosting } from "./post";

const SOLE: PostingContext = { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: [] };
const GMBH: PostingContext = { ...SOLE, legalForm: "gmbh" };

const mark = (over: Partial<BankTransactionMarkedEvent> = {}): BankTransactionMarkedEvent => ({
  kind: "bank_transaction_marked",
  transactionId: "tx1",
  mark: "private",
  date: "2026-10-15",
  amountCents: -100_000,
  bankAccountId: "acc1",
  ...over,
});

function brief(r: ReturnType<typeof postEvent>) {
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.kind !== "entry") throw new Error("no entry");
  return {
    explanation: r.value.posting.explanation,
    dating: r.value.posting.dating,
    source: r.value.posting.source,
    lines: r.value.posting.lines.map((l: RoleLine) => [
      l.role ?? l.account,
      l.debitCents > 0 ? "S" : "H",
      l.debitCents || l.creditCents,
    ]),
  };
}

describe("Darlehen (F07 BNK-062)", () => {
  const loan = (over: Partial<BankTransactionMarkedEvent> = {}) =>
    mark({
      mark: "loan",
      amountCents: -55_100,
      feeCents: 100,
      loan: { principalCents: 50_000, interestCents: 5_000, loanAccount: "0630", interestAccount: "2100" },
      ...over,
    });

  test("BNK-062 repayment: S loan principal · S interest · S bank fee · H bank; disbursement: S bank · H loan", () => {
    expect(brief(postEvent(loan(), SOLE))).toEqual({
      explanation: "L2",
      dating: "external",
      source: { kind: "bankTransaction", id: "tx1" },
      lines: [
        ["0630", "S", 50_000],
        ["2100", "S", 5_000],
        ["expense.bank_fees", "S", 100],
        ["bank.acc1", "H", 55_100],
      ],
    });
    const disb = brief(
      postEvent(
        loan({
          amountCents: 1_000_000,
          feeCents: 0,
          loan: { principalCents: 1_000_000, interestCents: 0, loanAccount: "0630", interestAccount: "2100" },
        }),
        SOLE,
      ),
    );
    expect(disb.explanation).toBe("L1");
    expect(disb.lines).toEqual([
      ["bank.acc1", "S", 1_000_000],
      ["0630", "H", 1_000_000],
    ]);
  });

  test("EC-BNK-75 BNK-062 a split that does not add up to the payment is refused by the posting too", () => {
    const r = postEvent(
      loan({ loan: { principalCents: 56_000, interestCents: 0, loanAccount: "0630", interestAccount: "2100" } }),
      SOLE,
    );
    expect(r.ok).toBe(false);
    expect(postEvent(loan({ loan: undefined }), SOLE).ok).toBe(false);
  });
});

describe("marked bank transactions (F08 T1/T2/T4, F07 BNK-060/061)", () => {
  test("T07-090 BNK-060 T1 private withdrawal from the bank: S private.withdrawal · H bank, dated the booking date", () => {
    expect(brief(postEvent(mark(), SOLE))).toEqual({
      explanation: "T1",
      dating: "external",
      source: { kind: "bankTransaction", id: "tx1" },
      lines: [
        ["private.withdrawal", "S", 100_000],
        ["bank.acc1", "H", 100_000],
      ],
    });
  });

  test("T07-090 BNK-060 T2 private deposit: S bank · H private.deposit", () => {
    expect(brief(postEvent(mark({ amountCents: 50_000 }), SOLE)).lines).toEqual([
      ["bank.acc1", "S", 50_000],
      ["private.deposit", "H", 50_000],
    ]);
  });

  test("T07-090 EC-BNK-21 ACC-028 a GmbH needs the shareholder clearing account (shareholder + note)", () => {
    const r = postEvent(mark(), GMBH);
    expect(r.ok).toBe(false);
    const corp = brief(postEvent(mark({ shareholder: { name: "A. Muster", note: "Entnahme Oktober" } }), GMBH));
    expect(corp.explanation).toBe("T1-corp");
    expect(corp.lines[0]).toEqual(["shareholder.clearing", "S", 100_000]);
  });

  test("T07-091 BNK-061 T4 Geldtransit legs: out S transit · H bank, in S bank · H transit", () => {
    expect(brief(postEvent(mark({ mark: "transfer" }), SOLE))).toMatchObject({
      explanation: "T4-out",
      lines: [
        ["transit", "S", 100_000],
        ["bank.acc1", "H", 100_000],
      ],
    });
    expect(brief(postEvent(mark({ mark: "transfer", amountCents: 92_000 }), SOLE)).lines).toEqual([
      ["bank.acc1", "S", 92_000],
      ["transit", "H", 92_000],
    ]);
  });

  test("T07-024 BNK-023 EC-145 a fee inside the movement is its own bank-fee line without VAT", () => {
    expect(brief(postEvent(mark({ mark: "transfer", amountCents: -20_100, feeCents: 100 }), SOLE)).lines).toEqual([
      ["transit", "S", 20_000],
      ["expense.bank_fees", "S", 100],
      ["bank.acc1", "H", 20_100],
    ]);
  });

  test("T07-095 CSH-025 T9 ATM withdrawal with fee: cash gets the cash, the fee is a bank fee (R5)", () => {
    const r = postEvent(
      {
        kind: "cash_transfer",
        cashTransferId: "ct1",
        transferKind: "bank_withdrawal_to_cash",
        date: "2026-10-12",
        amountCents: 20_000,
        feeCents: 250,
        bankAccountId: "acc1",
      },
      SOLE,
    );
    expect(brief(r)).toMatchObject({
      explanation: "T9",
      dating: "external",
      lines: [
        ["transit", "S", 20_000],
        ["expense.bank_fees", "S", 250],
        ["bank.acc1", "H", 20_250],
        ["cash", "S", 20_000],
        ["transit", "H", 20_000],
      ],
    });
  });

  test("GOBD-06 ACC-004 „Markierung aufheben“ mirrors the entry on the same source", () => {
    const original = postEvent(mark(), SOLE);
    if (!original.ok || original.value.kind !== "entry") throw new Error("no entry");
    const rev = reversalPosting(
      { kind: "bank_transaction_mark_reversed", transactionId: "tx1", date: "2026-10-20", reason: "falsch markiert" },
      original.value.posting,
      SOLE,
    );
    expect(rev.source).toEqual({ kind: "bankTransaction", id: "tx1" });
    expect(rev.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([
      ["private.withdrawal", 0, 100_000],
      ["bank.acc1", 100_000, 0],
    ]);
  });
});
