import { describe, expect, test } from "vitest";
import { taxPaymentFromTransaction } from "./tax-payment";

describe("tax payments from bank transactions (BNK-064)", () => {
  test("BNK-064 a transfer to the Finanzamt with an UStVA reference → tax_payment with subtype and period", () => {
    expect(
      taxPaymentFromTransaction({
        amountCents: -50_000,
        counterpartyName: "Finanzamt Berlin-Mitte",
        purpose: "StNr 12/345/67890 USt 09/26",
      }),
    ).toEqual({
      subtype: "ust_prepayment",
      period: "2026-09",
      hint: "Steuerzahlung: USt-Vorauszahlung 2026-09",
    });
  });

  test("BNK-064 a refund from the Finanzkasse is a tax payment too (income direction, X2/X4)", () => {
    expect(
      taxPaymentFromTransaction({
        amountCents: 12_000,
        counterpartyName: "Finanzkasse",
        purpose: "Erstattung ESt 2025",
      }),
    ).toEqual({ subtype: "est_private", hint: "Steuerzahlung: Einkommensteuer, Kirchensteuer, Soli (privat)" });
  });

  test("BNK-064 a Finanzamt row without a recognisable reference leaves the kind to the owner; others are no tax payment", () => {
    expect(
      taxPaymentFromTransaction({ amountCents: -10_000, counterpartyName: "Finanzamt Köln", purpose: "Zahlung" }),
    ).toEqual({
      hint: "Steuerzahlung – Art und Zeitraum bitte auswählen",
    });
    expect(
      taxPaymentFromTransaction({ amountCents: -10_000, counterpartyName: "Büro Schmidt", purpose: "USt 09/26" }),
    ).toBeNull();
  });
});
