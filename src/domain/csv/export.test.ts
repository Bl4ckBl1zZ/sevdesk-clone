import { describe, expect, test } from "vitest";
import { computeOpenItems, openItemsCsv } from "../payments/open-items";
import { parseCsv } from "./csv";
import { csvFileName, formatCsv, formatTextCsv, neutraliseFormula } from "./export";
import { DOCUMENT_COLUMNS, type DocumentCsvRow, JOURNAL_COLUMNS } from "./lists";

const doc: DocumentCsvRow = {
  id: "k57abc",
  type: "invoice",
  typeLabel: "Rechnung",
  number: "RE-1001",
  contactName: '=HYPERLINK("http://x","klick")',
  documentDate: "2026-10-12",
  dueDate: "2026-11-11",
  netCents: 100_000,
  vatCents: 19_000,
  grossCents: 119_000,
  openCents: -500,
  currency: "EUR",
  status: "Offen",
};

describe("list CSV export (F09 EXP-021, EXP-022)", () => {
  test("EXP-021 „CSV (Excel)“: BOM, ;, decimal comma, DD.MM.YYYY, euros, no IDs", () => {
    const csv = formatCsv(DOCUMENT_COLUMNS, [doc], "excel");
    expect(csv.startsWith("﻿Art;Nummer;Kunde;Datum;")).toBe(true);
    const [, row] = parseCsv(csv.slice(1), ";");
    expect(row).toEqual([
      "Rechnung",
      "RE-1001",
      `'=HYPERLINK("http://x","klick")`,
      "12.10.2026",
      "11.11.2026",
      "1000,00",
      "190,00",
      "1190,00",
      "-5,00",
      "EUR",
      "Offen",
    ]);
    expect(csv).not.toContain("k57abc");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  test("EXP-021 „CSV (technisch)“: no BOM, comma, ISO dates, *_cents integers, IDs included", () => {
    const csv = formatCsv(DOCUMENT_COLUMNS, [doc], "technical");
    expect(csv.startsWith("id,type,number,contact_name,document_date,due_date,net_cents")).toBe(true);
    const [, row] = parseCsv(csv, ",");
    expect(row?.slice(0, 2)).toEqual(["k57abc", "Rechnung"]);
    expect(row?.slice(4, 10)).toEqual(["2026-10-12", "2026-11-11", "100000", "19000", "119000", "-500"]);
    expect(formatCsv(JOURNAL_COLUMNS, [], "technical")).toContain("debit_cents,credit_cents");
    expect(csvFileName("dokumente", "technical", "2026-10-12")).toBe("dokumente-2026-10-12-technisch.csv");
  });

  test("EXP-022 TST-EXP-19 E-EXP-35 formula characters are neutralised in the Excel variant, including the OPOS list", () => {
    for (const v of ["=1+1", "+49 123", "-x", "@SUM(A1)", "\tTab", "\rCR"]) expect(neutraliseFormula(v)).toBe(`'${v}`);
    expect(neutraliseFormula("Müller GmbH")).toBe("Müller GmbH");
    const text = formatTextCsv(
      [
        ["Kontaktnummer", "Name"],
        ["10000", '=HYPERLINK("http://evil")'],
      ],
      "excel",
    );
    expect(text).toContain(`;"'=HYPERLINK(""http://evil"")"`);
    expect(formatTextCsv([["Straße & Nr."]], "technical")).toBe("strasse_nr\r\n");

    const opos = openItemsCsv(
      computeOpenItems({
        documents: [
          {
            id: "1",
            kind: "salesDocument",
            number: "RE-1",
            contactId: "c",
            contactName: "=cmd|' /C calc'!A0",
            documentDate: "2026-08-01",
            dueDate: "2026-08-29",
            payableCents: 119_000,
            currency: "EUR",
          },
        ],
        rows: [],
        asOf: "2026-10-13",
      }),
    );
    expect(opos).toContain(`RE-1;'=cmd|' /C calc'!A0;01.08.2026`);
  });
});
