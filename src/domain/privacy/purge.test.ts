import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import {
  ABLAUFHEMMUNG_ITEMS,
  auditPrefixEnd,
  auditRetentionUntil,
  checkPurgeRequest,
  groupEligible,
  isPurgeEligible,
  PURGE_PHRASE,
  scheduledPurgeDate,
} from "./purge";

const d = (s: string) => s as CalendarDate;
const allConfirmed = Object.fromEntries(ABLAUFHEMMUNG_ITEMS.map((i) => [i.id, true]));

describe("retention engine (PRV-003…PRV-008, GOBD-21)", () => {
  test("PRV-002 GOBD-21 a record is purge-eligible only after its retentionUntil (inclusive day stays retained)", () => {
    expect(isPurgeEligible("2027-12-31", d("2027-12-31"))).toBe(false);
    expect(isPurgeEligible("2027-12-31", d("2028-01-01"))).toBe(true);
    expect(isPurgeEligible(undefined, d("2028-01-01"))).toBe(false);
  });

  test("PRV-003 eligible records are grouped by retention class and the year their retention ended", () => {
    const groups = groupEligible(
      [
        { table: "salesDocuments", id: "a", retentionClass: "vouchers8", retentionUntil: "2026-12-31" },
        { table: "salesDocuments", id: "b", retentionClass: "vouchers8", retentionUntil: "2026-12-31" },
        { table: "journalEntries", id: "c", retentionClass: "books10", retentionUntil: "2025-12-31" },
        { table: "vouchers", id: "x", retentionClass: "vouchers8", retentionUntil: "2034-12-31" },
      ],
      d("2027-02-01"),
    );
    expect(groups).toEqual([
      { retentionClass: "books10", year: 2025, count: 1, tables: { journalEntries: 1 } },
      { retentionClass: "vouchers8", year: 2026, count: 2, tables: { salesDocuments: 2 } },
    ]);
  });

  test("PRV-005 E-PRV-02 E-PRV-03 E-PRV-04 EC-181 the purge request needs every Ablaufhemmung item, the phrase and no hold", () => {
    expect(ABLAUFHEMMUNG_ITEMS).toHaveLength(5);
    expect(PURGE_PHRASE).toBe("ENDGÜLTIG LÖSCHEN");
    expect(checkPurgeRequest({ checklist: allConfirmed, phrase: PURGE_PHRASE, holdActive: false })).toEqual([]);
    expect(checkPurgeRequest({ checklist: allConfirmed, phrase: PURGE_PHRASE, holdActive: true })).toEqual([
      "Während einer Betriebsprüfung sind Löschungen gesperrt.",
    ]);
    const partial = { ...allConfirmed, [ABLAUFHEMMUNG_ITEMS[0]?.id ?? ""]: false };
    expect(checkPurgeRequest({ checklist: partial, phrase: PURGE_PHRASE, holdActive: false })).toEqual([
      "Bitte bestätigen Sie alle Punkte zur Ablaufhemmung (§ 147 Abs. 3 Satz 5 AO).",
    ]);
    expect(checkPurgeRequest({ checklist: allConfirmed, phrase: "endgültig löschen", holdActive: false })).toEqual([
      "Bitte geben Sie „ENDGÜLTIG LÖSCHEN“ ein.",
    ]);
  });

  test("PRV-008 E-PRV-07 audit entries are kept 10 years from `at`; the prefix stops at the first non-expired entry", () => {
    // 2016-06-01 Berlin → retained until 2026-12-31
    const at2016 = Date.UTC(2016, 5, 1);
    const at2017 = Date.UTC(2017, 0, 1, 0, 30); // 01:30 Berlin on 01.01.2017
    expect(auditRetentionUntil(at2016)).toBe("2026-12-31");
    expect(auditRetentionUntil(Date.UTC(2016, 11, 31, 23, 30))).toBe("2027-12-31"); // already 2017 in Berlin
    const entries = [
      { seq: 1, at: at2016 },
      { seq: 2, at: at2016 },
      { seq: 3, at: at2017 },
      { seq: 4, at: at2016 }, // later seq, earlier at (clock) — never cut past seq 3
    ];
    expect(auditPrefixEnd(entries, d("2027-01-01"))).toBe(2);
    expect(auditPrefixEnd(entries, d("2026-12-31"))).toBe(0);
    expect(auditPrefixEnd(entries, d("2028-01-01"))).toBe(4);
  });

  test("DSGVO-02 CON-162 PRV-007 the purge due date is the day after the longest retention of the referencing records", () => {
    // 2024 invoice (8 y) → 2033-01-01; with journal entries (10 y) → 2035-01-01 (TST-PRV-08, F12 open item 4)
    expect(scheduledPurgeDate(["2032-12-31"])).toBe("2033-01-01");
    expect(scheduledPurgeDate(["2032-12-31", "2034-12-31"])).toBe("2035-01-01");
    expect(scheduledPurgeDate([])).toBeNull();
  });
});
