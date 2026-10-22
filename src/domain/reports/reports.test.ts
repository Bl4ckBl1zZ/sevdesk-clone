import { describe, expect, test } from "vitest";
import type { OpenItemDocument, SettlementRow } from "../payments/open-items";
import {
  type AccountInfo,
  bwaAmountsFromCash,
  bwaAmountsFromLines,
  computeBwa,
  computeLedger,
  computeSusa,
  type ReportLine,
} from "./ledger-reports";
import { metaLines, monthsOfRange, PROVISIONAL_NOTICE, reportMeta } from "./meta";
import { computeOpos } from "./opos";
import { computeRevenue, type RevenueDocument } from "./revenue";

const ACCOUNTS = new Map<string, AccountInfo>(
  (
    [
      ["1200", "Forderungen aus L+L", "asset", "NONE"],
      ["1800", "Bank", "bank", "NONE"],
      ["3806", "Umsatzsteuer 19 %", "liability", "NONE"],
      ["4400", "Erlöse 19 % USt", "revenue", "UMSATZ"],
      ["5400", "Wareneingang 19 %", "expense", "WAREN"],
      ["6310", "Miete", "expense", "RAUM"],
      ["6220", "Abschreibungen auf Sachanlagen", "expense", "AFA"],
      ["7300", "Zinsen", "expense", "ZINS"],
      ["9000", "Saldenvorträge", "neutral", "NONE"],
    ] as const
  ).map(([number, name, type, bwaGroup]) => [number, { number, name, type, bwaGroup }]),
);

let seq = 0;
/** One balanced entry as report lines. */
function entry(
  date: string,
  sourceKind: string,
  pairs: [debit: string, credit: string, cents: number][],
): ReportLine[] {
  const s = ++seq;
  return pairs.flatMap(([d, c, cents]) => [
    {
      entryId: `e${s}`,
      seq: s,
      date,
      account: d,
      debitCents: cents,
      creditCents: 0,
      sourceKind,
      sourceId: `s${s}`,
      text: `Buchung ${s}`,
      contra: [c],
    },
    {
      entryId: `e${s}`,
      seq: s,
      date,
      account: c,
      debitCents: 0,
      creditCents: cents,
      sourceKind,
      sourceId: `s${s}`,
      text: `Buchung ${s}`,
      contra: [d],
    },
  ]);
}

const LINES: ReportLine[] = [
  ...entry("2025-12-31", "salesDocument", [["1200", "4400", 50000]]),
  ...entry("2026-01-01", "opening_balance", [["1800", "9000", 100000]]),
  ...entry("2026-01-15", "salesDocument", [
    ["1200", "4400", 100000],
    ["1200", "3806", 19000],
  ]),
  ...entry("2026-02-01", "payment", [["1800", "1200", 119000]]),
  ...entry("2026-02-10", "voucher", [["5400", "1800", 30000]]),
  ...entry("2026-03-01", "voucher", [["6310", "1800", 12000]]),
  ...entry("2026-03-31", "asset_depreciation", [["6220", "1800", 1000]]),
  ...entry("2026-03-31", "manual", [["7300", "1800", 500]]),
  ...entry("2025-03-10", "salesDocument", [["1200", "4400", 80000]]),
];

describe("Summen- und Saldenliste and Kontenblatt (RPT-004, RPT-005)", () => {
  const susa = computeSusa({
    lines: LINES,
    accounts: ACCOUNTS,
    fiscalYearStart: "2026-01-01",
    from: "2026-03-01",
    to: "2026-03-31",
  });

  test("RPT-004 TST-RPT-01 SuSa 2026: EB-Wert from carried balances and opening entries, period vs YTD, Σ Soll = Σ Haben, totals per class", () => {
    const r1200 = susa.rows.find((r) => r.account === "1200");
    expect(r1200).toMatchObject({
      openingCents: 130000,
      ytdDebitCents: 119000,
      ytdCreditCents: 119000,
      periodDebitCents: 0,
      balanceCents: 130000,
    });
    const bank = susa.rows.find((r) => r.account === "1800");
    expect(bank).toMatchObject({
      openingCents: 100000,
      ytdDebitCents: 119000,
      ytdCreditCents: 43500,
      periodCreditCents: 13500,
      balanceCents: 175500,
    });
    expect(susa.balanced).toBe(true);
    expect(susa.totals.ytdDebitCents).toBe(susa.totals.ytdCreditCents);
    expect(susa.classes.map((c) => c.accountClass)).toEqual(["1", "3", "4", "5", "6", "7", "9"]);
    expect(
      computeSusa({
        lines: LINES,
        accounts: ACCOUNTS,
        fiscalYearStart: "2026-01-01",
        from: "2026-01-01",
        to: "2026-12-31",
        accountClass: "6",
      }).rows.map((r) => r.account),
    ).toEqual(["6220", "6310"]);
  });

  test("RPT-005 TST-RPT-01 Kontenblatt: opening balance, chronological lines with contra account and running balance; closing = SuSa balance", () => {
    const l = computeLedger({ lines: LINES, account: "1800", name: "Bank", from: "2026-02-01", to: "2026-12-31" });
    expect(l.openingCents).toBe(100000);
    expect(l.rows.map((r) => [r.date, r.contra, r.debitCents, r.creditCents, r.balanceCents])).toEqual([
      ["2026-02-01", "1200", 119000, 0, 219000],
      ["2026-02-10", "5400", 0, 30000, 189000],
      ["2026-03-01", "6310", 0, 12000, 177000],
      ["2026-03-31", "6220", 0, 1000, 176000],
      ["2026-03-31", "7300", 0, 500, 175500],
    ]);
    expect(l.closingCents).toBe(susa.rows.find((r) => r.account === "1800")?.balanceCents);
  });
});

describe("BWA-light (RPT-003)", () => {
  test("RPT-003 TST-RPT-03 groups in BWA order: Gesamtleistung, Rohertrag, Kosten, Betriebsergebnis, Zinsen, vorläufiges Ergebnis; % of Gesamtleistung", () => {
    const amounts = (from: string, to: string) => bwaAmountsFromLines(LINES, ACCOUNTS, { from, to });
    const rows = computeBwa(
      amounts("2026-03-01", "2026-03-31"),
      amounts("2026-01-01", "2026-03-31"),
      amounts("2025-01-01", "2025-03-31"),
    );
    const v = (k: string) => rows.find((r) => r.key === k);
    expect(v("umsatz")).toMatchObject({ monthCents: 0, ytdCents: 100000, priorYtdCents: 80000, ytdShareBp: 10000 });
    expect(v("rohertrag")?.ytdCents).toBe(70000);
    expect(v("gesamtkosten")?.ytdCents).toBe(13000);
    expect(v("betriebsergebnis")).toMatchObject({ ytdCents: 57000, ytdShareBp: 5700 });
    expect(v("ergebnis")?.ytdCents).toBe(56500);
    expect(rows.map((r) => r.label)[0]).toBe("Umsatzerlöse");
  });

  test("RPT-003 cash variant from the EÜR items (payment date) by the account's BWA group", () => {
    const a = bwaAmountsFromCash(
      [
        { key: "BE.STPFL", cents: 100000, date: "2026-02-01", account: "4400" },
        { key: "BE.UST_VEREINNAHMT", cents: 19000, date: "2026-02-01", account: "3806" },
        { key: "BA.WAREN", cents: 30000, date: "2026-02-10", account: "5400" },
      ],
      ACCOUNTS,
      { from: "2026-01-01", to: "2026-12-31" },
    );
    expect(a).toEqual({ UMSATZ: 100000, WAREN: 30000 });
  });
});

describe("Offene Posten (RPT-006)", () => {
  const docs: OpenItemDocument[] = [
    {
      id: "d1",
      kind: "salesDocument",
      number: "RE-1",
      contactName: "Kunde",
      documentDate: "2026-05-01",
      dueDate: "2026-05-15",
      payableCents: 119000,
      currency: "EUR",
    },
  ];
  const rows: SettlementRow[] = [
    { targetKind: "salesDocument", targetId: "d1", date: "2026-07-05", settlesCents: 119000, amountCents: 119000 },
  ];
  test("RPT-006 TST-RPT-02 as of 2026-06-30 after a payment on 2026-07-05 the invoice is open, 46 days overdue, with its dunning level", () => {
    const r = computeOpos({
      side: "debtors",
      documents: docs,
      rows,
      asOf: "2026-06-30",
      accountBalanceCents: 119000,
      dunningLevels: { d1: 1 },
    });
    expect(r.items).toEqual([
      expect.objectContaining({ id: "d1", openCents: 119000, daysOverdue: 46, bucket: "31-60" }),
    ]);
    expect(r.dunningLevels.d1).toBe(1);
    expect(r.reconciliation.differenceCents).toBe(0);
    expect(
      computeOpos({ side: "debtors", documents: docs, rows, asOf: "2026-07-31", accountBalanceCents: 0 }).items,
    ).toEqual([]);
  });

  test("RPT-006 E-RPT-06 a manual entry on the receivable account shows as a difference with its cause", () => {
    const r = computeOpos({
      side: "debtors",
      documents: docs,
      rows: [],
      asOf: "2026-06-30",
      accountBalanceCents: 119500,
      manualEntries: [{ entryId: "m1", seq: 9, date: "2026-06-01", text: "Korrektur", cents: 500 }],
    });
    expect(r.reconciliation.message).toBe("Offene Posten weichen vom Kontosaldo um 5,00 € ab.");
    expect(r.reconciliation.causes.map((c) => c.entryId)).toEqual(["m1"]);
  });
});

describe("Revenue reports (RPT-007)", () => {
  const docs: RevenueDocument[] = [
    {
      id: "a",
      number: "RE-1",
      type: "invoice",
      documentDate: "2026-03-01",
      supplyDate: "2026-02-28",
      contactId: "c1",
      contactName: "Alpha",
      netCents: 100000,
      grossCents: 119000,
      lines: [
        { productId: "p1", productName: "Beratung", netCents: 60000 },
        { productId: "p2", productName: "Lizenz", netCents: 40000 },
      ],
    },
    {
      id: "a-storno",
      number: "ST-1",
      type: "cancellation",
      documentDate: "2026-03-10",
      contactId: "c1",
      contactName: "Alpha",
      netCents: -100000,
      grossCents: -119000,
      lines: [
        { productId: "p1", productName: "Beratung", netCents: -60000 },
        { productId: "p2", productName: "Lizenz", netCents: -40000 },
      ],
    },
    {
      id: "b",
      number: "RE-2",
      type: "invoice",
      documentDate: "2026-03-05",
      contactId: "c2",
      contactName: "Beta",
      netCents: 50000,
      grossCents: 59500,
      lines: [{ productId: "p1", productName: "Beratung", netCents: 50000 }],
    },
  ];
  test("RPT-007 TST-RPT-04 by customer with a Storno: the cancelled invoice nets to 0", () => {
    const r = computeRevenue({
      documents: docs,
      groupBy: "customer",
      basis: "document_date",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(r.groups.map((g) => [g.label, g.netCents, g.grossCents])).toEqual([
      ["Beta", 50000, 59500],
      ["Alpha", 0, 0],
    ]);
    expect(r.totals).toEqual({ netCents: 50000, grossCents: 59500 });
  });
  test("RPT-007 by product, by month (supply date) and cash basis (pro rata of the payment)", () => {
    const p = computeRevenue({
      documents: docs,
      groupBy: "product",
      basis: "document_date",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(p.groups.map((g) => [g.label, g.netCents])).toEqual([
      ["Beratung", 50000],
      ["Lizenz", 0],
    ]);
    const m = computeRevenue({
      documents: docs,
      groupBy: "month",
      basis: "supply_date",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(m.groups.map((g) => [g.key, g.netCents])).toEqual([
      ["2026-02", 100000],
      ["2026-03", -50000],
    ]);
    const c = computeRevenue({
      documents: docs,
      payments: [{ documentId: "b", date: "2026-04-02", settlesCents: 29750 }],
      groupBy: "customer",
      basis: "cash",
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(c.groups).toEqual([expect.objectContaining({ label: "Beta", netCents: 25000, grossCents: 29750 })]);
  });
  test("RPT-007 PRJ-002 by project: line projects win over the document project; Storno netted; unassigned revenue", () => {
    const byProject: RevenueDocument[] = [
      { ...(docs[0] as RevenueDocument), projectId: "prj1" },
      { ...(docs[1] as RevenueDocument), projectId: "prj1" },
      {
        ...(docs[2] as RevenueDocument),
        lines: [
          { productId: "p1", productName: "Beratung", netCents: 30000, projectId: "prj2" },
          { productId: "p1", productName: "Beratung", netCents: 20000 },
        ],
      },
      {
        id: "c",
        number: "RE-3",
        type: "invoice",
        documentDate: "2026-03-20",
        contactId: "c1",
        contactName: "Alpha",
        projectId: "prj1",
        netCents: 10000,
        grossCents: 11900,
        lines: [{ productName: "Hosting", netCents: 10000, projectId: "prj2" }],
      },
    ];
    const r = computeRevenue({
      documents: byProject,
      groupBy: "project",
      basis: "document_date",
      from: "2026-03-01",
      to: "2026-03-31",
      projects: new Map([
        ["prj1", "PRJ-00001 Website"],
        ["prj2", "PRJ-00002 Shop"],
      ]),
    });
    expect(r.groups.map((g) => [g.label, g.netCents, g.grossCents, g.documents])).toEqual([
      ["PRJ-00002 Shop", 40000, 47600, 2],
      ["ohne Projekt", 20000, 23800, 1],
      ["PRJ-00001 Website", 0, 0, 2],
    ]);
    expect(r.totals).toEqual({ netCents: 60000, grossCents: 71400 });
  });
});

describe("report header facts (RPT-001, E-RPT-01)", () => {
  test("RPT-001 E-RPT-01 TST-RPT-08 a range with an unlocked month is „vorläufig“; parameters, rule versions and Berlin time in the footer", () => {
    expect(monthsOfRange("2025-11-15", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    const m = reportMeta({
      report: "susa",
      params: { from: "2026-01-01", to: "2026-03-31" },
      generatedAt: Date.UTC(2026, 3, 1, 22, 30),
      ruleVersions: ["chart-skr04"],
      from: "2026-01-01",
      to: "2026-03-31",
      lockedMonths: ["2026-01", "2026-02"],
    });
    expect(m.provisional).toBe(true);
    expect(m.notice).toBe(PROVISIONAL_NOTICE);
    expect(metaLines(m)).toEqual([
      ["Erstellt am", "02.04.2026, 00:30"],
      ["Parameter", "from=2026-01-01, to=2026-03-31"],
      ["Regelversionen", "chart-skr04"],
      ["Festschreibung", "vorläufig (2 von 3 Monaten festgeschrieben)"],
    ]);
    expect(
      reportMeta({ ...m, from: "2026-01-01", to: "2026-02-28", lockedMonths: ["2026-01", "2026-02"] }).provisional,
    ).toBe(false);
  });
});
