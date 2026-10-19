/**
 * Golden DATEV EXTF output (F09 TST-EXP-01, EXP-001…005, EXP-013…015, DATEV-01…03): every posting-matrix journal
 * (test/golden/posting-matrix/expected, SKR03 and SKR04) mapped to Buchungsstapel rows with the validation issues,
 * plus one complete EXTF file and the document index. A change needs `pnpm golden:update` and a written reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bookingColumns } from "@/domain/datev/columns";
import { datevDocumentPackage } from "@/domain/datev/documents";
import { buchungsstapelFile, buchungsstapelFileName, debitorenKreditorenFile, extfRowLine } from "@/domain/datev/extf";
import { type DatevJournalEntry, mapEntries } from "@/domain/datev/mapping";
import { masterDataRow } from "@/domain/datev/masterdata";
import { seededAccount } from "@/domain/rules/accounting";
import type { Chart } from "@/domain/rules/accounting/types";
import type { CalendarDate } from "@/domain/time/calendar-date";

const DIR = join(__dirname, "posting-matrix/expected");

interface GoldenJournal {
  date: string;
  text: string;
  source: { kind: string; id: string };
  lines: DatevJournalEntry["lines"];
}

function journals(chart: Chart): { name: string; entries: DatevJournalEntry[] }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".journal.json"))
    .sort()
    .map((f) => {
      const j = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Record<
        string,
        GoldenJournal | GoldenJournal[] | undefined
      >;
      const raw = j[chart];
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const name = f.replace(".journal.json", "");
      return {
        name,
        entries: list.map((e, i) => ({
          id: `${name}#${i}`,
          seq: i + 1,
          date: e.date,
          text: e.text,
          source: e.source,
          ...(name.includes("storno") || name.includes("reversal") ? { reversalOfId: "orig" } : {}),
          lines: e.lines,
        })),
      };
    });
}

const personal = new Map<string, string>();
const ctx = (chart: Chart, from = "2020-01-01", to = "2030-12-31") => ({
  accountLength: 4,
  festschreibung: 0 as const,
  from,
  to,
  isAutomatic: (a: string) => seededAccount(chart, "2026-01-01" as CalendarDate, a)?.automaticVatAccount === true,
  accountExists: (a: string) => seededAccount(chart, "2026-01-01" as CalendarDate, a) !== null,
  personalAccount: (contactId: string, kind: "debtor" | "creditor") => {
    const key = `${kind}:${contactId}`;
    if (!personal.has(key)) {
      const n = [...personal.keys()].filter((k) => k.startsWith(kind)).length + 1;
      personal.set(key, String((kind === "debtor" ? 10000 : 70000) + n));
    }
    return personal.get(key) as string;
  },
  beleg: (e: DatevJournalEntry) => ({
    belegfeld1: e.source.kind === "voucher" ? "ER-2026-0007" : "RE-2026-0001",
    ...(e.source.kind === "salesDocument" ? { dueDate: "2026-03-15", supplyDate: e.date } : {}),
    internalId: e.source.id,
    guid: "6F2C1A0E-0000-8000-8000-000000000001",
  }),
});

describe("golden DATEV Buchungsstapel rows per posting case (TST-EXP-01)", () => {
  for (const chart of ["SKR03", "SKR04"] as const) {
    test(`TST-EXP-01 EXP-005 DATEV-01 DATEV-02 posting matrix ${chart}`, async () => {
      const cols = bookingColumns(13);
      const out = journals(chart)
        .filter((j) => j.entries.length > 0)
        .map((j) => {
          const r = mapEntries(j.entries, ctx(chart));
          return {
            case: j.name,
            rows: r.rows.map((row) => extfRowLine(cols, row).replace(/;+$/, "")),
            issues: r.issues.map((i) => `${i.level}: ${i.message}`),
          };
        });
      await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(`./datev/posting-matrix.${chart}.json`);
    });
  }

  test("EXP-001 EXP-003 EXP-013 a complete Buchungsstapel and the Debitoren/Kreditoren file (Windows-1252 bytes)", async () => {
    const cases = journals("SKR03").filter((j) =>
      ["S1-domestic-19-soll", "S2-mixed-19-7-soll", "P4-skonto-soll", "V1-input-vat-19"].includes(j.name),
    );
    const entries = cases.flatMap((c, i) => c.entries.map((e) => ({ ...e, id: `${c.name}`, seq: i + 1 })));
    const r = mapEntries(entries, ctx("SKR03", "2026-01-01", "2026-12-31"));
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
      to: "2026-12-31",
      description: "Rechnungen 2026",
      festschreibung: 0 as const,
      chart: "SKR03" as const,
    };
    const file = buchungsstapelFile(header, 13, r.rows);
    expect(file.encoded.unmappable).toEqual([]);
    expect(buchungsstapelFileName("2026-01-01", "2026-12-31")).toBe("EXTF_Buchungsstapel_20260101_20261231.csv");
    await expect(new TextDecoder("windows-1252").decode(file.encoded.bytes)).toMatchFileSnapshot(
      "./datev/EXTF_Buchungsstapel_20260101_20261231.csv",
    );
    const master = debitorenKreditorenFile(header, [
      masterDataRow({
        account: "10001",
        kind: "organization",
        number: "K-0001",
        displayName: "Muster GmbH",
        vatId: "DE123456789",
        address: { street: "Markt 1", postalCode: "52062", city: "Aachen", countryCode: "DE" },
        email: "buchhaltung@muster.test",
        iban: "DE02 1203 0000 0000 2020 51",
        language: "de",
      }),
      masterDataRow({
        account: "10002",
        kind: "person",
        number: "K-0002",
        displayName: "Jörg Müßig",
        firstName: "Jörg",
        lastName: "Müßig",
        salutation: "herr",
      }),
    ]);
    await expect(new TextDecoder("windows-1252").decode(master.encoded.bytes)).toMatchFileSnapshot(
      "./datev/EXTF_Debitoren_Kreditoren.csv",
    );
  });

  test("EXP-014 EXP-015 DATEV-03 the document index", async () => {
    const pkg = datevDocumentPackage(
      [
        {
          belegfeld1: "RE-2026-0001",
          sourceId: "doc1",
          files: [
            { ext: "pdf", bytes: new Uint8Array([1]), sha256: "a".repeat(64) },
            { ext: "xml", bytes: new Uint8Array([2]), sha256: "b".repeat(64) },
          ],
        },
        {
          belegfeld1: "ER-2026-0007",
          sourceId: "v7",
          numbered: true,
          files: [
            { ext: "pdf", bytes: new Uint8Array([3]), sha256: "c".repeat(64) },
            { ext: "jpg", bytes: new Uint8Array([4]), sha256: "d".repeat(64) },
          ],
        },
      ],
      { createdAt: "2027-01-15T10:00:00", description: "DATEV-Export 2026" },
    );
    expect(Object.keys(pkg.files).sort()).toEqual([
      "ER-2026-0007_1.pdf",
      "ER-2026-0007_2.jpg",
      "RE-2026-0001.pdf",
      "RE-2026-0001.xml",
    ]);
    await expect(pkg.documentXml).toMatchFileSnapshot("./datev/document.xml");
    await expect(pkg.manifestCsv).toMatchFileSnapshot("./datev/manifest.csv");
  });
});
