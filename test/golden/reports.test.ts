/**
 * TST-RPT-09 / TST-RPT-03: report CSV exports with stable headers (RPT-014, GOBD-11) and the BWA golden values
 * (RPT-003). Expected files in `reports/` (change only with `pnpm golden:update` and a written reason).
 */
import { describe, expect, test } from "vitest";
import { bwaCsv, ledgerCsv, oposCsv, REPORT_CSV_HEADERS, revenueCsv, susaCsv } from "@/domain/reports/exports";
import {
  type AccountInfo,
  bwaAmountsFromLines,
  computeBwa,
  computeLedger,
  computeSusa,
  type ReportLine,
} from "@/domain/reports/ledger-reports";
import { reportMeta } from "@/domain/reports/meta";
import { computeOpos } from "@/domain/reports/opos";
import { computeRevenue } from "@/domain/reports/revenue";

const ACCOUNTS = new Map<string, AccountInfo>(
  (
    [
      ["1200", "Forderungen aus Lieferungen und Leistungen", "asset", "NONE"],
      ["1800", "Bank", "bank", "NONE"],
      ["3806", "Umsatzsteuer 19 %", "liability", "NONE"],
      ["4400", "Erlöse 19 % USt", "revenue", "UMSATZ"],
      ["5400", "Wareneingang 19 % Vorsteuer", "expense", "WAREN"],
      ["6310", "Miete (unbewegliche Wirtschaftsgüter)", "expense", "RAUM"],
      ["6520", "Kfz-Versicherungen", "expense", "KFZ"],
      ["6600", "Werbekosten", "expense", "WERBE_REISE"],
      ["6220", "Abschreibungen auf Sachanlagen", "expense", "AFA"],
      ["6815", "Bürobedarf", "expense", "SONSTIGE"],
      ["7300", "Zinsen und ähnliche Aufwendungen", "expense", "ZINS"],
    ] as const
  ).map(([number, name, type, bwaGroup]) => [number, { number, name, type, bwaGroup }]),
);

let seq = 0;
const entry = (
  date: string,
  sourceKind: string,
  debit: string,
  credit: string,
  cents: number,
  belegfeld1 = "",
): ReportLine[] => {
  const s = ++seq;
  const base = { entryId: `e${s}`, seq: s, date, sourceKind, sourceId: `s${s}`, text: `Buchung ${s}`, belegfeld1 };
  return [
    { ...base, account: debit, debitCents: cents, creditCents: 0, contra: [credit] },
    { ...base, account: credit, debitCents: 0, creditCents: cents, contra: [debit] },
  ];
};

/** Golden year 2026 (Jan–Mar) and prior year 2025 (Jan–Mar). */
const LINES: ReportLine[] = [
  ...entry("2025-02-10", "salesDocument", "1200", "4400", 900000, "RE-2025-0007"),
  ...entry("2025-02-20", "voucher", "5400", "1800", 300000, "BE-2025-0002"),
  ...entry("2026-01-10", "salesDocument", "1200", "4400", 1000000, "RE-2026-0001"),
  ...entry("2026-01-10", "salesDocument", "1200", "3806", 190000, "RE-2026-0001"),
  ...entry("2026-02-01", "payment", "1800", "1200", 1190000, "RE-2026-0001"),
  ...entry("2026-02-05", "voucher", "5400", "1800", 350000, "BE-2026-0001"),
  ...entry("2026-03-01", "voucher", "6310", "1800", 120000, "BE-2026-0002"),
  ...entry("2026-03-02", "voucher", "6520", "1800", 45000, "BE-2026-0003"),
  ...entry("2026-03-03", "voucher", "6600", "1800", 30000, "BE-2026-0004"),
  ...entry("2026-03-15", "voucher", "6815", "1800", 4990, "BE-2026-0005"),
  ...entry("2026-03-31", "asset_depreciation", "6220", "1800", 10000),
  ...entry("2026-03-31", "manual", "7300", "1800", 2500),
];
const meta = (report: string) =>
  reportMeta({
    report,
    params: { from: "2026-01-01", to: "2026-03-31" },
    generatedAt: Date.UTC(2026, 3, 2, 8, 0),
    ruleVersions: ["chart-skr04"],
    from: "2026-01-01",
    to: "2026-03-31",
    lockedMonths: ["2026-01", "2026-02"],
  });

describe("TST-RPT-09 report CSV golden files (RPT-014, GOBD-11)", () => {
  test("RPT-014 RPT-004 SuSa CSV", async () => {
    const s = computeSusa({
      lines: LINES,
      accounts: ACCOUNTS,
      fiscalYearStart: "2026-01-01",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    await expect(susaCsv(s, meta("susa"))).toMatchFileSnapshot("./reports/susa-2026-03.csv");
  });
  test("RPT-014 RPT-005 Kontenblatt CSV", async () => {
    const l = computeLedger({ lines: LINES, account: "1800", name: "Bank", from: "2026-01-01", to: "2026-03-31" });
    await expect(ledgerCsv(l, meta("ledger"))).toMatchFileSnapshot("./reports/kontenblatt-1800-2026-q1.csv");
  });
  test("RPT-014 RPT-003 TST-RPT-03 BWA golden year: groups and % of Gesamtleistung", async () => {
    const a = (from: string, to: string) => bwaAmountsFromLines(LINES, ACCOUNTS, { from, to });
    const rows = computeBwa(
      a("2026-03-01", "2026-03-31"),
      a("2026-01-01", "2026-03-31"),
      a("2025-01-01", "2025-03-31"),
    );
    await expect(bwaCsv(rows, meta("bwa"))).toMatchFileSnapshot("./reports/bwa-2026-03.csv");
  });
  test("RPT-014 RPT-006 OPOS CSV", async () => {
    const r = computeOpos({
      side: "debtors",
      documents: [
        {
          id: "d1",
          kind: "salesDocument",
          number: "RE-2026-0002",
          contactName: "Muster GmbH",
          documentDate: "2026-02-10",
          dueDate: "2026-02-24",
          payableCents: 59500,
          currency: "EUR",
        },
      ],
      rows: [],
      asOf: "2026-03-31",
      accountBalanceCents: 59500,
      dunningLevels: { d1: 1 },
    });
    await expect(oposCsv(r, meta("opos"))).toMatchFileSnapshot("./reports/opos-2026-03-31.csv");
  });
  test("RPT-014 RPT-007 revenue CSV", async () => {
    const r = computeRevenue({
      documents: [
        {
          id: "a",
          number: "RE-1",
          type: "invoice",
          documentDate: "2026-01-10",
          contactId: "c1",
          contactName: "Muster GmbH",
          netCents: 1000000,
          grossCents: 1190000,
          lines: [],
        },
      ],
      groupBy: "customer",
      basis: "document_date",
      from: "2026-01-01",
      to: "2026-03-31",
    });
    await expect(revenueCsv(r, meta("revenue"))).toMatchFileSnapshot("./reports/umsatz-kunde-2026-q1.csv");
  });
  test("RPT-014 the documented headers are the first CSV line (UTF-8 BOM, `;`)", () => {
    const s = computeSusa({
      lines: [],
      accounts: ACCOUNTS,
      fiscalYearStart: "2026-01-01",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(susaCsv(s, meta("susa")).split("\r\n")[0]).toBe(`﻿${REPORT_CSV_HEADERS.susa.join(";")}`);
  });
});
