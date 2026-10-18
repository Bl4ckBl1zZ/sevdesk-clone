import { describe, expect, test } from "vitest";
import { sevdeskVerifiedBytes, sevdeskVerifiedPdfNames } from "../../../../test/fixtures/sevdesk-export/load";
import type { CalendarDate } from "../../time/calendar-date";
import { inspectFile } from "./files";
import { autoMap, isMappedCsvKind } from "./mapping";
import {
  buildPlan,
  type FileMappingInput,
  type ImportFileInput,
  type ImportResolutions,
  type KuHistory,
  type LocalImportState,
  parseImportFiles,
  previewHashInput,
  summarizePlan,
} from "./preview";

/**
 * F09 E-IMP-10 „beim Import buchen“ (IMP-003, IMP-007, EC-204) and the corrected total of a row (EC-203, E-IMP-37)
 * over the verified sevdesk layout (Kleinunternehmer account, synthetic content). The whole sevdesk history lies in
 * the booked period: Buchungsbeginn 2026-06-01, documents June–September 2026.
 */
const TODAY = "2026-10-18" as CalendarDate;
const KU: KuHistory = [{ validFrom: "2026-01-01", isKU: true }];
const START = "2026-06-01" as CalendarDate;

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
  opening: { date: START, fiscalYear: 2026, receivablesPosted: false, taxedAs: "ist" },
  ...over,
});

function run(resolutions: ImportResolutions = {}, over: Partial<LocalImportState> = {}, ku: KuHistory = KU) {
  const { files, mappings } = verifiedFiles();
  const parsed = parseImportFiles(files, mappings, TODAY, { kleinunternehmer: ku });
  return { files, mappings, parsed, plan: buildPlan(parsed, local(over), resolutions) };
}
type Plan = ReturnType<typeof run>["plan"];
const doc = (p: Plan, number: string) => p.documents.find((d) => d.doc.number === number);
const POST: ImportResolutions = { postBookedPeriod: true };

describe("F09 E-IMP-10 documents dated on/after the Buchungsbeginn (IMP-003, IMP-007)", () => {
  test("E-IMP-10 without the owner's choice every booked-period row stays blocked and the choice is offered", () => {
    const { plan } = run();
    const late = plan.findings.filter((f) => f.code === "E-IMP-10" && f.severity === "error");
    expect(late.map((f) => f.key).sort()).toEqual([
      "cancellation:RE-5003",
      "invoice:RE-5000",
      "invoice:RE-5001",
      "invoice:RE-5002",
      "invoice:RE-5004",
    ]);
    expect(late.find((f) => f.key === "invoice:RE-5000")?.message).toBe(
      "RE-5000 liegt am oder nach dem Buchungsbeginn (01.06.2026). Bitte „Beim Import buchen“ wählen oder Zeile ausschließen.",
    );
    expect(plan.blocking).toBe(5);
    expect(plan.bookedPeriod).toEqual({ date: START, count: 5, post: false, paidInSevdesk: 0 });
    expect(plan.documents.some((d) => d.post)).toBe(false);
  });

  test("E-IMP-10 EC-204 with „beim Import buchen“ the rows are committed as posted documents, open for the bank import", () => {
    const { plan } = run(POST);
    expect(plan.blocking).toBe(0);
    expect(plan.documents.every((d) => d.status === "new" && d.post === true)).toBe(true);
    // EC-204: open receivables with their gross even if sevdesk says paid — the bank statement brings the payment.
    expect(doc(plan, "RE-5000")).toMatchObject({ paymentStatus: "open", openAmountCents: 99_830 });
    expect(doc(plan, "RE-5001")).toMatchObject({ paymentStatus: "open", openAmountCents: 154_880 });
    expect(doc(plan, "RE-5004")).toMatchObject({ paymentStatus: "open", openAmountCents: 55_600 });
    // The Storno pair: the original is cancelled (nothing open), the Storno reverses its entry.
    expect(doc(plan, "RE-5002")).toMatchObject({ finalStatus: "cancelled", openAmountCents: 0 });
    expect(doc(plan, "RE-5002")?.paymentStatus).toBeUndefined();
    expect(doc(plan, "RE-5003")).toMatchObject({ correctsKey: "invoice:RE-5002", post: true });
    // „Bezahlt am“ is kept as a hint on the document.
    expect(doc(plan, "RE-5000")?.deviations).toContain(
      "Laut sevdesk bezahlt am 11.06.2026 – als offene Forderung übernommen; die Zahlung wird über den Kontoauszug zugeordnet.",
    );
    expect(doc(plan, "RE-5004")?.deviations.some((x) => x.startsWith("Laut sevdesk bezahlt"))).toBe(false);
    // No supply date in sevdesk's list: harmless under § 19 (no tax point), stated as an import assumption.
    expect(doc(plan, "RE-5000")?.deviations).toContain(
      "Leistungsdatum für die Buchung = Rechnungsdatum (Import-Annahme; maßgeblich ist das Original-PDF).",
    );
    // No F08 opening items for posted documents (never a second receivable, EC-201).
    expect(plan.opening).toBeNull();
    expect(plan.openItems).toEqual({ count: 0, totalCents: 0 });
    expect(plan.counts.booked).toBe(5);
    expect(plan.bookedPeriod).toEqual({ date: START, count: 5, post: true, paidInSevdesk: 2 });
    expect(plan.findings.find((f) => f.code === "E-IMP-10" && f.severity === "info")?.message).toBe(
      "5 Belege ab dem Buchungsbeginn (01.06.2026) werden beim Import gebucht – wie eigene Rechnungen, mit dem Original-PDF (nie neu erzeugt).",
    );
    expect(plan.findings.find((f) => f.code === "E-IMP-39")).toMatchObject({
      severity: "warning",
      message:
        "3 gebuchte Rechnungen werden als offene Forderungen übernommen, davon 2 laut sevdesk bereits bezahlt. Bitte die Kontoauszüge ab dem Buchungsbeginn (01.06.2026) importieren, damit die Zahlungen zugeordnet werden; Barzahlungen als Zahlung erfassen. Mahnungen erst danach erstellen.",
    });
  });

  test("E-IMP-10 rows before the Buchungsbeginn keep the archive behaviour (F08 opening item for the open one)", () => {
    const { plan } = run(POST, {
      opening: { date: "2026-08-01" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "ist" },
    });
    expect(plan.blocking).toBe(0);
    expect(doc(plan, "RE-5000")).toMatchObject({ paymentStatus: "paid", openAmountCents: 0 });
    expect(doc(plan, "RE-5000")?.post).toBeUndefined();
    expect(doc(plan, "RE-5002")?.post).toBeUndefined();
    // RE-5003 (Storno, 12.08.) is posted; its original RE-5002 (29.07.) was archived: the reversal finds nothing.
    expect(doc(plan, "RE-5003")?.post).toBe(true);
    expect(doc(plan, "RE-5004")).toMatchObject({ post: true, openAmountCents: 55_600 });
    expect(plan.opening).toBeNull();
  });

  test("E-IMP-10 ACC-006 a locked period (e.g. UStVA filed) blocks posting into it", () => {
    const { plan } = run(POST, { closedPeriods: { "2026-09": "ustva_submitted" } });
    expect(doc(plan, "RE-5004")?.status).toBe("error");
    expect(plan.findings.find((f) => f.key === "invoice:RE-5004" && f.severity === "error")?.message).toBe(
      "RE-5004: Der Zeitraum 09/2026 ist festgeschrieben (UStVA abgegeben) – der Beleg kann nicht mehr gebucht werden. Bitte Zeile ausschließen.",
    );
    expect(doc(plan, "RE-5000")?.status).toBe("new");
  });

  test("E-IMP-10 IMP-010 an unknown tax case cannot be posted (F08 refuses unknown_imported)", () => {
    const { plan } = run(POST, {}, []);
    expect(doc(plan, "RE-5000")?.status).toBe("error");
    expect(plan.findings.find((f) => f.key === "invoice:RE-5000" && f.code === "E-IMP-10")?.message).toBe(
      "RE-5000: Steuerfall nicht eindeutig – der Beleg kann nicht gebucht werden. Bitte Steuerangaben ergänzen oder Zeile ausschließen.",
    );
  });

  test("E-IMP-10 a Storno can only be posted together with the invoice it cancels", () => {
    const original = run(POST);
    const re5002 = doc(original.plan, "RE-5002")?.doc.rowRef as string;
    const { plan } = run({ ...POST, excluded: [re5002] });
    expect(doc(plan, "RE-5003")?.status).toBe("error");
    expect(plan.findings.find((f) => f.key === "cancellation:RE-5003" && f.severity === "error")?.message).toBe(
      "RE-5003: Die stornierte Rechnung RE-5002 wird nicht mit übernommen – die Stornorechnung kann ohne sie nicht gebucht werden. Bitte beide übernehmen oder beide ausschließen.",
    );
  });

  test("E-IMP-10 UVA-01 a VAT invoice under Soll needs its supply date for the tax period (never guessed)", () => {
    const csv =
      "Rechnungsnummer;Rechnungsdatum;Kunde;Netto;Steuer;Brutto;Steuersatz;Offener Betrag\n" +
      "RE-7001;10.07.2026;Muster GmbH;100,00;19,00;119,00;19;0,00\n";
    const info = inspectFile("liste.csv", new TextEncoder().encode(csv));
    const files: ImportFileInput[] = [
      { id: "u1", name: "liste.csv", sha256: "x", kind: info.kind, ...(info.table ? { table: info.table } : {}) },
    ];
    const parsed = parseImportFiles(files, { u1: { columns: autoMap("invoices", info.headers ?? []) } }, TODAY);
    const soll = buildPlan(
      parsed,
      local({ opening: { date: START, fiscalYear: 2026, receivablesPosted: false, taxedAs: "soll" } }),
      POST,
    );
    expect(soll.documents[0]?.status).toBe("error");
    expect(soll.findings.find((f) => f.code === "E-IMP-10" && f.severity === "error")?.message).toBe(
      "RE-7001: Leistungsdatum fehlt – es bestimmt den Umsatzsteuer-Zeitraum. Bitte die Spalte „Leistungsdatum“ zuordnen oder Zeile ausschließen.",
    );
    // Under Ist the VAT of a domestic invoice is declared on payment: the document date stands in (flagged).
    const ist = buildPlan(parsed, local(), POST);
    expect(ist.documents[0]).toMatchObject({ status: "new", post: true, openAmountCents: 11_900 });
  });

  test("IMP-009 the owner's choice and the posting are part of the preview hash", () => {
    const a = run();
    const b = run(POST);
    expect(previewHashInput(a.files, a.mappings, {}, a.plan)).not.toBe(
      previewHashInput(b.files, b.mappings, POST, b.plan),
    );
    expect(summarizePlan(b.plan).bookedPeriod).toEqual({ date: START, count: 5, post: true, paidInSevdesk: 2 });
  });
});

describe("F09 EC-203 E-IMP-37 corrected total of a row without VAT", () => {
  const corrected = (grossCents: number, reason = "Betrag laut PDF") => ({
    ...POST,
    correctedTotals: { "invoice:RE-5000": { grossCents, reason } },
  });

  test("EC-203 the owner enters the gross from the PDF: net = gross, recorded as a deviation and an info", () => {
    const { plan } = run(corrected(99_910, "PDF zeigt 999,10 €"));
    const d = doc(plan, "RE-5000");
    expect(d?.doc.totals).toEqual({ netCents: 99_910, vatCents: 0, grossCents: 99_910 });
    expect(d?.doc.groups).toEqual([{ category: "KU", rateBp: 0, netCents: 99_910, vatCents: 0, grossCents: 99_910 }]);
    expect(d?.correction).toEqual({ exportedGrossCents: 99_830, grossCents: 99_910, reason: "PDF zeigt 999,10 €" });
    expect(d?.deviations).toContain(
      "Betrag gegenüber sevdesk-Export korrigiert: 998,30 € → 999,10 € (PDF zeigt 999,10 €).",
    );
    expect(plan.findings.find((f) => f.code === "E-IMP-37" && f.key === "invoice:RE-5000")).toMatchObject({
      severity: "info",
      message: "RE-5000: Betrag gegenüber sevdesk-Export korrigiert: 998,30 € → 999,10 € (PDF zeigt 999,10 €).",
    });
    // Posted: the open amount follows the corrected gross.
    expect(d).toMatchObject({ openAmountCents: 99_910, paymentStatus: "open" });
  });

  test("EC-203 archived rows: a paid row stays paid (open 0), an open row follows the corrected gross", () => {
    const archive = {
      date: "2026-10-01" as CalendarDate,
      fiscalYear: 2026,
      receivablesPosted: false,
      taxedAs: "ist",
    } as const;
    const paid = run(
      { correctedTotals: { "invoice:RE-5001": { grossCents: 154_800, reason: "PDF" } } },
      { opening: archive },
    );
    expect(doc(paid.plan, "RE-5001")).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    expect(doc(paid.plan, "RE-5001")?.doc.totals.grossCents).toBe(154_800);
    const open = run(
      { correctedTotals: { "invoice:RE-5004": { grossCents: 56_000, reason: "PDF" } } },
      { opening: archive },
    );
    expect(doc(open.plan, "RE-5004")).toMatchObject({ openAmountCents: 56_000, paymentStatus: "open" });
    expect(open.plan.opening?.items).toEqual([{ key: "invoice:RE-5004", openCents: 56_000, notDueVat: [] }]);
  });

  test("EC-203 a correction needs a reason, a valid amount of the same sign and a row without VAT", () => {
    expect(doc(run(corrected(99_910, "  ")).plan, "RE-5000")?.status).toBe("error");
    expect(
      run(corrected(99_910, " ")).plan.findings.find((f) => f.key === "invoice:RE-5000" && f.severity === "error")
        ?.message,
    ).toBe("RE-5000: Bitte einen Grund für die Betragskorrektur angeben.");
    expect(doc(run(corrected(-99_910)).plan, "RE-5000")?.status).toBe("error");
    expect(doc(run(corrected(0)).plan, "RE-5000")?.status).toBe("error");
    const csv =
      "Rechnungsnummer;Rechnungsdatum;Lieferdatum;Kunde;Netto;Steuer;Brutto;Steuersatz;Offener Betrag\n" +
      "RE-7001;10.07.2026;10.07.2026;Muster GmbH;100,00;19,00;119,00;19;0,00\n";
    const info = inspectFile("liste.csv", new TextEncoder().encode(csv));
    const files: ImportFileInput[] = [
      { id: "u1", name: "liste.csv", sha256: "x", kind: info.kind, ...(info.table ? { table: info.table } : {}) },
    ];
    const parsed = parseImportFiles(files, { u1: { columns: autoMap("invoices", info.headers ?? []) } }, TODAY);
    const vat = buildPlan(parsed, local(), {
      correctedTotals: { "invoice:RE-7001": { grossCents: 12_000, reason: "x" } },
    });
    expect(vat.documents[0]?.status).toBe("error");
    expect(vat.findings.find((f) => f.code === "E-IMP-37" && f.severity === "error")?.message).toBe(
      "RE-7001: Der Betrag kann nur bei Belegen ohne Umsatzsteuer (eine Steuergruppe mit 0 %) korrigiert werden.",
    );
  });

  test("EC-203 a posted Storno must match its corrected original (S12 reverses the whole invoice)", () => {
    const { plan } = run({
      ...POST,
      correctedTotals: { "invoice:RE-5002": { grossCents: 51_480, reason: "PDF" } },
    });
    expect(doc(plan, "RE-5003")?.status).toBe("error");
    expect(plan.findings.find((f) => f.key === "cancellation:RE-5003" && f.severity === "error")?.message).toBe(
      "RE-5003: Der Betrag der Stornorechnung (-514,00 €) entspricht nicht der Rechnung RE-5002 (514,80 €). Bitte Betrag korrigieren oder beide Zeilen ausschließen.",
    );
    const both = run({
      ...POST,
      correctedTotals: {
        "invoice:RE-5002": { grossCents: 51_480, reason: "PDF" },
        "cancellation:RE-5003": { grossCents: -51_480, reason: "PDF" },
      },
    });
    expect(both.plan.blocking).toBe(0);
  });

  test("IMP-009 corrections are part of the preview hash and listed for the E-IMP-37 check", () => {
    const a = run(POST);
    const b = run(corrected(99_910));
    expect(previewHashInput(a.files, a.mappings, POST, a.plan)).not.toBe(
      previewHashInput(b.files, b.mappings, corrected(99_910), b.plan),
    );
    const list = summarizePlan(b.plan).correctable;
    expect(list.map((c) => c.number)).toEqual(["RE-5004", "RE-5003", "RE-5002", "RE-5001", "RE-5000"]);
    expect(list.find((c) => c.number === "RE-5000")).toEqual({
      key: "invoice:RE-5000",
      number: "RE-5000",
      documentDate: "2026-06-10",
      exportedGrossCents: 99_830,
      grossCents: 99_910,
      reason: "Betrag laut PDF",
    });
    expect(list.find((c) => c.number === "RE-5001")).toEqual({
      key: "invoice:RE-5001",
      number: "RE-5001",
      documentDate: "2026-06-26",
      exportedGrossCents: 154_880,
      grossCents: 154_880,
    });
  });
});
