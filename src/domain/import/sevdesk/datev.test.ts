import { describe, expect, test } from "vitest";
import { sevdeskVerifiedBytes } from "../../../../test/fixtures/sevdesk-export/load";
import { decodeCp1252 } from "../../csv/cp1252";
import { buchungsstapelFile, debitorenKreditorenFile, type ExtfHeader, raw, txt } from "../../datev/extf";
import type { CalendarDate } from "../../time/calendar-date";
import { parseExtf } from "./datev";
import { inspectFile } from "./files";
import { autoMap, isMappedCsvKind } from "./mapping";
import {
  buildPlan,
  type FileMappingInput,
  type ImportFileInput,
  type KuHistory,
  type LocalImportState,
  lookupKeys,
  parseImportFiles,
  previewHashInput,
} from "./preview";

/**
 * F09 IMP-026: sevdesk's DATEV export read as reference data. The EXTF fixtures are generated with our own writer
 * (`src/domain/datev/extf.ts`) — the reader is its round-trip counterpart, and the content stays synthetic.
 */
const TODAY = "2026-10-23" as CalendarDate;
const KU: KuHistory = [{ validFrom: "2026-01-01", isKU: true }];
const NOT_KU: KuHistory = [{ validFrom: "2020-01-01", isKU: false }];

const HEADER: ExtfHeader = {
  category: 21,
  formatName: "Buchungsstapel",
  formatVersion: 13,
  createdAt: "20261018120000000",
  exportedBy: "sevdesk",
  consultantNumber: 1001,
  clientNumber: 1,
  fiscalYearStart: "2026-01-01",
  accountLength: 4,
  from: "2026-01-01",
  to: "2026-10-17",
  description: "sevdesk Export",
  chart: "SKR03",
};

const booking = (belegfeld1: string, amount: string, gegenkonto: string, konto = "10000", bu?: string) => ({
  "Umsatz (ohne Soll/Haben-Kz)": raw(amount),
  "Soll/Haben-Kennzeichen": txt("S"),
  Konto: raw(konto),
  "Gegenkonto (ohne BU-Schlüssel)": raw(gegenkonto),
  ...(bu ? { "BU-Schlüssel": txt(bu) } : {}),
  Belegdatum: raw("1506"),
  "Belegfeld 1": txt(belegfeld1),
  Buchungstext: txt(`Rechnung ${belegfeld1}`),
});

/** Buchungsstapel bytes as sevdesk writes them (Windows-1252). */
const stapel = (rows: ReturnType<typeof booking>[], header: Partial<ExtfHeader> = {}) =>
  buchungsstapelFile({ ...HEADER, ...header }, 13, rows).encoded.bytes;

const stammdaten = (rows: { konto: string; name: string; kundennummer?: string }[]) =>
  debitorenKreditorenFile(
    { ...HEADER, category: 16, formatName: "Debitoren/Kreditoren" },
    rows.map((r) => ({
      Konto: raw(r.konto),
      "Name (Adressatentyp Unternehmen)": txt(r.name),
      ...(r.kundennummer ? { Kundennummer: txt(r.kundennummer) } : {}),
    })),
  ).encoded.bytes;

/** Invoice list with net/VAT/gross (so the tax case is checkable against a revenue account). */
const INVOICES = new TextEncoder().encode(
  [
    "Rechnungsnummer;Rechnungsdatum;Kundennummer;Kunde;Netto;Steuer;Brutto;Offen",
    "RE-7001;15.06.2026;1000;Muster Handel UG;100,00;0,00;100,00;0,00",
    "RE-7002;16.06.2026;1001;Beispiel GmbH;200,00;38,00;238,00;0,00",
    "RE-7003;17.06.2026;1001;Beispiel GmbH;50,00;0,00;50,00;0,00",
  ].join("\n"),
);

function prepare(input: { name: string; bytes: Uint8Array }[]) {
  const files: ImportFileInput[] = [];
  const mappings: Record<string, FileMappingInput> = {};
  input.forEach((f, i) => {
    const info = inspectFile(f.name, f.bytes);
    const id = `f${i}`;
    files.push({
      id,
      name: f.name,
      sha256: `sha-${f.name}`,
      kind: info.kind,
      ...(info.table ? { table: info.table } : {}),
      ...(info.kind === "datev" ? { text: decodeCp1252(f.bytes) } : {}),
    });
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
  opening: { date: "2026-10-18" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "ist" },
  ...over,
});

function run(
  input: { name: string; bytes: Uint8Array }[],
  ku: KuHistory = NOT_KU,
  over: Partial<LocalImportState> = {},
) {
  const p = prepare(input);
  const parsed = parseImportFiles(p.files, p.mappings, TODAY, { kleinunternehmer: ku });
  return { ...p, parsed, plan: buildPlan(parsed, local(over), {}) };
}

describe("F09 IMP-026 EXTF reader (round trip with our writer)", () => {
  test("IMP-026 the Buchungsstapel header, columns and rows read back (category 21, Sachkontenlänge, SKR03)", () => {
    const bytes = stapel([booking("RE-7002", "238,00", "8400")]);
    expect(inspectFile("EXTF_Buchungsstapel.csv", bytes).kind).toBe("datev");
    const t = parseExtf(decodeCp1252(bytes));
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value).toMatchObject({ category: 21, formatVersion: 13, accountLength: 4, chart: "SKR03" });
    expect(t.value.fiscalYearStart).toBe("2026-01-01");
    expect(t.value.columns[0]).toBe("Umsatz (ohne Soll/Haben-Kz)");
    expect(t.value.rows).toHaveLength(1);
    const cell = (name: string) => t.value.rows[0]?.cells[t.value.columns.indexOf(name)];
    expect(cell("Belegfeld 1")).toBe("RE-7002");
    expect(cell("Gegenkonto (ohne BU-Schlüssel)")).toBe("8400");
  });

  test("IMP-026 a file that is not EXTF or another format category is refused with a message", () => {
    expect(parseExtf('"Rechnungsnummer";"Datum"\n').ok).toBe(false);
    const other = parseExtf('"EXTF";700;20;"Kontenbeschriftungen";3\n"Konto"\n');
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.message).toContain("Formatkategorie 20");
  });
});

describe("F09 IMP-026 DATEV export as reference data (TST-IMP-27)", () => {
  test("IMP-026 TST-IMP-27 Stammdaten: debtor numbers land on the matching contacts (customer number, else exact name)", () => {
    const { plan } = run(
      [
        { name: "contacts.csv", bytes: sevdeskVerifiedBytes("contacts.csv") },
        {
          name: "EXTF_Stammdaten.csv",
          bytes: stammdaten([
            { konto: "10000", name: "irgendwer", kundennummer: "1000" },
            { konto: "10001", name: "Beispiel Lokal GmbH" },
            { konto: "70000", name: "Unbekannter Lieferant KG" },
          ]),
        },
      ],
      KU,
      { contactsByName: { "beispiel lokal gmbh": ["c-local"] }, contactAccounts: { "c-local": {} } },
    );
    expect(plan.datevAccounts).toEqual([
      // the contacts CSV already carries „Debitoren-Nr.“ 10000 for customer 1000: consistent, nothing to set
      expect.objectContaining({
        account: "10000",
        field: "debtorAccount",
        contact: { kind: "import", key: "n:1000" },
        status: "skip",
      }),
      expect.objectContaining({
        account: "10001",
        field: "debtorAccount",
        contact: { kind: "local", id: "c-local" },
        status: "new",
      }),
    ]);
    expect(plan.counts.datevAccounts).toBe(1);
    expect(plan.findings).toContainEqual(
      expect.objectContaining({
        code: "E-IMP-49",
        severity: "info",
        message: expect.stringContaining("1 Personenkonten"),
      }),
    );
  });

  test("IMP-026 E-IMP-47 an existing different account or an account owned by another contact is never overwritten", () => {
    const sd = stammdaten([
      { konto: "10005", name: "A", kundennummer: "K-1" },
      { konto: "10006", name: "B", kundennummer: "K-2" },
      { konto: "10007", name: "C", kundennummer: "K-3" },
    ]);
    const { plan } = run([{ name: "EXTF_Stammdaten.csv", bytes: sd }], NOT_KU, {
      contactsByNumber: {
        "K-1": { id: "c1", name: "A" },
        "K-2": { id: "c2", name: "B" },
        "K-3": { id: "c3", name: "C" },
      },
      contactAccounts: { c1: { debtorAccount: "10099" }, c2: {}, c3: { debtorAccount: "10007" } },
      accountOwners: { "10006": "c9" },
    });
    expect(plan.datevAccounts.map((a) => [a.account, a.status])).toEqual([
      ["10005", "conflict"],
      ["10006", "conflict"],
      ["10007", "skip"],
    ]);
    expect(plan.findings.filter((f) => f.code === "E-IMP-47").map((f) => f.message)).toEqual([
      "Kontakt A hat bereits das Personenkonto 10099 – 10005 aus dem DATEV-Export wird nicht übernommen.",
      "Personenkonto 10006 ist bereits einem anderen Kontakt zugeordnet – für B nicht übernommen.",
    ]);
    expect(plan.counts.datevAccounts).toBe(0);
    expect(plan.blocking).toBe(0);
  });

  test("IMP-026 TST-IMP-27 IMP-010 Buchungsstapel: the revenue account per Belegfeld 1 refines unknown tax cases when the amounts fit", () => {
    const bytes = stapel([
      booking("RE-7001", "100,00", "8125"), // innergemeinschaftliche Lieferung, no VAT in the list → fits
      booking("RE-7002", "238,00", "8400"), // 19 %, VAT 38,00 on 200,00 → already domestic, confirmed
      booking("RE-7003", "50,00", "8400"), // 19 % account but the list has no VAT → contradiction, not refined
    ]);
    const { plan } = run([
      { name: "rechnungen.csv", bytes: INVOICES },
      { name: "EXTF_Buchungsstapel.csv", bytes },
    ]);
    const doc = (n: string) => plan.documents.find((p) => p.doc.number === n)?.doc;
    expect(doc("RE-7001")).toMatchObject({ taxCase: "intra_community_supply" });
    expect(doc("RE-7001")?.groups).toEqual([
      { category: "K", rateBp: 0, netCents: 10_000, vatCents: 0, grossCents: 10_000 },
    ]);
    expect(doc("RE-7001")?.deviations).toContain("Steuerfall aus dem DATEV-Export von sevdesk (Konto 8125).");
    expect(doc("RE-7002")).toMatchObject({ taxCase: "domestic" });
    expect(doc("RE-7003")).toMatchObject({ taxCase: "unknown_imported" });
    expect(plan.findings).toContainEqual(
      expect.objectContaining({
        code: "E-IMP-48",
        severity: "warning",
        key: "invoice:RE-7003",
        message:
          "RE-7003: Konto 8400 im DATEV-Export passt nicht zu den Beträgen der Rechnungsliste – Steuerfall nicht übernommen.",
      }),
    );
    // the E-IMP-09 warning of the refined row is gone, the contradicting one stays
    const e09 = plan.findings.filter((f) => f.code === "E-IMP-09").map((f) => f.key);
    expect(e09).toEqual(["invoice:RE-7003"]);
    expect(plan.counts.datevRefined).toBe(1);
  });

  test("IMP-026 §4.3.2 the DATEV account beats the Kleinunternehmer history, but only when the amounts fit", () => {
    const bytes = stapel([booking("RE-7001", "100,00", "8120"), booking("RE-7003", "50,00", "8195")]);
    const { plan } = run(
      [
        { name: "rechnungen.csv", bytes: INVOICES },
        { name: "EXTF_Buchungsstapel.csv", bytes },
      ],
      KU,
    );
    const doc = (n: string) => plan.documents.find((p) => p.doc.number === n)?.doc;
    expect(doc("RE-7001")).toMatchObject({ taxCase: "export" });
    expect(doc("RE-7001")?.taxCaseFromCompany).toBeUndefined();
    // 8195 = Kleinunternehmer revenue: confirms what the history said
    expect(doc("RE-7003")).toMatchObject({ taxCase: "kleinunternehmer" });
  });

  test("IMP-026 §4.3.2 an explicit tax-rule label wins over the DATEV account (warning)", () => {
    const list = new TextEncoder().encode(
      "Rechnungsnummer;Rechnungsdatum;Kunde;Netto;Steuer;Brutto;Steuerregel;Offen\nRE-7101;15.06.2026;X GmbH;100,00;0,00;100,00;Ausfuhren;0,00\n",
    );
    const { plan } = run([
      { name: "rechnungen.csv", bytes: list },
      { name: "EXTF_Buchungsstapel.csv", bytes: stapel([booking("RE-7101", "100,00", "8125")]) },
    ]);
    expect(plan.documents[0]?.doc.taxCase).toBe("export");
    expect(plan.findings).toContainEqual(
      expect.objectContaining({ code: "E-IMP-48", message: expect.stringContaining("die Steuerregel gilt") }),
    );
  });

  test("IMP-026 a BU key that contradicts the revenue account, or several revenue accounts, refine nothing", () => {
    const bytes = stapel([
      booking("RE-7002", "238,00", "8400", "10000", "2"), // BU 2 = 7 % on a 19 % account
      booking("RE-7001", "60,00", "8125"),
      booking("RE-7001", "40,00", "8120"),
    ]);
    const { plan } = run([
      { name: "rechnungen.csv", bytes: INVOICES },
      { name: "EXTF_Buchungsstapel.csv", bytes },
    ]);
    const msgs = plan.findings.filter((f) => f.code === "E-IMP-48").map((f) => f.message);
    expect(msgs).toContainEqual(expect.stringContaining("BU-Schlüssel 2 passt nicht zu Konto 8400"));
    expect(msgs).toContainEqual(expect.stringContaining("mehrere Erlöskonten (8125, 8120)"));
    expect(plan.documents.find((p) => p.doc.number === "RE-7001")?.doc.taxCase).toBe("unknown_imported");
  });

  test("IMP-026 the bookings never become plan records: no documents, open items or vouchers come from the DATEV file", () => {
    const { plan, parsed } = run([
      { name: "EXTF_Buchungsstapel.csv", bytes: stapel([booking("RE-7002", "238,00", "8400")]) },
    ]);
    expect(plan.documents).toEqual([]);
    expect(plan.vouchers).toEqual([]);
    expect(plan.openItems.count).toBe(0);
    expect(plan.datevFiles).toEqual([{ id: "f0", sha256: "sha-EXTF_Buchungsstapel.csv" }]);
    expect(plan.findings).toContainEqual(
      expect.objectContaining({
        code: "IMP-026",
        message: expect.stringContaining("seine Buchungen werden nicht übernommen"),
      }),
    );
    expect(lookupKeys(parsed).imported.some((k) => k.startsWith("sevdesk.datev"))).toBe(false);
    expect(plan.blocking).toBe(0);
  });

  test("IMP-026 E-IMP-27 the preview hash covers the planned personal accounts", () => {
    const a = run(
      [{ name: "S.csv", bytes: stammdaten([{ konto: "10000", name: "A", kundennummer: "K-1" }]) }],
      NOT_KU,
      {
        contactsByNumber: { "K-1": { id: "c1", name: "A" } },
      },
    );
    const b = run(
      [{ name: "S.csv", bytes: stammdaten([{ konto: "10000", name: "A", kundennummer: "K-1" }]) }],
      NOT_KU,
      {
        contactsByNumber: { "K-1": { id: "c1", name: "A" } },
        contactAccounts: { c1: { debtorAccount: "10000" } },
      },
    );
    expect(previewHashInput(a.files, a.mappings, {}, a.plan)).not.toBe(
      previewHashInput(b.files, b.mappings, {}, b.plan),
    );
  });
});
