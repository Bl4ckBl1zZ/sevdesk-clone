import { describe, expect, test } from "vitest";
import { mapRevolutHeaders, parseRevolutCsv } from "./revolut-csv";

function parse(text: string, options: { currency?: string } = {}) {
  const r = parseRevolutCsv(text, options);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("Revolut CSV — columns and dates (BNK-032, BNK-112)", () => {
  test("BNK-032 an empty file is unreadable", () => {
    const r = parseRevolutCsv("", {});
    expect(r.ok ? null : r.error.message).toBe("Die Datei konnte nicht gelesen werden (Zeile 1: die Datei ist leer).");
  });

  test("BNK-112 without a completed column the start date is used (UTC column, then local column with its zone)", () => {
    const utc = parse("Date started (UTC),Amount,Description\n2026-10-31 23:30:00,10.00,Kunde A\n", {
      currency: "EUR",
    });
    expect(utc.transactions[0]).toMatchObject({ bookingDate: "2026-11-01", amountCents: 1_000, currency: "EUR" });
    const local = parse("Date started (Europe/Berlin),Amount\n2026-10-31 23:30:00,10.00\n");
    expect(local.transactions[0]?.bookingDate).toBe("2026-10-31");
    expect(mapRevolutHeaders(["Date started (Europe/Berlin)", "Amount"]).localZone).toBe("Europe/Berlin");
  });

  test("BNK-032 rows with an empty completed date are skipped; an unreadable date is reported per row", () => {
    const st = parse("Date completed (UTC),Amount\n,5.00\nmorgen,5.00\n2026-10-02 08:00:00,5.00\n");
    expect(st.skipped).toEqual([{ line: 2, reason: "ohne Abschlussdatum (nicht abgeschlossen)" }]);
    expect(st.issues).toEqual([
      { line: 3, code: "bank_date_invalid", message: "Ungültiges Datum in Bankdaten (morgen)." },
    ]);
    expect(st.transactions).toHaveLength(1);
  });

  test("BNK-032 „Total amount“ alone is the movement; without a currency column the option (else EUR) applies", () => {
    const st = parse("Date completed (UTC),Total amount\n2026-10-02 08:00:00,-12.50\n", { currency: "usd" });
    expect(st.transactions[0]).toMatchObject({ amountCents: -1_250, currency: "USD" });
    expect(st.currency).toBe("USD");
    expect(parse("Date completed (UTC),Amount\n2026-10-02 08:00:00,1.00\n").transactions[0]?.currency).toBe("EUR");
  });

  test("BNK-032 rows are put in chronological order; equal instants keep the file order", () => {
    const st = parse(
      "Date completed (UTC),Amount,ID\n2026-10-03 08:00:00,3.00,C\n2026-10-01 08:00:00,1.00,A\n2026-10-03 08:00:00,4.00,D\n",
    );
    expect(st.transactions.map((t) => t.providerTransactionId)).toEqual(["A", "C", "D"]);
    expect(st).toMatchObject({ periodFrom: "2026-10-01", periodTo: "2026-10-03" });
  });
});

describe("Revolut CSV — fees and balances (BNK-023, BNK-035, EC-145)", () => {
  const H = "Date completed (UTC),Amount,Fee,Fee currency,Total amount,Balance";

  test("EC-145 an unreadable fee or total rejects the row; a fee in another currency is ignored", () => {
    const st = parse(
      `${H}\n2026-10-01 08:00:00,-10.00,x,,,\n2026-10-01 09:00:00,-10.00,,,-10.005,\n2026-10-01 10:00:00,-10.00,1.00,USD,,\n`,
    );
    expect(st.issues.map((i) => [i.line, i.code])).toEqual([
      [2, "bank_amount_invalid"],
      [3, "bank_amount_invalid"],
    ]);
    expect(st.transactions[0]).toMatchObject({ amountCents: -1_000 });
    expect(st.transactions[0]).not.toHaveProperty("feeCents");
  });

  test("BNK-035 an unreadable row balance means no balances for the file", () => {
    const st = parse(`${H}\n2026-10-01 08:00:00,10.00,,,,abc\n2026-10-01 09:00:00,5.00,,,,15.00\n`);
    expect(st.balanceSource).toBe("none");
    expect(st).not.toHaveProperty("openingBalanceCents");
    expect(st.transactions[0]).not.toHaveProperty("balanceAfterCents");
    expect(st.transactions[1]?.balanceAfterCents).toBe(1_500);
  });

  test("EC-145 fees whose balances fit neither reading keep the mapper constant (amount excludes the fee)", () => {
    const st = parse(`${H}\n2026-10-01 08:00:00,-10.00,1.00,,,50.00\n2026-10-01 09:00:00,-10.00,1.00,,,10.00\n`);
    expect(st.feeSemantics).toEqual({ amountIncludesFee: false, verifiedBy: "mapper_constant" });
    expect(st.transactions[0]).toMatchObject({ amountCents: -1_100, feeCents: 100 });
  });
});

describe("Revolut CSV — counterparties and purpose (BNK-120)", () => {
  const H = "Date completed (UTC),Amount,Type,Description,Reference,Payer,Orig currency,Orig amount";

  test("BNK-120 a credit without payer is named by the description; transfers drop the „To“ prefix; fees have no name", () => {
    const st = parse(
      `${H}\n2026-10-01 08:00:00,10.00,TRANSFER,Kunde A,,,,\n2026-10-01 09:00:00,-5.00,TRANSFER,To Max Muster,Miete,,,\n2026-10-01 10:00:00,-1.00,FEE,Monatsgebühr,,,,\n2026-10-01 11:00:00,-2.00,TRANSFER,,,,,\n`,
    );
    expect(st.transactions.map((t) => [t.counterpartyName, t.counterpartySource, t.purpose])).toEqual([
      ["Kunde A", "description", "Kunde A"],
      ["Max Muster", "description", "Miete"],
      [undefined, undefined, "Monatsgebühr"],
      [undefined, undefined, ""],
    ]);
  });

  test("BNK-120 an unreadable original amount gives no instructed amount; the same currency neither", () => {
    const st = parse(
      `${H}\n2026-10-01 08:00:00,-10.00,CARD_PAYMENT,Shop,,,USD,abc\n2026-10-01 09:00:00,-10.00,CARD_PAYMENT,Shop,,,EUR,10.00\n2026-10-01 10:00:00,-10.00,CARD_PAYMENT,Shop,,,USD,11.00\n`,
    );
    expect(st.transactions[0]).not.toHaveProperty("instructedAmount");
    expect(st.transactions[1]).not.toHaveProperty("instructedAmount");
    expect(st.transactions[2]?.instructedAmount).toEqual({ amountMinor: 1_100, currency: "USD" });
    expect(st.transactions[2]?.merchantName).toBe("Shop");
  });
});
