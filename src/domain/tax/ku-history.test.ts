import { describe, expect, test } from "vitest";
import { checkKuHistoryChange } from "./ku-history";

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
