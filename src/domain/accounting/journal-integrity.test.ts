import { describe, expect, test } from "vitest";
import { type IntegrityEntry, verifyJournalPage } from "./journal-integrity";

const e = (seq: number, over: Partial<IntegrityEntry> = {}): IntegrityEntry => ({
  id: `e${seq}`,
  seq,
  period: "2026-09",
  recordedAt: 1_000,
  lines: [
    { debitCents: 100, creditCents: 0 },
    { debitCents: 0, creditCents: 100 },
  ],
  ...over,
});

describe("ACC-020 journal integrity in integrity.verify", () => {
  test("ACC-020 GOBD-05 a clean journal has no findings and the cursor continues across pages", () => {
    const a = verifyJournalPage([e(1), e(2)], { nextSeq: 1 }, new Map());
    expect(a.findings).toEqual([]);
    const b = verifyJournalPage([e(3)], a.cursor, new Map());
    expect(b.findings).toEqual([]);
    expect(b.cursor.nextSeq).toBe(4);
  });

  test("ACC-020 a gap in seq is an error finding", () => {
    const r = verifyJournalPage([e(1), e(4)], { nextSeq: 1 }, new Map());
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "journal_seq_gap",
        severity: "error",
        detail: "Journal: Buchungsnummern 2–3 fehlen.",
      }),
    ]);
  });

  test("ACC-020 GOBD-03 an unbalanced or one-line entry is an error finding", () => {
    const r = verifyJournalPage(
      [
        e(1, {
          lines: [
            { debitCents: 100, creditCents: 0 },
            { debitCents: 0, creditCents: 90 },
          ],
        }),
        e(2, { lines: [{ debitCents: 100, creditCents: 100 }] }),
      ],
      { nextSeq: 1 },
      new Map(),
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["journal_unbalanced", "journal_unbalanced"]);
  });

  test("ACC-020 TST-ACC-23 RI-13 EC-182 an entry recorded after its period's lock is reported", () => {
    const locks = new Map([["2026-09", 2_000]]);
    const r = verifyJournalPage([e(1, { recordedAt: 1_500 }), e(2, { recordedAt: 2_500 })], { nextSeq: 1 }, locks);
    expect(r.findings).toEqual([
      expect.objectContaining({
        kind: "journal_after_lock",
        entity: { table: "journalEntries", id: "e2" },
        detail: "Journal: Buchung 2 im festgeschriebenen Zeitraum 09/2026 wurde nach der Festschreibung erfasst.",
      }),
    ]);
  });
});
