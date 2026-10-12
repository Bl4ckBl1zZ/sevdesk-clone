import { describe, expect, test } from "vitest";
import { findReversalCandidates, findTransferCandidates, type LinkRow } from "./links";
import { cashWithdrawalAmount, checkMark, MARK_MESSAGES, statusForMark } from "./marking";
import { allocationStatus, openAmountCents } from "./match-types";
import { suggestTypeDefault } from "./type-defaults";

const row = (over: Partial<LinkRow>): LinkRow => ({
  id: "x",
  accountId: "eur",
  bookingDate: "2026-10-16",
  amountCents: 59_500,
  currency: "EUR",
  purpose: "RE-2026-0043",
  status: "open",
  ...over,
});

describe("bank reversals (BNK-121)", () => {
  test("T07-027 EC-141 EC-BNK-14 a counter-entry with the inverse amount and the same end-to-end ID is suggested", () => {
    const original = row({ id: "orig", endToEndId: "E2E-BETA-0043" });
    const counter = row({
      id: "rv",
      bookingDate: "2026-10-20",
      amountCents: -59_500,
      endToEndId: "E2E-BETA-0043",
      reversal: true,
    });
    expect(findReversalCandidates(counter, [original, counter])).toEqual([
      {
        originalId: "orig",
        label: "Rückbuchung von 16.10.2026 595,00 €",
        reasons: ["end_to_end_id", "purpose", "reversal_flag"],
      },
    ]);
  });

  test("BNK-121 no candidate beyond 60 days, for another account, without a common reference or already linked", () => {
    const original = row({ id: "orig", endToEndId: "E" });
    const counter = row({ id: "rv", amountCents: -59_500, endToEndId: "E", bookingDate: "2026-12-16" });
    expect(findReversalCandidates(counter, [original])).toEqual([]);
    expect(findReversalCandidates({ ...counter, bookingDate: "2026-10-20", accountId: "usd" }, [original])).toEqual([]);
    expect(
      findReversalCandidates({ ...counter, bookingDate: "2026-10-20", endToEndId: "Z", purpose: "x" }, [original]),
    ).toEqual([]);
    const linked = row({ id: "rv0", amountCents: -59_500, reversalOfId: "orig" });
    expect(findReversalCandidates({ ...counter, bookingDate: "2026-10-20" }, [original, linked])).toEqual([]);
  });
});

describe("Geldtransit pairs (BNK-061)", () => {
  const accounts = [
    { id: "eur", iban: "LT443250010000000101", currency: "EUR" },
    { id: "usd", iban: "LT443250010000000101", currency: "USD" },
    { id: "eur2", iban: "DE89370400440532013000", currency: "EUR" },
  ];

  test("T07-091 EC-144 an exchange between pockets pairs by the instructed amount on the same booking date", () => {
    const eur = row({
      id: "e",
      amountCents: -92_000,
      instructedAmount: { amountMinor: 100_000, currency: "USD" },
      bookingDate: "2026-10-12",
    });
    const usd = row({
      id: "u",
      accountId: "usd",
      currency: "USD",
      amountCents: 100_000,
      bookingDate: "2026-10-12",
      instructedAmount: { amountMinor: 92_000, currency: "EUR" },
    });
    expect(findTransferCandidates(eur, [eur, usd], accounts)).toEqual([{ peerId: "u", reason: "exchange" }]);
  });

  test("T07-091 a transfer to an own IBAN pairs with the inverse credit in that account", () => {
    const out = row({ id: "o", amountCents: -50_000, counterpartyIban: "DE89370400440532013000" });
    const inc = row({ id: "i", accountId: "eur2", amountCents: 50_000 });
    expect(findTransferCandidates(out, [inc], accounts)).toEqual([{ peerId: "i", reason: "own_iban" }]);
    expect(findTransferCandidates(out, [{ ...inc, bookingDate: "2026-10-17" }], accounts)).toEqual([]);
  });

  test("T07-031 BNK-027 type defaults: exchange → transit, fee → bank fees, ATM → cash, refund, own IBAN", () => {
    expect(
      suggestTypeDefault({ amountCents: -92_000, proprietaryCode: "EXCHANGE", purpose: "Exchanged to USD" })?.kind,
    ).toBe("transfer");
    expect(
      suggestTypeDefault({ amountCents: -1000, bankTransactionCode: "ACMT-MDOP-CHRG", purpose: "Basic plan fee" })
        ?.kind,
    ).toBe("fee");
    expect(suggestTypeDefault({ amountCents: -20_100, proprietaryCode: "ATM", purpose: "Cash withdrawal" })?.kind).toBe(
      "atm",
    );
    expect(suggestTypeDefault({ amountCents: 1299, proprietaryCode: "CARD_REFUND", purpose: "Amazon" })?.kind).toBe(
      "card_refund",
    );
    expect(
      suggestTypeDefault({ amountCents: 119_000, bankTransactionCode: "PMNT-RCDT-ESCT", purpose: "RE-2026-0042" })
        ?.kind,
    ).toBe("incoming");
    expect(
      suggestTypeDefault({ amountCents: -100, purpose: "x", counterpartyIban: "DE89 3704 0044 0532 0130 00" }, [
        "DE89370400440532013000",
      ])?.ruleId,
    ).toBe("own_iban");
    expect(suggestTypeDefault({ amountCents: -100, purpose: "Lastschrift Finanzamt Berlin" })?.kind).toBe("tax");
  });

  test("T07-035 EC-164 EC-BNK-28 the plan fee transaction suggests „Bankgebühren“ without VAT and without § 13b", () => {
    expect(suggestTypeDefault({ amountCents: -1000, proprietaryCode: "FEE", purpose: "Basic plan fee" })).toEqual({
      kind: "fee",
      ruleId: "fee",
      hint: "Bankgebühren (ohne Umsatzsteuer, kein § 13b)",
    });
  });
});

describe("marking (BNK-060, BNK-063, CSH-025)", () => {
  const open = { amountCents: -100_000, currency: "EUR", status: "open", allocatedCents: 0 };

  test("T07-090 EC-BNK-21 Privat: allowed for an Einzelunternehmen, blocked for a GmbH without shareholder", () => {
    expect(checkMark(open, { as: "private" }, "einzelunternehmen")).toBeNull();
    expect(checkMark(open, { as: "private" }, "gmbh")?.message).toBe(MARK_MESSAGES.corporation);
    expect(checkMark(open, { as: "private", shareholder: { name: "A. Muster", note: "Entnahme" } }, "gmbh")).toBeNull();
    expect(statusForMark("private")).toBe("private");
  });

  test("T07-093 GOBD-02 EC-BNK-67 ignoring a booked transaction needs an allowed reason; a neutralised pair is allowed", () => {
    expect(checkMark(open, { as: "ignored" }, "einzelunternehmen")?.message).toBe(MARK_MESSAGES.ignoreRestricted);
    expect(checkMark(open, { as: "ignored", reason: "test_or_zero" }, "einzelunternehmen")?.message).toBe(
      MARK_MESSAGES.ignoreRestricted,
    );
    const back = {
      id: "b",
      accountId: "eur",
      amountCents: 100_000,
      currency: "EUR",
      status: "open",
      allocatedCents: 0,
    };
    expect(checkMark(open, { as: "ignored", reason: "neutralised_pair", link: back }, "einzelunternehmen")).toBeNull();
    expect(
      checkMark(
        open,
        { as: "ignored", reason: "neutralised_pair", link: { ...back, amountCents: 99_000 } },
        "einzelunternehmen",
      ),
    ).not.toBeNull();
  });

  test("T07-095 CSH-025 EC-CSH-35 only EUR debits go into the till; the ATM fee stays a bank fee", () => {
    expect(
      checkMark({ ...open, amountCents: -20_100, feeCents: 100 }, { as: "cash_withdrawal" }, "einzelunternehmen"),
    ).toBeNull();
    expect(cashWithdrawalAmount({ amountCents: -20_100, feeCents: 100 })).toBe(20_000);
    expect(checkMark({ ...open, amountCents: 5000 }, { as: "cash_withdrawal" }, "einzelunternehmen")?.message).toBe(
      MARK_MESSAGES.cashOnlyDebits,
    );
    expect(checkMark({ ...open, currency: "USD" }, { as: "cash_withdrawal" }, "einzelunternehmen")?.message).toBe(
      MARK_MESSAGES.cashEurOnly,
    );
  });

  test("EC-BNK-61 RI-10 a matched transaction cannot be marked; allocation status and open amount", () => {
    expect(
      checkMark({ ...open, status: "matched", allocatedCents: 100_000 }, { as: "private" }, "einzelunternehmen")
        ?.message,
    ).toBe(MARK_MESSAGES.notOpen);
    expect(openAmountCents({ amountCents: -100_000, allocatedCents: 40_000 })).toBe(60_000);
    expect(allocationStatus({ amountCents: -100_000 }, 40_000)).toBe("partially_matched");
    expect(allocationStatus({ amountCents: -100_000 }, 100_000)).toBe("matched");
    expect(() => allocationStatus({ amountCents: -100_000 }, 100_001)).toThrow(/RI-10/);
  });
});
