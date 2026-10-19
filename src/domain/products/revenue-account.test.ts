import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { automaticAccountVat, keyRatesFromToday, revenueAccountIssue, revenueAccountOptions } from "./revenue-account";

const TODAY = "2026-10-19" as CalendarDate;

describe("revenue account override (PRD-050, PRD-052)", () => {
  test("PRD-050 only a revenue account of the company chart is accepted", () => {
    expect(revenueAccountIssue({ chart: "SKR03", account: "8400", date: TODAY, rates: [] })).toBeNull();
    expect(revenueAccountIssue({ chart: "SKR03", account: "1200", date: TODAY, rates: [] })).toMatchObject({
      code: "REVENUE_ACCOUNT_INVALID",
      message: "Das Konto 1200 ist kein Erlöskonto im SKR 03.",
    });
    expect(revenueAccountIssue({ chart: "SKR04", account: "8400", date: TODAY, rates: [] })?.code).toBe(
      "REVENUE_ACCOUNT_INVALID",
    );
    expect(revenueAccountOptions("SKR04", TODAY).some((a) => a.number === "4400")).toBe(true);
    expect(revenueAccountOptions("SKR04", TODAY).some((a) => a.number === "1200")).toBe(false);
  });

  test("PRD-052 T-PRD-017 the 7 % automatic account 8300 is refused for a standard product and accepted for a reduced one", () => {
    expect(automaticAccountVat("SKR03", "8300", TODAY)).toEqual({ category: "S", rateBp: 700 });
    const standard = keyRatesFromToday("standard", TODAY);
    expect(standard).toEqual([{ category: "S", rateBp: 1900 }]);
    expect(revenueAccountIssue({ chart: "SKR03", account: "8300", date: TODAY, rates: standard })?.code).toBe(
      "REVENUE_ACCOUNT_RATE_MISMATCH",
    );
    expect(
      revenueAccountIssue({ chart: "SKR03", account: "8300", date: TODAY, rates: keyRatesFromToday("reduced", TODAY) }),
    ).toBeNull();
  });

  test("PRD-052 an automatic non-domestic account never fits a domestic line; a non-automatic account always does", () => {
    const rates = [{ category: "S", rateBp: 1900 }];
    expect(revenueAccountIssue({ chart: "SKR04", account: "4125", date: TODAY, rates })?.code).toBe(
      "REVENUE_ACCOUNT_RATE_MISMATCH",
    );
    expect(revenueAccountIssue({ chart: "SKR04", account: "4185", date: TODAY, rates })).toBeNull();
    expect(
      revenueAccountIssue({ chart: "SKR04", account: "4100", date: TODAY, rates: [{ category: "E", rateBp: 0 }] }),
    ).toBeNull();
  });

  test("PRD-052 a key's past rows do not count, known future rows do", () => {
    // The 2020 reduction (16 %) ended before today: only the current 19 % row remains.
    expect(keyRatesFromToday("standard", "2020-12-01" as CalendarDate)).toEqual([
      { category: "S", rateBp: 1600 },
      { category: "S", rateBp: 1900 },
    ]);
    expect(
      revenueAccountIssue({
        chart: "SKR03",
        account: "8400",
        date: "2020-12-01" as CalendarDate,
        rates: keyRatesFromToday("standard", "2020-12-01" as CalendarDate),
      })?.code,
    ).toBe("REVENUE_ACCOUNT_RATE_MISMATCH");
  });
});
