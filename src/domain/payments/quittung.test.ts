import { describe, expect, test } from "vitest";
import { euroInWords, numberInWords, quittungContent } from "./quittung";

describe("Quittung (F05 PAY-063, F07 CSH-028)", () => {
  test.each([
    [0, "null"],
    [1, "eins"],
    [16, "sechzehn"],
    [17, "siebzehn"],
    [21, "einundzwanzig"],
    [30, "dreißig"],
    [101, "einhunderteins"],
    [1190, "eintausendeinhundertneunzig"],
    [2000, "zweitausend"],
    [1_000_000, "eine Million"],
    [2_345_678, "zwei Millionen dreihundertfünfundvierzigtausendsechshundertachtundsiebzig"],
  ])("CSH-028 numberInWords(%i) = %s", (n, words) => {
    expect(numberInWords(n)).toBe(words);
  });

  test("CSH-028 amount in words: euros and cents", () => {
    expect(euroInWords(119_000)).toBe("eintausendeinhundertneunzig Euro");
    expect(euroInWords(100)).toBe("ein Euro");
    expect(euroInWords(2_105)).toBe("einundzwanzig Euro und fünf Cent");
    expect(euroInWords(1)).toBe("null Euro und ein Cent");
  });

  test("PAY-063 CSH-028 content: receipt number = payment reference, invoice reference, amount in figures and words", () => {
    const c = quittungContent({
      paymentId: "kd7abc123",
      date: "2026-10-13",
      amountCents: 119_000,
      payer: "Erika Beispiel",
      invoiceNumber: "RE-2026-0001",
      invoiceDate: "2026-10-09",
      company: { name: "Muster GmbH", address: "Hauptstr. 1, 10115 Berlin", city: "Berlin" },
    });
    expect(c.title).toBe("Quittung");
    expect(c.fileName).toBe("Quittung-RE-2026-0001-kd7abc123.pdf");
    expect(c.rows).toContainEqual(["Quittungsnummer", "kd7abc123"]);
    expect(c.rows).toContainEqual(["Betrag", "1.190,00 €"]);
    expect(c.rows).toContainEqual(["in Worten", "eintausendeinhundertneunzig Euro"]);
    expect(c.rows).toContainEqual(["Erhalten von", "Erika Beispiel"]);
    expect(c.rows).toContainEqual(["Verwendungszweck", "für Rechnung RE-2026-0001 vom 09.10.2026"]);
    expect(c.statement).toBe("Betrag bar erhalten.");
    expect(c.placeDate).toBe("Berlin, 13.10.2026");
    expect(c.note).toMatch(/keine Rechnung/);
  });
});
