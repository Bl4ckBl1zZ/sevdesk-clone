import { describe, expect, test } from "vitest";
import {
  bt81Code,
  CASH_HELP_TEXT,
  checkActivatePaymentMethod,
  PAYMENT_METHOD_KINDS,
  SEED_PAYMENT_METHODS,
  validatePaymentMethods,
} from "./payment-methods";

describe("SET-092 payment methods", () => {
  test("SET-092 seeded: Überweisung (default), SEPA-Lastschrift (inactive), Barzahlung, PayPal, Kartenzahlung, Sonstige", () => {
    expect(SEED_PAYMENT_METHODS.map((m) => [m.name, m.kind, m.isDefault, m.active])).toEqual([
      ["Überweisung", "transfer", true, true],
      ["SEPA-Lastschrift", "sepa_debit", false, false],
      ["Barzahlung", "cash", false, true],
      ["PayPal", "paypal", false, true],
      ["Kartenzahlung", "card", false, true],
      ["Sonstige", "other", false, true],
    ]);
    expect(validatePaymentMethods(SEED_PAYMENT_METHODS)).toEqual({ ok: true, value: undefined });
  });

  test("SET-092 ER-10 BT-81 is derived from the kind; transfer is 58 for SEPA IBANs, else 30", () => {
    expect(PAYMENT_METHOD_KINDS.map((k) => bt81Code(k, "DE89370400440532013000"))).toEqual([
      "58",
      "59",
      "10",
      "68",
      "48",
      "ZZZ",
    ]);
    expect(bt81Code("transfer", "CH9300762011623852957")).toBe("58");
    expect(bt81Code("transfer", "BR1500000000000010932840814P2")).toBe("30");
    expect(bt81Code("transfer", undefined)).toBe("30");
  });

  test("SET-092 activating SEPA-Lastschrift needs a creditor ID", () => {
    expect(checkActivatePaymentMethod("sepa_debit", undefined)).toMatchObject({
      code: "CREDITOR_ID_REQUIRED",
      message: "Für SEPA-Lastschrift wird eine Gläubiger-ID benötigt.",
    });
    expect(checkActivatePaymentMethod("sepa_debit", "DE98ZZZ09999999999")).toBeNull();
    expect(checkActivatePaymentMethod("cash", undefined)).toBeNull();
  });

  test("SET-092 names 1–60 characters and unique, texts ≤ 500 characters, exactly one default", () => {
    const base = SEED_PAYMENT_METHODS.map((m) => ({ ...m }));
    expect(validatePaymentMethods(base.map((m) => ({ ...m, isDefault: false })))).toMatchObject({
      error: { code: "PAYMENT_METHOD_DEFAULT" },
    });
    expect(validatePaymentMethods([...base, { ...base[3], isDefault: false } as (typeof base)[number]])).toMatchObject({
      error: { code: "PAYMENT_METHOD_DUPLICATE" },
    });
    expect(validatePaymentMethods([{ ...base[0], text: "x".repeat(501) } as (typeof base)[number]])).toMatchObject({
      error: { code: "PAYMENT_METHOD_INVALID" },
    });
  });
});

describe("SET-093 AO-04 cash is a payment on an invoice, never a till receipt", () => {
  test("SET-093 AO-04 the help text says the software is no cash register; the cash text implies no receipt", () => {
    expect(CASH_HELP_TEXT).toBe(
      "Barzahlung wird als Zahlung auf eine Rechnung gebucht. Diese Software ist keine Kasse.",
    );
    const cash = SEED_PAYMENT_METHODS.find((m) => m.kind === "cash");
    expect(cash?.text).toBe("Betrag in bar erhalten.");
    for (const text of ["Kassenbon folgt", "Beleg aus der Registrierkasse", "TSE-Signatur auf dem Bon"]) {
      expect(
        validatePaymentMethods([{ ...SEED_PAYMENT_METHODS[0], isDefault: true } as never, { ...cash, text } as never]),
      ).toMatchObject({
        error: { code: "CASH_TEXT_TILL" },
      });
    }
  });
});
