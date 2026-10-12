import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { EINVOICE_OBLIGATION, lookupEinvoiceObligation } from "./einvoice-obligation";
import { lookupRc13bType, RC13B_TYPES } from "./rc13b-types";
import { ALL_RULE_TABLES } from "./registry";

const d = calendarDate;

describe("E-Rechnung obligation table (ER-03, App. D R8–R11)", () => {
  test("ER-03 transition until 2026-12-31, 800.000 € threshold in 2027, mandatory from 2028-01-01", () => {
    const mode = (date: string) => {
      const r = lookupEinvoiceObligation(d(date));
      if (!r.ok) throw new Error(r.error.code);
      return r.value.value;
    };
    expect(mode("2026-12-31")).toEqual({ mode: "transition_consent" });
    expect(mode("2027-01-01")).toEqual({ mode: "turnover_threshold", priorYearLimitCents: 80_000_000 });
    expect(mode("2027-12-31")).toEqual({ mode: "turnover_threshold", priorYearLimitCents: 80_000_000 });
    expect(mode("2028-01-01")).toEqual({ mode: "mandatory" });
    expect(ALL_RULE_TABLES).toContain(EINVOICE_OBLIGATION);
  });
});

describe("§ 13b types (UST-22)", () => {
  test("UST-22 each type maps to its § 13b Abs. 2 Nr.; unknown types and dates before the rule are rejected", () => {
    const nr = (id: string, date = "2026-10-12") => {
      const r = lookupRc13bType(id, d(date));
      return r.ok ? r.value.value.paragraphNr : r.error.code;
    };
    expect(nr("construction")).toBe("4");
    expect(nr("cleaning")).toBe("8");
    expect(nr("energy_reseller")).toBe("5 Buchst. b");
    expect(nr("telecom_reseller", "2020-12-31")).toBe("rule_missing");
    expect(nr("spaceships")).toBe("rc13b_type_unknown");
    for (const table of Object.values(RC13B_TYPES)) expect(ALL_RULE_TABLES).toContain(table);
  });
});
