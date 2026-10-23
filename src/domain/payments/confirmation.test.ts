import { describe, expect, test } from "vitest";
import type { LetterCompany } from "../receivables/letter";
import { paymentConfirmationLetter } from "./confirmation";

const COMPANY: LetterCompany = {
  legalForm: "einzelunternehmen",
  name: "Lena Kleinert Design",
  address: { street: "Gartenweg 3", postalCode: "04109", city: "Leipzig", countryCode: "DE" },
  contact: { name: "Lena Kleinert", phone: "0341 555", email: "hallo@kleinert.de" },
  representatives: [],
  taxNumber: "2321081508150",
  taxNumberState: "SN",
};

const base = {
  paymentId: "p1",
  paymentDate: "2026-10-20",
  amountCents: 50_000,
  invoiceNumber: "RE-2026-0007",
  invoiceDate: "2026-10-01",
  openAfterCents: 69_000,
  salutation: "Sehr geehrte Frau Beispiel",
  company: COMPANY,
  recipient: { name: "Erika Beispiel", address: ["Lindenallee 2", "04109 Leipzig"] },
  date: "2026-10-21",
};

describe("payment confirmation letter (PAY-048)", () => {
  test("PAY-048 MAIL-03 „Zahlungseingang bestätigt“ from the default template: amount, dates, invoice, rest", () => {
    const l = paymentConfirmationLetter(base);
    expect(l.kind).toBe("payment_confirmation");
    expect(l.title).toBe("Zahlungsbestätigung");
    expect(l.fileName).toBe("Zahlungsbestaetigung-RE-2026-0007-2026-10-20.pdf");
    expect(l.subject).toBe("Bestätigung Ihres Zahlungseingangs zur Rechnung RE-2026-0007");
    expect(l.paragraphs).toEqual([
      "Sehr geehrte Frau Beispiel,",
      "wir bestätigen den Eingang Ihrer Zahlung über 500,00 € vom 20.10.2026 zu unserer Rechnung RE-2026-0007 vom 01.10.2026.",
      "Es verbleibt ein offener Betrag von 690,00 €.",
      "Vielen Dank für Ihre Zahlung.",
    ]);
    expect(l.footer[0]).toContain("Lena Kleinert Design");
    expect(paymentConfirmationLetter({ ...base, openAfterCents: 0 }).paragraphs[2]).toBe(
      "Die Rechnung ist damit vollständig beglichen.",
    );
  });

  test("PAY-048 an edited text keeps the placeholders; English template", () => {
    const l = paymentConfirmationLetter({
      ...base,
      template: { subject: "Danke – {rechnungsnummer}", body: "{anrede},\n\nbetrag {betrag} erhalten. {unbekannt}" },
    });
    expect(l.subject).toBe("Danke – RE-2026-0007");
    expect(l.paragraphs).toEqual(["Sehr geehrte Frau Beispiel,", "betrag 500,00 € erhalten. {unbekannt}"]);
    const en = paymentConfirmationLetter({ ...base, lang: "en", salutation: "Dear Ms Beispiel" });
    expect(en.title).toBe("Payment confirmation");
    expect(en.paragraphs[1]).toBe(
      "we confirm receipt of your payment of 500,00 € on 20.10.2026 for our invoice RE-2026-0007 dated 01.10.2026.",
    );
  });
});
