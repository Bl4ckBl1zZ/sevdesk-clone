import { describe, expect, test } from "vitest";
import { addDays, calendarDate } from "../time/calendar-date";
import { armedAlerts, budgetAlertText, budgetConsumption, budgetStatus, evaluateBudgetAlerts } from "./budget";
import { computeProfitability } from "./profitability";
import { summarizeUnbilled, unbilledEntryLevel, unbilledEscalationText, unbilledWarningText } from "./unbilled";

const d = calendarDate;

describe("PRJ-003 budget monitoring", () => {
  test("PRJ-003 TST-PRJ-16 hours budget 10 h: reaching 8 h then 10 h notifies once each; raising the budget re-arms", () => {
    const budget = { kind: "hours", value: 600 } as const;
    let alerts = armedAlerts();
    const step = (minutes: number, now: number) => {
      const consumed = budgetConsumption(budget, [{ durationMinutes: minutes, billable: true, hourlyRateMicros: 0 }]);
      const r = evaluateBudgetAlerts(alerts, budgetStatus(budget, consumed).ratioBp, now);
      alerts = r.alerts;
      return r.notify;
    };
    expect(step(300, 1)).toEqual([]);
    expect(step(480, 2)).toEqual([8000]);
    expect(step(500, 3)).toEqual([]);
    expect(step(600, 4)).toEqual([10000]);
    expect(step(620, 5)).toEqual([]);
    // budget raised to 20 h → both thresholds re-armed
    const raised = evaluateBudgetAlerts(alerts, budgetStatus({ kind: "hours", value: 1200 }, 620).ratioBp, 6);
    expect(raised.notify).toEqual([]);
    expect(raised.alerts).toEqual([{ thresholdBp: 8000 }, { thresholdBp: 10000 }]);
  });

  test("PRJ-003 PRJ-016 hours count non-billable time; amount budgets count billable value plus invoiced fixed amounts", () => {
    const entries = [
      { durationMinutes: 60, billable: true, hourlyRateMicros: 900_000 },
      { durationMinutes: 30, billable: false, hourlyRateMicros: 900_000 },
    ];
    expect(budgetConsumption({ kind: "hours", value: 600 }, entries)).toBe(90);
    expect(budgetConsumption({ kind: "amount", value: 100_000 }, entries, 50_000)).toBe(59_000);
    const s = budgetStatus({ kind: "amount", value: 100_000 }, 85_000);
    expect(s).toMatchObject({ ratioBp: 8500, level: "warning", label: "850,00 € von 1.000,00 €" });
    expect(budgetStatus({ kind: "hours", value: 600 }, 600).level).toBe("exceeded");
    expect(budgetStatus({ kind: "hours", value: 0 }, 60)).toMatchObject({ ratioBp: 0, level: "ok" });
    expect(budgetAlertText("Website", 8000, budgetStatus({ kind: "hours", value: 600 }, 480))).toBe(
      "Projekt Website: 80 % des Budgets verbraucht (8:00 h von 10:00 h).",
    );
  });
});

describe("PRJ-004 profitability", () => {
  test("PRJ-004 TST-PRJ-17 invoices 10.000 €, Storno 1.000 €, vouchers 2.000 €, 40 h × 30 € → margin 5.800 € (64,44 %)", () => {
    const p = computeProfitability({
      revenue: [
        { id: "i1", kind: "invoice", netCents: 1_000_000 },
        { id: "s1", kind: "cancellation", netCents: -100_000 },
      ],
      costs: [{ id: "v1", netCents: 200_000 }],
      time: [{ durationMinutes: 2400 }],
      internalCostRateMicros: 300_000,
    });
    expect(p).toMatchObject({
      revenueCents: 900_000,
      voucherCostCents: 200_000,
      timeCostCents: 120_000,
      costsCents: 320_000,
      marginCents: 580_000,
      minutes: 2400,
    });
    // Margin % on the revenue after the Storno: 5.800 / 9.000 = 64,44 % (owner decision 2026-10-22, F11 PRJ-004).
    expect(p.marginBp).toBe(6444);
  });

  test("PRJ-004 non-deductible VAT counts as cost; no revenue → no margin %", () => {
    const p = computeProfitability({
      revenue: [],
      costs: [{ id: "v", netCents: 10_000, nonDeductibleVatCents: 1_900 }],
      time: [{ durationMinutes: 60 }],
    });
    expect(p).toMatchObject({ costsCents: 11_900, timeCostCents: 0, marginCents: -11_900, marginBp: null });
  });
});

describe("PRJ-015 UST-01 monitor for unbilled time", () => {
  const today = d("2026-10-20");
  const b2b = { isConsumer: false, kind: "organization" } as const;
  const consumer = { isConsumer: true, kind: "person" } as const;
  const open = (daysAgo: number) => ({ date: addDays(today, -daysAgo), billable: true, status: "open" }) as const;

  test("PRJ-015 UST-01 EC-026 TST-PRJ-15 boundaries 150/151 (warning) and 180/181 (escalation for B2B)", () => {
    expect(unbilledEntryLevel(open(150), b2b, today)).toBeNull();
    expect(unbilledEntryLevel(open(151), b2b, today)).toEqual({ level: "warning", daysSince: 151 });
    expect(unbilledEntryLevel(open(180), b2b, today)?.level).toBe("warning");
    expect(unbilledEntryLevel(open(181), b2b, today)).toEqual({ level: "escalation", daysSince: 181 });
    // consumers: warning only (no six-month duty), unknown customer counts as obligated
    expect(unbilledEntryLevel(open(181), consumer, today)?.level).toBe("warning");
    expect(unbilledEntryLevel(open(181), null, today)?.level).toBe("escalation");
    expect(unbilledEntryLevel({ ...open(200), billable: false }, b2b, today)).toBeNull();
    expect(unbilledEntryLevel({ ...open(200), status: "invoiced" }, b2b, today)).toBeNull();
    expect(unbilledEntryLevel(open(-1), b2b, today)).toBeNull();
    expect(unbilledEntryLevel(open(9000), b2b, today)).toBeNull(); // before the first rule row (2004): no guess
  });

  test("PRJ-015 E-PRJ-26 summary counts and German texts", () => {
    const s = summarizeUnbilled(
      [
        { ...open(10), customer: b2b },
        { ...open(160), customer: b2b },
        { ...open(190), customer: b2b },
      ],
      today,
    );
    expect(s).toEqual({ warning: 1, escalation: 1, oldestDate: addDays(today, -190) });
    expect(summarizeUnbilled([], today)).toEqual({ warning: 0, escalation: 0 });
    expect(unbilledWarningText(3)).toBe(
      "3 abrechenbare Zeiteinträge sind älter als 150 Tage. Rechnungen müssen spätestens 6 Monate nach der Leistung gestellt werden (§ 14 Abs. 2 UStG).",
    );
    expect(unbilledEscalationText(1)).toContain("Rechnungsfrist überschritten");
  });
});
