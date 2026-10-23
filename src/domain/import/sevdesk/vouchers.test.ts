import { describe, expect, test } from "vitest";
import { sevdeskVerifiedBytes } from "../../../../test/fixtures/sevdesk-export/load";
import type { CalendarDate } from "../../time/calendar-date";
import { inspectFile } from "./files";
import { autoMap, checkMapping, classifyFile } from "./mapping";
import {
  buildPlan,
  type FileMappingInput,
  type ImportFileInput,
  type ImportResolutions,
  type KuHistory,
  type LocalImportState,
  lookupKeys,
  parseImportFiles,
  previewHashInput,
} from "./preview";
import { vatOfGross } from "./vouchers";

/**
 * F09 IMP-025 historical vouchers from the voucher list CSV (verified header layout, synthetic content in
 * `test/fixtures/sevdesk-export-verified/voucher.csv`) and the voucher files.
 */
const TODAY = "2026-10-23" as CalendarDate;
const KU: KuHistory = [{ validFrom: "2026-01-01", isKU: true }];
const enc = new TextEncoder();
const PDF_001 = sevdeskVerifiedBytes("belege/Beleg_ER-2026-001.pdf");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function files(extra: { name: string; bytes: Uint8Array }[] = [], csv = sevdeskVerifiedBytes("voucher.csv")) {
  const all = [{ name: "voucher.csv", bytes: csv }, ...extra];
  const out: ImportFileInput[] = [];
  const mappings: Record<string, FileMappingInput> = {};
  all.forEach((f, i) => {
    const info = inspectFile(f.name, f.bytes);
    const id = `f${i}`;
    out.push({
      id,
      name: f.name,
      sha256: `sha-${f.name}`,
      kind: info.kind,
      ...(info.table ? { table: info.table } : {}),
    });
    if (info.kind === "vouchers" && info.headers) mappings[id] = { columns: autoMap("vouchers", info.headers) };
  });
  return { files: out, mappings };
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
  extra: { name: string; bytes: Uint8Array }[] = [],
  opts: { over?: Partial<LocalImportState>; resolutions?: ImportResolutions; csv?: Uint8Array; ku?: KuHistory } = {},
) {
  const f = files(extra, opts.csv);
  const parsed = parseImportFiles(f.files, f.mappings, TODAY, { kleinunternehmer: opts.ku ?? KU });
  return { ...f, parsed, plan: buildPlan(parsed, local(opts.over), opts.resolutions ?? {}) };
}

const WITH_FILES = [
  { name: "Beleg_ER-2026-001.pdf", bytes: PDF_001 },
  { name: "ER-2026-002.jpg", bytes: JPEG },
];

describe("F09 IMP-025 voucher list: classification and mapping", () => {
  test("IMP-025 IMP-016 the verified voucher list („Belegnummer“, „Datum“, „Lieferant / Kunde“) is classified as vouchers", () => {
    const info = inspectFile("voucher.csv", sevdeskVerifiedBytes("voucher.csv"));
    expect(info.kind).toBe("vouchers");
    expect(info.headers).toContain("Position");
  });

  test("IMP-025 IMP-017 the shipped preset maps every verified header; number, date and amount are required", () => {
    const info = inspectFile("voucher.csv", sevdeskVerifiedBytes("voucher.csv"));
    const m = autoMap("vouchers", info.headers ?? []);
    expect(m).toEqual({
      number: "Belegnummer",
      status: "Status",
      position: "Position",
      supplierName: "Lieferant / Kunde",
      category: "Kategorie",
      description: "Beschreibung",
      documentDate: "Datum",
      dueDate: "Fällig am",
      paidOn: "Bezahlt am",
      open: "offener Betrag",
      amount: "Betrag",
      costCenter: "Kostenstelle",
      rate: "Umsatzsteuersatz",
    });
    expect(checkMapping("vouchers", info.headers ?? [], m).missing).toEqual([]);
    const { amount: _a, ...withoutAmount } = m;
    expect(checkMapping("vouchers", info.headers ?? [], withoutAmount).missing).toEqual(["amount"]);
  });

  test("IMP-025 JPEG and PNG voucher files are recognised by their magic bytes (not read as CSV)", () => {
    expect(classifyFile({ name: "beleg.jpg", head: JPEG })).toBe("image");
    expect(classifyFile({ name: "x", head: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) })).toBe("image");
    expect(inspectFile("ER-2026-002.jpg", JPEG).table).toBeUndefined();
  });
});

describe("F09 IMP-025 voucher list: parsing", () => {
  test("IMP-025 a header row with its position rows becomes one voucher; VAT is derived from the gross half-up", () => {
    const { parsed } = run();
    expect(parsed.vouchers.map((v) => v.number)).toEqual(["ER-2026-001", "ER-2026-002", "ER-2026-003"]);
    const v2 = parsed.vouchers[1];
    expect(v2?.supplierName).toBe("Beispiel Software AG");
    expect(v2?.documentDate).toBe("2026-04-15");
    expect(v2?.lines).toEqual([
      expect.objectContaining({ position: 1, rateBp: 1900, grossCents: 11_900, vatCents: 1_900, netCents: 10_000 }),
      expect.objectContaining({ position: 2, rateBp: 700, grossCents: 1_800, vatCents: 118, netCents: 1_682 }),
    ]);
    expect(v2?.lines[1]?.description).toBe("Fachliteratur – Handbuch");
    expect(v2?.totals).toEqual({
      netCents: 11_682,
      vatCents: 2_018,
      grossCents: 13_700,
      byRate: [
        { rateBp: 1900, netCents: 10_000, vatCents: 1_900 },
        { rateBp: 700, netCents: 1_682, vatCents: 118 },
      ],
    });
    expect(v2?.statedGrossCents).toBe(13_700);
    expect(v2?.openAmountCents).toBe(0);
    // integer half-away rounding: 0,05 € at 7 % contains 0,00327… € → 0 ct; 0,15 € → 0,98 ct → 1 ct
    expect(vatOfGross(5, 700)).toBe(0);
    expect(vatOfGross(15, 700)).toBe(1);
  });

  test("IMP-025 archival tax rule: a Kleinunternehmer on the voucher date deducts no input VAT; otherwise as printed", () => {
    expect(run().parsed.vouchers[0]?.taxRule).toBe("no_input_vat");
    const regular = run([], { ku: [{ validFrom: "2020-01-01", isKU: false }] }).parsed.vouchers;
    expect(regular[0]?.taxRule).toBe("input_vat_deductible");
    // ER-2026-003 carries 0 % VAT: nothing to deduct either way
    expect(regular[2]?.taxRule).toBe("no_input_vat");
  });

  test("IMP-025 E-IMP-46 categories without a chart account are archived only (one info per file)", () => {
    const { parsed } = run();
    expect(parsed.vouchers[0]?.lines[0]?.account).toBe("");
    const info = parsed.findings.filter((f) => f.code === "E-IMP-46");
    expect(info).toHaveLength(1);
    expect(info[0]?.severity).toBe("info");
    expect(info[0]?.message).toContain("4 Belegpositionen ohne Buchungskonto");
  });

  test("IMP-025 E-IMP-08 a position sum that differs from the Belegsumme is imported as exported with a warning", () => {
    const csv = enc.encode(
      "Belegnummer;Status;Position;Lieferant / Kunde;Kategorie;Beschreibung;Datum;Betrag;Umsatzsteuersatz\nB-1;bezahlt;;Muster GmbH;;;01.02.2026;100,00;\nB-1;bezahlt;1;Muster GmbH;Miete;;01.02.2026;99,99;19\n",
    );
    const { parsed } = run([], { csv });
    expect(parsed.vouchers[0]?.totals.grossCents).toBe(9_999);
    expect(parsed.vouchers[0]?.statedGrossCents).toBe(10_000);
    expect(parsed.findings).toContainEqual(
      expect.objectContaining({
        code: "E-IMP-08",
        severity: "warning",
        message: "Summen von B-1 weichen um 0,01 € ab (übernommen wie im sevdesk-Export).",
      }),
    );
  });

  test("IMP-025 E-IMP-45 a negative amount (credit note or income) is never sign-flipped — the row is blocked", () => {
    const csv = enc.encode(
      "Belegnummer;Status;Lieferant / Kunde;Datum;Betrag;Umsatzsteuersatz\nB-9;bezahlt;Muster GmbH;01.02.2026;-50,00;19\n",
    );
    const { parsed, plan } = run([], { csv });
    expect(parsed.vouchers).toHaveLength(0);
    expect(parsed.findings).toContainEqual(expect.objectContaining({ code: "E-IMP-45", severity: "error" }));
    expect(plan.blocking).toBe(1);
  });

  test("IMP-025 drafts in the voucher list are not imported", () => {
    const csv = enc.encode(
      "Belegnummer;Status;Lieferant / Kunde;Datum;Betrag\nB-7;Entwurf;Muster GmbH;01.02.2026;50,00\n",
    );
    const { parsed } = run([], { csv });
    expect(parsed.vouchers).toHaveLength(0);
    expect(parsed.skippedDrafts).toBe(1);
  });
});

describe("F09 IMP-025 voucher plan (TST-IMP-26)", () => {
  test("IMP-025 TST-IMP-26 paid vouchers before the Buchungsbeginn are planned with their files (PDF and image, matched by number)", () => {
    const { plan, files: f } = run(WITH_FILES);
    const byNumber = (n: string) => plan.vouchers.find((p) => p.voucher.number === n);
    expect(byNumber("ER-2026-001")).toMatchObject({ status: "new", fileId: f[1]?.id });
    expect(byNumber("ER-2026-002")).toMatchObject({ status: "new", fileId: f[2]?.id });
    expect(plan.counts.vouchers).toBe(2);
    expect(plan.pdf.orphans).toEqual([]);
  });

  test("IMP-025 E-IMP-43 an open voucher is blocked (no opening payables carry it)", () => {
    const { plan } = run(WITH_FILES);
    const open = plan.vouchers.find((p) => p.voucher.number === "ER-2026-003");
    expect(open?.status).toBe("error");
    expect(plan.findings).toContainEqual(
      expect.objectContaining({
        code: "E-IMP-43",
        severity: "error",
        message: expect.stringContaining("ER-2026-003 ist noch offen (25,00 €)"),
      }),
    );
    expect(plan.blocking).toBe(1);
    // excluding the row unblocks the import
    const excluded = run(WITH_FILES, { resolutions: { excluded: [open?.voucher.rowRef as string] } }).plan;
    expect(excluded.blocking).toBe(0);
    expect(excluded.counts.vouchersExcluded).toBe(1);
  });

  test("IMP-025 E-IMP-42 a voucher without its original file is blocked (RI-21) until a file is assigned", () => {
    const only001 = run([{ name: "Beleg_ER-2026-001.pdf", bytes: PDF_001 }]);
    const v2 = only001.plan.vouchers.find((p) => p.voucher.number === "ER-2026-002");
    expect(v2?.status).toBe("error");
    expect(only001.plan.findings).toContainEqual(
      expect.objectContaining({
        code: "E-IMP-42",
        severity: "error",
        message:
          "Für Beleg ER-2026-002 wurde keine Belegdatei gefunden. Bitte die Datei hochladen und zuordnen oder die Zeile ausschließen.",
      }),
    );
    // a manual assignment (pdfAssignments) attaches a file whose name does not carry the number
    const assigned = run([...WITH_FILES.slice(0, 1), { name: "scan-17.png", bytes: JPEG }], {
      resolutions: { pdfAssignments: { [v2?.voucher.key as string]: "f2" } },
    });
    expect(assigned.plan.vouchers.find((p) => p.voucher.number === "ER-2026-002")).toMatchObject({
      status: "new",
      fileId: "f2",
    });
  });

  test("IMP-025 E-IMP-44 a voucher on/after the Buchungsbeginn is never archived without its booking", () => {
    const { plan } = run(WITH_FILES, {
      over: {
        opening: { date: "2026-04-01" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "ist" },
      },
    });
    expect(plan.vouchers.find((p) => p.voucher.number === "ER-2026-001")?.status).toBe("new");
    expect(plan.vouchers.find((p) => p.voucher.number === "ER-2026-002")?.status).toBe("error");
    expect(plan.findings).toContainEqual(
      expect.objectContaining({
        code: "E-IMP-44",
        message: expect.stringContaining("ER-2026-002 liegt am oder nach dem Buchungsbeginn (01.04.2026)"),
      }),
    );
    const noStart = run(WITH_FILES, { over: { opening: null } }).plan;
    expect(noStart.vouchers.every((p) => p.status === "error")).toBe(true);
    expect(noStart.findings.filter((f) => f.code === "E-IMP-44")).toHaveLength(3);
  });

  test("IMP-025 IMP-006 a voucher imported earlier is skipped on a re-run", () => {
    const first = run(WITH_FILES);
    const keys = lookupKeys(first.parsed).imported.filter((k) => k.startsWith("sevdesk.voucher|"));
    expect(keys).toHaveLength(3);
    const again = run(WITH_FILES, { over: { imported: { [keys[0] as string]: "v1" } } }).plan;
    expect(again.vouchers[0]).toMatchObject({ status: "skip", localId: "v1" });
    expect(again.counts.vouchersSkipped).toBe(1);
  });

  test("IMP-025 E-IMP-27 the preview hash covers the voucher plan (a different file assignment changes it)", () => {
    const a = run(WITH_FILES);
    const b = run([...WITH_FILES.slice(0, 1)]);
    expect(previewHashInput(a.files, a.mappings, {}, a.plan)).not.toBe(
      previewHashInput(b.files, b.mappings, {}, b.plan),
    );
  });
});
