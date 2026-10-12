import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../../test/fixtures/bank/load";
import { parseMt940 } from "./mt940";

function parse(text: string) {
  const r = parseMt940(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("MT940 parser (BNK-033)", () => {
  test("T07-047 German :86: subfields: SVWZ+, EREF+, MREF+, CRED+, name (?32/?33) and IBAN (?31)", () => {
    const st = parse(bankFixture("generic/mt940-structured-86.sta"));
    expect(st.format).toBe("mt940");
    expect(st.currency).toBe("EUR");
    expect(st.openingBalanceCents).toBe(100_000);
    expect(st.closingBalanceCents).toBe(95_010);
    expect(st.periodTo).toBe("2026-10-03");
    expect(st.transactions[0]).toMatchObject({
      bookingDate: "2026-10-01",
      valueDate: "2026-10-01",
      amountCents: 25_000,
      purpose: "Rechnung RE-2026-0201 vom 10.09.2026",
      endToEndId: "E2E-KUNDE-77",
      counterpartyName: "Kunde Sieben GmbH",
      counterpartyIban: "DE44500105175407324931",
      counterpartyBic: "COBADEFFXXX",
      entryReference: "8420610011234",
      bankTransactionCode: "166",
      proprietaryCode: "NMSC",
    });
    expect(st.transactions[1]).toMatchObject({
      amountCents: -4990,
      mandateRef: "MANDAT-0815",
      creditorId: "DE98ZZZ09999999999",
      counterpartyName: "Stadtwerke Musterhausen GmbH",
      purpose: "Rechnung 998877 Strom",
    });
  });

  test("EC-BNK-48 BNK-121 RC (reversal of a credit) is a negative counter-entry flagged as reversal", () => {
    const st = parse(bankFixture("generic/mt940-structured-86.sta"));
    expect(st.transactions[2]).toMatchObject({ amountCents: -25_000, reversal: true, endToEndId: "E2E-KUNDE-77" });
    const sum = st.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect((st.openingBalanceCents ?? 0) + sum).toBe(st.closingBalanceCents);
  });

  test("T07-047 Revolut MT940 (SWIFT envelope, IBAN + currency in :25:, unstructured :86:)", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.mt940.txt`));
    expect(st.iban).toBe("LT443250010000000101");
    expect(st.transactions).toHaveLength(13);
    expect(st.transactions[1]).toMatchObject({
      amountCents: 119_000,
      purpose: "Mueller GmbH / Ref: RE-2026-0042 / IBAN: DE89370400440532013000",
    });
    expect(st.transactions[1]?.entryReference).toBeUndefined();
    expect(st.closingBalanceCents).toBe(1_300_723);
  });

  test("BNK-033 booking date (entry date MMDD) wraps the year against the value date", () => {
    const st = parse(
      `:20:X\n:25:DE89370400440532013000\n:60F:C261231EUR0,00\n:61:2612310102C1,00NTRFNONREF\n:86:x\n:62F:C270102EUR1,00\n`,
    );
    expect(st.transactions[0]).toMatchObject({ valueDate: "2026-12-31", bookingDate: "2027-01-02" });
  });

  test("EC-BNK-23 EC-BNK-49 invalid amounts are rejected per row; a file without :20:/:61: is unreadable", () => {
    const st = parse(
      `:20:X\n:25:DE89370400440532013000\n:60F:C261001EUR0,00\n:61:2610011001C1,005NTRFNONREF\n:62F:C261001EUR0,00\n`,
    );
    expect(st.transactions).toEqual([]);
    expect(st.issues).toEqual([
      { line: 4, code: "bank_amount_invalid", message: "Ungültiger Betrag in Bankdaten (1,005)." },
    ]);
    const bad = parseMt940("hello world");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/^Die Datei konnte nicht gelesen werden \(Zeile 1: /);
  });
});
