import { describe, expect, test } from "vitest";
import { formatEuro } from "../money";
import { euerMappingFor } from "../rules/euer";
import { ustvaMappingFor } from "../rules/ustva";
import { computeEuer } from "../tax/euer";
import { type Contribution, computeUstva } from "../tax/ustva";
import { computeZm, zmContributions } from "../tax/zm";
import {
  euerSheetCsv,
  euerSheetDocument,
  filingStatusText,
  lockStatusText,
  type SheetFooter,
  ustvaSheetCsv,
  ustvaSheetDocument,
  zmSheetCsv,
  zmSheetDocument,
} from "./kennzahlen";

const M = ustvaMappingFor(2026) as NonNullable<ReturnType<typeof ustvaMappingFor>>;
const c = (kz: string, part: "base" | "tax", cents: number): Contribution => ({
  kz,
  part,
  cents,
  taxPointDate: "2026-09-10",
  entryId: `e-${kz}-${part}`,
  seq: 1,
  source: { kind: "salesDocument", id: `d-${kz}` },
});
const footer: SheetFooter = {
  generatedAt: Date.UTC(2026, 9, 5, 8, 30),
  ruleVersions: ["ustva-2026.1", "elster-ustva-2026"],
  months: ["2026-09"],
  lockedMonths: [],
  filing: null,
};

describe("Kennzahlen sheets (EXP-020)", () => {
  test("EXP-020 UStVA CSV: Kz, label, form value, tax „laut Formular“ and „laut Buchhaltung“, difference, Kz 83 and the footer", () => {
    const sheet = computeUstva("2026-09", [c("81", "base", 123_456), c("81", "tax", 23_457)], M, { ku: false });
    const csv = ustvaSheetCsv(sheet, footer);
    expect(
      csv.startsWith("﻿Kennzahl;Bezeichnung;Wert (Formular);Steuer laut Formular;laut Buchhaltung;Differenz\r\n"),
    ).toBe(true);
    const row81 = csv.split("\r\n").find((l) => l.startsWith("81;"));
    expect(row81).toMatch(/^81;[^;]+;1234,00;234,46;234,57;-0,11$/);
    expect(csv.split("\r\n").filter((l) => l.startsWith("83;"))).toHaveLength(1);
    expect(csv).toContain("Erstellt am;05.10.2026, 10:30");
    expect(csv).toContain("Regelversionen;ustva-2026.1, elster-ustva-2026");
    expect(csv).toContain("Festschreibung;nicht festgeschrieben");
    expect(csv).toContain("Abgabestatus;nicht übermittelt");
    const doc = ustvaSheetDocument(sheet, footer, "Muster Handwerk GmbH");
    expect(doc.title).toBe("Umsatzsteuer-Voranmeldung 09/2026 – Kennzahlen");
    expect(doc.fileName).toBe("UStVA_2026-09_Kennzahlen.pdf");
    expect(doc.sections[0]?.table?.headers).toEqual([
      "Kz",
      "Bezeichnung",
      "Wert",
      "laut Formular",
      "laut Buchhaltung",
      "Differenz",
    ]);
    expect(doc.footer).toContain("Festschreibung: nicht festgeschrieben");
  });

  test("EXP-020 ZM CSV and document rows per USt-IdNr with the total", () => {
    const zm = computeZm(
      "2026-Q3",
      zmContributions({
        id: "e1",
        seq: 1,
        date: "2026-08-15",
        recordedAt: 1,
        source: { kind: "salesDocument", id: "d1" },
        text: "Rechnung",
        lines: [
          { account: "1400", role: "receivable", debitCents: 1_000_050, creditCents: 0 },
          { account: "8125", taxKey: "igL", debitCents: 0, creditCents: 1_000_050, taxPointDate: "2026-08-15" },
        ],
        counterparty: { vatId: "FR12345678901", name: "Client SARL" },
      }),
    );
    const f = { ...footer, months: ["2026-07", "2026-08", "2026-09"] };
    const csv = zmSheetCsv(zm, f);
    expect(csv).toContain("FR;12345678901;Client SARL;L;10000;10000,50\r\n");
    expect(csv).toContain("Summe;;;;10000;\r\n");
    expect(zmSheetDocument(zm, f, "Muster").sections[0]?.table?.rows[0]).toEqual([
      "FR",
      "12345678901",
      "Client SARL",
      "Innergemeinschaftliche Lieferung",
      "10000",
      formatEuro(1_000_050),
    ]);
  });

  test("EXP-020 footer: lock status and filing status texts", () => {
    expect(lockStatusText({ months: ["2026-07", "2026-08"], lockedMonths: ["2026-07", "2026-08"] })).toBe(
      "festgeschrieben",
    );
    expect(lockStatusText({ months: ["2026-07", "2026-08"], lockedMonths: ["2026-07"] })).toBe(
      "teilweise festgeschrieben (offen: 08/2026)",
    );
    expect(
      filingStatusText({ status: "submitted_manually", submittedOn: "2026-10-09", transmissionTicket: "et-123" }),
    ).toBe("übermittelt am 09.10.2026 (manuell in Mein ELSTER, Transferticket et-123)");
  });
});

describe("EÜR sheet export (EXP-020, TAX-015, RPT-014)", () => {
  test("TAX-015 RPT-014 EXP-020 EÜR CSV lists Zeile, Kz, label and amount, the sums, AVEÜR and the footer; the PDF model has the same rows", () => {
    const sheet = computeEuer(
      2025,
      [
        {
          key: "BE.STPFL",
          cents: 100_000,
          date: "2025-03-01",
          year: 2025,
          entryId: "a",
          seq: 1,
          source: { kind: "payment", id: "p" },
        },
        {
          key: "BA.GEWERBESTEUER",
          cents: 5_000,
          date: "2025-05-01",
          year: 2025,
          entryId: "b",
          seq: 2,
          source: { kind: "payment", id: "q" },
        },
      ],
      euerMappingFor(2025),
      { ku: false },
    );
    const f: SheetFooter = { ...footer, ruleVersions: ["euer-2025.1"], months: ["2025-01"], lockedMonths: ["2025-01"] };
    const csv = euerSheetCsv(sheet, null, f);
    expect(csv.startsWith("﻿Zeile;Kz;Bezeichnung;Betrag\r\n")).toBe(true);
    expect(csv).toContain(
      "\r\n15;112;Umsatzsteuerpflichtige Betriebseinnahmen (ohne solche zum ermäßigten Steuersatz von 0 %);1000,00\r\n",
    );
    expect(csv).toContain("\r\n23;159;Summe Betriebseinnahmen;1000,00\r\n");
    expect(csv).toContain("\r\n97;219;Steuerpflichtiger Gewinn/Verlust;1000,00\r\n");
    expect(csv).toContain("(nicht abziehbar);50,00");
    expect(csv).toContain("Festschreibung;festgeschrieben");
    const doc = euerSheetDocument(sheet, null, f, "Muster");
    expect(doc.title).toBe("Anlage EÜR 2025 – Zeilenwerte");
    expect(doc.fileName).toBe("EUER_2025_Kennzahlen.pdf");
    expect(doc.sections[0]?.table?.rows.map((r) => r[1])).toEqual(["112", "168", "159", "199", "219"]);
  });
});
