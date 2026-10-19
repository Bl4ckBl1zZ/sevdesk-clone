import { describe, expect, test } from "vitest";
import { parseDocumentedGap, registerGaps } from "./gaps";

describe("number register gap report (SET-063, DOC-39)", () => {
  test("SET-063 T-SET-034 a raised counter 42 → 50 lists 42–49 with the reason; other holes are unexplained", () => {
    const rows = [1, 2, 3, 5, ...Array.from({ length: 41 - 5 }, (_, i) => i + 6), 50, 51].map((counter) => ({
      periodKey: "2026",
      counter,
    }));
    const doc = parseDocumentedGap("Neues Jahr, Abstimmung mit Altsystem (Lücke 42–49)");
    expect(doc).toEqual({ from: 42, to: 49, reason: "Neues Jahr, Abstimmung mit Altsystem" });
    const gaps = registerGaps(rows, 1, doc ? [{ periodKey: "2026", ...doc }] : []);
    expect(gaps).toEqual([
      { periodKey: "2026", from: 4, to: 4, reason: null },
      { periodKey: "2026", from: 42, to: 49, reason: "Neues Jahr, Abstimmung mit Altsystem" },
    ]);
  });

  test("SET-063 periods are checked separately and rows without a counter (imports) are ignored", () => {
    const gaps = registerGaps(
      [
        { periodKey: "2025", counter: 1 },
        { periodKey: "2025", counter: 3 },
        { periodKey: "2026", counter: 1 },
        { periodKey: "2026" },
      ],
      1,
      [],
    );
    expect(gaps).toEqual([{ periodKey: "2025", from: 2, to: 2, reason: null }]);
    expect(parseDocumentedGap("ohne Lücke")).toBeNull();
  });
});
