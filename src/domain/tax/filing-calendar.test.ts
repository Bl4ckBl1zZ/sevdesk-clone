import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import {
  type CalendarSettings,
  deadlinesForTaxYear,
  dueNotifications,
  suggestUstvaPeriod,
  ustvaDeadline,
  zmDeadline,
} from "./filing-calendar";
import { computeSondervorauszahlung } from "./sondervorauszahlung";

const base: CalendarSettings = {
  ustvaPeriod: "quarterly",
  dauerfrist: false,
  zm: null,
  state: "BE",
  estPrepayments: false,
  gewstPrepayments: false,
  euServices: false,
  euer: true,
  gewerbe: true,
};

describe("filing period and deadline calendar (TAX-001, TAX-019, UVA-01)", () => {
  test("TAX-001 UVA-01 TST-TAX-01 E-UVA-11 prior-year tax 9,000.00 € → quarterly; 9,000.01 € → monthly", () => {
    expect(suggestUstvaPeriod({ year: 2027, priorYearTaxCents: 900_000 }).period).toBe("quarterly");
    const monthly = suggestUstvaPeriod({ year: 2027, priorYearTaxCents: 900_001 });
    expect(monthly.period).toBe("monthly");
    expect(monthly.reason).toBe("Ihre Zahllast 2026 lag über 9.000 € – ab 2027 monatliche Voranmeldung.");
    // ≤ 2,000 €: waiver possible on application, never applied automatically
    expect(suggestUstvaPeriod({ year: 2027, priorYearTaxCents: 200_000 })).toMatchObject({
      period: "quarterly",
      waiverPossible: true,
    });
    // date-effective: before 2025 the monthly limit was 7,500 €
    expect(suggestUstvaPeriod({ year: 2024, priorYearTaxCents: 800_000 }).period).toBe("monthly");
  });

  test("TAX-001 Neugründer rule per year from the table (2026: suspended; 2027: monthly ⚠)", () => {
    expect(suggestUstvaPeriod({ year: 2026, priorYearTaxCents: null, foundedOn: "2026-03-01" }).period).toBe(
      "quarterly",
    );
    expect(suggestUstvaPeriod({ year: 2027, priorYearTaxCents: null, foundedOn: "2026-03-01" }).period).toBe("monthly");
  });

  test("TAX-001 TST-TAX-01 E-UVA-10 Q1/2027 due 2027-04-10 (Saturday) → 2027-04-12; Dauerfrist adds a month", () => {
    expect(ustvaDeadline("2027-Q1", false, "BE")).toEqual({ statutory: "2027-04-10", due: "2027-04-12" });
    expect(ustvaDeadline("2026-09", false, "BE")).toEqual({ statutory: "2026-10-10", due: "2026-10-12" });
    expect(ustvaDeadline("2026-09", true, "BE")).toEqual({ statutory: "2026-11-10", due: "2026-11-10" });
    // ZM on the 25th, no Dauerfrist (TST-TAX-11: Q3 due 25.10.; 2026-10-25 is a Sunday)
    expect(zmDeadline("2026-Q3", "BE")).toEqual({ statutory: "2026-10-25", due: "2026-10-26" });
  });

  test("TAX-019 TST-TAX-36 calendar 2026 without Steuerberater: annual returns 31.07.2027 (shifted to 02.08.2027), reminders 6 and 1 weeks before", () => {
    const list = deadlinesForTaxYear(2026, {
      ...base,
      ustvaPeriod: "monthly",
      dauerfrist: true,
      zm: "quarterly",
      estPrepayments: true,
      gewstPrepayments: true,
    });
    const annual = list.filter((d) => d.kind.startsWith("annual_"));
    expect(annual.map((d) => [d.kind, d.statutory, d.due])).toEqual([
      ["annual_euer", "2027-07-31", "2027-08-02"],
      ["annual_ust", "2027-07-31", "2027-08-02"],
      ["annual_gewst", "2027-07-31", "2027-08-02"],
    ]);
    expect(annual[0]?.remindOn).toEqual(["2027-06-21", "2027-07-26"]);
    expect(list.find((d) => d.kind === "sondervorauszahlung")).toMatchObject({
      statutory: "2026-02-10",
      due: "2026-02-10",
    });
    expect(list.filter((d) => d.kind === "ustva")).toHaveLength(12);
    expect(list.find((d) => d.period === "2026-12" && d.kind === "ustva")).toMatchObject({ statutory: "2027-02-10" });
    expect(list.filter((d) => d.kind === "zm").map((d) => d.due)).toEqual([
      "2026-04-27",
      "2026-07-27",
      "2026-10-26",
      "2027-01-25",
    ]);
    expect(list.filter((d) => d.kind === "est_prepayment").map((d) => d.statutory)).toEqual([
      "2026-03-10",
      "2026-06-10",
      "2026-09-10",
      "2026-12-10",
    ]);
    expect(list.filter((d) => d.kind === "gewst_prepayment").map((d) => d.due)).toEqual([
      "2026-02-16",
      "2026-05-15",
      "2026-08-17",
      "2026-11-16",
    ]);
    const today = dueNotifications(list, calendarDate("2027-06-21"));
    expect(today.map((n) => [n.deadline.kind, n.when])).toEqual([
      ["annual_euer", "reminder"],
      ["annual_ust", "reminder"],
      ["annual_gewst", "reminder"],
    ]);
  });

  test("TAX-019 TAX-011 a KU company without UStVA has no UStVA deadlines, but the annual returns", () => {
    const list = deadlinesForTaxYear(2026, { ...base, ustvaPeriod: null });
    expect(list.some((d) => d.kind === "ustva")).toBe(false);
    expect(list.some((d) => d.kind === "annual_ust")).toBe(true);
  });
});

describe("Sondervorauszahlung (TAX-002, UVA-02)", () => {
  test("TAX-002 UVA-02 TST-TAX-02 prior-year advance payments 22,000 € → Sondervorauszahlung 2,000 €", () => {
    const months = [...Array(11).fill(200_000), 0];
    const r = computeSondervorauszahlung({
      year: 2027,
      period: "monthly",
      dauerfrist: true,
      priorYearKz83Cents: months,
    });
    expect(r).toMatchObject({ ok: true, value: { basisCents: 2_200_000, amountCents: 200_000 } });
  });

  test("TAX-002 only positive Kz 83 values count (Überschüsse are no Vorauszahlungen ⚠); prior SVZ is added back", () => {
    const r = computeSondervorauszahlung({
      year: 2027,
      period: "monthly",
      dauerfrist: true,
      priorYearKz83Cents: [110_000, -50_000, 0],
      priorYearSondervorauszahlungCents: 0,
    });
    expect(r).toMatchObject({ ok: true, value: { basisCents: 110_000, amountCents: 10_000 } });
    const withPrior = computeSondervorauszahlung({
      year: 2027,
      period: "monthly",
      dauerfrist: true,
      priorYearKz83Cents: [100_000],
      priorYearSondervorauszahlungCents: 10_000,
    });
    expect(withPrior).toMatchObject({ ok: true, value: { amountCents: 10_000 } });
  });

  test("TAX-002 quarterly filers pay no Sondervorauszahlung", () => {
    expect(
      computeSondervorauszahlung({ year: 2027, period: "quarterly", dauerfrist: true, priorYearKz83Cents: [1] }),
    ).toMatchObject({ ok: false, error: { code: "not_monthly" } });
  });
});
