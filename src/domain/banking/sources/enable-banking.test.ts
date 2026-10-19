import { describe, expect, test } from "vitest";
import { type EbTransaction, mapEnableBankingTransactions } from "./enable-banking";

const booked = (over: Partial<EbTransaction> = {}): EbTransaction => ({
  entry_reference: "ER-1",
  transaction_id: "tid-volatile-1",
  status: "BOOK",
  credit_debit_indicator: "CRDT",
  transaction_amount: { currency: "EUR", amount: "1190.00" },
  booking_date: "2026-10-05",
  value_date: "2026-10-05",
  debtor: { name: "Mueller GmbH" },
  debtor_account: { iban: "DE02 1203 0000 0000 2020 51" },
  remittance_information: ["RE-2026-01042", "Danke"],
  ...over,
});

describe("Enable Banking mapping (BNK-120, BNK-111, BNK-109, BNK-021)", () => {
  test("BNK-120 booked credit → normalised row (counterparty = debtor, remittance joined, entry_reference kept)", () => {
    const r = mapEnableBankingTransactions([booked()], "EUR");
    expect(r.issues).toEqual([]);
    expect(r.pending).toEqual([]);
    const [t] = r.booked;
    expect(t).toMatchObject({
      bookingDate: "2026-10-05",
      valueDate: "2026-10-05",
      amountCents: 119_000,
      currency: "EUR",
      counterpartyName: "Mueller GmbH",
      counterpartyIban: "DE02120300000000202051",
      counterpartySource: "provider",
      purpose: "RE-2026-01042 Danke",
      entryReference: "ER-1",
    });
    expect(JSON.parse(t?.raw ?? "{}").transaction_id).toBe("tid-volatile-1");
  });

  test("BNK-109 the volatile transaction_id is never used as a bank ID (no providerTransactionId)", () => {
    const r = mapEnableBankingTransactions([booked({ entry_reference: null })], "EUR");
    expect(r.booked[0]?.entryReference).toBeUndefined();
    expect(r.booked[0]?.providerTransactionId).toBeUndefined();
  });

  test("BNK-120 debit card payment: counterparty = creditor, merchant name, MCC, FX instructed amount, balance after", () => {
    const r = mapEnableBankingTransactions(
      [
        booked({
          credit_debit_indicator: "DBIT",
          transaction_amount: { currency: "EUR", amount: "12.05" },
          debtor: null,
          debtor_account: null,
          creditor: { name: "Acme Corp." },
          merchant_category_code: "5734",
          bank_transaction_code: { code: "CCRD", sub_code: "POSD", description: "CARD_PAYMENT" },
          exchange_rate: { exchange_rate: "1.0788", instructed_amount: { currency: "USD", amount: "13.00" } },
          balance_after_transaction: { balance_amount: { currency: "EUR", amount: "987.95" } },
          reference_number: "RF18539007547034",
          remittance_information: [],
        }),
      ],
      "EUR",
    );
    expect(r.booked[0]).toMatchObject({
      amountCents: -1205,
      counterpartyName: "Acme Corp.",
      merchantName: "Acme Corp.",
      mcc: "5734",
      bankTransactionCode: "CCRD-POSD",
      proprietaryCode: "CARD_PAYMENT",
      exchangeRate: "1.0788",
      instructedAmount: { amountMinor: 1300, currency: "USD" },
      balanceAfterCents: 98_795,
      reference: "RF18539007547034",
      purpose: "",
    });
  });

  test("BNK-111 PDNG rows are returned separately as provisional rows, other states are skipped", () => {
    const r = mapEnableBankingTransactions(
      [
        booked(),
        booked({ status: "PDNG", entry_reference: null, booking_date: null, transaction_date: "2026-10-06" }),
        booked({ status: "RJCT", entry_reference: "ER-X" }),
      ],
      "EUR",
    );
    expect(r.booked).toHaveLength(1);
    expect(r.pending).toEqual([
      expect.objectContaining({ bookingDate: "2026-10-06", amountCents: 119_000, counterpartyName: "Mueller GmbH" }),
    ]);
    expect(r.skipped).toEqual([{ line: 3, reason: "Status RJCT" }]);
  });

  test("EC-BNK-23 BNK-021 amount literals: more decimals than the exponent rejected, JPY exponent 0", () => {
    const r = mapEnableBankingTransactions(
      [booked({ transaction_amount: { currency: "EUR", amount: "1.005" } }), booked({ entry_reference: "ER-2" })],
      "EUR",
    );
    expect(r.booked).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ line: 1, code: "bank_amount_invalid" });
    expect(r.issues[0]?.message).toBe("Ungültiger Betrag in Bankdaten (1.005).");
    const jpy = mapEnableBankingTransactions(
      [booked({ transaction_amount: { currency: "JPY", amount: "1500" } })],
      "JPY",
    );
    expect(jpy.booked[0]?.amountCents).toBe(1500);
  });

  test("BNK-111 a booked row without any date is rejected with a finding (never guessed)", () => {
    const r = mapEnableBankingTransactions([booked({ booking_date: null, value_date: null })], "EUR");
    expect(r.booked).toEqual([]);
    expect(r.issues[0]?.code).toBe("bank_date_missing");
  });
});
