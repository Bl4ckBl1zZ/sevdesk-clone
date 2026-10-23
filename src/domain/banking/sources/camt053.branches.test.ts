import { describe, expect, test } from "vitest";
import { parseCamt053 } from "./camt053";

function parse(xml: string) {
  const r = parseCamt053(xml);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const errorOf = (xml: string) => {
  const r = parseCamt053(xml);
  return r.ok ? null : r.error.message;
};

const NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08";
const acct = (iban = "DE89370400440532013000") => `<Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>`;
const stmt = (body: string, iban?: string) => `<Stmt><Id>S</Id>${acct(iban)}${body}</Stmt>`;
const file = (...stmts: string[]) =>
  `<?xml version="1.0"?>\n<Document xmlns="${NS}"><BkToCstmrStmt>${stmts.join("\n")}</BkToCstmrStmt></Document>`;
const bal = (cd: string, amount: string, ind = "CRDT", date = "2026-10-01") =>
  `<Bal><Tp><CdOrPrtry><Cd>${cd}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
const ntry = (inner: string, amount = "10.00", ind = "CRDT") =>
  `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>${inner}</Ntry>`;
const booked = (d = "2026-10-02") => `<BookgDt><Dt>${d}</Dt></BookgDt>`;

describe("CAMT.053 parser — statements and balances (BNK-033, BNK-035)", () => {
  test("BNK-033 a file without statement or with statements of two accounts is refused", () => {
    expect(errorOf(file())).toContain("kein Kontoauszug (Stmt) enthalten");
    expect(errorOf(file(stmt(""), stmt("", "DE02120300000000202051")))).toContain(
      "die Datei enthält Kontoauszüge mehrerer Konten",
    );
  });

  test("BNK-035 an unreadable balance amount makes the file unreadable; balances without type are ignored", () => {
    expect(errorOf(file(stmt(bal("OPBD", "1.005"))))).toContain("1.005");
    const st = parse(
      file(
        stmt(
          `<Bal><Amt Ccy="EUR">5.00</Amt></Bal>${bal("PRCD", "100.00")}${bal("CLBD", "20.00", "DBIT", "2026-10-31")}`,
        ),
      ),
    );
    // PRCD (previous closing) is the opening when OPBD is missing; a DBIT balance is negative.
    expect(st).toMatchObject({
      openingBalanceCents: 10_000,
      closingBalanceCents: -2_000,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      balanceSource: "statement",
    });
  });

  test("BNK-033 several statements of one account: opening and period start from the first, closing and end from the last", () => {
    const st = parse(
      file(
        stmt(
          `<FrToDt><FrDtTm>2026-10-01T00:00:00+02:00</FrDtTm><ToDtTm>2026-10-15T23:59:59+02:00</ToDtTm></FrToDt>${bal("OPBD", "100.00")}${bal("CLBD", "110.00", "CRDT", "2026-10-15")}${ntry(booked("2026-10-02"))}`,
        ),
        stmt(
          `<FrToDt><FrDtTm>2026-10-16T00:00:00+02:00</FrDtTm><ToDtTm>2026-10-31T23:59:59+01:00</ToDtTm></FrToDt>${bal("OPBD", "110.00", "CRDT", "2026-10-16")}${bal("CLBD", "105.00", "CRDT", "2026-10-31")}${ntry(booked("2026-10-20"), "5.00", "DBIT")}`,
        ),
      ),
    );
    expect(st).toMatchObject({
      openingBalanceCents: 10_000,
      closingBalanceCents: 10_500,
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      periodStartUtc: "2026-10-01T00:00:00+02:00",
      periodEndUtc: "2026-10-31T23:59:59+01:00",
    });
    expect(st.transactions.map((t) => t.amountCents)).toEqual([1_000, -500]);
  });

  test("BNK-035 without balances and period the period comes from the bookings; a statement without IBAN has none", () => {
    const xml = `<?xml version="1.0"?>\n<Document xmlns="${NS}"><BkToCstmrStmt><Stmt><Id>S</Id><Acct><Id><Othr><Id>123</Id></Othr></Id></Acct>${ntry(booked("2026-10-05"))}${ntry(booked("2026-10-02"))}</Stmt></BkToCstmrStmt></Document>`;
    const st = parse(xml);
    expect(st).toMatchObject({ periodFrom: "2026-10-02", periodTo: "2026-10-05", balanceSource: "none" });
    expect(st).not.toHaveProperty("iban");
  });
});

describe("CAMT.053 parser — entries (BNK-033, BNK-112, EC-BNK-49)", () => {
  test("EC-BNK-49 an entry without amount or without any date is reported, the rest is imported", () => {
    const st = parse(file(stmt(`<Ntry><CdtDbtInd>CRDT</CdtDbtInd>${booked()}</Ntry>\n${ntry("")}\n${ntry(booked())}`)));
    expect(st.issues.map((i) => [i.code, i.message])).toEqual([
      ["bank_amount_invalid", "Ungültiger Betrag in Bankdaten (leer)."],
      ["bank_date_invalid", "Buchungsdatum fehlt."],
    ]);
    expect(st.transactions).toHaveLength(1);
  });

  test("BNK-112 a DtTm without offset is read as UTC and converted to the Europe/Berlin date", () => {
    const st = parse(file(stmt(ntry("<BookgDt><DtTm>2026-10-31T23:30:00</DtTm></BookgDt>"))));
    expect(st.transactions[0]).toMatchObject({ bookingDate: "2026-11-01", bookedAtRaw: "2026-10-31T23:30:00Z" });
    const bad = parse(file(stmt(ntry("<BookgDt><DtTm>kein Datum</DtTm></BookgDt><ValDt><Dt>2026-10-04</Dt></ValDt>"))));
    expect(bad.transactions[0]?.bookingDate).toBe("2026-10-04");
  });

  test("BNK-023 charges: records in another currency are ignored; charges without records count directly", () => {
    const withRecords = parse(
      file(
        stmt(
          ntry(
            `${booked()}<Chrgs><Rcrd><Amt Ccy="EUR">1.50</Amt></Rcrd><Rcrd><Amt Ccy="USD">2.00</Amt></Rcrd><Rcrd><Amt Ccy="EUR">abc</Amt></Rcrd></Chrgs>`,
            "20.00",
            "DBIT",
          ),
        ),
      ),
    );
    expect(withRecords.transactions[0]?.feeCents).toBe(150);
    const direct = parse(file(stmt(ntry(`${booked()}<Chrgs><Amt Ccy="EUR">0.75</Amt></Chrgs>`, "20.00", "DBIT"))));
    expect(direct.transactions[0]?.feeCents).toBe(75);
    const foreignOnly = parse(file(stmt(ntry(`${booked()}<Chrgs><Amt Ccy="USD">0.75</Amt></Chrgs>`, "20.00", "DBIT"))));
    expect(foreignOnly.transactions[0]).not.toHaveProperty("feeCents");
  });

  test("BNK-033 batch split: parts without own reference get „<entry ref>/<n>“, without entry ref none", () => {
    const tx = (amount: string, name: string) =>
      `<TxDtls><Amt Ccy="EUR">${amount}</Amt><RltdPties><Dbtr><Pty><Nm>${name}</Nm></Pty></Dbtr></RltdPties></TxDtls>`;
    const batch = (ref: string) =>
      file(stmt(ntry(`${booked()}${ref}<NtryDtls>${tx("6.00", "A")}${tx("4.00", "B")}</NtryDtls>`)));
    const withRef = parse(batch("<AcctSvcrRef>REF-9</AcctSvcrRef>"));
    expect(withRef.transactions.map((t) => [t.amountCents, t.entryReference, t.counterpartyName])).toEqual([
      [600, "REF-9/1", "A"],
      [400, "REF-9/2", "B"],
    ]);
    const without = parse(batch(""));
    expect(without.transactions.map((t) => t.entryReference)).toEqual([undefined, undefined]);
  });

  test("BNK-120 the instructed amount is kept only when it is in another currency; Ultimate debtor as fallback name", () => {
    const st = parse(
      file(
        stmt(
          ntry(
            `${booked()}<NtryDtls><TxDtls><AmtDtls><InstdAmt><Amt Ccy="EUR">10.00</Amt></InstdAmt></AmtDtls><RltdPties><UltmtDbtr><Nm>Endkunde</Nm></UltmtDbtr></RltdPties></TxDtls></NtryDtls>`,
          ),
        ),
      ),
    );
    expect(st.transactions[0]).not.toHaveProperty("instructedAmount");
    expect(st.transactions[0]?.counterpartyName).toBe("Endkunde");
  });
});
