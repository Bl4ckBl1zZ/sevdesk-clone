import { describe, expect, test } from "vitest";
import { counterCapacityWarning, MAX_NUMBER_LENGTH, normalizeNumber, render, validateFormat } from "./format";
import { assignNumber, simulateCollision } from "./register";

/** 10-edge-cases §3.1 numbering edge cases that are pure domain rules (UST-06, DATEV-04). */

const OCT_2026 = { year: 2026, month: 10 };
const issued = (from: number, to: number, format = "RE-{YYYY}-{####}") =>
  new Set(Array.from({ length: to - from + 1 }, (_, i) => normalizeNumber(render(format, OCT_2026, from + i))));

describe("EC-008 format change after numbers were issued", () => {
  test("EC-008 a new format that would re-create an issued number is rejected; one that cannot collide is accepted for future numbers", () => {
    const register = issued(1, 40);
    // Prefix in lower case + restart at 1 → re-2026-0001 normalises to an issued number.
    expect(
      simulateCollision(
        { format: "re-{YYYY}-{####}", resetPolicy: "yearly", startValue: 1, next: 1 },
        OCT_2026,
        register,
      ),
    ).toEqual({ number: "re-2026-0001" });
    // Collision far in the simulated window (value 10,000 of the current period) is still found.
    const late = new Set([normalizeNumber("R-2026-9999")]);
    expect(
      simulateCollision({ format: "R-{YYYY}-{####}", resetPolicy: "yearly", startValue: 1, next: 1 }, OCT_2026, late),
    ).toEqual({ number: "R-2026-9999" });
    // A new prefix only affects future numbers and cannot collide.
    expect(
      simulateCollision(
        { format: "RG-{YYYY}-{####}", resetPolicy: "yearly", startValue: 1, next: 41 },
        OCT_2026,
        register,
      ),
    ).toBeNull();
  });
});

describe("EC-009 yearly reset without {YYYY}", () => {
  test("EC-009 a yearly reset without a year token is rejected; with {YYYY} or {YY} it is accepted", () => {
    const r = validateFormat("RE-{####}", "yearly");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("reset_requires_year");
    expect(validateFormat("RE-{YYYY}-{####}", "yearly").ok).toBe(true);
    expect(validateFormat("RE-{YY}-{####}", "yearly").ok).toBe(true);
    // Without reset the same format is fine (the counter never restarts).
    expect(validateFormat("RE-{####}", "never").ok).toBe(true);
  });
});

describe("EC-011 counter exhaustion", () => {
  test("EC-011 T-SET-095 {###} at 999 → the next number is 1000 (no truncation), all numbers stay unique; warning from 900", () => {
    const range = { format: "RE-{YYYY}-{###}", resetPolicy: "yearly" as const, startValue: 1 };
    const at999 = assignNumber(range, 999, OCT_2026, issued(1, 998, range.format));
    expect(at999.ok && at999.value).toMatchObject({ number: "RE-2026-999", next: 1000 });
    const at1000 = assignNumber(range, 1000, OCT_2026, issued(1, 999, range.format));
    expect(at1000.ok && at1000.value).toMatchObject({ number: "RE-2026-1000", next: 1001 });
    const all = Array.from({ length: 1200 }, (_, i) => render(range.format, OCT_2026, i + 1));
    expect(new Set(all).size).toBe(1200);

    expect(counterCapacityWarning(range.format, 899)).toBeNull();
    expect(counterCapacityWarning(range.format, 900)).toBe(
      "Der Zähler erreicht bald 999; danach werden die Nummern eine Stelle länger.",
    );
    expect(counterCapacityWarning(range.format, 999)).not.toBeNull();
    expect(counterCapacityWarning(range.format, 1000)).toBeNull(); // already one digit longer
    expect(counterCapacityWarning("RE-{YYYY}-{####}", 8_999)).toBeNull();
    expect(counterCapacityWarning("RE-{YYYY}-{####}", 9_000)).toMatch(/9999/);
  });
});

describe("EC-012 number too long or forbidden characters", () => {
  test("EC-012 formats that could exceed 36 characters or contain characters outside DATEV Belegfeld 1 are rejected at configuration time", () => {
    const long = validateFormat(`${"A".repeat(28)}-{YYYY}-{###}`, "yearly");
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.error.code).toBe("format_too_long");
      expect(long.error.message).toContain(`höchstens ${MAX_NUMBER_LENGTH}`);
    }
    for (const bad of ["RE_{####}", "RE {####}", "RÉ-{####}", "RE.{####}", "RE#{####}"]) {
      const r = validateFormat(bad, "never");
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code, bad).toBe("format_illegal_char");
    }
    // Exactly at the limit including the widened counter is still allowed.
    const fits = `${"A".repeat(36 - "-2026-".length - 4)}-{YYYY}-{###}`;
    expect(render(fits, OCT_2026, 1000)).toHaveLength(36);
    expect(validateFormat(fits, "yearly").ok).toBe(true);
  });
});
