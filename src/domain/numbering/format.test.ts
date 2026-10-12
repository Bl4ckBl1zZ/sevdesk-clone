import { describe, expect, test } from "vitest";
import { normalizeNumber, periodKey, previewNumbers, SEEDED_RANGES, validateFormat } from "./format";

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
