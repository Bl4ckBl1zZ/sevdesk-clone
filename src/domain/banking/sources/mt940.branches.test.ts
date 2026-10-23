import { describe, expect, test } from "vitest";
import { parseMt940 } from "./mt940";

function parse(text: string) {
  const r = parseMt940(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const errorOf = (text: string) => {
  const r = parseMt940(text);
  return r.ok ? null : r.error.message;
};
const IBAN = "DE89370400440532013000";

describe("MT940 parser — statement structure (BNK-033, BNK-035)", () => {
  test("BNK-033 several statements of one account: :28C: numbers join the id, the first opening and last closing count", () => {
    const st = parse(
      [
        `:20:STMT1`,
        `:25:${IBAN}`,
        `:28C:00001/001`,
        `:60F:C261001EUR100,00`,
        `:61:2610011001C10,00NTRFNONREF`,
        `:62M:C261001EUR110,00`,
        `:20:STMT2`,
        `:25:${IBAN}`,
        `:60M:C261001EUR110,00`,
        `:61:2610021002D5,50NTRFNONREF`,
        `:62F:D261002EUR104,50`,
      ].join("\n"),
    );
    expect(st.statementId).toBe("STMT1 00001/001");
    expect(st.openingBalanceCents).toBe(10_000);
    // A debit closing balance is negative (overdraft).
    expect(st.closingBalanceCents).toBe(-10_450);
    expect(st.balanceSource).toBe("statement");
    expect(st.transactions.map((t) => t.amountCents)).toEqual([1_000, -550]);
  });

  test("BNK-033 a file with statements of two accounts, without :25: or with unreadable balances is refused", () => {
    expect(errorOf(`:20:A\n:25:${IBAN}\n:20:B\n:25:DE02120300000000202051\n`)).toContain(
      "die Datei enthält Kontoauszüge mehrerer Konten",
    );
    expect(errorOf(`:20:A\n:61:2610011001C1,00NTRFNONREF\n`)).toContain("Felder :20: und :25: fehlen");
    expect(errorOf(`:20:A\n:25:${IBAN}\n:60F:C26AB01EUR1,00\n`)).toContain(
      "Anfangssaldo nicht lesbar (C26AB01EUR1,00)",
    );
    expect(errorOf(`:20:A\n:25:${IBAN}\n:60F:C261301EUR1,00\n`)).toContain("Anfangssaldo nicht lesbar");
    expect(errorOf(`:20:A\n:25:${IBAN}\n:60F:C261001EUR1,00\n:62F:C261001EUR1,005\n`)).toContain(
      "Endsaldo nicht lesbar (C261001EUR1,005)",
    );
  });

  test("BNK-035 without balances the statement has no balance source; the currency defaults to EUR", () => {
    const st = parse(`:20:A\n:25:37040044/0532013000\n:61:9912311231C1,00NTRFNONREF\n:61:2610011001C2,00NTRFNONREF\n`);
    expect(st.balanceSource).toBe("none");
    expect(st.iban).toBeUndefined();
    expect(st.currency).toBeUndefined();
    expect(st.transactions.map((t) => [t.bookingDate, t.currency])).toEqual([
      ["1999-12-31", "EUR"],
      ["2026-10-01", "EUR"],
    ]);
    expect(st.periodFrom).toBe("1999-12-31");
    expect(st.periodTo).toBe("2026-10-01");
  });
});

describe("MT940 parser — :61: lines (BNK-033, EC-BNK-49)", () => {
  test("EC-BNK-49 an unreadable :61: line and an impossible value date are reported per row", () => {
    const st = parse(
      `:20:A\n:25:${IBAN}\n:60F:C261001EUR0,00\n:61:kaputt\n:61:2613011001C1,00NTRFNONREF\n:62F:C261001EUR0,00\n`,
    );
    expect(st.transactions).toEqual([]);
    expect(st.issues).toEqual([
      { line: 4, code: "bank_line_invalid", message: "Umsatzzeile nicht lesbar (:61:kaputt)." },
      { line: 5, code: "bank_date_invalid", message: "Ungültiges Datum (261301)." },
    ]);
  });

  test("BNK-033 the entry date wraps back a year (value 1 January, booked 31 December); an invalid entry date is ignored", () => {
    const st = parse(
      `:20:A\n:25:${IBAN}\n:61:2701011231C1,00NTRFNONREF\n:61:2610011340C1,00NTRFNONREF\n:61:2610011003RD2,00NTRFNONREF\n`,
    );
    expect(st.transactions.map((t) => [t.valueDate, t.bookingDate])).toEqual([
      ["2027-01-01", "2026-12-31"],
      ["2026-10-01", "2026-10-01"],
      ["2026-10-01", "2026-10-03"],
    ]);
    // RD = reversal of a debit → positive counter-entry.
    expect(st.transactions[2]).toMatchObject({ amountCents: 200, reversal: true });
  });

  test("BNK-033 without :86: the supplementary details line of :61: is the purpose; customer reference as end-to-end ID", () => {
    const st = parse(`:20:A\n:25:${IBAN}\n:61:2610011001C12,34NTRFKD-REF-1//BANK-9\nZahlung   Rechnung 4711\n`);
    expect(st.transactions[0]).toMatchObject({
      purpose: "Zahlung Rechnung 4711",
      endToEndId: "KD-REF-1",
      bankRef: "BANK-9",
      entryReference: "BANK-9",
    });
    expect(JSON.parse(st.transactions[0]?.raw ?? "{}")).not.toHaveProperty(":86:");
  });
});

describe("MT940 parser — :86: purpose (BNK-033, BNK-120)", () => {
  test("BNK-120 an unstructured, hard-wrapped :86: is joined and whitespace-normalised", () => {
    const st = parse(`:20:A\n:25:${IBAN}\n:61:2610011001C1,00NTRFNONREF\n:86:Miete Oktober   Wohnung\n 3 links\n`);
    expect(st.transactions[0]?.purpose).toBe("Miete Oktober Wohnung 3 links");
    expect(st.transactions[0]).not.toHaveProperty("counterpartySource");
  });

  test("BNK-120 structured :86: without SEPA tags uses ?20–?29; text before the first tag is the purpose without SVWZ", () => {
    const plain = parse(
      `:20:A\n:25:${IBAN}\n:61:2610011001C1,00NTRFNONREF\n:86:051?00UEBERWEISUNG?20Rechnung 12?21 vom 1.10.\n`,
    );
    expect(plain.transactions[0]).toMatchObject({ purpose: "Rechnung 12 vom 1.10.", bankTransactionCode: "051" });
    expect(plain.transactions[0]).not.toHaveProperty("counterpartyName");
    const prefixed = parse(
      `:20:A\n:25:${IBAN}\n:61:2610011001C1,00NTRFNONREF\n:86:166?00GUTSCHRIFT?20Abo Oktober EREF+E2E-1 IBAN+DE02 1203 0000 0000 2020 51\n`,
    );
    expect(prefixed.transactions[0]).toMatchObject({
      purpose: "Abo Oktober",
      endToEndId: "E2E-1",
      counterpartyIban: "DE02120300000000202051",
      counterpartySource: "statement",
    });
    // NOTPROVIDED references are no references.
    const notProvided = parse(
      `:20:A\n:25:${IBAN}\n:61:2610011001C1,00NTRFNONREF\n:86:166?20EREF+NOTPROVIDED SVWZ+Test\n`,
    );
    expect(notProvided.transactions[0]).toMatchObject({ purpose: "Test" });
    expect(notProvided.transactions[0]).not.toHaveProperty("endToEndId");
  });
});
