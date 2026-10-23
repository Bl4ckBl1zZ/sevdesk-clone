import { describe, expect, test } from "vitest";
import {
  aliasToken,
  autoApplicable,
  jaroWinkler,
  type MatchInput,
  numberMatch,
  type OpenDocument,
  type OpenRefund,
  type OpenVoucher,
  scoreTransaction,
  subsetSum,
} from "./match";
import type { MatchCandidate, UnmatchedTransaction } from "./match-types";

const IBAN = "DE02120300000000202051";
const tx = (over: Partial<UnmatchedTransaction> = {}): UnmatchedTransaction => ({
  id: "tx1",
  accountId: "acc",
  accountName: "Revolut EUR",
  bookingDate: "2026-10-12",
  amountCents: 119000,
  currency: "EUR",
  openCents: 119000,
  direction: "in",
  purpose: "",
  ...over,
});
const out = (over: Partial<UnmatchedTransaction> = {}) =>
  tx({ direction: "out", amountCents: -(over.openCents ?? 119000), ...over });
const doc = (over: Partial<OpenDocument> = {}): OpenDocument => ({
  kind: "salesDocument",
  id: "d1",
  number: "RE-2026-01042",
  contactId: "c1",
  contactName: "Müller GmbH",
  ibans: [IBAN],
  aliases: [],
  documentDate: "2026-10-01",
  dueDate: "2026-10-31",
  openCents: 119000,
  currency: "EUR",
  ...over,
});
const score = (t: UnmatchedTransaction, input: Partial<MatchInput>) => scoreTransaction(t, { documents: [], ...input });

describe("matching helpers (BNK-042, BNK-048)", () => {
  test("BNK-042 a number without letters or digits never matches", () => {
    expect(numberMatch("---", "Rechnung ---")).toBeNull();
    expect(numberMatch("RE-2026-0042", "Danke")).toBeNull();
  });

  test("BNK-042 Jaro-Winkler: empty strings, no common characters, transpositions and the prefix bonus", () => {
    expect(jaroWinkler("", "")).toBe(0);
    expect(jaroWinkler("mueller", "")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
  });

  test("BNK-048 no alias is learned from a missing or too short counterparty name", () => {
    expect(aliasToken({ counterpartyName: undefined })).toBeNull();
    expect(aliasToken({ counterpartyName: "AB GmbH" })).toBeNull();
    expect(aliasToken({ counterpartyName: "Müller GmbH" })).toBe("mueller");
  });

  test("BNK-044 subset-sum orders by due date, else document date", () => {
    const items = [
      doc({ id: "late", openCents: 100, dueDate: undefined, documentDate: "2026-12-01" }),
      doc({ id: "early", openCents: 100, dueDate: undefined, documentDate: "2026-01-01" }),
      doc({ id: "mid", openCents: 100, dueDate: "2026-06-01" }),
    ];
    expect(subsetSum(items, 200)?.map((d) => d.id)).toEqual(["early", "mid"]);
    expect(subsetSum(items, 200, 1)).toBeNull();
  });
});

describe("matching scorer — documents (BNK-042, BNK-044, PAY-047)", () => {
  test("BNK-042 a slightly short payment (fees) from a known IBAN suggests the invoice with a bank-fee difference", () => {
    const [c] = score(tx({ amountCents: 118900, openCents: 118900, counterpartyIban: IBAN }), { documents: [doc()] });
    expect(c).toMatchObject({
      score: 0.4,
      reasons: ["amount_tolerance", "known_iban", "date_window"],
      allocations: [
        { target: { id: "d1" }, amountCents: 118900, differences: [{ reason: "bank_fees", amountCents: 100 }] },
      ],
    });
  });

  test("BNK-042 the date window: inside → +0.05, up to 180 days outside → 0, further outside → −0.30", () => {
    const at = (bookingDate: string) =>
      score(tx({ bookingDate, reference: "RE-2026-01042" }), { documents: [doc()] })[0]?.score;
    expect(at("2026-10-12")).toBe(0.95);
    expect(at("2027-01-15")).toBe(0.9);
    expect(at("2026-09-20")).toBe(0.9);
    expect(at("2027-12-31")).toBe(0.6);
    // A document without due date: the window ends 45 days after the document date.
    const noDue = score(tx({ bookingDate: "2026-11-14", reference: "RE-2026-01042" }), {
      documents: [doc({ dueDate: undefined })],
    });
    expect(noDue[0]?.reasons).toContain("date_window");
  });

  test("PAY-047 a manual payment that was rejected, differs in amount or is more than 3 days away is not proposed", () => {
    const m = { paymentId: "p1", date: "2026-10-10", amountCents: 119000, accountId: "acc", label: "Bar" };
    const kinds = (input: Partial<MatchInput>) => score(tx(), input).map((c) => c.allocations[0]?.target.kind);
    expect(kinds({ manualPayments: [m] })).toEqual(["payment"]);
    expect(kinds({ manualPayments: [{ ...m, amountCents: 100 }] })).toEqual([]);
    expect(kinds({ manualPayments: [{ ...m, date: "2026-10-08" }] })).toEqual([]);
    expect(kinds({ manualPayments: [m], rejected: new Set(["payment:p1"]) })).toEqual([]);
  });

  test("BNK-044 two numbers that don't add up to the amount make no combined candidate; outside the window no date bonus", () => {
    const a = doc({ id: "a", number: "RE-2026-0011", openCents: 50000 });
    const b = doc({ id: "b", number: "RE-2026-0012", openCents: 60000 });
    const notSum = score(tx({ reference: "RE-2026-0011 RE-2026-0012" }), { documents: [a, b] });
    expect(notSum.some((c) => c.kind === "combined")).toBe(false);
    const late = score(
      tx({ amountCents: 110000, openCents: 110000, bookingDate: "2027-03-01", reference: "RE-2026-0011 RE-2026-0012" }),
      {
        documents: [a, b],
      },
    );
    const combined = late.find((c) => c.kind === "combined");
    expect(combined).toMatchObject({ score: 0.9, reasons: ["number_in_purpose", "exact_amount"] });
  });

  test("BNK-044 subset-sum for a contact identified by name only adds the name signal", () => {
    const docs = [
      doc({ id: "a", number: "RE-11", openCents: 30000, ibans: [] }),
      doc({ id: "b", number: "RE-12", openCents: 50000, ibans: [] }),
    ];
    const r = score(tx({ amountCents: 80000, openCents: 80000, counterpartyName: "MUELLER GMBH" }), {
      documents: docs,
    });
    const combined = r.find((c) => c.kind === "combined");
    expect(combined).toMatchObject({ score: 0.5, reasons: ["exact_amount", "name_similarity", "date_window"] });
  });

  test("BNK-042 the ambiguity guard stops at candidates clearly below the best", () => {
    const docs = [
      doc({ id: "a", number: "RE-1", contactId: "c1", ibans: [IBAN] }),
      doc({ id: "b", number: "RE-2", contactId: "c2", ibans: [IBAN] }),
      doc({ id: "c", number: "RE-3", contactId: "c3", ibans: [], openCents: 119200 }),
    ];
    const r: MatchCandidate[] = score(tx({ counterpartyIban: IBAN }), { documents: docs });
    expect(r.map((c) => [c.allocations[0]?.target.id, c.reasons.includes("ambiguous")])).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });

  test("BNK-043 a candidate below the auto threshold is never auto-applied", () => {
    const c: MatchCandidate = {
      kind: "single",
      score: 0.97,
      reasons: ["number_in_purpose", "exact_amount"],
      allocations: [{ target: { kind: "salesDocument", id: "d1" }, amountCents: 1 }],
    };
    expect(autoApplicable(c)).toBe(false);
    expect(autoApplicable({ ...c, score: 0.98 })).toBe(true);
  });
});

describe("matching scorer — outgoing debits (PAY-033, BNK-041, BNK-049)", () => {
  const credit = { contactId: "c1", contactName: "Müller GmbH", ibans: [IBAN], aliases: [], balanceCents: 4500 };

  test("PAY-033 a credit balance refund: known IBAN adds; empty, rejected or different balances are skipped", () => {
    const [c] = score(out({ openCents: 4500, counterpartyIban: IBAN }), { credits: [credit] });
    expect(c).toMatchObject({ score: 0.6, reasons: ["exact_amount", "known_iban"] });
    expect(score(out({ openCents: 4500 }), { credits: [{ ...credit, balanceCents: 0 }] })).toEqual([]);
    expect(score(out({ openCents: 4000 }), { credits: [credit] })).toEqual([]);
    expect(
      score(out({ openCents: 4500, counterpartyIban: IBAN }), {
        credits: [credit],
        rejected: new Set(["contactCredit:c1"]),
      }),
    ).toEqual([]);
  });

  const refund = (over: Partial<OpenRefund> = {}): OpenRefund => ({
    id: "k1",
    number: "RK-2026-0042",
    contactId: "c1",
    contactName: "Müller GmbH",
    ibans: [IBAN],
    aliases: [],
    documentDate: "2026-10-01",
    openCents: 5000,
    currency: "EUR",
    ...over,
  });

  test("BNK-041 a bare number tail shared by two open refunds counts for neither; outside the window no date bonus", () => {
    const r = score(out({ openCents: 5000, purpose: "Erstattung 42", bookingDate: "2026-12-30" }), {
      refunds: [refund(), refund({ id: "k2", number: "RK-2025-0042" })],
    });
    expect(r.every((c) => !c.reasons.includes("number_in_purpose"))).toBe(true);
    expect(r.every((c) => !c.reasons.includes("date_window"))).toBe(true);
  });

  const voucher = (over: Partial<OpenVoucher> = {}): OpenVoucher => ({
    id: "v1",
    documentNumber: "INV-778899",
    supplierName: "Hosting AG",
    ibans: [],
    documentDate: "2026-10-01",
    dueDate: "2026-10-15",
    openCents: 10000,
    currency: "EUR",
    ...over,
  });

  test("BNK-049 a smaller debit with the supplier's number is a partial voucher payment; a bare tail is no number", () => {
    const [partial] = score(out({ openCents: 4000, reference: "INV-778899" }), { vouchers: [voucher()] });
    expect(partial).toMatchObject({ kind: "partial", reasons: ["number_in_purpose", "partial", "date_window"] });
    expect(score(out({ openCents: 4000, purpose: "Rechnung 778899" }), { vouchers: [voucher()] })).toEqual([]);
  });

  test("BNK-049 a voucher paid far outside its date window loses the date bonus and gets the penalty", () => {
    const [c] = score(out({ openCents: 10000, reference: "INV-778899", bookingDate: "2027-09-01" }), {
      vouchers: [voucher()],
    });
    expect(c).toMatchObject({ score: 0.6, reasons: ["number_in_purpose", "exact_amount"] });
  });
});
