import { describe, expect, test } from "vitest";
import {
  aliasToken,
  autoApplicable,
  isSafe,
  isValidRf,
  jaroWinkler,
  numberMatch,
  type OpenDocument,
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
