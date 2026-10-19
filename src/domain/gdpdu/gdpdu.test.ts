import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { decodeCp1252, encodeCp1252 } from "../csv/cp1252";
import { addressLine, buchungRow, buchungszeilenRows, kassenRows, kontaktRow, positionRows } from "./adapters";
import { GDPDU_DTD, GDPDU_DTD_FILE, GDPDU_DTD_SHA256 } from "./dtd";
import { parseDtd, validateAgainstDtd } from "./dtd-validate";
import { GDPDU_V1_TABLES, gdpduTable } from "./schema-v1";
import { buildGdpduPackage, type GdpduPackageInput, gdpduAmount, gdpduCsv, gdpduDate, gdpduIndexXml } from "./write";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const td = new TextDecoder();

const base = (): GdpduPackageInput => ({
  supplier: { name: "Muster & Söhne GmbH", location: "Aachen" },
  app: { name: "Rechnungen", version: "1.4.0" },
  year: 2026,
  range: { from: "2026-01-01", to: "2026-12-31" },
  encoding: "utf8",
  createdAt: "19.10.2026 12:00",
  rows: {},
  dbCounts: {},
  internalSchemaVersions: ["2026.10.18"],
  restrictedContacts: 0,
  purges: [],
});

describe("bundled DTD (EXP-017, GOBD-11)", () => {
  test("EXP-017 the bundled DTD constant is the official gdpdu-01-09-2004.dtd (SHA-256 pinned, CRLF kept)", () => {
    expect(sha(GDPDU_DTD)).toBe(GDPDU_DTD_SHA256);
    expect(GDPDU_DTD_SHA256).toBe("af3d4c5a19e991f2d8c53995bc708680bbd7ff9326fde539c55b7e2c63f848a2");
    expect(new TextEncoder().encode(GDPDU_DTD).length).toBe(9140);
    expect(GDPDU_DTD).toContain("\r\n");
    expect(GDPDU_DTD_FILE).toBe("gdpdu-01-09-2004.dtd");
  });

  test("EXP-017 every element of the DTD is parsed (content models for DataSet, Table, VariableLength, …)", () => {
    const m = parseDtd(GDPDU_DTD);
    expect(m.get("UTF8")).toEqual({ kind: "empty" });
    expect(m.get("URL")).toEqual({ kind: "pcdata" });
    const table = m.get("Table");
    expect(table?.kind).toBe("children");
    expect(m.size).toBe((GDPDU_DTD.match(/<!ELEMENT/g) ?? []).length); // 49 declarations
  });
});

describe("index.xml (EXP-017, EXP-018, E-EXP-31)", () => {
  const xml = gdpduIndexXml(base());

  test("EXP-017 GOBD-11 the generated index.xml for every gdpdu-v1 table validates against the DTD", () => {
    expect(validateAgainstDtd(xml, GDPDU_DTD, GDPDU_DTD_FILE)).toEqual([]);
    expect(
      xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">'),
    ).toBe(true);
    for (const t of GDPDU_V1_TABLES) expect(xml).toContain(`<URL>${t.file}</URL>`);
    expect(xml).toContain("Muster &amp; Söhne GmbH");
  });

  test('EXP-018 declares UTF-8, decimal comma, grouping dot, ;/"/CRLF, amounts with Accuracy 2, dates DD.MM.YYYY, keys', () => {
    expect(xml).toContain("<UTF8/><DecimalSymbol>,</DecimalSymbol><DigitGroupingSymbol>.</DigitGroupingSymbol>");
    expect(xml).toContain(
      '<ColumnDelimiter>;</ColumnDelimiter><RecordDelimiter>&#13;&#10;</RecordDelimiter><TextEncapsulator>"</TextEncapsulator>',
    );
    expect(xml).toContain(
      "<Name>soll</Name><Description>Soll (EUR)</Description><Numeric><Accuracy>2</Accuracy></Numeric>",
    );
    expect(xml).toContain(
      "<Name>datum</Name><Description>Buchungsdatum</Description><Date><Format>DD.MM.YYYY</Format></Date>",
    );
    expect(xml).toContain("<VariablePrimaryKey><Name>seq</Name>");
    expect(xml).toContain("<ForeignKey><Name>seq</Name><References>Buchungen</References></ForeignKey>");
    expect(xml).toContain("<Validity><Range><From>01.01.2026</From><To>31.12.2026</To></Range>");
    expect(gdpduIndexXml({ ...base(), encoding: "ansi" })).toContain("<ANSI/><DecimalSymbol>");
  });

  test("E-EXP-31 the validator rejects wrong order, missing elements, undeclared elements, attributes and broken XML", () => {
    const v = (x: string) => validateAgainstDtd(x, GDPDU_DTD, GDPDU_DTD_FILE);
    expect(v(xml.replace("<Version>1.0</Version>", ""))[0]).toMatch(/DataSet: Inhalt .* passt nicht/);
    const swapped = xml.replace("<URL>firma.csv</URL><Name>Firma</Name>", "<Name>Firma</Name><URL>firma.csv</URL>");
    expect(v(swapped).some((e) => e.includes("/Table: Inhalt"))).toBe(true);
    expect(
      v(xml.replace("<Version>1.0</Version>", "<Version>1.0</Version><Foo/>")).some((e) => e.includes("Foo")),
    ).toBe(true);
    expect(v(xml.replace("<DataSet>", '<DataSet lang="de">')).some((e) => e.includes("Attribute"))).toBe(true);
    expect(v(xml.replace("</Media>", "")).length).toBeGreaterThan(0);
    expect(v(xml.replace("gdpdu-01-09-2004.dtd", "other.dtd")).some((e) => e.includes("other.dtd"))).toBe(true);
    expect(v(xml.replace("<UTF8/>", "<UTF8>x</UTF8>")).some((e) => e.includes("muss leer sein"))).toBe(true);
  });
});

describe("CSV values (EXP-018)", () => {
  test("EXP-018 amounts with decimal comma and no float, dates DD.MM.YYYY, quoted text, CRLF records, no header", () => {
    expect(gdpduAmount(123456)).toBe("1234,56");
    expect(gdpduAmount(-5)).toBe("-0,05");
    expect(gdpduAmount(0)).toBe("0,00");
    expect(() => gdpduAmount(1.5)).toThrow();
    expect(gdpduDate("2026-03-01")).toBe("01.03.2026");
    const t = gdpduTable("buchungszeilen.csv");
    const csv = gdpduCsv(t, [
      { seq: 1, zeile: 1, konto: "1200", soll: 11900, haben: 0, steuerschluessel: null, kontakt_id: 'a"b' },
      { seq: 1, zeile: 2, konto: "8400", soll: 0, haben: 10000, steuerschluessel: "USt19" },
    ]);
    expect(csv).toBe('1;1;"1200";119,00;0,00;;;;"a""b"\r\n1;2;"8400";0,00;100,00;"USt19";;;\r\n');
  });

  test("EXP-018 line breaks inside a text value become LF so CRLF stays the record delimiter", () => {
    const csv = gdpduCsv(gdpduTable("buchungen.csv"), [
      { seq: 1, datum: "2026-01-02", periode: "2026-01", text: "a\r\nb" },
    ]);
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toContain('"a\nb"');
  });

  test("EXP-018 ANSI: Windows-1252 bytes (€ = 0x80, „ = 0x84, ä = 0xE4); unmappable characters reported", () => {
    const r = encodeCp1252("€ „ä“ − ✓");
    expect([...r.bytes.slice(0, 3)]).toEqual([0x80, 0x20, 0x84]);
    expect(decodeCp1252(r.bytes)).toBe("€ „ä“ - ?");
    expect(r.unmappable).toEqual(["✓"]);
  });
});

describe("package (EXP-017, E-EXP-32, E-EXP-33, E-EXP-34)", () => {
  const entry = {
    _id: "j1",
    seq: 7,
    date: "2026-02-01",
    period: "2026-02",
    text: "Rechnung RE-2026-0001",
    source: { kind: "salesDocument", id: "d1" },
    recordedAt: Date.UTC(2026, 1, 1, 9),
    actor: "user:u1",
    lines: [
      { account: "1400", debitCents: 11900, creditCents: 0, contactId: "c1" },
      { account: "8400", debitCents: 0, creditCents: 10000, taxKey: "USt19" },
      { account: "1776", debitCents: 0, creditCents: 1900, taxKey: "USt19" },
    ],
  };

  test("EXP-017 README row counts equal the CSV records and the DB counts; DTD and index.xml are in the root", () => {
    const input = base();
    const r = buildGdpduPackage({
      ...input,
      rows: { "buchungen.csv": [buchungRow(entry, () => undefined)], "buchungszeilen.csv": buchungszeilenRows(entry) },
      dbCounts: { "buchungen.csv": 1, "buchungszeilen.csv": 3 },
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.value.counts["buchungszeilen.csv"]).toBe(3);
    expect(Object.keys(r.value.files)).toEqual(
      expect.arrayContaining(["index.xml", "gdpdu-01-09-2004.dtd", "README.txt"]),
    );
    expect(sha(r.value.files["gdpdu-01-09-2004.dtd"] as Uint8Array)).toBe(GDPDU_DTD_SHA256);
    const readme = td.decode(r.value.files["README.txt"]);
    expect(readme).toContain("- buchungszeilen.csv (Buchungszeilen): 3");
    expect(readme).toContain("Keine Löschläufe");
  });

  test("E-EXP-32 a row count mismatch blocks the export with the German message", () => {
    const r = buildGdpduPackage({
      ...base(),
      rows: { "buchungen.csv": [buchungRow(entry, () => undefined)] },
      dbCounts: { "buchungen.csv": 2 },
    });
    expect(r).toEqual({ ok: false, errors: ["Zeilenanzahl buchungen.csv stimmt nicht (1 statt 2)."] });
  });

  test("E-EXP-33 E-EXP-34 restricted contacts are exported and noted; purge batches are listed in the README", () => {
    const contact = {
      _id: "c1",
      number: "K-0001",
      kind: "person",
      displayName: "Erika Mustermann",
      dsgvo: { restrictedAt: 1 },
    };
    const r = buildGdpduPackage({
      ...base(),
      rows: { "kontakte.csv": [kontaktRow(contact, null)] },
      restrictedContacts: 1,
      purges: [{ id: "pb1", date: "02.01.2035", classes: ["Buchungsbelege (8 Jahre)"], count: 12 }],
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(td.decode(r.value.files["kontakte.csv"])).toContain('"Erika Mustermann"');
    expect(td.decode(r.value.files["kontakte.csv"])).toContain('"ja"');
    const readme = td.decode(r.value.files["README.txt"]);
    expect(readme).toContain("Gesperrte Kontakte (Art. 18 DSGVO) sind enthalten");
    expect(readme).toContain("02.01.2035 Lauf pb1: 12 Datensätze (Buchungsbelege (8 Jahre))");
  });

  test("CSH-020 Kassenbewegungen: cash lines in journal order with running balance", () => {
    const cash = (seq: number, debit: number, credit: number) => ({
      ...entry,
      _id: `e${seq}`,
      seq,
      lines: [{ account: "1000", debitCents: debit, creditCents: credit }],
    });
    const rows = kassenRows([cash(3, 0, 2000), cash(2, 5000, 0)], ["1000"]);
    expect(rows.map((r) => [r.seq, r.betrag, r.saldo])).toEqual([
      [2, 5000, 5000],
      [3, -2000, 3000],
    ]);
  });
});

describe("migration adapters (EXP-019, GOBD-23, E-EXP-30, TST-EXP-17)", () => {
  test("EXP-019 TST-EXP-17 a record written under an older internal schema exports byte-identically", () => {
    const v1Address = { street: "Markt 1", zip: "52062", city: "Aachen", country: "DE" };
    const v2Address = { street: "Markt 1", postalCode: "52062", city: "Aachen", countryCode: "DE", name: "x" };
    expect(addressLine(v1Address)).toBe(addressLine(v2Address));
    const contact = { _id: "c1", number: "K-0001", kind: "organization", displayName: "Muster GmbH" };
    const t = gdpduTable("kontakte.csv");
    expect(gdpduCsv(t, [kontaktRow(contact, v1Address)])).toBe(gdpduCsv(t, [kontaktRow(contact, v2Address)]));
  });

  test("EXP-019 positions: quantities and unit prices as exact fixed-point text, only item lines", () => {
    const rows = positionRows([
      { documentId: "d1", position: 2, kind: "text" },
      {
        documentId: "d1",
        position: 1,
        kind: "item",
        name: "Wartung",
        quantityMilli: 1500,
        unitCode: "HUR",
        unitPriceMicros: 856_250,
        lineNetCents: 12844,
        vatCategory: "S",
        vatRateBp: 1900,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ menge: "1,5", einzelpreis: "85,625", ust_satz: "19,00", netto: 12844 });
  });
});
