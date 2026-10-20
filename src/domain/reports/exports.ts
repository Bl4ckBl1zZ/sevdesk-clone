/**
 * Report exports (F08 RPT-014, GOBD-11 Z2 evaluations): CSV (UTF-8 with BOM, `;`, decimal comma without thousands
 * separator — the shared `writeCsv`) and the section model of the PDF/A renderer (src/pdf/import-protocol.tsx). The
 * CSV columns are documented here and stable (golden headers, TST-RPT-09); every file ends with the RPT-001 facts
 * (generation time, parameters, rule versions, lock status). Pure.
 */
import { writeCsv } from "../csv/csv";
import type { ImportProtocol, ProtocolSection } from "../import/sevdesk/protocol";
import { formatEuro } from "../money";
import type { AccountLedger, BwaRow, Susa } from "./ledger-reports";
import { metaLines, type ReportMeta } from "./meta";
import type { OposReport } from "./opos";
import type { RevenueReport } from "./revenue";

/** "-1234,56": decimal comma, no thousands separator (cells stay numeric in spreadsheets). */
export const plainCents = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined) return "";
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
};
const dateDe = (iso: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const pct = (bp: number | null) => (bp === null ? "" : plainCents(bp));

/** The stable CSV headers per report (TST-RPT-09). */
export const REPORT_CSV_HEADERS = {
  susa: [
    "Konto",
    "Bezeichnung",
    "Kontenklasse",
    "EB-Wert",
    "Soll Zeitraum",
    "Haben Zeitraum",
    "Soll kumuliert",
    "Haben kumuliert",
    "Saldo",
  ],
  ledger: ["Datum", "Buchung", "Belegfeld 1", "Buchungstext", "Gegenkonto", "Soll", "Haben", "Saldo"],
  bwa: ["Position", "Monat", "Kumuliert", "Vorjahr kumuliert", "% der Gesamtleistung"],
  opos: [
    "Nummer",
    "Kontakt",
    "Datum",
    "Fällig am",
    "Betrag",
    "Bezahlt",
    "Offen",
    "Tage überfällig",
    "Mahnstufe",
    "Altersklasse",
  ],
  revenue: ["Gruppe", "Netto", "Brutto", "Belege"],
} as const;

const withMeta = (rows: (string | number)[][], meta: ReportMeta) => [
  ...rows,
  [],
  ...metaLines(meta).map(([k, v]) => [k, v]),
];

export function susaCsv(s: Susa, meta: ReportMeta): string {
  const rows: (string | number)[][] = s.rows.map((r) => [
    r.account,
    r.name,
    r.accountClass,
    plainCents(r.openingCents),
    plainCents(r.periodDebitCents),
    plainCents(r.periodCreditCents),
    plainCents(r.ytdDebitCents),
    plainCents(r.ytdCreditCents),
    plainCents(r.balanceCents),
  ]);
  for (const c of s.classes) {
    rows.push([
      `Summe Klasse ${c.accountClass}`,
      "",
      c.accountClass,
      plainCents(c.openingCents),
      plainCents(c.periodDebitCents),
      plainCents(c.periodCreditCents),
      plainCents(c.ytdDebitCents),
      plainCents(c.ytdCreditCents),
      plainCents(c.balanceCents),
    ]);
  }
  const t = s.totals;
  rows.push([
    "Summe",
    s.balanced ? "Soll = Haben" : "Soll ≠ Haben",
    "",
    plainCents(t.openingCents),
    plainCents(t.periodDebitCents),
    plainCents(t.periodCreditCents),
    plainCents(t.ytdDebitCents),
    plainCents(t.ytdCreditCents),
    plainCents(t.balanceCents),
  ]);
  return writeCsv(REPORT_CSV_HEADERS.susa, withMeta(rows, meta));
}

export function ledgerCsv(l: AccountLedger, meta: ReportMeta): string {
  const rows: (string | number)[][] = [
    [dateDe(l.from), "", "", "Anfangsbestand", "", "", "", plainCents(l.openingCents)],
    ...l.rows.map((r) => [
      dateDe(r.date),
      r.seq,
      r.belegfeld1,
      r.text,
      r.contra,
      plainCents(r.debitCents || null),
      plainCents(r.creditCents || null),
      plainCents(r.balanceCents),
    ]),
    [
      dateDe(l.to),
      "",
      "",
      "Endbestand",
      "",
      plainCents(l.debitCents),
      plainCents(l.creditCents),
      plainCents(l.closingCents),
    ],
  ];
  return writeCsv(REPORT_CSV_HEADERS.ledger, withMeta(rows, meta));
}

export function bwaCsv(rows: readonly BwaRow[], meta: ReportMeta): string {
  return writeCsv(
    REPORT_CSV_HEADERS.bwa,
    withMeta(
      rows.map((r) => [
        r.label,
        plainCents(r.monthCents),
        plainCents(r.ytdCents),
        plainCents(r.priorYtdCents),
        pct(r.ytdShareBp),
      ]),
      meta,
    ),
  );
}

export function oposCsv(r: OposReport, meta: ReportMeta): string {
  const rows: (string | number)[][] = r.items.map((i) => [
    i.number,
    i.contactName,
    dateDe(i.documentDate),
    dateDe(i.dueDate ?? ""),
    plainCents(i.payableCents),
    plainCents(i.paidCents),
    plainCents(i.openCents),
    i.daysOverdue,
    r.dunningLevels[i.id] ?? 0,
    r.totals.buckets.find((b) => b.key === i.bucket)?.label ?? i.bucket,
  ]);
  rows.push([], ["Kontensaldo", "", "", "", plainCents(r.reconciliation.accountBalanceCents)]);
  rows.push(["Summe offene Posten", "", "", "", plainCents(r.reconciliation.openItemsCents)]);
  if (r.reconciliation.message)
    rows.push(["Differenz", r.reconciliation.message, "", "", plainCents(r.reconciliation.differenceCents)]);
  return writeCsv(REPORT_CSV_HEADERS.opos, withMeta(rows, meta));
}

export function revenueCsv(r: RevenueReport, meta: ReportMeta): string {
  const rows: (string | number)[][] = r.groups.map((g) => [
    g.label,
    plainCents(g.netCents),
    plainCents(g.grossCents),
    g.documents,
  ]);
  rows.push(["Summe", plainCents(r.totals.netCents), plainCents(r.totals.grossCents), ""]);
  return writeCsv(REPORT_CSV_HEADERS.revenue, withMeta(rows, meta));
}

// ── PDF section models ─────────────────────────────────────────────────────────────────────────────────

function doc(
  title: string,
  subtitle: string,
  fileName: string,
  meta: ReportMeta,
  sections: ProtocolSection[],
): ImportProtocol {
  return {
    title,
    subtitle,
    fileName,
    createdAt: meta.generatedAt,
    sections: [
      ...(meta.notice ? [{ title: "Hinweis", paragraphs: [meta.notice] }] : []),
      ...sections,
      { title: "Stand", table: { headers: ["Angabe", "Wert"], widths: [25, 75], rows: metaLines(meta) } },
    ],
    footer: metaLines(meta)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · "),
  };
}

const eur = (c: number) => formatEuro(c);

export function susaDocument(s: Susa, meta: ReportMeta, company: string): ImportProtocol {
  return doc(
    `Summen- und Saldenliste ${dateDe(s.from)} – ${dateDe(s.to)}`,
    company,
    `SuSa_${s.from}_${s.to}.pdf`,
    meta,
    [
      {
        title: "Konten",
        table: {
          headers: ["Konto", "Bezeichnung", "EB-Wert", "Soll", "Haben", "Soll kum.", "Haben kum.", "Saldo"],
          widths: [8, 28, 9, 9, 9, 9, 9, 9],
          rows: [
            ...s.rows.map((r) => [
              r.account,
              r.name,
              eur(r.openingCents),
              eur(r.periodDebitCents),
              eur(r.periodCreditCents),
              eur(r.ytdDebitCents),
              eur(r.ytdCreditCents),
              eur(r.balanceCents),
            ]),
            [
              "Summe",
              s.balanced ? "Soll = Haben" : "Soll ≠ Haben",
              eur(s.totals.openingCents),
              eur(s.totals.periodDebitCents),
              eur(s.totals.periodCreditCents),
              eur(s.totals.ytdDebitCents),
              eur(s.totals.ytdCreditCents),
              eur(s.totals.balanceCents),
            ],
          ],
        },
      },
    ],
  );
}

export function ledgerDocument(l: AccountLedger, meta: ReportMeta, company: string): ImportProtocol {
  return doc(
    `Kontenblatt ${l.account} ${l.name}`,
    `${company} · ${dateDe(l.from)} – ${dateDe(l.to)}`,
    `Kontenblatt_${l.account}_${l.from}_${l.to}.pdf`,
    meta,
    [
      {
        title: "Buchungen",
        table: {
          headers: ["Datum", "Nr.", "Beleg", "Text", "Gegenkonto", "Soll", "Haben", "Saldo"],
          widths: [10, 6, 12, 28, 10, 11, 11, 12],
          rows: [
            ["", "", "", "Anfangsbestand", "", "", "", eur(l.openingCents)],
            ...l.rows.map((r) => [
              dateDe(r.date),
              String(r.seq),
              r.belegfeld1,
              r.text,
              r.contra,
              r.debitCents ? eur(r.debitCents) : "",
              r.creditCents ? eur(r.creditCents) : "",
              eur(r.balanceCents),
            ]),
            ["", "", "", "Endbestand", "", eur(l.debitCents), eur(l.creditCents), eur(l.closingCents)],
          ],
        },
      },
    ],
  );
}

export function bwaDocument(rows: readonly BwaRow[], meta: ReportMeta, company: string, title: string): ImportProtocol {
  return doc(title, company, `${title.replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`, meta, [
    {
      title: "Positionen",
      table: {
        headers: ["Position", "Monat", "Kumuliert", "Vorjahr kum.", "%"],
        widths: [40, 15, 15, 15, 15],
        rows: rows.map((r) => [
          r.label,
          eur(r.monthCents),
          eur(r.ytdCents),
          eur(r.priorYtdCents),
          r.ytdShareBp === null ? "" : `${pct(r.ytdShareBp)} %`,
        ]),
      },
    },
  ]);
}

export function oposDocument(r: OposReport, meta: ReportMeta, company: string): ImportProtocol {
  const side = r.side === "debtors" ? "Debitoren" : "Kreditoren";
  return doc(`Offene Posten ${side} zum ${dateDe(r.asOf)}`, company, `OPOS_${r.side}_${r.asOf}.pdf`, meta, [
    {
      title: "Posten",
      table: {
        headers: ["Nummer", "Kontakt", "Fällig", "Betrag", "Bezahlt", "Offen", "Tage", "Stufe"],
        widths: [13, 25, 11, 12, 12, 12, 7, 8],
        rows: r.items.map((i) => [
          i.number,
          i.contactName,
          dateDe(i.dueDate ?? ""),
          eur(i.payableCents),
          eur(i.paidCents),
          eur(i.openCents),
          String(i.daysOverdue),
          String(r.dunningLevels[i.id] ?? 0),
        ]),
      },
    },
    {
      title: "Altersstruktur und Abstimmung",
      paragraphs: [
        ...r.totals.buckets.map((b) => `${b.label}: ${eur(b.openCents)} (${b.count})`),
        `Kontensaldo ${eur(r.reconciliation.accountBalanceCents)} · offene Posten ${eur(r.reconciliation.openItemsCents)}`,
        ...(r.reconciliation.message ? [r.reconciliation.message] : []),
      ],
    },
  ]);
}

export function revenueDocument(r: RevenueReport, meta: ReportMeta, company: string, title: string): ImportProtocol {
  return doc(title, company, `Umsatz_${r.groupBy}_${r.from}_${r.to}.pdf`, meta, [
    {
      title: "Umsatz",
      table: {
        headers: ["Gruppe", "Netto", "Brutto", "Belege"],
        widths: [50, 18, 18, 14],
        rows: [
          ...r.groups.map((g) => [g.label, eur(g.netCents), eur(g.grossCents), String(g.documents)]),
          ["Summe", eur(r.totals.netCents), eur(r.totals.grossCents), ""],
        ],
      },
    },
  ]);
}
