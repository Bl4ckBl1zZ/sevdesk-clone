import { describe, expect, test } from "vitest";
import { sevdeskFixtureBytes, sevdeskPdfNames } from "../../../../test/fixtures/sevdesk-export/load";
import type { CalendarDate } from "../../time/calendar-date";
import { inspectFile } from "./files";
import { autoMap, isMappedCsvKind } from "./mapping";
import {
  buildPlan,
  EXTERNAL_TYPES,
  type FileMappingInput,
  type ImportFileInput,
  importedKey,
  type LocalImportState,
  lookupKeys,
  missingPdfKeys,
  parseImportFiles,
  previewHashInput,
  summarizePlan,
} from "./preview";

const TODAY = "2026-10-18" as CalendarDate;

function fixtureFiles(): { files: ImportFileInput[]; mappings: Record<string, FileMappingInput> } {
  const names = ["kontakte.csv", "artikel.csv", "rechnungen.csv", ...sevdeskPdfNames().map((n) => `pdf/${n}`)];
  const files: ImportFileInput[] = [];
  const mappings: Record<string, FileMappingInput> = {};
  names.forEach((path, i) => {
    const name = path.replace(/^pdf\//, "");
    const info = inspectFile(name, sevdeskFixtureBytes(path));
    const id = `f${i}`;
    files.push({ id, name, sha256: `sha-${name}`, kind: info.kind, ...(info.table ? { table: info.table } : {}) });
    if (isMappedCsvKind(info.kind) && info.headers) mappings[id] = { columns: autoMap(info.kind, info.headers) };
  });
  return { files, mappings };
}

const emptyLocal = (over: Partial<LocalImportState> = {}): LocalImportState => ({
  today: TODAY,
  imported: {},
  registerNumbers: {},
  contactsByNumber: {},
  contactsByName: {},
  productsByNumber: {},
  documentsByNumber: {},
  ranges: [],
  ...over,
});

function plan(local: LocalImportState = emptyLocal(), resolutions = {}) {
  const { files, mappings } = fixtureFiles();
  const parsed = parseImportFiles(files, mappings, TODAY);
  return { files, mappings, parsed, plan: buildPlan(parsed, local, resolutions) };
}
const docOf = (p: ReturnType<typeof plan>["plan"], number: string) => p.documents.find((d) => d.doc.number === number);

describe("F09 IMP-009 import preview over the synthetic export set (TST-IMP-16 domain part)", () => {
  test("TST-IMP-16 IMP-018 contacts, products and documents with original numbers; drafts skipped", () => {
    const { plan: p } = plan();
    expect(p.counts).toMatchObject({
      contactsNew: 3,
      productsNew: 2,
      invoices: 5, // RE-1005/RE-1006 are blocked by the ambiguous PDF (E-IMP-22)
      corrections: 1,
      cancellations: 1,
      drafts: 1,
      contactsMinimal: 1,
    });
    expect(p.contacts.map((c) => [c.key, c.name])).toEqual([
      ["n:1001", "Muster Bau GmbH"],
      ["n:1002", "Erika Beispiel"],
      ["n:1003", "Société Exemple SARL"],
    ]);
    expect(p.products.map((pr) => [pr.key, pr.form.price, pr.form.vatRateKey])).toEqual([
      ["ART-001", "95,00", "standard"],
      ["ART-002", "24,30", "reduced"],
    ]);
  });

  test("§4.3.3 status per document: paid/partially paid/open, Storno cancels its original and references it", () => {
    const { plan: p } = plan();
    expect(docOf(p, "RE-1001")).toMatchObject({ finalStatus: "sent", paymentStatus: "paid", openAmountCents: 0 });
    expect(docOf(p, "RE-1002")).toMatchObject({ paymentStatus: "partially_paid", openAmountCents: 5700 });
    expect(docOf(p, "RE-1003")).toMatchObject({ paymentStatus: "open", openAmountCents: 200000 });
    expect(docOf(p, "RE-1004")).toMatchObject({ finalStatus: "cancelled" });
    expect(docOf(p, "RE-1004")?.openAmountCents).toBeUndefined();
    expect(docOf(p, "STORNO-1004")).toMatchObject({ status: "new", correctsKey: "invoice:RE-1004" });
    expect(docOf(p, "GS-0001")).toMatchObject({ status: "new", correctsKey: "invoice:RE-1001" });
    expect(p.openItems).toEqual({ count: 3, totalCents: 5700 + 200000 + 23800 });
  });

  test("IMP-021 E-IMP-25 customer number links to the imported contact; unknown customers get a minimal contact", () => {
    const { plan: p } = plan();
    expect(docOf(p, "RE-1001")?.contact).toEqual({ kind: "import", key: "n:1001" });
    expect(docOf(p, "RE-1005")?.contact).toEqual({ kind: "minimal", key: "m:neukunde kg" });
    expect(p.minimalContacts).toEqual([{ key: "m:neukunde kg", name: "Neukunde KG", customerNumber: "2001" }]);
    expect(p.findings.find((f) => f.code === "E-IMP-25")?.message).toBe(
      "1 Belege verweisen auf unbekannte Kunden – Kontakte werden unvollständig angelegt.",
    );
  });

  test("TST-IMP-18 IMP-019 PDF matching in the preview: ambiguous rows blocked, orphan and missing PDFs listed", () => {
    const { plan: p, files } = plan();
    const name = (id?: string) => files.find((f) => f.id === id)?.name;
    expect(name(docOf(p, "RE-1001")?.pdfFileId)).toBe("RE-1001.pdf");
    expect(name(docOf(p, "RE-1002")?.pdfFileId)).toBe("Rechnung_RE-1002.pdf");
    expect(name(docOf(p, "RE-1003")?.pdfFileId)).toBe("re 1003.PDF");
    expect(docOf(p, "RE-1005")?.status).toBe("error");
    expect(docOf(p, "RE-1006")?.status).toBe("error");
    expect(p.findings.filter((f) => f.code === "E-IMP-22").map((f) => f.key)).toEqual([
      "invoice:RE-1005",
      "invoice:RE-1006",
    ]);
    expect(missingPdfKeys(p)).toEqual(["invoice:RE-1004", "cancellation:STORNO-1004", "invoice:RE-1007"]);
    expect(p.findings.find((f) => f.code === "E-IMP-23")?.message).toBe("1 Dateien ohne passenden Beleg in der Liste.");
    expect(p.blocking).toBe(2);
  });

  test("E-IMP-22 resolutions: a manual PDF assignment or an exclusion unblocks the rows", () => {
    const { files } = fixtureFiles();
    const combined = files.find((f) => f.name === "RE-1005_RE-1006.pdf")?.id as string;
    const orphan = files.find((f) => f.name === "RE-0999.pdf")?.id as string;
    const assigned = plan(emptyLocal(), {
      pdfAssignments: { "invoice:RE-1005": combined, "invoice:RE-1006": orphan },
    }).plan;
    expect(assigned.blocking).toBe(0);
    expect(docOf(assigned, "RE-1006")?.pdfFileId).toBe(orphan);
    const re1006 = docOf(assigned, "RE-1006")?.doc.rowRef as string;
    const excluded = plan(emptyLocal(), { excluded: [re1006], pdfAssignments: { "invoice:RE-1005": combined } }).plan;
    expect(excluded.blocking).toBe(0);
    expect(docOf(excluded, "RE-1006")?.status).toBe("excluded");
  });

  test("IMP-005 number range proposals and E-IMP-11 for the invoice range (RE- vs STORNO- in 2026)", () => {
    const { plan: p } = plan();
    const invoice = p.numberRanges.find((r) => r.rangeKey === "invoice");
    expect(invoice?.candidates[0]).toMatchObject({ format: "RE-{####}", next: 1008 });
    expect(invoice?.ambiguous).toBe(true);
    expect(p.numberRanges.find((r) => r.rangeKey === "correction")?.candidates[0]).toMatchObject({
      format: "GS-{####}",
      next: 2,
    });
    expect(p.findings.some((f) => f.code === "E-IMP-11")).toBe(true);
  });

  test("TST-IMP-10 / EC-190 tax cases and deviations in the preview", () => {
    const { plan: p } = plan();
    expect(docOf(p, "RE-1003")?.doc.taxCase).toBe("intra_community_supply");
    expect(docOf(p, "RE-1003")?.deviations).toContain("Kein Leistungsdatum angegeben (§ 14 Abs. 4 Nr. 6 UStG).");
    expect(docOf(p, "RE-1005")?.doc.taxCase).toBe("unknown_imported");
    expect(docOf(p, "RE-1006")?.doc.taxCase).toBe("unknown_imported");
    expect(docOf(p, "RE-1007")?.doc.taxCase).toBe("domestic");
    expect(p.findings.filter((f) => f.code === "EC-190").length).toBeGreaterThan(0);
  });
});

describe("F09 IMP-006 idempotency, IMP-004 collisions, E-IMP-24 duplicates", () => {
  test("TST-IMP-03 IMP-006 E-IMP-04 records of an earlier import are skipped", () => {
    const { parsed } = plan();
    const keys = lookupKeys(parsed);
    expect(keys.imported).toContain(importedKey(EXTERNAL_TYPES.document, "invoice:RE-1001"));
    const imported = Object.fromEntries(keys.imported.map((k) => [k, "local-id"]));
    const p = buildPlan(
      parsed,
      emptyLocal({ imported, registerNumbers: Object.fromEntries(keys.registerNumbers.map((n) => [n, true])) }),
    );
    expect(p.counts).toMatchObject({
      contactsNew: 0,
      contactsSkipped: 3,
      productsNew: 0,
      invoices: 0,
      documentsSkipped: 9,
    });
    expect(p.findings.filter((f) => f.code === "E-IMP-06")).toEqual([]);
    expect(p.blocking).toBe(0);
  });

  test("TST-IMP-06 IMP-004 E-IMP-06 a number already in the local register (not from the import) blocks the row", () => {
    const p = plan(emptyLocal({ registerNumbers: { "RE-1007": true } })).plan;
    expect(docOf(p, "RE-1007")?.status).toBe("error");
    expect(p.findings.find((f) => f.code === "E-IMP-06")?.message).toBe(
      "Rechnungsnummer RE-1007 existiert bereits. Bitte Nummernkreise prüfen.",
    );
  });

  test("E-IMP-05 an existing local contact or product with the same number is linked, never overwritten", () => {
    const p = plan(
      emptyLocal({
        contactsByNumber: { "1001": { id: "c1", name: "Muster Bau" } },
        productsByNumber: { "ART-001": "p1" },
      }),
    ).plan;
    expect(p.contacts[0]).toMatchObject({ status: "existing", localId: "c1" });
    expect(p.products[0]).toMatchObject({ status: "existing", localId: "p1" });
    expect(docOf(p, "RE-1001")?.contact).toEqual({ kind: "local", id: "c1" });
  });

  test("E-IMP-24 overlapping exports: identical rows count once, different rows with the same number block both", () => {
    const { files, mappings } = fixtureFiles();
    const invoices = files.find((f) => f.kind === "invoices") as ImportFileInput;
    const table = invoices.table as NonNullable<ImportFileInput["table"]>;
    const copy: ImportFileInput = { ...invoices, id: "copy", name: "rechnungen-2.csv", sha256: "other" };
    const changedRecords = table.records.map((r) =>
      r.cells[0] === "RE-1007" ? { ...r, cells: r.cells.map((c, i) => (i === 9 ? "239,00" : c)) } : r,
    );
    const changed: ImportFileInput = { ...copy, id: "changed", table: { ...table, records: changedRecords } };
    const both = (extra: ImportFileInput) =>
      buildPlan(
        parseImportFiles(
          [...files, extra],
          { ...mappings, [extra.id]: mappings[invoices.id] as FileMappingInput },
          TODAY,
        ),
        emptyLocal(),
      );
    expect(both(copy).counts.duplicatesDropped).toBe(9);
    expect(both(copy).findings.some((f) => f.code === "E-IMP-24")).toBe(false);
    const conflict = both(changed);
    expect(conflict.findings.filter((f) => f.code === "E-IMP-24").map((f) => f.message)).toEqual([
      "RE-1007 ist mehrfach mit unterschiedlichen Werten enthalten (rechnungen.csv, rechnungen-2.csv).",
      "RE-1007 ist mehrfach mit unterschiedlichen Werten enthalten (rechnungen.csv, rechnungen-2.csv).",
    ]);
  });

  test("TST-IMP-09 IMP-009 the hash input is stable for unchanged input and changes with local state or resolutions", () => {
    const a = plan();
    const b = plan();
    const h = (x: ReturnType<typeof plan>, res = {}) => previewHashInput(x.files, x.mappings, res, x.plan);
    expect(h(a)).toBe(h(b));
    const changed = plan(emptyLocal({ registerNumbers: { "RE-1007": true } }));
    expect(h(changed)).not.toBe(h(a));
    expect(h(a, { excluded: ["f2:3"] })).not.toBe(h(a));
    const summary = summarizePlan(a.plan);
    expect(summary.samples.documents.length).toBeLessThanOrEqual(10);
    expect(summary.findingsTotal).toBe(a.plan.findings.length);
  });

  test("E-IMP-21 E-IMP-26 a file with a missing required column or an ambiguous format is blocked as a whole", () => {
    const { files, mappings } = fixtureFiles();
    const inv = files.find((f) => f.kind === "invoices") as ImportFileInput;
    const noGross = { ...mappings, [inv.id]: { columns: { ...mappings[inv.id]?.columns, gross: "" } } };
    const { gross: _g, ...rest } = mappings[inv.id]?.columns ?? {};
    const p = buildPlan(parseImportFiles(files, { ...noGross, [inv.id]: { columns: rest } }, TODAY), emptyLocal());
    expect(p.files.find((f) => f.id === inv.id)?.blocked).toBe(true);
    expect(p.findings.find((f) => f.code === "E-IMP-21")?.message).toBe(
      "In rechnungen.csv fehlt die Spalte für Brutto. Bitte Spaltenzuordnung ergänzen.",
    );
    expect(p.counts.invoices).toBe(0);
    expect(p.blocking).toBeGreaterThan(0);
  });
});
