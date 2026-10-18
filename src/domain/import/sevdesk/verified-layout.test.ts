import { describe, expect, test } from "vitest";
import { sevdeskVerifiedBytes, sevdeskVerifiedPdfNames } from "../../../../test/fixtures/sevdesk-export/load";
import type { CalendarDate } from "../../time/calendar-date";
import { inspectFile } from "./files";
import { autoMap, checkMapping, isMappedCsvKind } from "./mapping";
import {
  buildPlan,
  type FileMappingInput,
  type ImportFileInput,
  type KuHistory,
  type LocalImportState,
  parseImportFiles,
} from "./preview";

/**
 * F09 §4.3 against the layout of real sevdesk exports (2026-10-18, Kleinunternehmer account; open item 9 resolved):
 * synthetic content in `test/fixtures/sevdesk-export-verified/`.
 */
const TODAY = "2026-10-18" as CalendarDate;
const KU: KuHistory = [{ validFrom: "2026-01-01", isKU: true }];

function verifiedFiles() {
  const names = [
    "contacts.csv",
    "18-10-2026_part.csv",
    "invoices.csv",
    ...sevdeskVerifiedPdfNames().map((n) => `pdf/${n}`),
  ];
  const files: ImportFileInput[] = [];
  const mappings: Record<string, FileMappingInput> = {};
  names.forEach((path, i) => {
    const name = path.replace(/^pdf\//, "");
    const info = inspectFile(name, sevdeskVerifiedBytes(path));
    const id = `f${i}`;
    files.push({ id, name, sha256: `sha-${name}`, kind: info.kind, ...(info.table ? { table: info.table } : {}) });
    if (isMappedCsvKind(info.kind) && info.headers) mappings[id] = { columns: autoMap(info.kind, info.headers) };
  });
  return { files, mappings };
}

const local = (over: Partial<LocalImportState> = {}): LocalImportState => ({
  today: TODAY,
  imported: {},
  registerNumbers: {},
  contactsByNumber: {},
  contactsByName: {},
  productsByNumber: {},
  documentsByNumber: {},
  ranges: [],
  opening: { date: "2026-10-01" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "ist" },
  ...over,
});

function run(kleinunternehmer: KuHistory = KU, over: Partial<LocalImportState> = {}) {
  const { files, mappings } = verifiedFiles();
  const parsed = parseImportFiles(files, mappings, TODAY, { kleinunternehmer });
  return { files, mappings, parsed, plan: buildPlan(parsed, local(over), {}) };
}
const doc = (p: ReturnType<typeof run>["plan"], number: string) => p.documents.find((d) => d.doc.number === number);

describe("F09 TST-IMP-16 verified sevdesk layout: classification and mapping (IMP-016, IMP-017)", () => {
  test("IMP-016 contacts (two BOMs), part list and invoice list are recognised; the PDFs from the ZIP too", () => {
    const { files } = verifiedFiles();
    expect(files.map((f) => f.kind)).toEqual(["contacts", "products", "invoices", "pdf", "pdf", "pdf", "pdf", "pdf"]);
    expect(files[0]?.table?.headers[0]).toBe("Kunden-Nr.");
  });

  test("IMP-017 E-IMP-39 the sevdesk invoice list maps by name („Bezahlt am“ as a hint); the unnamed reference column stays unmapped", () => {
    const inv = inspectFile("invoices.csv", sevdeskVerifiedBytes("invoices.csv"));
    const m = autoMap("invoices", inv.headers ?? []);
    expect(m).toEqual({
      number: "Rechnungs-Nr.",
      documentDate: "Rechnungs-Datum",
      dueDate: "Fällig am",
      paidOn: "Bezahlt am",
      subject: "Betreff",
      net: "Gesamtbetrag-Netto",
      gross: "Gesamtbetrag-Brutto",
      open: "offener Betrag",
      customerNumber: "Empfänger-KdNr",
      customerName: "Empfänger-Adresse",
    });
    expect(checkMapping("invoices", inv.headers ?? [], m)).toMatchObject({ missing: [], conflicts: [] });
  });

  test("IMP-017 contacts map „UmSt.-ID“ and the Leitweg-ID; products map „Verkaufspreis“ as the net price", () => {
    const c = inspectFile("contacts.csv", sevdeskVerifiedBytes("contacts.csv"));
    expect(autoMap("contacts", c.headers ?? [])).toMatchObject({
      number: "Kunden-Nr.",
      organizationName: "Organisation",
      vatId: "UmSt.-ID",
      buyerReference: "Leitweg-ID / Leitwegsnummer",
      street: "Strasse",
    });
    const p = inspectFile("18-10-2026_part.csv", sevdeskVerifiedBytes("18-10-2026_part.csv"));
    expect(autoMap("products", p.headers ?? [])).toMatchObject({ netPrice: "Verkaufspreis", vat: "Umsatzsteuer" });
  });
});

describe("F09 §4.3.3 verified sevdesk layout: type and status without type/status columns", () => {
  test("§4.3.3 a Storno is recognised by its subject and cancels its original; the rest follows the open amount", () => {
    const { plan } = run();
    expect(doc(plan, "RE-5003")).toMatchObject({
      status: "new",
      doc: { type: "cancellation", referenceNumber: "RE-5002" },
      correctsKey: "invoice:RE-5002",
    });
    expect(doc(plan, "RE-5002")).toMatchObject({ status: "new", finalStatus: "cancelled" });
    expect(doc(plan, "RE-5002")?.paymentStatus).toBeUndefined();
    expect(doc(plan, "RE-5000")).toMatchObject({ finalStatus: "sent", paymentStatus: "paid" });
    expect(doc(plan, "RE-5001")).toMatchObject({ finalStatus: "sent", paymentStatus: "paid" });
    // RE-5004 is open and predates the Buchungsbeginn 2026-10-01 → an F08 opening receivable (IMP-007).
    expect(doc(plan, "RE-5004")).toMatchObject({ status: "new", paymentStatus: "open", openAmountCents: 55_600 });
    expect(plan.opening?.items.map((i) => [i.key, i.openCents, i.notDueVat])).toEqual([
      ["invoice:RE-5004", 55_600, []],
    ]);
    const late = run(KU, {
      opening: { date: "2026-09-01" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "ist" },
    });
    expect(late.plan.documents.find((d) => d.doc.number === "RE-5004")?.status).toBe("error");
  });

  test("IMP-019 the ZIP's file names (date_Rechnung_number_hash.pdf) match their rows", () => {
    const { plan } = run();
    const name = (id?: string) => plan.documentFiles.find((f) => f.id === id)?.name ?? "";
    for (const n of ["RE-5000", "RE-5001", "RE-5002", "RE-5003", "RE-5004"]) {
      expect(name(doc(plan, n)?.pdfFileId), n).toMatch(new RegExp(`_${n}_[0-9a-f]{32}\\.pdf$`));
    }
    expect(plan.findings.filter((f) => f.code === "E-IMP-22" || f.code === "E-IMP-23")).toEqual([]);
  });
});

describe("F09 IMP-010 EC-202 tax case of a sevdesk invoice list without tax columns", () => {
  test("EC-202 E-IMP-38 net = gross and the company is Kleinunternehmer on the document date → kleinunternehmer", () => {
    const { plan } = run();
    const re1000 = doc(plan, "RE-5000");
    expect(re1000?.doc).toMatchObject({
      taxCase: "kleinunternehmer",
      groups: [{ category: "KU", rateBp: 0, netCents: 99_830, vatCents: 0, grossCents: 99_830 }],
    });
    // EC-190 lists deviations of the document, not columns sevdesk's list does not export (supply date is on the PDF).
    expect(re1000?.deviations).toEqual([]);
    expect(plan.findings.filter((f) => f.code === "E-IMP-09")).toEqual([]);
    expect(plan.findings.find((f) => f.code === "E-IMP-38" && !f.fileName)).toMatchObject({
      severity: "info",
      message:
        "5 Rechnungen ohne Steuerangabe werden als Kleinunternehmer-Rechnungen (§ 19 UStG) übernommen, weil Ihr Unternehmen am Rechnungsdatum Kleinunternehmer war (Einstellungen › Steuern).",
    });
  });

  test("EC-202 not Kleinunternehmer on the document date → unknown_imported (archived only, E-IMP-09)", () => {
    const later = run([{ validFrom: "2026-07-01", isKU: true }]);
    expect(doc(later.plan, "RE-5000")?.doc.taxCase).toBe("unknown_imported");
    expect(doc(later.plan, "RE-5002")?.doc.taxCase).toBe("kleinunternehmer");
    expect(later.plan.findings.filter((f) => f.code === "E-IMP-09").map((f) => f.key)).toEqual([
      "invoice:RE-5001",
      "invoice:RE-5000",
    ]);
    const never = run([]);
    expect(never.plan.documents.every((d) => d.doc.taxCase === "unknown_imported")).toBe(true);
    expect(never.plan.findings.some((f) => f.code === "E-IMP-38")).toBe(false);
    expect(never.plan.findings.filter((f) => f.code === "E-IMP-09")).toHaveLength(5);
  });

  test("EC-202 a file that maps a VAT column is never resolved via the company setting", () => {
    const { files, mappings } = verifiedFiles();
    const inv = files.findIndex((f) => f.kind === "invoices");
    const id = `f${inv}`;
    const m = mappings[id];
    if (!m) throw new Error("mapping");
    // Owner maps the (empty) IBAN column as VAT: the file now claims to carry tax data → no KU fallback.
    const parsed = parseImportFiles(
      files,
      { ...mappings, [id]: { ...m, columns: { ...m.columns, vat: "Empfänger-IBAN" } } },
      TODAY,
      { kleinunternehmer: KU },
    );
    expect(parsed.documents.every((d) => d.taxCase === "unknown_imported")).toBe(true);
  });

  test("EC-203 E-IMP-37 an invoice list without tax data asks the owner to compare the totals with the PDFs", () => {
    const { plan } = run();
    expect(plan.findings.find((f) => f.code === "E-IMP-37")).toMatchObject({
      severity: "warning",
      fileName: "invoices.csv",
      message:
        "invoices.csv enthält keine Steuer- und Positionsangaben. Bitte die Gesamtbeträge vor der Übernahme mit den PDFs vergleichen – sevdesk exportiert in Einzelfällen abweichende Beträge (z. B. nach Teilzahlungen). Ein übernommener Beleg kann danach nicht mehr geändert werden.",
    });
  });
});

describe("F09 PRD-082 products of a Kleinunternehmer export (Umsatzsteuer 0,00)", () => {
  test("EC-202 under § 19 UStG 0 % is not ambiguous: the dormant key „standard“ is stored, with one notice", () => {
    const { plan } = run();
    expect(plan.products.map((p) => [p.number, p.form.price, p.form.vatRateKey])).toEqual([
      ["1001", "6,50", "standard"],
      ["1000", "20,00", "standard"],
    ]);
    expect(plan.findings.filter((f) => f.code === "E-IMP-16")).toEqual([]);
    expect(plan.findings.find((f) => f.code === "E-IMP-38" && f.fileName === "18-10-2026_part.csv")).toMatchObject({
      severity: "info",
      message:
        "18-10-2026_part.csv: 2 Artikel mit 0 % Umsatzsteuer erhalten den Steuersatz „Standard“. Er wird angewendet, sobald Sie die Kleinunternehmerregelung verlassen – bitte dann prüfen.",
    });
  });

  test("PRD-082 without Kleinunternehmer status 0 % stays ambiguous (E-IMP-16)", () => {
    const { plan } = run([]);
    expect(plan.findings.filter((f) => f.code === "E-IMP-16" && f.fileName === "18-10-2026_part.csv")).toHaveLength(2);
  });
});

describe("F09 §4.3.6 number range continuation over the verified layout", () => {
  test("IMP-004 Stornos share the invoice range: RE-5000…RE-5004 → next RE-5005", () => {
    const { plan } = run();
    const invoice = plan.numberRanges.find((r) => r.rangeKey === "invoice");
    expect(invoice?.ambiguous).toBe(false);
    expect(invoice?.candidates[0]).toMatchObject({ lastImported: "RE-5004", next: 5005 });
  });
});
