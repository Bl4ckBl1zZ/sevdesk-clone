/**
 * F09 EXP-020 Kennzahlen sheets for the manual entry in Mein ELSTER (F08 TAX-006/TAX-010): the UStVA sheet with
 * „laut Formular" and „laut Buchhaltung", the ZM rows per USt-IdNr — as CSV (UTF-8 with BOM, `;`, decimal comma
 * without grouping) and as a section model for the PDF/A renderer (src/pdf/import-protocol.tsx). Every sheet carries
 * the footer: generation time, rule versions, period lock status and filing status. Pure; the sheets themselves are
 * computed by F08 (src/domain/tax/ustva.ts, zm.ts).
 *
 * The EÜR sheet (Anlage EÜR lines and AVEÜR, F08 TAX-015/TAX-022) uses the same footer.
 */
import { writeCsv } from "../csv/csv";
import type { ImportProtocol, ProtocolSection } from "../import/sevdesk/protocol";
import { formatEuro } from "../money";
import type { Aveuer, EuerSheet } from "../tax/euer";
import { filingPeriodLabel, type UstvaSheet } from "../tax/ustva";
import type { ZmSheet } from "../tax/zm";

export interface SheetFooter {
  generatedAt: number;
  ruleVersions: readonly string[];
  /** Months of the filing period and which of them are locked (F08 ACC-015). */
  months: readonly string[];
  lockedMonths: readonly string[];
  /** Active filing record of the period (F08 TAX-021), if any. */
  filing: { status: string; submittedOn: string | null; transmissionTicket: string | null } | null;
}

/** "-1234,56" — decimal comma, no thousands separator (CSV cells stay numeric in spreadsheets). */
const plain = (cents: number | undefined) => {
  if (cents === undefined) return "";
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
};
const monthLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const dateDe = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

export function lockStatusText(f: Pick<SheetFooter, "months" | "lockedMonths">): string {
  const locked = new Set(f.lockedMonths);
  const open = f.months.filter((m) => !locked.has(m));
  if (open.length === 0) return "festgeschrieben";
  if (open.length === f.months.length) return "nicht festgeschrieben";
  return `teilweise festgeschrieben (offen: ${open.map(monthLabel).join(", ")})`;
}

export function filingStatusText(f: SheetFooter["filing"]): string {
  if (!f) return "nicht übermittelt";
  const on = f.submittedOn ? ` am ${dateDe(f.submittedOn)}` : "";
  const ticket = f.transmissionTicket ? `, Transferticket ${f.transmissionTicket}` : "";
  return `übermittelt${on} (manuell in Mein ELSTER${ticket})`;
}

export function footerLines(f: SheetFooter): [string, string][] {
  return [
    ["Erstellt am", DATE_TIME.format(f.generatedAt)],
    ["Regelversionen", f.ruleVersions.filter(Boolean).join(", ") || "—"],
    ["Festschreibung", lockStatusText(f)],
    ["Abgabestatus", filingStatusText(f.filing)],
  ];
}

const footerText = (f: SheetFooter) =>
  footerLines(f)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");

// ── UStVA ────────────────────────────────────────────────────────────────────────────────────────────────

export function ustvaSheetCsv(sheet: UstvaSheet, footer: SheetFooter): string {
  const rows: (string | number)[][] = sheet.fields.map((f) => [
    f.kz,
    f.label,
    plain(f.valueCents),
    plain(f.formTaxCents),
    plain(f.bookedTaxCents ?? f.exactCents),
    plain(f.differenceCents),
  ]);
  rows.push([], ...footerLines(footer).map(([k, v]) => [k, v]));
  return writeCsv(
    ["Kennzahl", "Bezeichnung", "Wert (Formular)", "Steuer laut Formular", "laut Buchhaltung", "Differenz"],
    rows,
  );
}

export function ustvaSheetDocument(sheet: UstvaSheet, footer: SheetFooter, company: string): ImportProtocol {
  const label = filingPeriodLabel(sheet.period);
  const sections: ProtocolSection[] = [
    {
      title: "Kennzahlen",
      paragraphs: [
        "Werte zur manuellen Eingabe in Mein ELSTER. Bemessungsgrundlagen in vollen Euro; „laut Formular“ ist die vom Formular berechnete Steuer, „laut Buchhaltung“ die gebuchte.",
      ],
      table: {
        headers: ["Kz", "Bezeichnung", "Wert", "laut Formular", "laut Buchhaltung", "Differenz"],
        widths: [7, 41, 13, 13, 13, 13],
        rows: [
          ...sheet.fields.map((f) => [
            f.kz,
            f.label,
            formatEuro(f.valueCents),
            f.formTaxCents === undefined ? "" : formatEuro(f.formTaxCents),
            (f.bookedTaxCents ?? f.exactCents) === undefined
              ? ""
              : formatEuro((f.bookedTaxCents ?? f.exactCents) as number),
            f.differenceCents === undefined ? "" : formatEuro(f.differenceCents),
          ]),
        ],
      },
    },
    ...(sheet.notices.length ? [{ title: "Hinweise", paragraphs: [...sheet.notices] }] : []),
    { title: "Stand", table: { headers: ["Angabe", "Wert"], widths: [25, 75], rows: footerLines(footer) } },
  ];
  return {
    title: `Umsatzsteuer-Voranmeldung ${label} – Kennzahlen`,
    subtitle: `${company} · Formularjahr ${sheet.formYear} · Zuordnung ${sheet.mappingVersion}${sheet.verified ? "" : " (nicht verifiziert)"}`,
    fileName: `UStVA_${sheet.period}_Kennzahlen.pdf`,
    createdAt: footer.generatedAt,
    sections,
    footer: footerText(footer),
  };
}

// ── ZM ───────────────────────────────────────────────────────────────────────────────────────────────────

const ZM_TYPE: Readonly<Record<string, string>> = {
  L: "Innergemeinschaftliche Lieferung",
  S: "Sonstige Leistung",
  D: "Dreiecksgeschäft",
};

export function zmSheetCsv(zm: ZmSheet, footer: SheetFooter): string {
  const rows: (string | number)[][] = zm.rows.map((r) => [
    r.countryCode,
    r.vatNumber,
    r.name,
    r.type,
    String(r.euros),
    plain(r.exactCents),
  ]);
  rows.push(["Summe", "", "", "", String(zm.totalEuros), ""]);
  rows.push([], ...footerLines(footer).map(([k, v]) => [k, v]));
  return writeCsv(["Land", "USt-IdNr.", "Name", "Art", "Betrag (Euro, Formular)", "laut Buchhaltung"], rows);
}

export function zmSheetDocument(zm: ZmSheet, footer: SheetFooter, company: string): ImportProtocol {
  const label = filingPeriodLabel(zm.period);
  return {
    title: `Zusammenfassende Meldung ${label}`,
    subtitle: company,
    fileName: `ZM_${zm.period}.pdf`,
    createdAt: footer.generatedAt,
    sections: [
      {
        title: "Meldezeilen",
        table: {
          headers: ["Land", "USt-IdNr.", "Name", "Art", "Betrag (Euro)", "laut Buchhaltung"],
          widths: [7, 17, 30, 18, 14, 14],
          rows: [
            ...zm.rows.map((r) => [
              r.countryCode,
              r.vatNumber,
              r.name,
              ZM_TYPE[r.type] ?? r.type,
              String(r.euros),
              formatEuro(r.exactCents),
            ]),
            ["", "", "Summe", "", String(zm.totalEuros), ""],
          ],
        },
      },
      ...(zm.warnings.length ? [{ title: "Hinweise", paragraphs: [...zm.warnings] }] : []),
      { title: "Stand", table: { headers: ["Angabe", "Wert"], widths: [25, 75], rows: footerLines(footer) } },
    ],
    footer: footerText(footer),
  };
}

// ── EÜR (F08 TAX-015/TAX-022) ────────────────────────────────────────────────────────────────────────────

const EUER_HINT: Readonly<Record<string, string>> = { nicht_abziehbar: " (nicht abziehbar)" };

/** Rows Zeile · Kz · Bezeichnung · Betrag: non-zero lines by Zeile, then the sums 159/199/219. */
export function euerRows(sheet: EuerSheet): [string, string, string, number][] {
  const rows: [string, string, string, number][] = sheet.lines
    .filter((l) => l.valueCents !== 0 && l.section !== "PRIVAT")
    .sort((a, b) => a.zeile - b.zeile)
    .map((l) => [
      String(l.zeile),
      l.kz,
      `${l.label}${l.column ? (EUER_HINT[l.column] ?? "") : ""}${l.informational ? " (nachrichtlich)" : ""}`,
      l.valueCents,
    ]);
  if (sheet.sumFields) {
    const s = sheet.sumFields;
    rows.push(
      [String(s.einnahmen.zeile), s.einnahmen.kz, "Summe Betriebseinnahmen", sheet.sums.einnahmenCents],
      [String(s.ausgaben.zeile), s.ausgaben.kz, "Summe Betriebsausgaben", sheet.sums.ausgabenCents],
      [String(s.gewinn.zeile), s.gewinn.kz, "Steuerpflichtiger Gewinn/Verlust", sheet.sums.gewinnCents],
    );
  }
  for (const l of sheet.lines.filter((x) => x.section === "PRIVAT" && x.valueCents !== 0)) {
    rows.push([String(l.zeile), l.kz, l.label, l.valueCents]);
  }
  return rows;
}

export function euerSheetCsv(sheet: EuerSheet, aveuer: Aveuer | null, footer: SheetFooter): string {
  const rows: (string | number)[][] = euerRows(sheet).map(([z, kz, label, cents]) => [z, kz, label, plain(cents)]);
  if (aveuer) {
    rows.push([], ["Anlage AVEÜR"]);
    for (const g of aveuer.groups) {
      for (const f of g.fields) rows.push([String(f.zeile), f.kz, `${g.title}: ${f.label}`, plain(f.valueCents)]);
    }
  }
  rows.push([], ...footerLines(footer).map(([k, v]) => [k, v]));
  return writeCsv(["Zeile", "Kz", "Bezeichnung", "Betrag"], rows);
}

export function euerSheetDocument(
  sheet: EuerSheet,
  aveuer: Aveuer | null,
  footer: SheetFooter,
  company: string,
): ImportProtocol {
  const sections: ProtocolSection[] = [
    {
      title: "Anlage EÜR",
      paragraphs: [
        "Werte zur manuellen Eingabe in Mein ELSTER (Einnahmen und Ausgaben nach Zahlungszeitpunkt, § 11 EStG; Beträge in Euro und Cent).",
      ],
      table: {
        headers: ["Zeile", "Kz", "Bezeichnung", "Betrag"],
        widths: [8, 8, 64, 20],
        rows: euerRows(sheet).map(([z, kz, label, cents]) => [z, kz, label, formatEuro(cents)]),
      },
    },
    ...(aveuer
      ? [
          {
            title: "Anlage AVEÜR",
            table: {
              headers: ["Zeile", "Kz", "Bezeichnung", "Betrag"],
              widths: [8, 8, 64, 20],
              rows: aveuer.groups.flatMap((g) =>
                g.fields.map((f) => [String(f.zeile), f.kz, `${g.title}: ${f.label}`, formatEuro(f.valueCents)]),
              ),
            },
          },
        ]
      : []),
    ...(sheet.notices.length || sheet.blockers.length
      ? [{ title: "Hinweise", paragraphs: [...new Set([...sheet.notices, ...sheet.blockers])] }]
      : []),
    { title: "Stand", table: { headers: ["Angabe", "Wert"], widths: [25, 75], rows: footerLines(footer) } },
  ];
  return {
    title: `Anlage EÜR ${sheet.year} – Zeilenwerte`,
    subtitle: `${company} · Zuordnung ${sheet.mappingVersion ?? "—"}${sheet.verified ? "" : " (nicht gegen den amtlichen Vordruck geprüft)"}`,
    fileName: `EUER_${sheet.year}_Kennzahlen.pdf`,
    createdAt: footer.generatedAt,
    sections,
    footer: footerText(footer),
  };
}
