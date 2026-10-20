import { describe, expect, test } from "vitest";
import { chartAccounts } from "../rules/accounting";
import type { CalendarDate } from "../time/calendar-date";
import type { DatevJournalEntry } from "./mapping";
import type { PreviousExport } from "./masterdata";
import { batchDescription, bookingScopeOf, type DatevRunInput, monthsOf, runDatevExport } from "./run";

const accounts = (() => {
  const r = chartAccounts("SKR03", "2026-01-01" as CalendarDate);
  return r.ok ? r.value.map((a) => ({ n: a.number, auto: a.automaticVatAccount === true })) : [];
})();

const invoice = (id: string, date: string, gross = 11900): DatevJournalEntry => ({
  id,
  seq: Number(id.replace(/\D/g, "")) || 1,
  date,
  text: `Rechnung ${id}`,
  source: { kind: "salesDocument", id: `doc-${id}` },
  lines: [
    { account: "1400", role: "receivable", debitCents: gross, creditCents: 0, contactId: "c1" },
    {
      account: "8400",
      role: "revenue.domestic.19",
      debitCents: 0,
      creditCents: gross - Math.round((gross / 1.19) * 0.19),
      taxKey: "USt19",
    },
    { account: "1776", role: "vat.output.19", debitCents: 0, creditCents: Math.round((gross / 1.19) * 0.19) },
  ],
});

const input = (over: Partial<DatevRunInput> = {}): DatevRunInput => ({
  from: "2026-10-01",
  to: "2026-10-31",
  mode: "new",
  scope: ["revenue", "vouchers", "payments", "manual", "master_data", "documents"],
  settings: {
    consultantNumber: 1234567,
    clientNumber: 12345,
    accountLength: 4,
    formatVersion: 13,
    personalAccounts: true,
    companyName: "Muster Handwerk GmbH",
  },
  years: [{ from: "2026-10-01", to: "2026-10-31", fiscalYearStart: "2026-01-01", chart: "SKR03", accounts }],
  lockedMonths: [],
  previous: [],
  entries: [invoice("e1", "2026-10-05")],
  belege: { "doc-e1": { belegfeld1: "RE-2026-0001", dueDate: "2026-10-19", internalId: "doc-e1" } },
  contacts: [{ id: "c1", kind: "organization", number: "K-0001", displayName: "Muster GmbH", vatId: "DE123456789" }],
  docs: [
    {
      sourceId: "doc-e1",
      belegfeld1: "RE-2026-0001",
      numbered: false,
      files: [{ ext: "pdf", sha256: "a".repeat(64), bytes: new Uint8Array([1, 2]) }],
    },
  ],
  usedAccounts: [],
  accepted: false,
  createdAt: Date.UTC(2026, 10, 2, 9, 0, 0),
  ...over,
});

const prevOf = (over: Partial<PreviousExport>): PreviousExport => ({
  id: "x1",
  fileName: "EXTF_Buchungsstapel_20261001_20261031.csv",
  createdAt: Date.UTC(2026, 10, 1, 9),
  festschreibung: 0,
  from: "2026-10-01",
  to: "2026-10-31",
  lineIds: [],
  sha256ByFile: {},
  ...over,
});

const text = (b: Uint8Array | undefined) => new TextDecoder("windows-1252").decode(b);

describe("DATEV export flow (F09 §4.1.3)", () => {
  test("EXP-008 booking scopes per journal source", () => {
    expect(bookingScopeOf("salesDocument")).toBe("revenue");
    expect(bookingScopeOf("payment", "salesDocument")).toBe("revenue");
    expect(bookingScopeOf("payment", "voucher")).toBe("payments");
    expect(bookingScopeOf("voucher")).toBe("vouchers");
    expect(bookingScopeOf("cashTransfer")).toBe("payments");
    expect(bookingScopeOf("asset_depreciation")).toBe("assets");
    expect(bookingScopeOf("opening_balance")).toBe("manual");
    expect(monthsOf("2026-11-15", "2027-01-02")).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(batchDescription("2026-10-01", "2026-10-31", false)).toBe("Rechnungen 10/2026");
    expect(batchDescription("2026-10-01", "2026-12-31", true)).toBe("Wiederholung 10/2026–12/2026");
  });

  test("E-EXP-01 missing Berater-/Mandantennummer blocks the export", async () => {
    const r = await runDatevExport(input({ settings: { ...input().settings, consultantNumber: undefined } }));
    expect(r.report.blocking).toBe(true);
    expect(r.report.issues.map((i) => i.message)).toContain(
      "Für den DATEV-Export fehlen Berater- und/oder Mandantennummer (Einstellungen › Unternehmen › DATEV).",
    );
    expect(r.files).toEqual({});
  });

  test("EXP-001 EXP-006 EXP-013 EXP-014 EXP-015 E-EXP-13 the ZIP: batch, master data with the assigned debtor, documents with Beleglink", async () => {
    const r = await runDatevExport(input());
    expect(r.report.blocking).toBe(false);
    expect(Object.keys(r.files).sort()).toEqual([
      "EXTF_Buchungsstapel_20261001_20261031.csv",
      "EXTF_Debitoren_Kreditoren.csv",
      "RE-2026-0001.pdf",
      "document.xml",
      "manifest.csv",
    ]);
    expect(r.needsAccount).toEqual([{ contactId: "c1", kind: "debtor" }]);
    expect(r.report.issues.map((i) => i.message)).toContain(
      "1 Kontakten werden beim Export Debitoren-/Kreditorennummern zugewiesen.",
    );
    const csv = text(r.files["EXTF_Buchungsstapel_20261001_20261031.csv"]);
    const guid = /<document guid="([^"]+)"/.exec(text(r.files["document.xml"]))?.[1];
    expect(csv).toContain(`"BEDI ""${guid}"""`);
    expect(csv.split("\r\n")[0]).toContain(';"Rechnungen 10/2026";');
    expect(csv.split("\r\n")[2]).toMatch(/^119,00;"S";"EUR";;;;10000;8400;;0510;"RE-2026-0001";"191026";/);
    expect(text(r.files["EXTF_Debitoren_Kreditoren.csv"]).split("\r\n")[2]).toMatch(/^10000;"Muster GmbH";/);
    expect(r.lineIds).toEqual(["e1:0", "e1:1", "e1:2"]);
    expect(r.fileHashes[0]?.rowsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.report).toMatchObject({ rowCount: 1, sumUmsatzCents: 11900, festschreibung: 0, isRepeat: false });
  });

  test("EXP-006 Sammelkonten: without personal accounts the receivable account stays and no master data is written", async () => {
    const r = await runDatevExport(input({ settings: { ...input().settings, personalAccounts: false } }));
    expect(r.needsAccount).toEqual([]);
    expect(text(r.files["EXTF_Buchungsstapel_20261001_20261031.csv"]).split("\r\n")[2]).toContain(";1400;8400;");
    expect(r.files["EXTF_Debitoren_Kreditoren.csv"]).toBeUndefined();
  });

  test("E-EXP-02 a range across two fiscal years gives two files and the info", async () => {
    const r = await runDatevExport(
      input({
        from: "2026-12-01",
        to: "2027-01-31",
        years: [
          { from: "2026-12-01", to: "2026-12-31", fiscalYearStart: "2026-01-01", chart: "SKR03", accounts },
          { from: "2027-01-01", to: "2027-01-31", fiscalYearStart: "2027-01-01", chart: "SKR03", accounts },
        ],
        entries: [invoice("e1", "2026-12-05"), invoice("e2", "2027-01-05")],
        belege: {},
      }),
    );
    expect(r.report.files.map((f) => f.name)).toEqual([
      "EXTF_Buchungsstapel_20261201_20261231.csv",
      "EXTF_Buchungsstapel_20270101_20270131.csv",
      "EXTF_Debitoren_Kreditoren.csv",
    ]);
    expect(r.report.issues.map((i) => i.message)).toContain(
      "Der Zeitraum umfasst zwei Wirtschaftsjahre – es werden zwei Dateien erzeugt.",
    );
  });

  test("EXP-011 E-EXP-06 E-EXP-07 Festschreibung: 1 when every month is locked, otherwise forced to 0 with the warning", async () => {
    expect((await runDatevExport(input({ lockedMonths: ["2026-10"] }))).report.festschreibung).toBe(1);
    const r = await runDatevExport(input({ festschreibung: true }));
    expect(r.report.festschreibung).toBe(0);
    expect(r.report.issues.map((i) => i.message)).toContain(
      "Nicht festgeschriebene Monate (10/2026) werden ohne Festschreibung exportiert.",
    );
    expect(text(r.files["EXTF_Buchungsstapel_20261001_20261031.csv"]).split("\r\n")[0]).toContain(';1;0;0;"EUR";');
  });

  test("EC-174 EXP-010 E-EXP-03 E-EXP-08 „Nur neue Buchungen“: nothing new → no file; a late posting → only it, marked as repeat", async () => {
    const prev = prevOf({ lineIds: ["e1:0", "e1:1", "e1:2"] });
    const none = await runDatevExport(input({ previous: [prev] }));
    expect(none.report.nothingToExport).toBe(true);
    expect(none.files).toEqual({});
    expect(none.report.issues.map((i) => i.message)).toContain(
      "Seit dem letzten Export (01.11.2026) gibt es keine neuen Buchungen in diesem Zeitraum.",
    );
    const late = { ...invoice("e2", "2026-10-31"), originalDate: "2026-09-30" };
    const r = await runDatevExport(input({ previous: [prev], entries: [invoice("e1", "2026-10-05"), late] }));
    expect(r.lineIds).toEqual(["e2:0", "e2:1", "e2:2"]);
    expect(r.report.isRepeat).toBe(true);
    expect(r.report.files[0]?.name).toBe("EXTF_Buchungsstapel_20261001_20261031_2.csv");
    expect(r.report.issues.map((i) => i.message)).toContain(
      "1 nachträgliche Buchungen zu bereits exportierten Zeiträumen enthalten.",
    );
    expect(text(r.files["EXTF_Buchungsstapel_20261001_20261031_2.csv"]).split("\r\n")[0]).toContain(
      '"Wiederholung 10/2026"',
    );
  });

  test("EC-174 E-EXP-04 E-EXP-05 „Vollständig neu“: festgeschrieben → identical rows or integrity error; unlocked → confirmation", async () => {
    const first = await runDatevExport(input({ lockedMonths: ["2026-10"] }));
    const rows = first.fileHashes[0]?.rowsSha256 as string;
    const locked = prevOf({
      festschreibung: 1,
      lineIds: first.lineIds,
      sha256ByFile: { "EXTF_Buchungsstapel_20261001_20261031.csv": rows },
    });
    const again = await runDatevExport(input({ mode: "full", lockedMonths: ["2026-10"], previous: [locked] }));
    expect(again.report.blocking).toBe(false);
    expect(again.report.doNotReimport).toBe(true);
    expect(again.fileHashes[0]?.rowsSha256).toBe(rows);
    const changed = await runDatevExport(
      input({
        mode: "full",
        lockedMonths: ["2026-10"],
        previous: [locked],
        entries: [invoice("e1", "2026-10-05", 23800)],
      }),
    );
    expect(changed.report.blocking).toBe(true);
    expect(changed.report.issues.map((i) => i.message)).toContain(
      "Der festgeschriebene Zeitraum hat sich seit dem Export verändert – Integritätsfehler, Export abgebrochen.",
    );
    const open = await runDatevExport(
      input({ mode: "full", previous: [prevOf({ lineIds: ["e1:0", "e1:1", "e1:2"] })] }),
    );
    expect(open.report.needsConfirmation).toBe(
      "Der Steuerberater muss den vorherigen Stapel EXTF_Buchungsstapel_20261001_20261031.csv vor dem Import löschen. Fortfahren?",
    );
    expect(open.report.issues.map((i) => i.message)).toContain(
      "Gegenüber dem letzten Export: 0 neue und 0 entfallene Buchungszeilen.",
    );
    expect(
      (await runDatevExport(input({ mode: "full", confirmReplace: true, previous: [prevOf({})] }))).report
        .needsConfirmation,
    ).toBeNull();
  });

  test("E-EXP-15 E-EXP-16 transliterated characters and missing document files are warnings", async () => {
    const r = await runDatevExport(
      input({
        contacts: [{ id: "c1", kind: "organization", number: "K-0001", displayName: "Łódź Sp. z o.o." }],
        docs: [],
      }),
    );
    const messages = r.report.issues.map((i) => i.message);
    expect(messages).toContain("Für 1 Buchungen fehlt die Belegdatei.");
    expect(messages.some((m) => /^\d+ Zeichen wurden für DATEV umgeschrieben \(z\. B\. „Ł“ → „L“\)\.$/.test(m))).toBe(
      true,
    );
    expect(r.report.blocking).toBe(false);
  });
});
