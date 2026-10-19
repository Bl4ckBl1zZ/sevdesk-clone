import { describe, expect, test } from "vitest";
import { checkKuHistoryChange, waiverLockOf } from "./ku-history";

const history = [
  { validFrom: "2025-01-01", isKU: true },
  { validFrom: "2026-01-01", isKU: false },
];
const docs = [
  { id: "d1", number: "RE-2025-0001", date: "2025-05-10" },
  { id: "d2", number: "RE-2026-0001", date: "2026-03-01" },
];

describe("SET-034 the KU history is append-only once documents use it", () => {
  test("SET-034 T-SET-016 KU-03 editing or deleting an entry used by a finalised invoice → HISTORY_ENTRY_LOCKED", () => {
    const edited = [{ validFrom: "2025-01-01", isKU: false }, history[1] as (typeof history)[number]];
    expect(checkKuHistoryChange(history, edited, docs)).toMatchObject({
      ok: false,
      error: {
        code: "HISTORY_ENTRY_LOCKED",
        message:
          "Dieser Eintrag wurde bereits für fertiggestellte Dokumente verwendet und kann nicht geändert werden. Bitte einen neuen Eintrag hinzufügen.",
      },
    });
    expect(checkKuHistoryChange(history, [history[1] as (typeof history)[number]], docs)).toMatchObject({
      error: { code: "HISTORY_ENTRY_LOCKED" },
    });
    // An unused entry may still be changed.
    expect(
      checkKuHistoryChange(
        history,
        [history[0] as (typeof history)[number], { validFrom: "2026-01-01", isKU: true }],
        [docs[0] as (typeof docs)[number]],
      ).ok,
    ).toBe(true);
  });

  test("SET-034 T-SET-016 UST-30 a retroactive entry needs a reason and lists the affected documents", () => {
    const after = [...history, { validFrom: "2025-04-01", isKU: false }];
    expect(checkKuHistoryChange(history, after, docs)).toMatchObject({
      ok: false,
      error: { code: "REASON_REQUIRED", params: { affected: 1 } },
    });
    expect(checkKuHistoryChange(history, after, docs, "Umsatzgrenze überschritten")).toEqual({
      ok: true,
      value: { affected: [docs[0]] },
    });
    // A future entry is no correction.
    expect(checkKuHistoryChange(history, [...history, { validFrom: "2027-01-01", isKU: true }], docs)).toEqual({
      ok: true,
      value: { affected: [] },
    });
  });
});

describe("KU-04 SET-033 the waiver (§ 19 Abs. 2/3 UStG) binds for five calendar years", () => {
  const waived = [
    { validFrom: "2024-01-01", isKU: true },
    { validFrom: "2025-01-01", isKU: false, waiverDate: "2025-03-10" },
  ];

  test("KU-04 T-SET-077 switching back to KU inside the lock (2025–2029) is blocked; with a reason it passes", () => {
    const back = [...waived, { validFrom: "2027-01-01", isKU: true }];
    expect(checkKuHistoryChange(waived, back, [])).toMatchObject({
      ok: false,
      error: {
        code: "KU_WAIVER_LOCKED",
        message:
          "Der Verzicht auf die Kleinunternehmerregelung vom 10.03.2025 bindet bis 31.12.2029 (§ 19 Abs. 3 UStG). Wechsel nur mit Begründung möglich.",
        params: { lockEnd: "2029-12-31" },
      },
    });
    expect(checkKuHistoryChange(waived, back, [], "Finanzamt hat Widerruf ausnahmsweise zugelassen").ok).toBe(true);
    // the last locked day and the first free year
    expect(checkKuHistoryChange(waived, [...waived, { validFrom: "2029-12-31", isKU: true }], [])).toMatchObject({
      error: { code: "KU_WAIVER_LOCKED" },
    });
    expect(checkKuHistoryChange(waived, [...waived, { validFrom: "2030-01-01", isKU: true }], []).ok).toBe(true);
  });

  test("KU-04 a waiver starts on 1 January and must be declared by the end of February of the second following year", () => {
    const start = [{ validFrom: "2024-01-01", isKU: true }];
    expect(
      checkKuHistoryChange(start, [...start, { validFrom: "2025-04-01", isKU: false, waiverDate: "2025-03-10" }], []),
    ).toMatchObject({
      error: { code: "KU_WAIVER_START_INVALID", message: "Ein Verzicht wirkt immer ab Beginn eines Kalenderjahres." },
    });
    // SET-E09: a waiver for 2025 declared on 2027-02-28 is still in time (2027 is no leap year) …
    expect(
      checkKuHistoryChange(start, [...start, { validFrom: "2025-01-01", isKU: false, waiverDate: "2027-02-28" }], [])
        .ok,
    ).toBe(true);
    // … one day later it is too late
    expect(
      checkKuHistoryChange(start, [...start, { validFrom: "2025-01-01", isKU: false, waiverDate: "2027-03-01" }], []),
    ).toMatchObject({
      error: {
        code: "KU_WAIVER_TOO_LATE",
        message: "Der Verzicht für 2025 kann nur bis 28./29.02.2027 erklärt werden.",
      },
    });
    // the leap-year end of February counts (waiver for 2026 until 29.02.2028)
    expect(
      checkKuHistoryChange(start, [...start, { validFrom: "2026-01-01", isKU: false, waiverDate: "2028-02-29" }], [])
        .ok,
    ).toBe(true);
  });

  test("KU-04 an exceeded limit (no waiver) does not lock the return to KU", () => {
    const exceeded = [
      { validFrom: "2024-01-01", isKU: true },
      { validFrom: "2025-06-01", isKU: false },
    ];
    expect(checkKuHistoryChange(exceeded, [...exceeded, { validFrom: "2027-01-01", isKU: true }], []).ok).toBe(true);
    expect(waiverLockOf(waived, "2027-06-01")).toEqual({ waiverDate: "2025-03-10", lockEnd: "2029-12-31" });
    expect(waiverLockOf(waived, "2030-01-01")).toBeNull();
    expect(waiverLockOf(exceeded, "2027-06-01")).toBeNull();
  });
});
