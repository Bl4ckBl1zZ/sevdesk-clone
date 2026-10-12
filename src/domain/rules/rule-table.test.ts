import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays, type CalendarDate, calendarDate, fromEpochDay } from "../time/calendar-date";
import {
  defineRuleTable,
  lookupRule,
  lookupRuleForPeriod,
  type RuleOverride,
  RuleTableError,
  validateRuleEntries,
} from "./rule-table";

const d = calendarDate;
const src = "test source";

const vat = defineRuleTable("demo", [
  { validFrom: "2007-01-01", validTo: "2020-06-30", value: 1900, source: src },
  { validFrom: "2020-07-01", validTo: "2020-12-31", value: 1600, source: src },
  { validFrom: "2021-01-01", value: 1900, source: src },
]);

describe("date-effective rule tables (ADR-005, 01 design rule 1)", () => {
  test("DOC-13 lookup by a passed-in business date returns the row valid on that date with a stable row ID", () => {
    const r = lookupRule(vat, d("2020-07-01"));
    expect(r.ok && r.value).toMatchObject({ rowId: "demo@2020-07-01", value: 1600, origin: "code", source: src });
    expect(lookupRule(vat, d("2020-06-30")).ok && lookupRule(vat, d("2020-06-30"))).toMatchObject({
      value: { value: 1900, rowId: "demo@2007-01-01" },
    });
    expect(lookupRule(vat, d("2020-12-31")).ok && lookupRule(vat, d("2020-12-31"))).toMatchObject({
      value: { value: 1600 },
    });
    expect(lookupRule(vat, d("2099-01-01")).ok && lookupRule(vat, d("2099-01-01"))).toMatchObject({
      value: { value: 1900, rowId: "demo@2021-01-01" },
    });
  });

  test("EC-127 a date outside every row is an explicit rule_missing error, never a guess", () => {
    const r = lookupRule(vat, d("2006-12-31"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatchObject({ code: "rule_missing", params: { tableId: "demo", date: "2006-12-31" } });
  });

  test("SET-120 load-time validation rejects overlaps, gaps, inverted ranges, open rows before the end and missing sources", () => {
    const codes = (entries: Parameters<typeof validateRuleEntries>[1]) =>
      validateRuleEntries("t", entries).map((i) => i.code);
    expect(codes([])).toEqual(["rule_table_empty"]);
    expect(
      codes([
        { validFrom: "2020-01-01", validTo: "2020-12-31", value: 1, source: src },
        { validFrom: "2020-12-31", value: 2, source: src },
      ]),
    ).toEqual(["rule_overlap"]);
    expect(
      codes([
        { validFrom: "2020-01-01", validTo: "2020-12-30", value: 1, source: src },
        { validFrom: "2021-01-01", value: 2, source: src },
      ]),
    ).toEqual(["rule_gap"]);
    expect(codes([{ validFrom: "2020-02-01", validTo: "2020-01-31", value: 1, source: src }])).toEqual([
      "rule_range_inverted",
    ]);
    expect(
      codes([
        { validFrom: "2020-01-01", value: 1, source: src },
        { validFrom: "2021-01-01", value: 2, source: src },
      ]),
    ).toEqual(["rule_overlap"]);
    expect(codes([{ validFrom: "2020-01-01", value: 1, source: " " }])).toEqual(["rule_source_missing"]);
    expect(codes([{ validFrom: "2020-13-01", value: 1, source: src }])).toEqual(["rule_date_invalid"]);
    expect(codes([{ validFrom: "2020-01-01", validTo: "2020-02-30", value: 1, source: src }])).toEqual([
      "rule_date_invalid",
    ]);
    // unsorted input is sorted before checking
    expect(
      codes([
        { validFrom: "2021-01-01", value: 2, source: src },
        { validFrom: "2020-01-01", validTo: "2020-12-31", value: 1, source: src },
      ]),
    ).toEqual([]);
    // gaps can be allowed explicitly (e.g. owner overrides)
    expect(
      validateRuleEntries(
        "t",
        [
          { validFrom: "2020-01-01", validTo: "2020-01-31", value: 1, source: src },
          { validFrom: "2020-03-01", validTo: "2020-03-31", value: 2, source: src },
        ],
        { allowGaps: true },
      ),
    ).toEqual([]);
    expect(() => defineRuleTable("broken", [])).toThrow(RuleTableError);
    expect(() =>
      defineRuleTable("broken", [
        { validFrom: "2020-01-01", value: 1, source: src },
        { validFrom: "2020-06-01", value: 2, source: src },
      ]),
    ).toThrow(/broken.*rule_overlap/);
  });

  test("PRD-021 a period resolves only if one row covers it; a change inside blocks with the change date (EC-024)", () => {
    const whole = lookupRuleForPeriod(vat, d("2020-07-01"), d("2020-12-31"));
    expect(whole.ok && whole.value.value).toBe(1600);
    const crossing = lookupRuleForPeriod(vat, d("2020-12-15"), d("2021-01-15"));
    expect(!crossing.ok && crossing.error).toMatchObject({
      code: "rule_changes_in_period",
      params: { tableId: "demo", changeDate: "2021-01-01" },
    });
    expect(crossing.ok ? "" : crossing.error.message).toMatch(/aufteilen/);
    const before = lookupRuleForPeriod(vat, d("2006-12-01"), d("2007-01-31"));
    expect(!before.ok && before.error.code).toBe("rule_missing");
    const inverted = lookupRuleForPeriod(vat, d("2021-02-01"), d("2021-01-01"));
    expect(!inverted.ok && inverted.error.code).toBe("period_inverted");
  });

  test("SET-122 an owner override wins over the shipped row for its validity range only; both keep their row IDs", () => {
    const overrides: RuleOverride<number>[] = [
      {
        id: "ovr_1",
        validFrom: d("2027-01-01"),
        validTo: d("2027-06-30"),
        value: 2000,
        source: "BGBl. 2026 I Nr. 999",
      },
    ];
    const inside = lookupRule(vat, d("2027-03-01"), overrides);
    expect(inside.ok && inside.value).toMatchObject({ value: 2000, origin: "override", rowId: "override:ovr_1" });
    const outside = lookupRule(vat, d("2027-07-01"), overrides);
    expect(outside.ok && outside.value).toMatchObject({ value: 1900, origin: "code", rowId: "demo@2021-01-01" });
    const span = lookupRuleForPeriod(vat, d("2026-12-01"), d("2027-01-31"), overrides);
    expect(!span.ok && span.error.params?.changeDate).toBe("2027-01-01");
    const endSpan = lookupRuleForPeriod(vat, d("2027-06-01"), d("2027-07-31"), overrides);
    expect(!endSpan.ok && endSpan.error.params?.changeDate).toBe("2027-07-01");
    const within = lookupRuleForPeriod(vat, d("2027-02-01"), d("2027-02-28"), overrides);
    expect(within.ok && within.value.rowId).toBe("override:ovr_1");
    // an override may also fill a date the shipped table does not cover
    const early = lookupRule(vat, d("2000-01-01"), [
      { id: "ovr_2", validFrom: d("1999-01-01"), validTo: d("2006-12-31"), value: 1600, source: src },
    ]);
    expect(early.ok && early.value.value).toBe(1600);
  });

  test("SET-121 overlapping overrides are rejected (each date has exactly one effective value)", () => {
    const overlapping: RuleOverride<number>[] = [
      { id: "a", validFrom: d("2027-01-01"), value: 1, source: src },
      { id: "b", validFrom: d("2027-06-01"), value: 2, source: src },
    ];
    expect(() => lookupRule(vat, d("2027-07-01"), overlapping)).toThrow(/rule_overlap/);
  });

  test("MISC-09 Stichtag simulation: an injected future rate change applies exactly from its date", () => {
    const stichtag = d("2027-07-01");
    const injected: RuleOverride<number>[] = [{ id: "sim", validFrom: stichtag, value: 2100, source: "simulation" }];
    const dayBefore = lookupRule(vat, addDays(stichtag, -1), injected);
    const onDay = lookupRule(vat, stichtag, injected);
    expect(dayBefore.ok && dayBefore.value.value).toBe(1900);
    expect(onDay.ok && onDay.value.value).toBe(2100);
  });

  test("DOC-13 random contiguous tables: every date in range resolves to exactly the covering row", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30_000 }),
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        fc.integer({ min: 0, max: 4000 }),
        (startDay, lengths, openEnded, probe) => {
          let from = startDay;
          const entries = lengths.map((len, i) => {
            const isLast = i === lengths.length - 1;
            const e = {
              validFrom: fromEpochDay(from),
              ...(isLast && openEnded ? {} : { validTo: fromEpochDay(from + len - 1) }),
              value: i,
              source: src,
            };
            from += len;
            return e;
          });
          const table = defineRuleTable("rand", entries);
          const day = startDay + probe;
          const r = lookupRule(table, fromEpochDay(day) as CalendarDate);
          const total = lengths.reduce((a, b) => a + b, 0);
          if (day < startDay + total || openEnded) {
            let acc = startDay;
            let expected = lengths.length - 1;
            for (let i = 0; i < lengths.length; i++) {
              acc += lengths[i] ?? 0;
              if (day < acc) {
                expected = i;
                break;
              }
            }
            expect(r.ok && r.value.value).toBe(expected);
          } else {
            expect(r.ok).toBe(false);
          }
        },
      ),
    );
  });
});
