import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../../test/fixtures/bank/load";
import { parseCamt053 } from "./camt053";
import { mapRevolutHeaders, parseRevolutCsv, REVOLUT_CSV_MAPPING } from "./revolut-csv";

function parse(text: string, currency?: string) {
  const r = parseRevolutCsv(text, currency ? { currency } : {});
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const HEADER =
  "Date started (UTC),Date completed (UTC),ID,Type,Description,Reference,Payer,Card number,Orig currency,Orig amount,Payment currency,Amount,Fee,Balance";

describe("Revolut CSV parser (BNK-032)", () => {
  test("T07-045 BNK-032 three header variants of the same month yield the same bookings", () => {
    const variants = ["eur-2026-10.csv", "eur-2026-10.variant-b.csv", "eur-2026-10.variant-c.csv"].map((f) =>
      parse(bankFixture(`${SYNTH}/${f}`)),
    );
    const key = (s: ReturnType<typeof parse>) =>
      s.transactions.map((t) => [t.providerTransactionId, t.bookingDate, t.amountCents, t.feeCents ?? 0]);
    expect(key(variants[1] as ReturnType<typeof parse>)).toEqual(key(variants[0] as ReturnType<typeof parse>));
    expect(key(variants[2] as ReturnType<typeof parse>)).toEqual(key(variants[0] as ReturnType<typeof parse>));
    for (const v of variants) {
      expect(v.transactions).toHaveLength(13);
      expect(v.openingBalanceCents).toBe(1_250_000);
      expect(v.closingBalanceCents).toBe(1_300_723);
      expect(v.balanceSource).toBe("row_balances");
      expect(v.currency).toBe("EUR");
    }
  });

  test("BNK-032 only completed rows are imported; the pending row of variant C is reported as skipped", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.variant-c.csv`));
    expect(st.skipped).toEqual([{ line: 15, reason: "Status PENDING (nicht abgeschlossen)" }]);
  });

  test("T07-022 EC-155 BNK-112 „Date completed (UTC)“ is converted to the Europe/Berlin booking date", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.csv`));
    const last = st.transactions[12];
    expect(last).toMatchObject({ bookingDate: "2026-11-01", bookedAtRaw: "2026-10-31T23:30:00Z" });
    const dst = parse(
      `${HEADER}\n2026-03-28 23:00:00,2026-03-28 23:30:00,X1,CARD_PAYMENT,Shop,,,,EUR,-1.00,EUR,-1.00,0.00,9.00\n`,
    );
    expect(dst.transactions[0]?.bookingDate).toBe("2026-03-29");
    const summer = parse(
      `${HEADER}\n2026-07-31 21:00:00,2026-07-31 22:30:00,X2,CARD_PAYMENT,Shop,,,,EUR,-1.00,EUR,-1.00,0.00,9.00\n`,
    );
    expect(summer.transactions[0]?.bookingDate).toBe("2026-08-01");
  });

  test("T07-022 local-time columns are taken as Europe/Berlin dates and their UTC instant is kept", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.variant-c.csv`));
    expect(st.transactions[12]).toMatchObject({ bookingDate: "2026-11-01", bookedAtRaw: "2026-10-31T23:30:00Z" });
  });

  test("T07-024 BNK-023 EC-145 the fee is part of the account movement; balances verify the mapper constant", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.csv`));
    expect(st.transactions[2]).toMatchObject({
      amountCents: -5037,
      feeCents: 25,
      instructedAmount: { amountMinor: 5499, currency: "USD" },
      merchantName: "Adobe Systems",
      proprietaryCode: "CARD_PAYMENT",
    });
    expect(st.feeSemantics).toEqual({ amountIncludesFee: false, verifiedBy: "balance" });
    expect(REVOLUT_CSV_MAPPING.amountIncludesFee).toBe(false);
  });

  test("T07-024 EC-145 a file whose balances prove that Amount already includes the fee is mapped accordingly", () => {
    const csv = `${HEADER}\n2026-10-04 10:00:00,2026-10-04 10:00:00,F0,CARD_PAYMENT,Shop,,,,EUR,-9.63,EUR,-9.63,0.00,990.37\n2026-10-05 14:29:00,2026-10-05 14:30:00,F1,CARD_PAYMENT,Adobe,,,,USD,-54.99,EUR,-50.37,0.25,940.00\n`;
    const st = parse(csv);
    expect(st.feeSemantics).toEqual({ amountIncludesFee: true, verifiedBy: "balance" });
    expect(st.transactions[1]).toMatchObject({ amountCents: -5037, feeCents: 25 });
  });

  test("BNK-120 counterparties: payer for credits, beneficiary IBAN and description for transfers", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.csv`));
    expect(st.transactions[1]).toMatchObject({
      counterpartyName: "Mueller GmbH",
      counterpartySource: "statement",
      purpose: "RE-2026-0042",
      providerTransactionId: "6a1f0c2e-0002-4c3b-9d10-000000000002",
    });
    expect(st.transactions[7]).toMatchObject({
      counterpartyName: "Hausverwaltung Schmidt",
      counterpartySource: "description",
      counterpartyIban: "DE44500105175407324931",
      counterpartyBic: "INGDDEFFXXX",
      purpose: "Miete Oktober 2026",
    });
    expect(st.transactions[10]).toMatchObject({ reversal: true, amountCents: -59_500 });
  });

  test("T07-023 BNK-120 the CSV and the CAMT.053 of the same month describe the same bookings", () => {
    const csv = parse(bankFixture(`${SYNTH}/eur-2026-10.csv`)).transactions;
    const camtR = parseCamt053(bankFixture(`${SYNTH}/eur-2026-10.camt053.xml`));
    if (!camtR.ok) throw new Error(camtR.error.message);
    const camt = camtR.value.transactions;
    expect(csv.map((t) => [t.providerTransactionId, t.amountCents, t.feeCents ?? 0])).toEqual(
      camt.map((t) => [t.entryReference, t.amountCents, t.feeCents ?? 0]),
    );
  });

  test("BNK-032 repeated IDs inside one file get an occurrence suffix; unknown columns are ignored", () => {
    const csv = `${HEADER},Something new\n2026-10-01 10:00:00,2026-10-01 10:00:00,DUP,FEE,Fee,,,,EUR,-1.00,EUR,-1.00,0.00,9.00,x\n2026-10-01 10:00:00,2026-10-01 10:00:00,DUP,FEE,Fee,,,,EUR,-1.00,EUR,-1.00,0.00,8.00,y\n`;
    const st = parse(csv);
    expect(st.transactions.map((t) => t.providerTransactionId)).toEqual(["DUP", "DUP#2"]);
  });

  test("EC-BNK-49 EC-BNK-23 missing required columns make the file unreadable; a bad amount rejects one row", () => {
    const bad = parseRevolutCsv("Foo,Bar\n1,2\n", {});
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.error.message).toBe(
        "Die Datei konnte nicht gelesen werden (Zeile 1: Pflichtspalten fehlen: Datum (abgeschlossen), Betrag).",
      );
    const st = parse(`${HEADER}\n2026-10-01 10:00:00,2026-10-01 10:00:00,A,FEE,Fee,,,,EUR,-1.005,EUR,-1.005,0.00,\n`);
    expect(st.issues).toEqual([
      { line: 2, code: "bank_amount_invalid", message: "Ungültiger Betrag in Bankdaten (-1.005)." },
    ]);
  });

  test("BNK-032 mapping is header-driven and marks unconfirmed columns UNSURE", () => {
    const m = mapRevolutHeaders(["date completed (utc)", "Amount", "ID", "Payment currency"]);
    expect(m.columns.dateCompletedUtc).toBe(0);
    expect(m.columns.amount).toBe(1);
    expect(REVOLUT_CSV_MAPPING.columns.find((c) => c.key === "state")?.unsure).toBe(true);
  });
});
