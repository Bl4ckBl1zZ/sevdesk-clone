import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { currentEuEeaCountries, euEeaCountriesAt, isEuEeaCountry } from "./eu-eea";

describe("EU/EEA member states (SET-046, AO-06)", () => {
  test("SET-046 the 27 EU and 3 EEA states count as EU; GB (since 2020-02-01), CH and US do not", () => {
    expect(currentEuEeaCountries()).toHaveLength(30);
    expect(isEuEeaCountry("DE")).toBe(true);
    expect(isEuEeaCountry("no")).toBe(true);
    for (const code of ["GB", "CH", "US"]) expect(isEuEeaCountry(code)).toBe(false);
  });

  test("SET-046 the list is date-effective; before the first row nothing is EU (callers treat that as non-EU)", () => {
    expect(euEeaCountriesAt(calendarDate("2026-10-12"))).toContain("AT");
    expect(euEeaCountriesAt(calendarDate("2019-12-31"))).toEqual([]);
  });
});
