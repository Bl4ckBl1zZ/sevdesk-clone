import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../test/fixtures/bank/load";
import { detectStatementFormat, parseStatement } from "./statement";

describe("statement import entry point (MISC-02, F07 BNK-030/033)", () => {
  test("MISC-02 the same month as CAMT.053 (primary), MT940 and CSV is detected and yields the same bookings", () => {
    const files = {
      camt053: "eur-2026-10.camt053.xml",
      mt940: "eur-2026-10.mt940.txt",
      revolut_csv: "eur-2026-10.csv",
    } as const;
    const parsed = Object.entries(files).map(([format, file]) => {
      const text = bankFixture(`${SYNTH}/${file}`);
      expect(detectStatementFormat(text, file)).toBe(format);
      const r = parseStatement(text, { fileName: file });
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.format).toBe(format);
      return r.value;
    });
    const bookings = (s: (typeof parsed)[number]) =>
      s.transactions.map((t) => [t.bookingDate, t.amountCents]).sort((a, b) => String(a).localeCompare(String(b)));
    const [camt, mt940, csv] = parsed;
    if (!camt || !mt940 || !csv) throw new Error("missing statement");
    expect(camt.transactions.length).toBeGreaterThan(0);
    expect(bookings(mt940)).toEqual(bookings(camt));
    expect(camt.closingBalanceCents).toBe(mt940.closingBalanceCents);
    expect(csv.closingBalanceCents).toBe(camt.closingBalanceCents);
  });

  test("MISC-02 unknown formats (e.g. a pain.008 direct-debit file) are refused — SEPA mandates are deferred with F10", () => {
    const pain008 = '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08"><CstmrDrctDbtInitn/></Document>';
    expect(parseStatement("irgendein Text ohne Kopfzeile").ok).toBe(false);
    const r = parseStatement(pain008, { fileName: "lastschrift.txt" });
    expect(r.ok).toBe(false);
  });
});
