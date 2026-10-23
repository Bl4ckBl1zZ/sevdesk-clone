/**
 * F09 IMP-009 / IMP-016 parse step: per-file handling of the uploaded export set (ignored files, archives, documents,
 * unreadable DATEV/CSV files, unknown files, ambiguous formats, invalid rows) and the summary findings.
 */
import { describe, expect, test } from "vitest";
import type { CsvRecord } from "../../csv/csv";
import type { CalendarDate } from "../../time/calendar-date";
import { autoMap, type MappedCsvKind } from "./mapping";
import { type FileMappingInput, type ImportFileInput, lookupKeys, parseImportFiles } from "./preview";

const TODAY = "2026-10-18" as CalendarDate;

const table = (headers: string[], rows: string[][]) => ({
  headers,
  records: rows.map((cells, i): CsvRecord => ({ line: i + 2, cells })),
});
const csvFile = (id: string, name: string, kind: MappedCsvKind, headers: string[], rows: string[][]) => ({
  file: { id, name, sha256: `sha-${id}`, kind, table: table(headers, rows) } satisfies ImportFileInput,
  mapping: { columns: autoMap(kind, headers) } satisfies FileMappingInput,
});

const CONTACT_HEADERS = ["Kundennummer", "Kategorie", "Firma", "Vorname", "Nachname", "Straße", "PLZ", "Ort", "Land", "E-Mail", "Telefon", "USt-IdNr."];
const PRODUCT_HEADERS = ["Artikelnummer", "Name", "Beschreibung", "Einheit", "Preis (netto)", "Steuersatz"];
const INVOICE_HEADERS = ["Rechnungsnummer", "Typ", "Rechnungsdatum", "Lieferdatum", "Fällig am", "Kundennummer", "Kunde", "Netto", "Steuer", "Brutto", "Steuersatz", "Steuerregel", "Status", "Offener Betrag", "Währung", "Bezug"];

describe("IMP-016 per-file handling in the parse step", () => {
  test("IMP-016 ignored files, ZIP archives and PDF/XML/image documents produce no rows and never block", () => {
    const files: ImportFileInput[] = [
      { id: "z", name: "export.zip", sha256: "sha-z", kind: "zip" },
      { id: "p", name: "RE-1001.pdf", sha256: "sha-p", kind: "pdf" },
      { id: "x", name: "RE-1001.xml", sha256: "sha-x", kind: "xml" },
      { id: "i", name: "beleg.jpg", sha256: "sha-i", kind: "image" },
      { id: "g", name: "alt.csv", sha256: "sha-g", kind: "contacts", ignored: true },
    ];
    const parsed = parseImportFiles(files, {}, TODAY);
    expect(parsed.files.map((f) => [f.id, f.rows, f.blocked, f.ignored])).toEqual([
      ["z", 0, false, false],
      ["p", 0, false, false],
      ["x", 0, false, false],
      ["i", 0, false, false],
      ["g", 0, false, true],
    ]);
    expect(parsed.documentFiles).toEqual([
      { id: "p", name: "RE-1001.pdf", sha256: "sha-p", kind: "pdf" },
      { id: "x", name: "RE-1001.xml", sha256: "sha-x", kind: "xml" },
      { id: "i", name: "beleg.jpg", sha256: "sha-i", kind: "image" },
    ]);
    expect(parsed.findings).toEqual([]);
    // The documents' hashes are looked up as earlier imported files (IMP-006).
    expect(lookupKeys(parsed).imported).toEqual([
      "sevdesk.file|sha-p",
      "sevdesk.file|sha-x",
      "sevdesk.file|sha-i",
    ]);
  });

  test("E-IMP-20 an unrecognised file is listed with a warning and does not block", () => {
    const parsed = parseImportFiles([{ id: "u", name: "notizen.txt", sha256: "s", kind: "unknown" }], {}, TODAY);
    expect(parsed.findings).toEqual([
      {
        code: "E-IMP-20",
        severity: "warning",
        message: "Datei notizen.txt wurde nicht erkannt. Bitte Dateiart wählen oder ignorieren.",
        fileId: "u",
        fileName: "notizen.txt",
      },
    ]);
    expect(parsed.files[0]).toMatchObject({ rows: 0, blocked: false });
  });

  test("E-IMP-15 an unreadable CSV table or DATEV file blocks the file with an error", () => {
    const parsed = parseImportFiles(
      [
        { id: "c", name: "kontakte.csv", sha256: "s1", kind: "contacts" },
        { id: "d1", name: "EXTF_ohne_text.csv", sha256: "s2", kind: "datev" },
        { id: "d2", name: "EXTF_kaputt.csv", sha256: "s3", kind: "datev", text: "kein EXTF-Kopf\n1;2;3" },
      ],
      {},
      TODAY,
    );
    const e15 = parsed.findings.filter((f) => f.code === "E-IMP-15");
    expect(e15.map((f) => f.message)).toEqual([
      "kontakte.csv konnte nicht gelesen werden.",
      "EXTF_ohne_text.csv konnte nicht als DATEV-Export gelesen werden.",
      expect.stringMatching(/^EXTF_kaputt\.csv konnte nicht als DATEV-Export gelesen werden: .+/),
    ]);
    expect(e15.every((f) => f.severity === "error")).toBe(true);
    expect(parsed.files.map((f) => f.blocked)).toEqual([true, true, true]);
    expect(parsed.datev.files).toEqual([]);
  });

  test("E-IMP-26 an invoice list whose amounts and dates are ambiguous blocks until the owner chooses the format", () => {
    // „1.000“ can be 1000 (German) or 1,0 (English); „03/04/2026“ can be 3 April or 4 March.
    const row = ["RE-1", "Rechnung", "03/04/2026", "03/04/2026", "03/05/2026", "1001", "Muster", "1.000", "190", "1.190", "19", "", "Bezahlt", "0", "EUR", ""];
    const { file, mapping } = csvFile("r", "rechnungen.csv", "invoices", INVOICE_HEADERS, [row]);
    const parsed = parseImportFiles([file], { r: mapping }, TODAY);
    expect(parsed.findings.map((f) => [f.code, f.severity, f.message])).toEqual([
      ["E-IMP-26", "error", "Zahlen-/Datumsformat in rechnungen.csv ist nicht eindeutig. Bitte Format wählen."],
    ]);
    expect(parsed.files[0]).toMatchObject({ blocked: true, numberFormat: "ambiguous", dateFormat: "ambiguous" });
    expect(parsed.documents).toEqual([]);

    // The owner's choice resolves it: German numbers, day-first dates.
    const chosen = parseImportFiles([file], { r: { ...mapping, numberFormat: "de", dateFormat: "dmy" } }, TODAY);
    expect(chosen.files[0]).toMatchObject({ blocked: false, numberFormat: "de", dateFormat: "dmy" });
    expect(chosen.documents.map((d) => [d.number, d.documentDate])).toEqual([["RE-1", "2026-04-03"]]);
  });
});

describe("E-IMP-16 invalid contact and product rows are skipped and listed", () => {
  test("E-IMP-16 a contact row with an invalid USt-IdNr. is skipped with the line number; valid rows stay", () => {
    const { file, mapping } = csvFile("k", "kontakte.csv", "contacts", CONTACT_HEADERS, [
      ["1001", "Kunde", "Muster Bau GmbH", "", "", "Hauptstraße 1", "10115", "Berlin", "DE", "", "", ""],
      ["1002", "Kunde", "Falsch GmbH", "", "", "Weg 2", "20095", "Hamburg", "DE", "", "", "DE12"],
      ["", "Kunde", "Ohne Nummer AG", "", "", "Platz 3", "50667", "Köln", "DE", "", "", ""],
    ]);
    const parsed = parseImportFiles([file], { k: mapping }, TODAY);
    const e16 = parsed.findings.filter((f) => f.code === "E-IMP-16");
    expect(e16).toHaveLength(1);
    expect(e16[0]).toMatchObject({ severity: "error", line: 3, rowRef: "k:3" });
    expect(e16[0]?.message).toMatch(/^Zeile 3: /);
    // Without a customer number the key is name + postal code (IMP-020 duplicate detection).
    expect(parsed.contacts.map((c) => c.key)).toEqual(["n:1001", "h:ohne nummer ag|50667"]);
    // Contacts are personal data → privacy notice (IMP-009).
    expect(parsed.findings.some((f) => f.severity === "info" && f.code !== "E-IMP-16")).toBe(true);
  });

  test("E-IMP-16 a product row without Artikelnummer or with an unreadable price is skipped", () => {
    const { file, mapping } = csvFile("a", "artikel.csv", "products", PRODUCT_HEADERS, [
      ["ART-001", "Beratung", "", "Std", "95,00", "19"],
      ["", "Ohne Nummer", "", "Stk", "10,00", "19"],
      ["ART-003", "Kaputt", "", "Stk", "zehn Euro", "19"],
    ]);
    const parsed = parseImportFiles([file], { a: mapping }, TODAY);
    const e16 = parsed.findings.filter((f) => f.code === "E-IMP-16");
    expect(e16.map((f) => f.line)).toEqual([3, 4]);
    expect(e16[0]?.message).toBe("Zeile 3: Artikelnummer fehlt (sie ist der Schlüssel für wiederholte Importe).");
    expect(parsed.products.map((p) => p.key)).toEqual(["ART-001"]);
  });

  test("EC-202 E-IMP-38 a Kleinunternehmer's 0 % articles get the dormant key „standard“ with an info", () => {
    const { file, mapping } = csvFile("a", "artikel.csv", "products", PRODUCT_HEADERS, [
      ["ART-001", "Beratung", "", "Std", "95,00", "0"],
      ["ART-002", "Buch", "", "Stk", "24,30", "0 %"],
    ]);
    const ku = parseImportFiles([file], { a: mapping }, TODAY, {
      kleinunternehmer: [{ validFrom: "2024-01-01", isKU: true }],
    });
    expect(ku.products.map((p) => p.form.vatRateKey)).toEqual(["standard", "standard"]);
    expect(ku.findings.find((f) => f.code === "E-IMP-38")?.message).toBe(
      "artikel.csv: 2 Artikel mit 0 % Umsatzsteuer erhalten den Steuersatz „Standard“. Er wird angewendet, sobald Sie die Kleinunternehmerregelung verlassen – bitte dann prüfen.",
    );
    // Not a Kleinunternehmer today → 0 % is ambiguous (PV zero rate or exempt) and the rows are refused (E-IMP-16).
    const regular = parseImportFiles([file], { a: mapping }, TODAY, {
      kleinunternehmer: [
        { validFrom: "2024-01-01", isKU: true },
        { validFrom: "2026-01-01", isKU: false },
      ],
    });
    expect(regular.findings.some((f) => f.code === "E-IMP-38")).toBe(false);
    expect(regular.products).toEqual([]);
    expect(regular.findings.map((f) => f.message)).toEqual([
      "Zeile 2: 0 % ist mehrdeutig — bitte „zero“ (PV-Nullsatz) oder „exempt“ mit Befreiungsgrund angeben.",
      "Zeile 3: 0 % ist mehrdeutig — bitte „zero“ (PV-Nullsatz) oder „exempt“ mit Befreiungsgrund angeben.",
    ]);
  });
});
