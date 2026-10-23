import { describe, expect, test } from "vitest";
import {
  cashTransferFormSchema,
  emptyCashTransferForm,
  emptyStatementAccountForm,
  statementAccountSchema,
} from "./banking";

/** Bank account form (F07 BNK-001) and „Bargeld eingezahlt / entnommen“ (CSH-024) shared by the UI and Convex. */

const issuesOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]);

describe("bank account form (BNK-001)", () => {
  const valid = {
    ...emptyStatementAccountForm(),
    name: "Revolut EUR",
    iban: "de89 3704 0044 0532 0130 00",
    bic: "cobade ffxxx",
    accountHolder: "Max Mustermann",
    currency: "eur",
  };

  test("BNK-001 IBAN and BIC are normalised, the currency upper-cased; an opening balance needs date and amount", () => {
    const r = statementAccountSchema.parse({ ...valid, openingDate: "2026-01-01", openingAmount: "1.234,56" });
    expect(r).toMatchObject({ iban: "DE89370400440532013000", bic: "COBADEFFXXX", currency: "EUR", kind: "bank" });
    expect(issuesOf(statementAccountSchema.safeParse({ ...valid, openingDate: "2026-01-01" }))).toEqual([
      ["openingAmount", "Für den Anfangsbestand bitte Datum und Betrag angeben."],
    ]);
    expect(issuesOf(statementAccountSchema.safeParse({ ...valid, openingAmount: "10,00" }))).toEqual([
      ["openingDate", "Für den Anfangsbestand bitte Datum und Betrag angeben."],
    ]);
  });

  test("BNK-001 invalid IBAN/BIC are refused; only bank accounts carry an IBAN; a pocket without IBAN is fine", () => {
    expect(issuesOf(statementAccountSchema.safeParse({ ...valid, iban: "DE00 1234", bic: "XX" }))).toEqual([
      ["iban", "Die IBAN ist ungültig."],
      ["bic", "Die BIC ist ungültig."],
    ]);
    expect(issuesOf(statementAccountSchema.safeParse({ ...valid, kind: "paypal" }))).toEqual([
      ["iban", "Nur Bankkonten haben eine IBAN."],
    ]);
    expect(statementAccountSchema.parse({ ...valid, iban: "", bic: "", currency: "usd" })).toMatchObject({
      iban: "",
      bic: "",
      currency: "USD",
    });
  });
});

describe("cash transfer form (CSH-024)", () => {
  const base = emptyCashTransferForm("2026-10-13");

  test("CSH-024 a deposit needs the bank account and a positive amount; the note and backdate reason are kept", () => {
    expect(
      cashTransferFormSchema.parse({
        ...base,
        amount: "250,00",
        bankAccountId: "bac1",
        note: "Tageseinnahmen",
        backdateReason: "Nachtrag",
      }),
    ).toEqual({
      kind: "deposit_to_bank",
      date: "2026-10-13",
      amountCents: 25_000,
      bankAccountId: "bac1",
      note: "Tageseinnahmen",
      backdateReason: "Nachtrag",
    });
    expect(issuesOf(cashTransferFormSchema.safeParse({ ...base, amount: "0", bankAccountId: "" }))).toEqual([
      ["amount", "Der Betrag muss größer als 0 sein."],
      ["bankAccountId", "Bitte das Bankkonto angeben."],
    ]);
    const bad = issuesOf(cashTransferFormSchema.safeParse({ ...base, amount: "abc", bankAccountId: "bac1" }));
    expect(bad.map(([p]) => p)).toEqual(["amount"]);
  });

  test("CSH-026 a private withdrawal has no bank account and carries the shareholder note for corporations", () => {
    expect(
      cashTransferFormSchema.parse({
        ...base,
        kind: "private_withdrawal",
        amount: "50",
        bankAccountId: "ignored",
        shareholderName: "Max Mustermann",
        shareholderNote: "Entnahme Gesellschafter",
      }),
    ).toEqual({
      kind: "private_withdrawal",
      date: "2026-10-13",
      amountCents: 5_000,
      shareholder: { name: "Max Mustermann", note: "Entnahme Gesellschafter" },
    });
  });
});
