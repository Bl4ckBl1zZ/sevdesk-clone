import { describe, expect, test } from "vitest";
import { formatElapsed } from "../projects/time-entries";
import {
  emptyProjectForm,
  projectFormFromRecord,
  projectFormSchema,
  stockAdjustmentSchema,
  stockSettingsSchema,
  timeEntryFormFromRecord,
  timeEntryFormSchema,
} from "./projects";

describe("PRJ-001 project form", () => {
  test("PRJ-001 a stored project round-trips through the form (rates, hours budget, rounding)", () => {
    const record = {
      name: "Website Relaunch",
      description: "Neue Seite",
      contactId: "c1",
      status: "active" as const,
      billingMode: "hourly" as const,
      hourlyRateMicros: 1_234_567,
      internalCostRateMicros: 450_000,
      budget: { kind: "hours" as const, value: 750 },
      startDate: "2026-10-01",
      defaultProductId: "p1",
      rounding: { incrementMinutes: 15 as const, mode: "up" as const, minimumMinutes: 30 },
    };
    const values = projectFormFromRecord(record);
    expect(values).toMatchObject({
      hourlyRate: "123,4567",
      internalCostRate: "45,00",
      budgetKind: "hours",
      budgetValue: "12,5",
      roundingIncrement: "15",
      roundingMode: "up",
      roundingMinimum: "30",
      endDate: "",
    });
    const parsed = projectFormSchema.parse(values);
    expect(parsed).toMatchObject({
      hourlyRateMicros: 1_234_567,
      internalCostRateMicros: 450_000,
      budget: { kind: "hours", value: 750 },
      rounding: { incrementMinutes: 15, mode: "up", minimumMinutes: 30 },
      contactId: "c1",
      defaultProductId: "p1",
    });
  });

  test("PRJ-003 an amount budget with thousands separators round-trips; no rounding means the default", () => {
    const values = projectFormFromRecord({
      name: "Pauschal",
      status: "done",
      billingMode: "fixed",
      budget: { kind: "amount", value: 500_000_00 },
    });
    expect(values.budgetValue).toBe("500.000,00");
    expect(values.roundingIncrement).toBe("default");
    expect(projectFormSchema.parse(values)).toMatchObject({ budget: { kind: "amount", value: 500_000_00 } });
    expect(projectFormSchema.parse({ ...emptyProjectForm(), name: "X" }).budget).toBeUndefined();
  });
});

describe("PRJ-007 time entry form", () => {
  test("PRJ-007 a stored entry fills the edit form (duration, wall-clock times, rate override)", () => {
    const v = timeEntryFormFromRecord({
      date: "2026-10-12",
      durationMinutes: 135,
      description: "Workshop",
      projectId: "pr1",
      billable: true,
      hourlyRateMicros: 950_000,
    });
    expect(v).toMatchObject({ mode: "duration", duration: "2:15", rate: "95,00", projectId: "pr1", contactId: "" });
    expect(timeEntryFormSchema.safeParse(v).success).toBe(true);
    // 2026-10-12 09:00 / 10:30 Berlin (UTC+2)
    const withTimes = timeEntryFormFromRecord({
      date: "2026-10-12",
      durationMinutes: 90,
      startedAt: Date.UTC(2026, 9, 12, 7, 0),
      endedAt: Date.UTC(2026, 9, 12, 8, 30),
      description: "Call",
      billable: false,
      hourlyRateMicros: 0,
    });
    expect(withTimes).toMatchObject({ mode: "start_end", startTime: "09:00", endTime: "10:30", rate: "" });
  });
});

describe("PRJ-005 timer display", () => {
  test("PRJ-005 elapsed time is shown as h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00:00");
    expect(formatElapsed(65_000)).toBe("0:01:05");
    expect(formatElapsed(10 * 3_600_000 + 59_999)).toBe("10:00:59");
    expect(formatElapsed(-5)).toBe("0:00:00");
  });
});

describe("PRD-090 stock forms", () => {
  test("PRD-090 PRD-096 settings and adjustments parse German quantities into milli", () => {
    expect(stockSettingsSchema.parse({ enabled: true, reorderLevel: "2,5" })).toEqual({
      enabled: true,
      reorderLevelMilli: 2500,
    });
    expect(stockSettingsSchema.safeParse({ enabled: true, reorderLevel: "-1" }).success).toBe(false);
    expect(stockAdjustmentSchema.parse({ kind: "correction", quantity: "-2", text: "Inventur" })).toEqual({
      kind: "correction",
      quantityMilli: -2000,
      text: "Inventur",
    });
  });
});
