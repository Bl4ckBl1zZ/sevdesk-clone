import { describe, expect, test } from "vitest";
import {
  amountFilterCents,
  journalCsv,
  matchesJournalFilter,
  type SearchableEntry,
  sortJournal,
  validateJournalFilter,
} from "./journal-search";

const e = (over: Partial<SearchableEntry> & { seq: number }): SearchableEntry => ({
  date: "2026-05-04",
  text: "Rechnung RE-2026-001",
  source: { kind: "salesDocument", id: "d1" },
  lines: [
    { account: "1400", debitCents: 11_900, creditCents: 0, contactId: "c1" },
    { account: "8400", debitCents: 0, creditCents: 10_000 },
    { account: "1776", debitCents: 0, creditCents: 1_900 },
  ],
  late: false,
  reversal: false,
  reversed: false,
  actor: "user:owner",
  ...over,
});

describe("ACC-025 journal search", () => {
  const entries = [
    e({ seq: 1 }),
    e({ seq: 2, date: "2026-06-01", source: { kind: "manual", id: "m1" }, text: "Darlehen", actor: "user:bk" }),
    e({ seq: 3, date: "2026-06-02", reversal: true, late: true, text: "Storno: Darlehen" }),
    e({
      seq: 4,
      date: "2026-04-30",
      lines: [
        { account: "4930", debitCents: 500, creditCents: 0 },
        { account: "1200", debitCents: 0, creditCents: 500 },
      ],
    }),
  ];
  const seqs = (f: Parameters<typeof matchesJournalFilter>[1]) =>
    entries.filter((x) => matchesJournalFilter(x, f)).map((x) => x.seq);

  test("ACC-025 filters by period, account, contact, source kind, text, amount, late postings, reversals and actor", () => {
    expect(seqs({ from: "2026-05-01", to: "2026-05-31" })).toEqual([1]);
    expect(seqs({ account: "1200" })).toEqual([4]);
    expect(seqs({ contactId: "c1" })).toEqual([1, 2, 3]);
    expect(seqs({ sourceKind: "manual" })).toEqual([2]);
    expect(seqs({ text: "darlehen" })).toEqual([2, 3]);
    expect(seqs({ minCents: 1_000 })).toEqual([1, 2, 3]);
    expect(seqs({ maxCents: 500 })).toEqual([4]);
    expect(seqs({ late: true })).toEqual([3]);
    expect(seqs({ reversals: "only" })).toEqual([3]);
    expect(seqs({ reversals: "exclude" })).toEqual([1, 2, 4]);
    expect(seqs({ actor: "user:bk" })).toEqual([2]);
  });

  test("ACC-025 sorting by seq or date and filter validation", () => {
    expect(sortJournal(entries, "seq_desc").map((x) => x.seq)).toEqual([4, 3, 2, 1]);
    expect(sortJournal(entries, "date_asc").map((x) => x.seq)).toEqual([4, 1, 2, 3]);
    expect(validateJournalFilter({ from: "2026-06-01", to: "2026-05-01" }).ok).toBe(false);
    expect(validateJournalFilter({ minCents: 500, maxCents: 100 }).ok).toBe(false);
    expect(amountFilterCents("1.234,56")).toBe(123_456);
    expect(amountFilterCents("")).toBeUndefined();
    expect(amountFilterCents("abc")).toBeNull();
  });
});

describe("RPT-008 Buchungsjournal", () => {
  test("RPT-008 CSV has one row per line with reversals, late postings and the lock flag (Excel variant)", () => {
    const csv = journalCsv([
      {
        seq: 7,
        date: "2026-06-02",
        period: "2026-06",
        text: "=Darlehen",
        source: { id: "m1", label: "Manuelle Buchung" },
        lines: [
          { account: "1200", accountName: "Bank", debitCents: 0, creditCents: 500_000 },
          { account: "0630", accountName: "Verbindlichkeiten Kreditinstitute", debitCents: 500_000, creditCents: 0 },
        ],
        reversalOfSeq: 5,
        latePostingReason: "05/2026 festgeschrieben",
        originalDate: "2026-05-31",
        locked: false,
        actor: "user:owner",
      },
    ]);
    const rows = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(rows[0]).toBe(
      "Nr.;Buchungsdatum;Periode;Beleg;Buchungstext;Konto;Kontobezeichnung;Soll;Haben;Steuerschlüssel;Kostenstelle;Währung;Betrag Fremdwährung;Storno von Nr.;Storniert durch Nr.;Nachbuchung;Ursprüngliches Datum;Festgeschrieben;Erfasst von",
    );
    expect(rows[1]).toBe(
      "7;02.06.2026;2026-06;Manuelle Buchung;'=Darlehen;1200;Bank;;5000,00;;;;;5;;05/2026 festgeschrieben;31.05.2026;nein;user:owner",
    );
    expect(rows).toHaveLength(3);
    const technical = journalCsv([], "technical");
    expect(technical.startsWith("seq,date,period,source,source_id,text")).toBe(true);
  });
});
