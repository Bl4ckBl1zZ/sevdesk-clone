import { BANK_ACCOUNT, makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { paymentMeansFor, paymentTermsText } from "./payment";

const pay = (over: object) =>
  ({ method: "transfer", dueDays: 30, bankAccount: BANK_ACCOUNT, showEpcQr: true, ...over }) as const;

describe("paymentMeansFor (App. A.5, BG-16)", () => {
  test("INV-19 BT-81 58 SEPA credit transfer with BT-84 IBAN, BT-85 holder, BT-86 BIC and BT-83 = number", () => {
    expect(paymentMeansFor(makeSnapshot())).toEqual({
      code: "58",
      text: "SEPA-Überweisung",
      remittance: "RE-2026-0042",
      account: { iban: "DE89370400440532013000", name: "Muster Design GmbH", bic: "COBADEFFXXX" },
    });
  });

  test("INV-19 BT-81 30 for non-EUR transfers and transfers without a stored account", () => {
    const usd = makeSnapshot({ currency: "USD", fx: { rate: "1.0831", source: "bmf_monthly", date: "2026-10-01" } });
    expect(paymentMeansFor(usd).code).toBe("30");
    const noAccount = makeSnapshot({ payment: { method: "transfer", dueDays: 30, showEpcQr: false } });
    expect(paymentMeansFor(noAccount)).toEqual({ code: "30", remittance: "RE-2026-0042" });
    const en = makeSnapshot({
      language: "en",
      currency: "USD",
      fx: { rate: "1.0831", source: "bmf_monthly", date: "2026-10-01" },
    });
    expect(paymentMeansFor(en).text).toBe("Credit transfer");
  });

  test("INV-19 BT-81 for cash, card, PayPal and other methods", () => {
    expect(paymentMeansFor(makeSnapshot({ payment: pay({ method: "cash" }) })).code).toBe("10");
    expect(paymentMeansFor(makeSnapshot({ payment: pay({ method: "card" }) })).code).toBe("48");
    expect(paymentMeansFor(makeSnapshot({ payment: pay({ method: "paypal" }) })).code).toBe("68");
    const other = paymentMeansFor(
      makeSnapshot({ payment: pay({ method: "other", methodText: "Verrechnung mit Gutschrift" }) }),
    );
    expect(other).toMatchObject({ code: "ZZZ", text: "Verrechnung mit Gutschrift" });
    expect(paymentMeansFor(makeSnapshot({ language: "en", payment: pay({ method: "cash" }) })).text).toBe("Cash");
  });

  test("INV-19 Storno and zero payable → 97; refunds → 58 with the customer's IBAN, else 97", () => {
    const storno = makeSnapshot({
      type: "cancellation",
      original: { number: "RE-2026-0042", date: "2026-10-12" },
      lines: [{ ...makeSnapshot().lines[0], kind: "item", quantityMilli: -10_000 } as never],
    });
    expect(paymentMeansFor(storno).code).toBe("97");
    const credit = (refundIban?: string) =>
      makeSnapshot({
        type: "correction",
        correctionKind: "credit",
        original: { number: "RE-2026-0042", date: "2026-10-12" },
        lines: [
          {
            kind: "item",
            name: "Gutschrift",
            quantityMilli: -1_000,
            unitCode: "LS",
            unitPriceMicros: 1_000_000,
            vatCategory: "S",
            vatRateBp: 1900,
          },
        ],
        payment: pay(refundIban ? { refundIban } : {}),
      });
    expect(paymentMeansFor(credit("DE02 1203 0000 0000 2020 51"))).toMatchObject({
      code: "58",
      account: { iban: "DE02120300000000202051" },
    });
    expect(paymentMeansFor(credit()).code).toBe("97");
  });
});

describe("paymentTermsText (App. A.4, BT-20)", () => {
  test("T-DOC-033 terms sentence plus the XRechnung Skonto line #SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=1190.00#", () => {
    const s = makeSnapshot({ payment: pay({ skonto: { percentBp: 200, days: 14 } }) });
    expect(paymentTermsText(s)).toBe(
      "Zahlbar innerhalb von 30 Tagen ohne Abzug bis 11.11.2026.\n#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=1190.00#\n",
    );
  });

  test("DOC-50 immediate terms, custom text, refunds, zero amounts and Storno sentences (BR-CO-25)", () => {
    expect(paymentTermsText(makeSnapshot({ payment: pay({ dueDays: 0 }) }))).toBe("Zahlbar sofort ohne Abzug.");
    expect(paymentTermsText(makeSnapshot({ language: "en", payment: pay({ dueDays: 0 }) }))).toBe(
      "Payable immediately without deduction.",
    );
    expect(paymentTermsText(makeSnapshot({ payment: pay({ termsText: "Lieferung frei Haus." }) }))).toBe(
      "Lieferung frei Haus.\nZahlbar innerhalb von 30 Tagen ohne Abzug bis 11.11.2026.",
    );
    expect(paymentTermsText(makeSnapshot({ language: "en" }))).toBe(
      "Payable within 30 days without deduction by 11 Nov 2026.",
    );
    const storno = makeSnapshot({
      type: "cancellation",
      original: { number: "RE-2026-0042", date: "2026-10-12" },
      lines: [
        {
          kind: "item",
          name: "Storno",
          quantityMilli: -1_000,
          unitCode: "LS",
          unitPriceMicros: 1_000_000,
          vatCategory: "S",
          vatRateBp: 1900,
        },
      ],
    });
    expect(paymentTermsText(storno)).toBe("Keine Zahlung erforderlich (Stornierung der Rechnung RE-2026-0042).");
    const zero = makeSnapshot({
      lines: [
        {
          kind: "item",
          name: "Kulanz",
          quantityMilli: 1_000,
          unitCode: "LS",
          unitPriceMicros: 0,
          vatCategory: "S",
          vatRateBp: 1900,
        },
      ],
    });
    expect(paymentTermsText(zero)).toBe("Kein Zahlbetrag.");
  });
});
