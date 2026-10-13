import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../../test/fixtures/bank/load";
import { parseCamt053 } from "./camt053";

function parse(xml: string) {
  const r = parseCamt053(xml);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const doc = (version: string, entries: string, extra = "") => `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.${version}"><BkToCstmrStmt><Stmt><Id>X</Id>
<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>${extra}
${entries}</Stmt></BkToCstmrStmt></Document>`;

describe("CAMT.053 parser (BNK-033, BNK-120)", () => {
  test("T07-046 BNK-033 camt.053.001.02 Revolut month: balances, period, booked entries with signed amounts", () => {
    const st = parse(bankFixture(`${SYNTH}/eur-2026-10.camt053.xml`));
    expect(st.format).toBe("camt053");
    expect(st.iban).toBe("LT443250010000000101");
    expect(st.currency).toBe("EUR");
    expect(st.statementId).toBe("SYNTH-EUR-2026-10");
    expect(st.periodFrom).toBe("2026-10-01");
    expect(st.periodTo).toBe("2026-10-31");
    expect(st.periodStartUtc).toBe("2026-10-01T00:00:00Z");
    expect(st.openingBalanceCents).toBe(1_250_000);
    expect(st.closingBalanceCents).toBe(1_300_723);
    expect(st.balanceSource).toBe("statement");
    expect(st.transactions).toHaveLength(13);
    expect(st.issues).toEqual([]);
    const sum = st.transactions.reduce((a, t) => a + t.amountCents, 0);
    expect((st.openingBalanceCents ?? 0) + sum).toBe(st.closingBalanceCents);
  });

  test("BNK-120 incoming SEPA credit: debtor is the counterparty, remittance and end-to-end ID mapped", () => {
    const tx = parse(bankFixture(`${SYNTH}/eur-2026-10.camt053.xml`)).transactions[1];
    expect(tx).toMatchObject({
      bookingDate: "2026-10-02",
      valueDate: "2026-10-02",
      amountCents: 119_000,
      currency: "EUR",
      counterpartyName: "Mueller GmbH",
      counterpartyIban: "DE89370400440532013000",
      counterpartyBic: "COBADEFFXXX",
      counterpartySource: "statement",
      purpose: "RE-2026-0042",
      endToEndId: "E2E-MUELLER-0042",
      entryReference: "6a1f0c2e-0002-4c3b-9d10-000000000002",
      bankTransactionCode: "PMNT-RCDT-ESCT",
      proprietaryCode: "TRANSFER",
    });
  });

  test("T07-024 BNK-023 EC-145 card FX payment: entry amount includes the charge, fee and instructed amount kept", () => {
    const tx = parse(bankFixture(`${SYNTH}/eur-2026-10.camt053.xml`)).transactions[2];
    expect(tx).toMatchObject({
      amountCents: -5037,
      feeCents: 25,
      instructedAmount: { amountMinor: 5499, currency: "USD" },
      exchangeRate: "0.9114",
      counterpartyName: "Adobe Systems",
    });
  });

  test("EC-BNK-48 BNK-121 RvslInd entries are imported as negative counter-entries flagged as reversal", () => {
    const tx = parse(bankFixture(`${SYNTH}/eur-2026-10.camt053.xml`)).transactions[10];
    expect(tx).toMatchObject({ amountCents: -59_500, reversal: true, endToEndId: "E2E-BETA-0043" });
  });

  test("T07-046 camt.053.001.08: DtTm booking instants become Europe/Berlin dates (BNK-112, EC-155)", () => {
    const st = parse(bankFixture(`${SYNTH}/usd-2026-10.camt053.xml`));
    expect(st.currency).toBe("USD");
    expect(st.transactions.map((t) => [t.bookingDate, t.bookedAtRaw, t.amountCents])).toEqual([
      ["2026-10-12", "2026-10-12T11:00:00Z", 100_000],
      ["2026-10-25", "2026-10-25T18:05:00Z", -12_000],
    ]);
  });

  test("T07-046 EC-BNK-48 batch entries are split per TxDtls; Sts PDNG is skipped; RF reference kept structured", () => {
    const st = parse(bankFixture("generic/camt053-v08-batch.xml"));
    expect(st.openingBalanceCents).toBe(100_000);
    expect(st.closingBalanceCents).toBe(138_450);
    expect(st.transactions.map((t) => [t.amountCents, t.entryReference, t.counterpartyName])).toEqual([
      [10_000, "BATCH-7781-1", "Kunde Eins GmbH"],
      [15_000, "BATCH-7781-2", "Kunde Zwei"],
      [20_000, "BATCH-7781-3", "Kunde Drei KG"],
      [-6550, "DD-5521", "Telefon AG"],
    ]);
    expect(st.transactions[1]).toMatchObject({ reference: "RF18539007547034", purpose: "" });
    expect(st.transactions[1]?.endToEndId).toBeUndefined();
    expect(st.transactions[2]?.purpose).toBe("RE-2026-0102 und RE-2026-0103");
    expect(st.transactions[3]).toMatchObject({
      mandateRef: "MANDAT-42",
      creditorId: "DE98ZZZ09999999999",
      endToEndId: "INV-778899",
    });
    expect(st.skipped).toEqual([{ line: expect.any(Number), reason: "Status PDNG (nicht gebucht)" }]);
  });

  test("EC-BNK-23 an amount with too many decimals rejects only that entry with its line number", () => {
    const xml = doc(
      "02",
      `<Ntry><Amt Ccy="EUR">10.005</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-01</Dt></BookgDt></Ntry>
<Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-01</Dt></BookgDt></Ntry>`,
    );
    const st = parse(xml);
    expect(st.transactions.map((t) => t.amountCents)).toEqual([-500]);
    expect(st.issues).toEqual([
      { line: 4, code: "bank_amount_invalid", message: "Ungültiger Betrag in Bankdaten (10.005)." },
    ]);
  });

  test("EC-BNK-49 malformed XML and non-camt files are rejected with a line number", () => {
    const broken = parseCamt053('<?xml version="1.0"?>\n<Document>\n<BkToCstmrStmt>\n</Document>');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.message).toMatch(/^Die Datei konnte nicht gelesen werden \(Zeile \d+: .+\)\.$/);
    const pain = parseCamt053('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><X/></Document>');
    expect(pain.ok).toBe(false);
  });

  test("BNK-033 entries without booking date fall back to the value date; missing Sts is treated as booked (v02)", () => {
    const st = parse(
      doc("04", `<Ntry><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><ValDt><Dt>2026-10-03</Dt></ValDt></Ntry>`),
    );
    expect(st.transactions[0]).toMatchObject({ bookingDate: "2026-10-03", amountCents: 100 });
  });
});
