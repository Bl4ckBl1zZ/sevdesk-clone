import { describe, expect, test } from "vitest";
import {
  aliasToken,
  autoApplicable,
  isSafe,
  isValidRf,
  jaroWinkler,
  numberMatch,
  type OpenDocument,
  type OpenRefund,
  rfFor,
  scoreTransaction,
  subsetSum,
} from "./match";
import type { UnmatchedTransaction } from "./match-types";

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
const doc = (over: Partial<OpenDocument> = {}): OpenDocument => ({
  kind: "salesDocument",
  id: "d1042",
  number: "RE-2026-01042",
  contactId: "c1",
  contactName: "Müller GmbH",
  ibans: [],
  aliases: [],
  documentDate: "2026-10-01",
  dueDate: "2026-10-31",
  openCents: 119000,
  currency: "EUR",
  ...over,
});

describe("matching scorer (BNK-042, §4.4 golden M1–M8)", () => {
  test("T07-060 M1 number + exact amount + similar name → 1.00, auto-applied", () => {
    const [c] = scoreTransaction(tx({ reference: "RE-2026-01042", counterpartyName: "MUELLER GMBH" }), {
      documents: [doc()],
    });
    expect(c?.score).toBe(1);
    expect(c?.reasons).toEqual(["number_in_purpose", "exact_amount", "name_similarity", "date_window"]);
    expect(c && autoApplicable(c)).toBe(true);
  });

  test("T07-060 M2 „Rechnung 1042“ (unique number tail, no name) → 0.95: safe, not auto", () => {
    const [c] = scoreTransaction(tx({ purpose: "Rechnung 1042" }), { documents: [doc()] });
    expect(c?.score).toBe(0.95);
    expect(c && [isSafe(c), autoApplicable(c)]).toEqual([true, false]);
  });

  test("T07-065 M3 2 % Skonto within the period → 0.90 with the Skonto difference; never auto", () => {
    const [c] = scoreTransaction(tx({ amountCents: 116620, openCents: 116620, purpose: "RE-2026-01042" }), {
      documents: [doc({ skonto: { deadline: "2026-10-15", agreedCents: 2380 } })],
    });
    expect(c?.score).toBe(0.9);
    expect(c?.allocations).toEqual([
      {
        target: { kind: "salesDocument", id: "d1042" },
        amountCents: 116620,
        differences: [{ reason: "skonto", amountCents: 2380 }],
      },
    ]);
    expect(c && autoApplicable(c)).toBe(false);
  });

  test("T07-065 M4 500,00 with number on 1.190,00 open → 0.65 Teilzahlung", () => {
    const [c] = scoreTransaction(tx({ amountCents: 50000, openCents: 50000, purpose: "RE-2026-01042" }), {
      documents: [doc()],
    });
    expect(c).toMatchObject({ kind: "partial", score: 0.65, reasons: ["number_in_purpose", "partial", "date_window"] });
  });

  test("T07-064 M5 two numbers summing to the amount → combined 0.95, never auto", () => {
    const [c] = scoreTransaction(tx({ amountCents: 238000, openCents: 238000, reference: "RE-1042 RE-1043" }), {
      documents: [doc({ number: "RE-1042" }), doc({ id: "d1043", number: "RE-1043" })],
    });
    expect(c).toMatchObject({ kind: "combined", score: 0.95 });
    expect(c?.allocations.map((a) => a.target.id)).toEqual(["d1042", "d1043"]);
    expect(c && autoApplicable(c)).toBe(false);
  });

  test("T07-062 EC-BNK-63 M6 no number, two invoices of the same amount → 0.45 each, ambiguous, never auto", () => {
    const r = scoreTransaction(tx(), {
      documents: [
        doc({ number: "RE-1", id: "a" }),
        doc({ number: "RE-2", id: "b", contactId: "c2", contactName: "Schulz AG" }),
      ],
    });
    expect(r.map((c) => [c.score, c.reasons.includes("ambiguous")])).toEqual([
      [0.45, true],
      [0.45, true],
    ]);
  });

  test("T07-066 EC-152 M8 no number, IBAN known → 0.65 suggestion (never auto without number/RF)", () => {
    const [c] = scoreTransaction(tx({ counterpartyIban: "DE89 3704 0044 0532 0130 00" }), {
      documents: [doc({ number: "RE-9", ibans: ["DE89370400440532013000"] })],
    });
    expect(c).toMatchObject({ score: 0.65, reasons: ["exact_amount", "known_iban", "date_window"] });
    expect(c && autoApplicable(c)).toBe(false);
  });

  test("T07-066 EC-152 without payer IBAN/name: the name in the description counts; learned alias token", () => {
    const [c] = scoreTransaction(tx({ purpose: "Gutschrift Mueller Verwendungszweck RE-2026-01042" }), {
      documents: [doc()],
    });
    expect(c?.reasons).toContain("name_similarity");
    expect(aliasToken({ counterpartyName: "MÜLLER GmbH & Co. KG" })).toBe("mueller");
  });

  test("T07-061 RF reference (ISO 11649) → 1.00; an invalid RF is ignored", () => {
    const rf = rfFor("RE202601042");
    expect(isValidRf(rf)).toBe(true);
    expect(isValidRf("RF00RE2026001042")).toBe(false);
    const [c] = scoreTransaction(tx({ reference: rf, amountCents: 100, openCents: 100 }), { documents: [doc()] });
    expect(c?.reasons[0]).toBe("rf_reference");
    expect(c?.score).toBe(1);
  });

  test("BNK-041 EC-BNK-65 rejected pairs, other currencies and settled documents are not candidates", () => {
    const t = tx({ reference: "RE-2026-01042" });
    expect(scoreTransaction(t, { documents: [doc()], rejected: new Set(["salesDocument:d1042"]) })).toEqual([]);
    expect(scoreTransaction(t, { documents: [doc({ currency: "USD" })] })).toEqual([]);
    expect(scoreTransaction(t, { documents: [doc({ openCents: 0 })] })).toEqual([]);
  });

  test("T07-067 PAY-047 an unreconciled manual payment with the same amount (±3 days) is ranked first", () => {
    const r = scoreTransaction(tx({ reference: "RE-2026-01042" }), {
      documents: [doc({ openCents: 0 })],
      manualPayments: [
        { paymentId: "p1", date: "2026-10-10", amountCents: 119000, accountId: "acc", label: "RE-2026-01042" },
      ],
    });
    expect(r[0]).toMatchObject({ allocations: [{ target: { kind: "payment", id: "p1" } }] });
    expect(r[0]?.reasons[0]).toBe("existing_manual_payment");
  });

  test("T07-069 EC-BNK-64 overpayment with a number match → invoice + credit balance", () => {
    const [c] = scoreTransaction(tx({ amountCents: 123500, openCents: 123500, reference: "RE-2026-01042" }), {
      documents: [doc()],
    });
    expect(c?.allocations).toEqual([
      { target: { kind: "salesDocument", id: "d1042" }, amountCents: 119000 },
      { target: { kind: "contactCredit", id: "c1" }, amountCents: 4500 },
    ]);
  });

  test("T07-064 BNK-044 subset-sum over the identified contact's items, fewest items, ≤ 12", () => {
    const docs = [
      doc({ id: "a", number: "RE-11", openCents: 30000, dueDate: "2026-10-01", ibans: ["DE02120300000000202051"] }),
      doc({ id: "b", number: "RE-12", openCents: 50000, dueDate: "2026-10-05", ibans: ["DE02120300000000202051"] }),
      doc({ id: "c", number: "RE-13", openCents: 20000, dueDate: "2026-10-02", ibans: ["DE02120300000000202051"] }),
    ];
    const r = scoreTransaction(
      tx({ amountCents: 80000, openCents: 80000, counterpartyIban: "DE02120300000000202051" }),
      {
        documents: docs,
      },
    );
    const combined = r.find((c) => c.kind === "combined");
    expect(combined?.allocations.map((a) => a.target.id).sort()).toEqual(["a", "b"]);
    expect(
      subsetSum(docs, 100000)
        ?.map((d) => d.id)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(subsetSum(docs, 1)).toBeNull();
  });

  test("PAY-033 outgoing transaction matched to an equal credit balance (refund)", () => {
    const [c] = scoreTransaction(
      tx({ amountCents: -4500, openCents: 4500, direction: "out", counterpartyName: "Müller GmbH" }),
      {
        documents: [],
        credits: [{ contactId: "c1", contactName: "Müller GmbH", ibans: [], aliases: [], balanceCents: 4500 }],
      },
    );
    expect(c?.allocations).toEqual([{ target: { kind: "contactCredit", id: "c1" }, amountCents: 4500 }]);
  });

  describe("BNK-041 PAY-033 (b) outgoing debits against open refunds of credit corrections", () => {
    const refund = (over: Partial<OpenRefund> = {}): OpenRefund => ({
      id: "rk1",
      number: "RK-2026-0001",
      contactId: "c1",
      contactName: "Müller GmbH",
      ibans: [],
      aliases: [],
      documentDate: "2026-10-10",
      openCents: 23_800,
      currency: "EUR",
      ...over,
    });
    const out = (over: Partial<UnmatchedTransaction> = {}) =>
      tx({ amountCents: -23_800, openCents: 23_800, direction: "out", ...over });

    test("T07-074 BNK-041 number + exact open refund + name → 1.00 refund of the correction, auto-applicable (BNK-043)", () => {
      const [c] = scoreTransaction(out({ purpose: "Erstattung RK-2026-0001", counterpartyName: "MUELLER GMBH" }), {
        documents: [],
        refunds: [refund()],
      });
      expect(c).toMatchObject({
        kind: "single",
        score: 1,
        reasons: ["number_in_purpose", "exact_amount", "name_similarity", "date_window"],
        allocations: [{ target: { kind: "salesDocument", id: "rk1" }, amountCents: 23_800 }],
      });
      expect(c && autoApplicable(c)).toBe(true);
    });

    test("T07-074 BNK-041 without the number: exact amount + known IBAN → 0.65 suggestion, never auto", () => {
      const [c] = scoreTransaction(out({ counterpartyIban: "DE02 1203 0000 0000 2020 51" }), {
        documents: [],
        refunds: [refund({ ibans: ["DE02120300000000202051"] })],
      });
      expect(c).toMatchObject({ score: 0.65, reasons: ["exact_amount", "known_iban", "date_window"] });
      expect(c && autoApplicable(c)).toBe(false);
    });

    test("T07-074 BNK-045 EC-PAY-33 a smaller debit with the number is a partial refund; a larger one is never proposed", () => {
      const [partial] = scoreTransaction(out({ amountCents: -10_000, openCents: 10_000, purpose: "RK 2026 1" }), {
        documents: [],
        refunds: [refund()],
      });
      expect(partial).toMatchObject({
        kind: "partial",
        score: 0.65,
        reasons: ["number_in_purpose", "partial", "date_window"],
        allocations: [{ target: { kind: "salesDocument", id: "rk1" }, amountCents: 10_000 }],
      });
      expect(partial && autoApplicable(partial)).toBe(false);
      // More than the open refund (EC-PAY-33) or a smaller amount without the number: no suggestion.
      expect(
        scoreTransaction(out({ amountCents: -30_000, openCents: 30_000, purpose: "RK-2026-0001" }), {
          documents: [],
          refunds: [refund()],
        }),
      ).toEqual([]);
      expect(
        scoreTransaction(out({ amountCents: -10_000, openCents: 10_000 }), { documents: [], refunds: [refund()] }),
      ).toEqual([]);
    });

    test("T07-074 BNK-041 hard filters: incoming money, other currency and rejected pairs never propose a refund", () => {
      expect(
        scoreTransaction(tx({ amountCents: 23_800, openCents: 23_800, purpose: "RK-2026-0001" }), {
          documents: [],
          refunds: [refund()],
        }),
      ).toEqual([]);
      expect(
        scoreTransaction(out({ purpose: "RK-2026-0001" }), { documents: [], refunds: [refund({ currency: "USD" })] }),
      ).toEqual([]);
      expect(
        scoreTransaction(out({ purpose: "RK-2026-0001" }), {
          documents: [],
          refunds: [refund()],
          rejected: new Set(["salesDocument:rk1"]),
        }),
      ).toEqual([]);
    });

    test("T07-074 BNK-042 a credit balance and an open refund of the same amount and customer are ambiguous", () => {
      const r = scoreTransaction(out({ counterpartyName: "Müller GmbH" }), {
        documents: [],
        credits: [{ contactId: "c1", contactName: "Müller GmbH", ibans: [], aliases: [], balanceCents: 23_800 }],
        refunds: [refund()],
      });
      expect(r.map((c) => c.allocations[0]?.target.kind).sort()).toEqual(["contactCredit", "salesDocument"]);
      expect(r.every((c) => c.reasons.includes("ambiguous"))).toBe(true);
    });
  });

  test("number normalisation: case, separators, leading zeros, „RE “ prefix, tail only when unique", () => {
    expect(numberMatch("RE-2026-0042", "re 2026 / 42")).toBe("full");
    expect(numberMatch("RE-2026-0042", "Zahlung 2026-0042")).toBe("body");
    expect(numberMatch("RE-2026-0042", "Rechnung 42 danke")).toBe("tail");
    expect(numberMatch("RE-2026-0042", "RE-2026-00420")).toBeNull();
    const r = scoreTransaction(tx({ purpose: "Rechnung 42" }), {
      documents: [
        doc({ id: "x", number: "RE-2026-0042", openCents: 1 }),
        doc({ id: "y", number: "RE-2025-0042", openCents: 1 }),
      ],
    });
    expect(r).toEqual([]);
    expect(jaroWinkler("mueller", "mueller")).toBe(1);
    expect(jaroWinkler("", "a")).toBe(0);
  });
});
