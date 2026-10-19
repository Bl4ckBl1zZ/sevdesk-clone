import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { seededAccount } from "../rules/accounting";
import type { CalendarDate } from "../time/calendar-date";
import { BUCHUNGSSTAPEL_V12, BUCHUNGSSTAPEL_V13, DEBITOREN_KREDITOREN_V5 } from "./columns";
import { datevDocumentPackage, deterministicGuid } from "./documents";
import {
  buchungsstapelFile,
  buchungsstapelFileName,
  extfAmount,
  extfHeaderLine,
  extfTimestamp,
  splitByFiscalYear,
} from "./extf";
import {
  type DatevJournalEntry,
  type DatevJournalLine,
  type DatevMapContext,
  datevDerivedVat,
  datevVatOfGross,
  mapEntries,
} from "./mapping";
import { assignPersonalAccounts, planReexport, REEXPORT_MESSAGES } from "./masterdata";

const auto = (a: string) => seededAccount("SKR03", "2026-01-01" as CalendarDate, a)?.automaticVatAccount === true;
const ctx = (over: Partial<DatevMapContext> = {}): DatevMapContext => ({
  accountLength: 4,
  festschreibung: 0,
  from: "2026-01-01",
  to: "2026-12-31",
  isAutomatic: auto,
  accountExists: (a) => seededAccount("SKR03", "2026-01-01" as CalendarDate, a) !== null,
  personalAccount: (_c, kind) => (kind === "debtor" ? "10001" : "70001"),
  beleg: () => ({ belegfeld1: "RE-2026-0001", dueDate: "2026-03-15", internalId: "d1" }),
  ...over,
});
const L = (
  account: string,
  role: string,
  d: number,
  c: number,
  extra: Partial<DatevJournalLine> = {},
): DatevJournalLine => ({
  account,
  role,
  debitCents: d,
  creditCents: c,
  ...extra,
});
const entry = (lines: DatevJournalLine[], over: Partial<DatevJournalEntry> = {}): DatevJournalEntry => ({
  id: "e1",
  seq: 1,
  date: "2026-03-01",
  text: "Rechnung RE-2026-0001 Muster GmbH",
  source: { kind: "salesDocument", id: "d1" },
  lines,
  ...over,
});
const cellOf = (row: Record<string, unknown>, name: string) => {
  const c = row[name] as { t?: string; r?: string } | null | undefined;
  return c ? (c.t ?? c.r) : undefined;
};

describe("columns (EXP-004, EXP-013)", () => {
  test("EXP-004 Buchungsstapel v13 has 125 columns, v12 124; Debitoren/Kreditoren v5 254; names pinned", () => {
    expect(BUCHUNGSSTAPEL_V13).toHaveLength(125);
    expect(BUCHUNGSSTAPEL_V12).toHaveLength(124);
    expect(DEBITOREN_KREDITOREN_V5).toHaveLength(254);
    const at = (n: number) => BUCHUNGSSTAPEL_V13[n - 1];
    expect([at(1), at(2), at(7), at(8), at(9), at(10), at(11), at(12), at(14), at(20)]).toEqual([
      "Umsatz (ohne Soll/Haben-Kz)",
      "Soll/Haben-Kennzeichen",
      "Konto",
      "Gegenkonto (ohne BU-Schlüssel)",
      "BU-Schlüssel",
      "Belegdatum",
      "Belegfeld 1",
      "Belegfeld 2",
      "Buchungstext",
      "Beleglink",
    ]);
    expect([at(37), at(40), at(114), at(115), at(116), at(117), at(118), at(119), at(125)]).toEqual([
      "KOST1 - Kostenstelle",
      "EU-Land u. UStID",
      "Festschreibung",
      "Leistungsdatum",
      "Datum Zuord. Steuerperiode",
      "Fälligkeit",
      "Generalumkehr",
      "Steuersatz",
      "Abw. Skontokonto",
    ]);
    expect(DEBITOREN_KREDITOREN_V5[0]).toBe("Konto");
  });
});

describe("EXTF writer (EXP-001, EXP-002, EXP-003)", () => {
  const header = {
    category: 21 as const,
    formatName: "Buchungsstapel" as const,
    formatVersion: 13,
    createdAt: "20270115100000000",
    exportedBy: "Muster Handwerk GmbH",
    consultantNumber: 1234567,
    clientNumber: 12345,
    fiscalYearStart: "2026-01-01",
    accountLength: 4,
    from: "2026-01-01",
    to: "2026-03-31",
    description: "Rechnungen 01-03/2026",
    festschreibung: 1 as const,
    chart: "SKR03" as const,
  };

  test("EXP-001 EXP-002 header line: EXTF 700 21 Buchungsstapel 13, keys, WJ, Sachkontenlänge, range, Festschreibung, EUR, SKR 03", () => {
    expect(extfHeaderLine(header)).toBe(
      '"EXTF";700;21;"Buchungsstapel";13;20270115100000000;;"RE";"Muster Handwerk GmbH";;1234567;12345;20260101;4;20260101;20260331;"Rechnungen 01-03/2026";;1;0;1;"EUR";;;;;"03";;;;',
    );
    expect(extfHeaderLine(header).split(";")).toHaveLength(31);
  });

  test("EXP-001 file: header, column line, CRLF, decimal comma, quoted text, Windows-1252", () => {
    const f = buchungsstapelFile(header, 13, [
      { "Umsatz (ohne Soll/Haben-Kz)": { r: extfAmount(123456) }, Buchungstext: { t: 'Müller "GmbH"' } },
    ]);
    const lines = f.text.split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]?.split(";")).toHaveLength(125);
    expect(lines[2]).toMatch(/^1234,56;;;;;;;;;;;;;"Müller ""GmbH""";/);
    expect(f.encoded.bytes.includes(0xfc)).toBe(true); // ü in Windows-1252
    expect(extfAmount(5)).toBe("0,05");
  });

  test("EXP-003 E-EXP-02 file names and the split per fiscal year", () => {
    expect(buchungsstapelFileName("2026-10-01", "2026-10-31")).toBe("EXTF_Buchungsstapel_20261001_20261031.csv");
    expect(buchungsstapelFileName("2026-10-01", "2026-10-31", 1)).toBe("EXTF_Buchungsstapel_20261001_20261031_2.csv");
    expect(splitByFiscalYear("2025-11-01", "2026-02-28", 1)).toEqual([
      { from: "2025-11-01", to: "2025-12-31", fiscalYearStart: "2025-01-01" },
      { from: "2026-01-01", to: "2026-02-28", fiscalYearStart: "2026-01-01" },
    ]);
    expect(splitByFiscalYear("2026-05-01", "2026-08-31", 7)).toEqual([
      { from: "2026-05-01", to: "2026-06-30", fiscalYearStart: "2025-07-01" },
      { from: "2026-07-01", to: "2026-08-31", fiscalYearStart: "2026-07-01" },
    ]);
    expect(extfTimestamp(Date.UTC(2026, 9, 19, 10, 0, 0, 7))).toBe("20261019120000007");
  });
});

describe("journal → DATEV rows (EXP-005, EXP-006, §4.1.4)", () => {
  test("EXP-005 a 19 % invoice: one row, gross on the automatic revenue account without BU, debtor in Konto", () => {
    const r = mapEntries(
      [
        entry([
          L("1400", "receivable", 119000, 0, { contactId: "c1" }),
          L("8400", "revenue.domestic.19", 0, 100000, { taxKey: "USt19" }),
          L("1776", "vat.output.19", 0, 19000),
        ]),
      ],
      ctx(),
    );
    expect(r.issues).toEqual([]);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as Record<string, unknown>;
    expect(cellOf(row, "Umsatz (ohne Soll/Haben-Kz)")).toBe("1190,00");
    expect(cellOf(row, "Soll/Haben-Kennzeichen")).toBe("S");
    expect(cellOf(row, "Konto")).toBe("10001");
    expect(cellOf(row, "Gegenkonto (ohne BU-Schlüssel)")).toBe("8400");
    expect(cellOf(row, "BU-Schlüssel")).toBeUndefined();
    expect(cellOf(row, "Belegdatum")).toBe("0103");
    expect(cellOf(row, "Belegfeld 2")).toBe("150326");
    expect(datevDerivedVat(r.rows)).toBe(19000);
    expect(r.lineIds).toEqual(["e1:0", "e1:1", "e1:2"]);
  });

  test("EXP-005 DATEV-02 a non-automatic expense account gets the BU key (Vorsteuer 19 % = 9)", () => {
    expect(auto("4970")).toBe(false);
    const r = mapEntries(
      [
        entry(
          [
            L("4970", "expense.x", 10000, 0, { taxKey: "VSt19" }),
            L("1576", "vat.input.19", 1900, 0),
            L("1600", "payable", 0, 11900, { contactId: "s1" }),
          ],
          { source: { kind: "voucher", id: "v1" } },
        ),
      ],
      ctx(),
    );
    const row = r.rows[0] as Record<string, unknown>;
    expect([cellOf(row, "Konto"), cellOf(row, "Gegenkonto (ohne BU-Schlüssel)"), cellOf(row, "BU-Schlüssel")]).toEqual([
      "70001",
      "4970",
      "9",
    ]);
    expect(cellOf(row, "Soll/Haben-Kennzeichen")).toBe("H");
    expect(cellOf(row, "Umsatz (ohne Soll/Haben-Kz)")).toBe("119,00");
  });

  test("EXP-005 vouchers: Belegfeld 1 = internal number, the supplier's number in Zusatzinformation „Lieferanten-Rechnungsnr.“", () => {
    const r = mapEntries(
      [
        entry(
          [
            L("4970", "expense.x", 10000, 0, { taxKey: "VSt19" }),
            L("1576", "vat.input.19", 1900, 0),
            L("1600", "payable", 0, 11900, { contactId: "s1" }),
          ],
          { source: { kind: "voucher", id: "v1" } },
        ),
      ],
      ctx({ beleg: () => ({ belegfeld1: "ER-2026-0007", supplierNumber: "LF 4711/26", internalId: "v1" }) }),
    );
    const row = r.rows[0] as Record<string, unknown>;
    expect(cellOf(row, "Belegfeld 1")).toBe("ER-2026-0007");
    expect(cellOf(row, "Zusatzinformation - Art 1")).toBe("Lieferanten-Rechnungsnr.");
    expect(cellOf(row, "Zusatzinformation - Inhalt 1")).toBe("LF 4711/26");
  });

  test("EXP-005 Skonto: bank and the automatic Skonto account against the debtor; DATEV's VAT equals the booked correction", () => {
    const r = mapEntries(
      [
        entry([
          L("1200", "bank.b1", 115430, 0),
          L("8736", "skonto.granted.19", 3000, 0, { taxKey: "USt19" }),
          L("1776", "vat.output.19", 570, 0),
          L("1400", "receivable", 0, 119000, { contactId: "c1" }),
        ]),
      ],
      ctx(),
    );
    expect(
      r.rows.map((x) => [
        cellOf(x, "Konto"),
        cellOf(x, "Gegenkonto (ohne BU-Schlüssel)"),
        cellOf(x, "Umsatz (ohne Soll/Haben-Kz)"),
        cellOf(x, "Soll/Haben-Kennzeichen"),
      ]),
    ).toEqual([
      ["10001", "1200", "1154,30", "H"],
      ["10001", "8736", "35,70", "H"],
    ]);
    expect(datevDerivedVat(r.rows)).toBe(570);
  });

  test("EXP-005 Ist-Versteuerung: the „nicht fällig → fällig“ reclassification is left to DATEV (info), the payment is exported", () => {
    const r = mapEntries(
      [
        entry([
          L("1200", "bank.b1", 59500, 0),
          L("1400", "receivable", 0, 59500, { contactId: "c1" }),
          L("1766", "vat.output.notdue.19", 9500, 0),
          L("1776", "vat.output.19", 0, 9500),
        ]),
      ],
      ctx(),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.issues.map((i) => i.code)).toEqual(["DATEV_VAT_DERIVED"]);
  });

  test("E-EXP-09 a reversal keeps the original side with Generalumkehr = 1", () => {
    const r = mapEntries(
      [
        entry(
          [
            L("1400", "receivable", 0, 119000, { contactId: "c1" }),
            L("8400", "revenue.domestic.19", 100000, 0, { taxKey: "USt19" }),
            L("1776", "vat.output.19", 19000, 0),
          ],
          { reversalOfId: "e0" },
        ),
      ],
      ctx(),
    );
    const row = r.rows[0] as Record<string, unknown>;
    expect([
      cellOf(row, "Soll/Haben-Kennzeichen"),
      cellOf(row, "Generalumkehr"),
      cellOf(row, "Umsatz (ohne Soll/Haben-Kz)"),
    ]).toEqual(["S", "1", "1190,00"]);
  });

  test("§4.1.4 one VAT group on two revenue accounts: cents are shifted so DATEV's recomputation equals the booked VAT", () => {
    // 3 × 33,33 € net at 19 % = 99,99 € net, VAT booked on the document total: 19,00 €
    const r = mapEntries(
      [
        entry([
          L("1400", "receivable", 11899, 0, { contactId: "c1" }),
          L("8400", "revenue.domestic.19", 0, 6666, { taxKey: "USt19" }),
          L("8406", "revenue.x.19", 0, 3333, { taxKey: "USt19" }),
          L("1776", "vat.output.19", 0, 1900),
        ]),
      ],
      ctx({ accountExists: () => true }),
    );
    const gross = r.rows.reduce((s, x) => s + Number(cellOf(x, "Umsatz (ohne Soll/Haben-Kz)")?.replace(",", "")), 0);
    expect(gross).toBe(11899);
    expect(datevDerivedVat(r.rows.filter((x) => cellOf(x, "BU-Schlüssel") !== "40"))).toBe(1900);
  });

  test("§4.1.4 property: Σ DATEV-derived VAT + correction rows = booked VAT for any split of one rate group", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 4 }),
        fc.constantFrom(1900, 700),
        (nets, rate) => {
          const net = nets.reduce((s, n) => s + n, 0);
          const vat = Math.floor((2 * net * rate + 10_000) / 20_000);
          const key = rate === 1900 ? "USt19" : "USt7";
          const lines = [
            L("1400", "receivable", net + vat, 0, { contactId: "c1" }),
            ...nets.map((n, i) => L(`84${String(i).padStart(2, "0")}`, `revenue.${i}`, 0, n, { taxKey: key })),
            L(rate === 1900 ? "1776" : "1771", rate === 1900 ? "vat.output.19" : "vat.output.7", 0, vat),
          ];
          const r = mapEntries([entry(lines)], ctx({ accountExists: () => true, isAutomatic: () => true }));
          const corrections = r.rows
            .filter((x) => cellOf(x, "BU-Schlüssel") === "40")
            .reduce(
              (s, x) =>
                s +
                Number(cellOf(x, "Umsatz (ohne Soll/Haben-Kz)")?.replace(",", "")) *
                  (cellOf(x, "Soll/Haben-Kennzeichen") === "S" ? 1 : -1),
              0,
            );
          expect(datevDerivedVat(r.rows) + corrections).toBe(vat);
          const gross = r.rows
            .filter((x) => cellOf(x, "BU-Schlüssel") !== "40")
            .reduce((s, x) => s + Number(cellOf(x, "Umsatz (ohne Soll/Haben-Kz)")?.replace(",", "")), 0);
          expect(gross).toBe(net + vat);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("validation (EXP-007)", () => {
  test("EXP-007 E-EXP-10 E-EXP-11 E-EXP-12 E-EXP-22 blocking errors and warnings with the German messages", () => {
    const base = [
      L("1400", "receivable", 11900, 0, { contactId: "c1" }),
      L("8400", "revenue.domestic.19", 0, 10000, { taxKey: "USt19" }),
      L("1776", "vat.output.19", 0, 1900),
    ];
    const bad = mapEntries([entry(base)], ctx({ beleg: () => ({ belegfeld1: "RE 2026_01" }) }));
    expect(bad.issues).toContainEqual(
      expect.objectContaining({
        level: "error",
        message:
          "Belegnummer RE 2026_01 enthält Zeichen, die DATEV nicht akzeptiert. Bitte DATEV-Belegnummer festlegen.",
      }),
    );
    const long = mapEntries([entry(base, { text: "x".repeat(70) })], ctx());
    expect(long.issues).toContainEqual(
      expect.objectContaining({ level: "warning", message: "Buchungstext für RE-2026-0001 auf 60 Zeichen gekürzt." }),
    );
    expect(cellOf(long.rows[0] as Record<string, unknown>, "Buchungstext")).toHaveLength(60);
    const len = mapEntries(
      [entry([L("1400", "receivable", 100, 0), L("84000", "x", 0, 100)])],
      ctx({ accountExists: () => true }),
    );
    expect(len.issues).toContainEqual(
      expect.objectContaining({ message: "Konto 84000 passt nicht zur Sachkontenlänge 4." }),
    );
    const neg = mapEntries([entry([L("1400", "receivable", -100, 0), L("8400", "x", 0, -100)])], ctx());
    expect(neg.issues).toContainEqual(expect.objectContaining({ message: "Ungültige Buchung 1: negativer Betrag." }));
    const unb = mapEntries([entry([L("1400", "receivable", 100, 0), L("8400", "x", 0, 90)])], ctx());
    expect(unb.issues[0]?.message).toBe("Buchung 1 ist nicht ausgeglichen.");
    const out = mapEntries([entry(base, { date: "2027-01-02" })], ctx());
    expect(out.issues).toContainEqual(
      expect.objectContaining({ message: "Buchung 1 liegt außerhalb des Exportzeitraums." }),
    );
    const unknown = mapEntries(
      [entry([L("1400", "receivable", 100, 0, { contactId: "c1" }), L("9999", "x", 0, 100)])],
      ctx(),
    );
    expect(unknown.issues).toContainEqual(
      expect.objectContaining({ message: "Konto 9999 ist im Kontenrahmen nicht vorhanden." }),
    );
  });

  test("EXP-005 an amount without VAT on an automatic account gets BU 40 (Kleinunternehmer Skonto on 3736)", () => {
    expect(auto("3736")).toBe(true);
    const r = mapEntries(
      [
        entry([
          L("1600", "payable", 11900, 0, { contactId: "s1" }),
          L("3736", "skonto.received.19", 0, 238),
          L("1200", "bank.b1", 0, 11662),
        ]),
      ],
      ctx(),
    );
    const sk = r.rows.find((x) => cellOf(x, "Gegenkonto (ohne BU-Schlüssel)") === "3736") as Record<string, unknown>;
    expect(cellOf(sk, "BU-Schlüssel")).toBe("40");
    expect(datevDerivedVat(r.rows)).toBe(0);
  });

  test("E-EXP-14 by construction no tax BU key is ever written on an automatic account", () => {
    const r = mapEntries(
      [
        entry([
          L("1400", "receivable", 11900, 0, { contactId: "c1" }),
          L("8400", "revenue.domestic.19", 0, 10000, { taxKey: "USt19" }),
          L("1776", "vat.output.19", 0, 1900),
        ]),
      ],
      ctx(),
    );
    for (const row of r.rows) {
      const g = cellOf(row, "Gegenkonto (ohne BU-Schlüssel)") as string;
      if (auto(g)) expect([undefined, "40"]).toContain(cellOf(row, "BU-Schlüssel"));
    }
  });
});

describe("re-export, personal accounts, documents (EXP-006, EXP-010, EXP-014, EXP-015, EC-174)", () => {
  const prev = (over = {}) => ({
    id: "x1",
    fileName: "EXTF_Buchungsstapel_20261001_20261031.csv",
    createdAt: Date.UTC(2026, 10, 5),
    festschreibung: 0 as const,
    from: "2026-10-01",
    to: "2026-10-31",
    lineIds: ["a:0", "a:1"],
    sha256ByFile: {},
    ...over,
  });
  const fmt = () => "05.11.2026";

  test("EC-174 EXP-010 E-EXP-03 „Nur neue Buchungen“ exports only lines not yet exported; nothing new → info", () => {
    expect(
      planReexport({ mode: "new", lineIds: ["a:0", "a:1", "b:0"], previous: [prev()], formatDate: fmt }),
    ).toMatchObject({ lineIds: ["b:0"], repeat: true, info: null });
    expect(planReexport({ mode: "new", lineIds: ["a:0", "a:1"], previous: [prev()], formatDate: fmt }).info).toBe(
      REEXPORT_MESSAGES.nothingNew("05.11.2026"),
    );
  });

  test("EC-174 E-EXP-04 E-EXP-05 „Vollständig neu“: festgeschrieben → identical and „nicht erneut importieren“; else confirmation", () => {
    const locked = planReexport({
      mode: "full",
      lineIds: ["a:0", "a:1"],
      previous: [prev({ festschreibung: 1 })],
      formatDate: fmt,
    });
    expect(locked).toMatchObject({
      doNotReimport: true,
      repeat: true,
      mustEqual: expect.objectContaining({ id: "x1" }),
    });
    expect(locked.info).toBe(REEXPORT_MESSAGES.lockedRepeat("05.11.2026"));
    const open = planReexport({ mode: "full", lineIds: ["a:0"], previous: [prev()], formatDate: fmt });
    expect(open.needsConfirmation).toBe(
      "Der Steuerberater muss den vorherigen Stapel EXTF_Buchungsstapel_20261001_20261031.csv vor dem Import löschen. Fortfahren?",
    );
  });

  test("EXP-006 E-EXP-13 personal account numbers are assigned after the highest used one of the range", () => {
    expect(assignPersonalAccounts(2, "debtor", ["10001", "10005", "70001"], 4)).toEqual(["10006", "10007"]);
    expect(assignPersonalAccounts(1, "creditor", [], 4)).toEqual(["70000"]);
    expect(assignPersonalAccounts(1, "debtor", [], 5)).toEqual(["100000"]);
  });

  test("EXP-014 EXP-015 DATEV-03 files named by Belegfeld 1, unique names, one GUID per Beleg, deterministic", () => {
    const pkg = datevDocumentPackage(
      [
        { belegfeld1: "RE/2026 1", sourceId: "d1", files: [{ ext: "pdf", bytes: new Uint8Array([1]), sha256: "a" }] },
        { belegfeld1: "RE_2026_1", sourceId: "d2", files: [{ ext: "pdf", bytes: new Uint8Array([2]), sha256: "b" }] },
      ],
      { createdAt: "2027-01-15T10:00:00", description: "x" },
    );
    expect(Object.keys(pkg.files).sort()).toEqual(["RE_2026_1.pdf", "RE_2026_1_2.pdf"]);
    expect(pkg.guids.get("RE/2026 1")).toBe(deterministicGuid("d1"));
    expect(deterministicGuid("d1")).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(pkg.documentXml).toContain(`<document guid="${deterministicGuid("d1")}"`);
  });

  test("DATEV recomputation helper: 119,00 gross at 19 % contains 19,00 VAT", () => {
    expect(datevVatOfGross(11900, 1900)).toBe(1900);
    expect(datevVatOfGross(10700, 700)).toBe(700);
  });
});
