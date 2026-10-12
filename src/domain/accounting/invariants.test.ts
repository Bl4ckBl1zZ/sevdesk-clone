import { describe, expect, test } from "vitest";
import { checkCash, checkJournal, type EntrySnapshot, type LineSnapshot } from "./invariants";

const entry = (seq: number, over: Partial<EntrySnapshot> = {}): EntrySnapshot => ({
  id: `e${seq}`,
  seq,
  date: "2026-03-01",
  period: "2026-03",
  lines: [
    { account: "1400", debitCents: 119, creditCents: 0 },
    { account: "8400", debitCents: 0, creditCents: 119 },
  ],
  source: { kind: "salesDocument", id: `d${seq}` },
  attachmentsCount: 0,
  ...over,
});

const rowsOf = (e: EntrySnapshot): LineSnapshot[] =>
  e.lines.map((l, i) => ({ entryId: e.id, lineIndex: i, seq: e.seq, date: e.date, ...l }));

const exists = (a: string) => a !== "4711";

describe("RI-12 journal invariants", () => {
  test("RI-12 a consistent journal has no findings", () => {
    const es = [entry(1), entry(2)];
    expect(checkJournal(es, es.flatMap(rowsOf), exists)).toEqual([]);
  });

  test("RI-12 GOBD-05 gaps, duplicates, unbalanced entries, missing sources and unknown accounts are found", () => {
    const unbalanced = entry(3, {
      lines: [
        { account: "1400", debitCents: 100, creditCents: 0 },
        { account: "8400", debitCents: 0, creditCents: 90 },
      ],
    });
    const noSource = entry(4, { source: { kind: "", id: "" } });
    const badAccount = entry(5, {
      lines: [
        { account: "4711", debitCents: 5, creditCents: 0 },
        { account: "8400", debitCents: 0, creditCents: 5 },
      ],
    });
    const manual = entry(6, { source: { kind: "manual", id: "m1" } });
    const wrongPeriod = entry(7, { period: "2026-04" });
    const es = [entry(1), unbalanced, noSource, badAccount, manual, wrongPeriod, entry(9)];
    const msgs = checkJournal(es, es.flatMap(rowsOf), exists).map((v) => v.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "Journal-Nummer 2 fehlt oder ist doppelt (gefunden: 3).",
        "Buchung 3: Soll und Haben sind nicht ausgeglichen (Differenz: 0,10 €).",
        "Buchung 4 hat keinen Beleg (Quelle).",
        "Buchung 5: Konto 4711 existiert nicht.",
        "Buchung 6: manuelle Buchung ohne Beleg.",
        "Buchung 7: Periode 2026-04 passt nicht zum Datum 2026-03-01.",
      ]),
    );
  });

  test("RI-12 ACC-004 E-ACC-05 reversals must mirror an existing entry and happen once; read model must match", () => {
    const orig = entry(1);
    const good = entry(2, {
      reversalOfId: "e1",
      lines: orig.lines.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents })),
    });
    const twice = { ...good, id: "e3", seq: 3 };
    const notMirror = entry(4, { reversalOfId: "e1" });
    const dangling = entry(5, { reversalOfId: "nope" });
    const es = [orig, good, twice, notMirror, dangling];
    const rows = es.flatMap(rowsOf);
    rows.push({
      entryId: "ghost",
      lineIndex: 0,
      seq: 99,
      date: "2026-03-01",
      account: "1400",
      debitCents: 1,
      creditCents: 0,
    });
    const tampered = rows.map((r) => (r.entryId === "e5" && r.lineIndex === 0 ? { ...r, debitCents: 5 } : r));
    const msgs = checkJournal(es, tampered, exists).map((v) => v.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "Buchung 1 wurde mehrfach storniert.",
        "Buchung 4 spiegelt Buchung 1 nicht.",
        "Buchung 5: storniert eine unbekannte Buchung.",
        "Buchung 5: Zeilenverzeichnis weicht von der Buchung ab.",
        "Buchungszeilen ohne Buchung (ghost).",
      ]),
    );
  });

  test("RI-11 AO-05 the cash account must be ≥ 0 after every movement in (date, seq) order", () => {
    expect(checkCash([{ date: "2026-01-01", seq: 1, debitCents: 100, creditCents: 0 }])).toEqual([]);
    expect(
      checkCash([
        { date: "2026-01-02", seq: 1, debitCents: 100, creditCents: 0 },
        { date: "2026-01-01", seq: 2, debitCents: 0, creditCents: 50 },
      ]),
    ).toEqual([
      { id: "RI-11", severity: "ERROR", message: "Kassenbestand am 01.01.2026 negativ (−0,50\u00a0€, Buchung 2)." },
    ]);
  });
});
