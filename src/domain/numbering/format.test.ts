import { describe, expect, test } from "vitest";
import {
  counterCapacityWarning,
  normalizeNumber,
  periodKey,
  previewNumbers,
  render,
  SEEDED_RANGES,
  validateFormat,
} from "./format";

describe("counter capacity (F01 §5.5, F04 EC-DOC-06)", () => {
  test("EC-DOC-06 T-EC-006 the counter outgrows its padding: RE-2026-10000 is longer but unique; warning from 90 %", () => {
    expect(render("RE-{YYYY}-{####}", { year: 2026, month: 10 }, 9_999)).toBe("RE-2026-9999");
    expect(render("RE-{YYYY}-{####}", { year: 2026, month: 10 }, 10_000)).toBe("RE-2026-10000");
    expect(normalizeNumber("RE-2026-10000")).not.toBe(normalizeNumber("RE-2026-1000"));
    expect(counterCapacityWarning("RE-{YYYY}-{####}", 8_999)).toBeNull();
    const msg = "Der Zähler erreicht bald 9999; danach werden die Nummern eine Stelle länger.";
    expect(counterCapacityWarning("RE-{YYYY}-{####}", 9_000)).toBe(msg);
    // Once the counter is past the capacity the numbers are already longer: no warning any more (EC-011).
    expect(counterCapacityWarning("RE-{YYYY}-{####}", 10_000)).toBeNull();
    expect(counterCapacityWarning("RE-{YYYY}-{######}", 9_000)).toBeNull();
  });
});

const code = (format: string, reset: "never" | "yearly" | "monthly" = "never") => {
  const r = validateFormat(format, reset);
  return r.ok ? "ok" : r.error.code;
};

describe("number formats (F01 SET-056…058, UST-06)", () => {
  test("SET-056 illegal characters and counter tokens (T-SET-027)", () => {
    expect(code("RE {YYYY}-{####}")).toBe("format_illegal_char");
    expect(code("RE-{YYYY}")).toBe("format_counter_token");
    expect(code("RE-{YYYY}-{####}{##}")).toBe("format_counter_token");
    expect(code("RE-{YYYY}-{QQ}-{####}")).toBe("format_unknown_token");
    expect(code("RE-{YYYY}-{####}")).toBe("ok");
  });

  test("SET-057 a yearly reset needs a year, a monthly reset a year and the month (T-SET-028)", () => {
    expect(code("RE-{####}", "yearly")).toBe("reset_requires_year");
    expect(code("RE-{MM}-{####}", "monthly")).toBe("reset_requires_month");
    expect(code("RE-{YY}{MM}-{####}", "monthly")).toBe("ok");
  });

  test("SET-058 numbers longer than 36 characters (DATEV Belegfeld 1) are refused (T-SET-029)", () => {
    expect(code(`${"A".repeat(30)}{##########}`)).toBe("format_too_long");
  });

  test("DATEV-04 UST-06 every number a valid format can produce fits DATEV Belegfeld 1 (OPOS matching key)", () => {
    // DATEV OPOS matches invoice and payment by Belegfeld 1: ≤ 36 characters from [A-Za-z0-9$%&*+-/].
    const BELEGFELD_1 = /^[A-Za-z0-9$%&*+\-/]{1,36}$/;
    const counters = [1, 9_999, 10_000_000_000 - 1];
    for (const r of SEEDED_RANGES) {
      for (const c of counters) {
        for (const n of previewNumbers(r.format, { year: 2026, month: 12 }, c)) {
          expect(n, `${r.key} ${n}`).toMatch(BELEGFELD_1);
        }
      }
    }
    // the validator refuses every format whose output DATEV could not take
    expect(code("RE_{YYYY}-{####}")).toBe("format_illegal_char");
    expect(code("RE.{####}")).toBe("format_illegal_char");
    expect(code(`${"R".repeat(25)}{##########}`)).toBe("ok");
    expect(code(`${"R".repeat(26)}{##########}`)).toBe("format_too_long");
  });

  test("SET-055 preview, period keys and the seeded ranges are valid", () => {
    expect(previewNumbers("RE-{YYYY}-{####}", { year: 2026, month: 10 }, 7)).toEqual([
      "RE-2026-0007",
      "RE-2026-0008",
      "RE-2026-0009",
    ]);
    expect(periodKey("never", { year: 2026, month: 3 })).not.toBe(periodKey("monthly", { year: 2026, month: 3 }));
    expect(normalizeNumber(" re-2026-0007 ")).toBe(normalizeNumber("RE-2026-0007"));
    for (const r of SEEDED_RANGES) expect(code(r.format, r.resetPolicy), r.key).toBe("ok");
  });
});
