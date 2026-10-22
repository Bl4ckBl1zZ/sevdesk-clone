import { describe, expect, test } from "vitest";
import { seededAccount } from "../rules/accounting";
import type { CalendarDate } from "../time/calendar-date";
import {
  type DatevJournalEntry,
  type DatevJournalLine,
  type DatevMapContext,
  datevDerivedVat,
  mapEntries,
} from "./mapping";

/** F09 §5.1 DATEV edge cases E-EXP-17 (unresolvable VAT recomputation) and E-EXP-21 (foreign currency). */

const auto = (a: string) => seededAccount("SKR03", "2026-01-01" as CalendarDate, a)?.automaticVatAccount === true;
const ctx = (over: Partial<DatevMapContext> = {}): DatevMapContext => ({
  accountLength: 4,
  festschreibung: 0,
  from: "2026-01-01",
  to: "2026-12-31",
  isAutomatic: auto,
  accountExists: (a) => seededAccount("SKR03", "2026-01-01" as CalendarDate, a) !== null,
  personalAccount: (_c, kind) => (kind === "debtor" ? "10001" : "70001"),
  beleg: () => ({ belegfeld1: "RE-2026-0007", dueDate: "2026-03-15", internalId: "d1" }),
  ...over,
});
const L = (
  account: string,
  role: string,
  d: number,
  c: number,
  extra: Partial<DatevJournalLine> = {},
): DatevJournalLine => ({ account, role, debitCents: d, creditCents: c, ...extra });
const entry = (lines: DatevJournalLine[]): DatevJournalEntry => ({
  id: "e1",
  seq: 7,
  date: "2026-03-01",
  text: "Rechnung RE-2026-0007 Muster GmbH",
  source: { kind: "salesDocument", id: "d1" },
  lines,
});
const cellOf = (row: Record<string, unknown>, name: string) => {
  const c = row[name] as { t?: string; r?: string } | null | undefined;
  return c ? (c.t ?? c.r) : undefined;
};
const cents = (row: Record<string, unknown>) => Number(cellOf(row, "Umsatz (ohne Soll/Haben-Kz)")?.replace(",", ""));

describe("DATEV edge cases (F09 §5.1)", () => {
  test("E-EXP-17 a booked VAT no gross distribution reproduces → separate BU-40 correction line on the VAT account + warning", () => {
    // pathological cent case (§4.1.4): one 19 % group of 0,08 € net split 0,01 / 0,01 / 0,06 € over three revenue
    // accounts, booked VAT 0,02 €. DATEV derives the VAT per row from the gross; no whole-cent distribution of the
    // 0,02 € over the three rows makes Σ derived VAT = 0,02 €, so the writer emits a correction row with BU 40.
    const r = mapEntries(
      [
        entry([
          L("1400", "receivable", 10, 0, { contactId: "c1" }),
          L("8400", "revenue.a.19", 0, 1, { taxKey: "USt19" }),
          L("8410", "revenue.b.19", 0, 1, { taxKey: "USt19" }),
          L("8420", "revenue.c.19", 0, 6, { taxKey: "USt19" }),
          L("1776", "vat.output.19", 0, 2),
        ]),
      ],
      ctx({ accountExists: () => true, isAutomatic: () => true }),
    );
    const correction = r.rows.filter((x) => cellOf(x, "BU-Schlüssel") === "40");
    expect(correction.length).toBeGreaterThan(0);
    for (const row of correction) {
      expect(cellOf(row, "Gegenkonto (ohne BU-Schlüssel)")).toBe("1776");
      expect(cellOf(row, "Belegfeld 1")).toBe("RE-2026-0007");
      expect(cellOf(row, "Buchungstext")).toMatch(/^Rundungsausgleich USt /);
    }
    expect(r.issues).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "DATEV_CORRECTION",
        message: "Rundungsausgleich für RE-2026-0007 als separate Steuerzeile exportiert.",
      }),
    );
    // the regular rows keep the gross; DATEV's derived VAT + the correction = the booked VAT
    const regular = r.rows.filter((x) => cellOf(x, "BU-Schlüssel") !== "40");
    expect(regular.reduce((s, x) => s + cents(x), 0)).toBe(10);
    const signed = (x: Record<string, unknown>) => cents(x) * (cellOf(x, "Soll/Haben-Kennzeichen") === "S" ? 1 : -1);
    expect(datevDerivedVat(r.rows) + correction.reduce((s, x) => s + signed(x), 0)).toBe(2);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  test("E-EXP-21 foreign-currency posting: Umsatz in EUR as booked (WKZ EUR); currency, foreign amount and Kurs for information", () => {
    // LEGAL-OPEN (F09 §9 open question 4): decided default „EUR as booked“, one-off Steuerberater check recommended
    const fx = { currency: "USD", fxRate: { rate: "1.085000" } };
    const r = mapEntries(
      [
        entry([
          L("1400", "receivable", 10000, 0, { contactId: "c1", ...fx, amountFx: 10850 }),
          L("8338", "revenue.eu_service", 0, 10000, { ...fx, amountFx: 10850 }),
        ]),
      ],
      ctx({ accountExists: () => true, isAutomatic: () => false }),
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as Record<string, unknown>;
    expect([
      cellOf(row, "Umsatz (ohne Soll/Haben-Kz)"),
      cellOf(row, "WKZ Umsatz"),
      cellOf(row, "Basis-Umsatz"),
      cellOf(row, "WKZ Basis-Umsatz"),
      cellOf(row, "Kurs"),
    ]).toEqual(["100,00", "EUR", "108,50", "USD", "1,085000"]);
    // an EUR line never carries the information columns
    const eur = mapEntries(
      [entry([L("1400", "receivable", 10000, 0, { contactId: "c1" }), L("8338", "revenue.eu_service", 0, 10000)])],
      ctx({ accountExists: () => true, isAutomatic: () => false }),
    );
    const eurRow = eur.rows[0] as Record<string, unknown>;
    expect([cellOf(eurRow, "Basis-Umsatz"), cellOf(eurRow, "WKZ Basis-Umsatz"), cellOf(eurRow, "Kurs")]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
