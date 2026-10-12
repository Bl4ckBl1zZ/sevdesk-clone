import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { euVatPrefixesAt, isEuVatCountry, isEuVatPrefix, vatPrefixToCountry } from "./eu-vat-countries";
import { EVATR_STATUS, evatrStatus } from "./evatr-status";
import { EXEMPTION_REASONS, lookupExemptionReason } from "./exemption-reasons";
import { isRc13bType, lookupRc13bType, RC13B_TYPES } from "./rc13b-types";
import { ALL_RULE_TABLES } from "./registry";

const d = calendarDate;

describe("EU VAT territory (CON-025, CON-E10, CON-E12)", () => {
  test("CON-E12 GB VAT IDs are EU only until 2020-12-31; XI (Northern Ireland) from 2021-01-01", () => {
    expect(isEuVatPrefix("GB", d("2020-12-31"))).toBe(true);
    expect(isEuVatPrefix("GB", d("2021-01-01"))).toBe(false);
    expect(isEuVatPrefix("XI", d("2020-12-31"))).toBe(false);
    expect(isEuVatPrefix("XI", d("2021-01-01"))).toBe(true);
    expect(euVatPrefixesAt(d("2026-10-12")).prefixes).toHaveLength(28);
    expect(euVatPrefixesAt(d("2010-01-01")).prefixes).toEqual([]);
  });

  test("CON-E10 XI is valid for goods only", () => {
    expect(euVatPrefixesAt(d("2026-10-12")).goodsOnly).toEqual(["XI"]);
  });

  test("CON-025 address countries map to VAT prefixes (GR ↔ EL)", () => {
    expect(isEuVatCountry("GR", d("2026-10-12"))).toBe(true);
    expect(isEuVatCountry("CH", d("2026-10-12"))).toBe(false);
    expect(isEuVatCountry("GB", d("2019-06-01"))).toBe(true);
    expect(isEuVatCountry("GB", d("2026-06-01"))).toBe(false);
    expect(vatPrefixToCountry("EL")).toBe("GR");
    expect(vatPrefixToCountry("XI")).toBe("GB");
    expect(vatPrefixToCountry("FR")).toBe("FR");
  });
});

describe("eVatR status table (CON-051, CON-054, F02 §4.2)", () => {
  test("CON-054 evatr-0000 is valid; not-assigned and expired IDs are invalid; service errors are unavailable", () => {
    expect(evatrStatus("evatr-0000").outcome).toBe("valid");
    expect(evatrStatus("evatr-2001").outcome).toBe("invalid");
    expect(evatrStatus("evatr-2006").outcome).toBe("invalid");
    expect(evatrStatus("evatr-0011").outcome).toBe("unavailable");
    expect(evatrStatus("evatr-2005").outcome).toBe("request");
  });

  test("CON-055 unknown codes are never valid or invalid but unavailable (override path)", () => {
    const unknown = evatrStatus("evatr-9999");
    expect(unknown.outcome).toBe("unavailable");
    expect(unknown.message).toContain("evatr-9999");
  });

  test("CON-051 the bundled table holds every code of /v1/info/statusmeldungen once", () => {
    const codes = EVATR_STATUS.map((e) => e.status);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(26);
  });
});

describe("§13b types (PRD-009a, UST-22)", () => {
  test("PRD-009a rc13bTypes is date-effective data with paragraph and Kz 60", () => {
    const r = lookupRc13bType("construction", d("2026-10-12"));
    expect(r.ok && r.value.value).toMatchObject({ paragraphNr: "4", ustvaKz: "60" });
    expect(Object.keys(RC13B_TYPES)).toHaveLength(10);
    expect(isRc13bType("metals")).toBe(true);
  });

  test("T-PRD-055 an unknown type → rc13b_type_unknown (product field: RC13B_TYPE_UNKNOWN); before the first row → rule_missing", () => {
    const unknown = lookupRc13bType("bananas", d("2026-10-12"));
    expect(!unknown.ok && unknown.error.code).toBe("rc13b_type_unknown");
    const early = lookupRc13bType("construction", d("2020-12-31"));
    expect(!early.ok && early.error.code).toBe("rule_missing");
  });
});

describe("exemption reasons (PRD-024, UST-10)", () => {
  test("PRD-024 VATEX codes map to the § 4 UStG number of the exempt_4 note", () => {
    const r = lookupExemptionReason("VATEX-EU-132-1C", d("2026-10-12"));
    expect(r.ok && r.value.ustgNr).toBe("14");
    expect(Object.keys(EXEMPTION_REASONS).length).toBeGreaterThanOrEqual(9);
    const bad = lookupExemptionReason("VATEX-EU-XYZ", d("2026-10-12"));
    expect(!bad.ok && bad.error.code).toBe("EXEMPTION_REASON_INVALID");
    const early = lookupExemptionReason("VATEX-EU-132-1C", d("2000-01-01"));
    expect(early.ok).toBe(false);
  });

  test("SET-120 the new tables are listed in the rule registry", () => {
    const ids = ALL_RULE_TABLES.map((t) => t.id);
    expect(ids).toContain("eu_vat_territory");
    expect(ids).toContain("rc13b_construction");
    expect(ids).toContain("VATEX-EU-132-1C");
  });

  test("SET-120 rule table ids are unique across all slices (row ids and overrides are keyed by them)", () => {
    const ids = ALL_RULE_TABLES.map((t) => t.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
