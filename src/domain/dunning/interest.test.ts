import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays, type CalendarDate } from "../time/calendar-date";
import { computeInterest } from "./interest";

const d = (s: string) => s as CalendarDate;

describe("DUN-020 MAHN-02 § 288 interest calculator (golden G1–G5, F05 §4.7)", () => {
  test("MAHN-02 T05-090 G1: B2B 10.000,00 € 2026-06-01 … 2026-07-31 splits at the Basiszinssatz change → 173,76 € (EC-126, EC-DUN-09)", () => {
    const r = computeInterest({ principalCents: 1_000_000, from: d("2026-06-01"), to: d("2026-07-31"), margin: "b2b" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalCents).toBe(17_376);
    expect(r.value.segments.map((s) => [s.from, s.to, s.days, s.rateBp, s.principalCents])).toEqual([
      ["2026-06-01", "2026-06-30", 30, 1027, 1_000_000],
      ["2026-07-01", "2026-07-31", 31, 1052, 1_000_000],
    ]);
    expect(r.value.segments.map((s) => s.amountCents)).toEqual([8441, 8935]);
  });

  test("MAHN-02 T05-091 G2: partial payment 4.000,00 € on 2026-07-10 reduces the principal from that day → 148,40 €", () => {
    const r = computeInterest({
      principalCents: 1_000_000,
      changes: [{ date: d("2026-07-10"), deltaCents: -400_000 }],
      from: d("2026-06-01"),
      to: d("2026-07-31"),
      margin: "b2b",
    });
    expect(r.ok && r.value.totalCents).toBe(14_840);
    expect(r.ok && r.value.segments.map((s) => [s.days, s.principalCents, s.rateBp])).toEqual([
      [30, 1_000_000, 1027],
      [9, 1_000_000, 1052],
      [22, 600_000, 1052],
    ]);
  });

  test("MAHN-02 T05-092 G3: B2C 1.000,00 € in August 2026 at 6,52 % → 5,54 €", () => {
    const r = computeInterest({ principalCents: 100_000, from: d("2026-08-01"), to: d("2026-08-31"), margin: "b2c" });
    expect(r.ok && r.value.totalCents).toBe(554);
    expect(r.ok && r.value.segments[0]?.rateBp).toBe(652);
  });

  test("MAHN-02 EC-DUN-11 T05-092 G4: negative Basiszinssatz (−0,88 %) B2C 2021 → 4,12 % → 41,20 €", () => {
    const r = computeInterest({ principalCents: 100_000, from: d("2021-01-01"), to: d("2021-12-31"), margin: "b2c" });
    expect(r.ok && r.value.totalCents).toBe(4120);
    expect(r.ok && r.value.segments.map((s) => [s.days, s.rateBp])).toEqual([[365, 412]]);
  });

  test("MAHN-02 EC-DUN-12 T05-092 G5: 0,01 € for one day rounds to 0,00 € and prints no line", () => {
    const r = computeInterest({ principalCents: 1, from: d("2026-08-01"), to: d("2026-08-01"), margin: "b2b" });
    expect(r.ok && r.value.totalCents).toBe(0);
    expect(r.ok && r.value.printable).toBe(false);
  });

  test("MAHN-02 a custom margin is added to the Basiszinssatz (calculator „individuell“)", () => {
    const r = computeInterest({
      principalCents: 100_000,
      from: d("2026-08-01"),
      to: d("2026-08-31"),
      margin: { customBp: 300 },
    });
    expect(r.ok && r.value.segments[0]?.rateBp).toBe(452);
  });

  test("MAHN-02 T05-094 EC-DUN-10 EC-127: a missing Basiszinssatz row blocks the computation (no guess)", () => {
    const r = computeInterest({ principalCents: 100_000, from: d("2026-12-01"), to: d("2027-01-15"), margin: "b2b" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("basiszinssatz_missing");
    expect(r.error.message).toBe(
      "Der Basiszinssatz ab 01.01.2027 ist nicht hinterlegt. Bitte unter Einstellungen › Regeln ergänzen.",
    );
  });

  test("MAHN-02 an owner override row (ruleOverrides) closes the gap", () => {
    const r = computeInterest({
      principalCents: 1_000_000,
      from: d("2027-01-01"),
      to: d("2027-01-31"),
      margin: "b2b",
      overrides: [
        {
          id: "o1",
          validFrom: d("2027-01-01"),
          validTo: d("2027-06-30"),
          value: { rateBp: 200 },
          source: "Bundesbank",
        },
      ],
    });
    expect(r.ok && r.value.segments[0]?.rateBp).toBe(1100);
  });

  test("MAHN-02 the principal never goes below zero and a fully paid tail accrues nothing", () => {
    const r = computeInterest({
      principalCents: 100_000,
      changes: [{ date: d("2026-08-11"), deltaCents: -150_000 }],
      from: d("2026-08-01"),
      to: d("2026-08-31"),
      margin: "b2c",
    });
    expect(r.ok && r.value.segments.map((s) => s.days)).toEqual([10]);
  });

  test("MAHN-02 an empty period (to < from) is zero interest", () => {
    const r = computeInterest({ principalCents: 100_000, from: d("2026-08-02"), to: d("2026-08-01"), margin: "b2c" });
    expect(r.ok && r.value.totalCents).toBe(0);
    expect(r.ok && r.value.segments).toEqual([]);
  });

  test("MAHN-02 T05-093 property: interest(a,b) + interest(b+1,c) = interest(a,c) ± 1 cent; no compounding", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.integer({ min: 0, max: 1200 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom<"b2b" | "b2c">("b2b", "b2c"),
        (principal, start, len1, len2, margin) => {
          const a = addDays(d("2023-01-01"), start);
          const b = addDays(a, len1);
          const c = addDays(b, len2 + 1);
          const ab = computeInterest({ principalCents: principal, from: a, to: b, margin });
          const bc = computeInterest({ principalCents: principal, from: addDays(b, 1), to: c, margin });
          const ac = computeInterest({ principalCents: principal, from: a, to: c, margin });
          if (!ab.ok || !bc.ok || !ac.ok) return c > "2026-12-31";
          return Math.abs(ab.value.totalCents + bc.value.totalCents - ac.value.totalCents) <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });
});
