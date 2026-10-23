import { describe, expect, test } from "vitest";
import {
  autoDepositPair,
  checkDepositPair,
  type TransitBankRow,
  type TransitCashDeposit,
  transitWarnings,
} from "./transit";

const accounts = [
  { id: "eur", name: "Revolut EUR", currency: "EUR" },
  { id: "usd", name: "Revolut USD", currency: "USD" },
];
const row = (over: Partial<TransitBankRow> = {}): TransitBankRow => ({
  id: "r1",
  accountId: "eur",
  bookingDate: "2026-10-01",
  amountCents: -92_000,
  currency: "EUR",
  instructedCurrency: "USD",
  paired: false,
  ...over,
});
const deposit = (over: Partial<TransitCashDeposit> = {}): TransitCashDeposit => ({
  id: "d1",
  date: "2026-03-02",
  amountCents: 50_000,
  bankAccountId: "eur",
  paired: false,
  ...over,
});

describe("open Geldtransit (BNK-061, E-ACC-23, EC-BNK-68, EC-BNK-20)", () => {
  test("E-ACC-23 an exchange whose other side is missing for more than 3 days names the account and currency", () => {
    expect(transitWarnings([row()], [], accounts, "2026-10-04")).toEqual([]);
    expect(transitWarnings([row()], [], accounts, "2026-10-05")).toEqual([
      {
        id: "r1",
        kind: "transit_missing",
        accountId: "eur",
        date: "2026-10-01",
        severity: "info",
        title: "Devisentausch/Umbuchung vom 01.10.2026: Gegenbuchung im Konto Revolut USD (USD) fehlt.",
      },
    ]);
    // A paired side never warns (transit nets to 0).
    expect(transitWarnings([row({ paired: true })], [], accounts, "2026-12-01")).toEqual([]);
  });

  test("EC-BNK-68 a Geldtransit without counterpart for more than 7 days is a warning with date and amount", () => {
    const own = row({ instructedCurrency: undefined, amountCents: -25_000 });
    expect(transitWarnings([own], [], accounts, "2026-10-08")[0]?.kind).toBe("transit_missing");
    expect(transitWarnings([own], [], accounts, "2026-10-09")).toEqual([
      {
        id: "r1",
        kind: "transit_open",
        accountId: "eur",
        date: "2026-10-01",
        severity: "warning",
        title: "Geldtransit vom 01.10.2026 über 250,00 € ohne Gegenbuchung.",
      },
    ]);
  });

  test("EC-BNK-20 an exchange into a currency without an own account warns at once to add that account", () => {
    const toGbp = row({ instructedCurrency: "GBP", bookingDate: "2026-10-20" });
    expect(transitWarnings([toGbp], [], accounts, "2026-10-20")).toEqual([
      {
        id: "r1",
        kind: "transit_unmapped",
        accountId: "eur",
        date: "2026-10-20",
        severity: "warning",
        title: "Gegenbuchung in einem nicht übernommenen Konto (GBP). Bitte Konto übernehmen.",
      },
    ]);
  });
});

describe("cash deposit ↔ bank credit (CSH-024, EC-CSH-15, E-ACC-31)", () => {
  test("EC-CSH-15 a deposit whose bank credit is not booked stays open; after 7 days a warning", () => {
    expect(transitWarnings([], [deposit()], accounts, "2026-03-09")).toEqual([]);
    expect(transitWarnings([], [deposit()], accounts, "2026-03-10")).toEqual([
      {
        id: "d1",
        kind: "cash_deposit_open",
        accountId: "eur",
        date: "2026-03-02",
        severity: "warning",
        title: "Bareinzahlung vom 02.03.2026 (500,00 €) noch nicht auf dem Bankkonto gefunden.",
      },
    ]);
    expect(transitWarnings([], [deposit({ paired: true })], accounts, "2026-04-30")).toEqual([]);
  });

  test("E-ACC-31 TST-ACC-32 only a credit of exactly the deposit amount pairs (automatically within 10 days)", () => {
    const credit = { accountId: "eur", bookingDate: "2026-03-03", amountCents: 50_000, currency: "EUR" };
    expect(autoDepositPair(credit, [deposit()])).toBe("d1");
    expect(autoDepositPair({ ...credit, amountCents: 49_900 }, [deposit()])).toBeNull();
    expect(autoDepositPair({ ...credit, bookingDate: "2026-03-13" }, [deposit()])).toBeNull();
    expect(autoDepositPair({ ...credit, bookingDate: "2026-03-01" }, [deposit()])).toBeNull();
    expect(autoDepositPair({ ...credit, accountId: "usd" }, [deposit()])).toBeNull();
    // Two identical deposits: ambiguous → the owner decides.
    expect(autoDepositPair(credit, [deposit(), deposit({ id: "d2" })])).toBeNull();
    expect(checkDepositPair({ ...credit, amountCents: 49_900 }, deposit())).toBe(
      "Der Betrag der Gutschrift (499,00 €) entspricht nicht der Bareinzahlung vom 02.03.2026 (500,00 €).",
    );
    expect(checkDepositPair({ ...credit, bookingDate: "2026-03-20" }, deposit())).toBeNull();
  });
});
