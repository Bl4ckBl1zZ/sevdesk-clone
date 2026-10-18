import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../../time/calendar-date";
import { parseNumberPattern, proposeContinuation } from "./number-pattern";

const d = (s: string) => s as CalendarDate;
const inv = (number: string, date: string) => ({ type: "invoice" as const, number, documentDate: d(date) });

describe("F09 IMP-005 number range continuation (§4.3.6, EC-014)", () => {
  test("IMP-005 number patterns: prefix, year token, counter width, suffix", () => {
    expect(parseNumberPattern("RE-1042", d("2026-05-01"))).toMatchObject({
      format: "RE-{####}",
      resetPolicy: "never",
      counter: 1042,
    });
    expect(parseNumberPattern("RE-2026-0042", d("2026-05-01"))).toMatchObject({
      format: "RE-{YYYY}-{####}",
      resetPolicy: "yearly",
      counter: 42,
    });
    expect(parseNumberPattern("2026001", d("2026-01-02"))).toMatchObject({ format: "{YYYY}{###}", counter: 1 });
    expect(parseNumberPattern("R26/017-A", d("2026-03-01"))).toMatchObject({ format: "R{YY}/{###}-A", counter: 17 });
    // a 4-digit group that is not the document year stays literal
    expect(parseNumberPattern("RE-2025-0042", d("2026-01-03"))).toMatchObject({ format: "RE-2025-{####}" });
    expect(parseNumberPattern("ENTWURF", d("2026-01-01"))).toBeNull();
  });

  test("TST-IMP-05 EC-014 imported max RE-1042 → proposed RE-{####} with next 1043", () => {
    const [r] = proposeContinuation(
      [inv("RE-1040", "2026-03-01"), inv("RE-1042", "2026-04-01"), inv("RE-1041", "2026-03-15")],
      d("2026-10-18"),
    );
    expect(r).toMatchObject({ rangeKey: "invoice", ambiguous: false, gapCount: 0 });
    expect(r?.candidates).toEqual([
      expect.objectContaining({
        format: "RE-{####}",
        resetPolicy: "never",
        next: 1043,
        lastImported: "RE-1042",
        formatValid: true,
      }),
    ]);
  });

  test("IMP-005 yearly patterns continue in the current year only; the local counter is never lowered (SET-059)", () => {
    const samples = [
      inv("RE-2025-0099", "2025-12-30"),
      inv("RE-2026-0007", "2026-02-01"),
      inv("RE-2026-0008", "2026-02-03"),
    ];
    const [r] = proposeContinuation(samples, d("2026-10-18"));
    expect(r?.candidates[0]).toMatchObject({ format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 9 });
    const [withLocal] = proposeContinuation(samples, d("2026-10-18"), [
      { rangeKey: "invoice", format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 20 },
    ]);
    expect(withLocal?.candidates[0]?.next).toBe(20);
    const [nextYear] = proposeContinuation(samples, d("2027-01-02"));
    expect(nextYear?.candidates[0]?.next).toBe(1);
  });

  test("E-IMP-11 several formats in the latest year are ambiguous; E-IMP-32 gaps are listed; corrections have their own range", () => {
    const out = proposeContinuation(
      [
        inv("RE-1001", "2026-01-01"),
        inv("RE-1004", "2026-02-01"),
        inv("RE-1005", "2026-03-01"),
        inv("STORNO-1004", "2026-03-02"),
        { type: "correction", number: "GS-0001", documentDate: d("2026-04-20") },
      ],
      d("2026-10-18"),
    );
    const invoice = out.find((r) => r.rangeKey === "invoice");
    expect(invoice?.ambiguous).toBe(true);
    expect(invoice?.candidates.map((c) => c.format)).toEqual(["RE-{####}", "STORNO-{####}"]);
    expect(invoice?.gaps).toEqual(["RE-1002", "RE-1003"]);
    expect(out.find((r) => r.rangeKey === "correction")?.candidates[0]).toMatchObject({ format: "GS-{####}", next: 2 });
  });

  test("IMP-005 literals the DATEV-safe format grammar refuses are flagged (owner sets the range manually)", () => {
    const [r] = proposeContinuation([inv("RE_1001", "2026-01-01")], d("2026-10-18"));
    expect(r?.candidates[0]).toMatchObject({ format: "RE_{####}", formatValid: false });
    expect(r?.candidates[0]?.formatMessage).toContain("nicht erlaubt");
  });
});
