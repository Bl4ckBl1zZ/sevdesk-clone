import { describe, expect, test } from "vitest";
import { checkCounterSequences } from "./invariants";

const ranges = new Map([["r1", { name: "Rechnungen", startValue: 1 }]]);
const row = (counter: number, order: number, extra: Record<string, unknown> = {}) => ({
  number: `RE-2026-${String(counter).padStart(3, "0")}`,
  rangeId: "r1",
  periodKey: "2026",
  counter,
  order,
  ...extra,
});

describe("RI-03 counter sequences", () => {
  test("RI-03 strictly increasing, gapless counters per range and period pass", () => {
    const rows = [row(1, 10), row(2, 20), row(3, 30), { ...row(1, 40), periodKey: "2027", number: "RE-2027-001" }];
    expect(checkCounterSequences(rows, ranges, new Map())).toEqual([]);
  });

  test("RI-03 a counter that does not increase in finalisation order is a WARN", () => {
    const f = checkCounterSequences([row(1, 10), row(3, 20), row(2, 30)], ranges, new Map());
    expect(f).toEqual([
      expect.objectContaining({ id: "RI-03", severity: "WARN", message: expect.stringContaining("RE-2026-002") }),
    ]);
  });

  test("RI-03 an undocumented gap is a WARN, a documented one (SET-059 „Lücke a–b“) is not", () => {
    const rows = [row(1, 10), row(2, 20), row(5, 30)];
    expect(checkCounterSequences(rows, ranges, new Map())).toEqual([
      expect.objectContaining({ id: "RI-03", severity: "WARN", message: expect.stringContaining("(3–4)") }),
    ]);
    const documented = new Map([["r1", [{ periodKey: "2026", from: 3, to: 4, reason: "Zähler angepasst" }]]]);
    expect(checkCounterSequences(rows, ranges, documented)).toEqual([]);
  });

  test("RI-03 imported numbers and rows without counter are not part of a sequence", () => {
    const rows = [row(1, 10), row(7, 15, { imported: true }), row(2, 20), { number: "X", order: 1 }];
    expect(checkCounterSequences(rows, ranges, new Map())).toEqual([]);
  });
});
