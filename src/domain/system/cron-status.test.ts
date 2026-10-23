import { describe, expect, test } from "vitest";
import { cronStatusRows, nextRunAt, scheduleText } from "./cron-status";

const at = (iso: string) => Date.parse(iso);

describe("SET-134 cron schedule: next run", () => {
  test("SET-134 cron expressions in UTC: fixed minute/hour, lists, ranges, steps and weekdays", () => {
    const after = at("2026-10-12T10:07:00Z"); // Monday
    expect(nextRunAt({ type: "cron", cron: "30 * * * *" }, after)).toBe(at("2026-10-12T10:30:00Z"));
    expect(nextRunAt({ type: "cron", cron: "0 6 * * *" }, after)).toBe(at("2026-10-13T06:00:00Z"));
    expect(nextRunAt({ type: "cron", cron: "30 3,9,15,21 * * *" }, after)).toBe(at("2026-10-12T15:30:00Z"));
    expect(nextRunAt({ type: "cron", cron: "*/15 8-9 * * *" }, after)).toBe(at("2026-10-13T08:00:00Z"));
    expect(nextRunAt({ type: "cron", cron: "20 6 * * 1" }, after)).toBe(at("2026-10-19T06:20:00Z"));
    expect(nextRunAt({ type: "cron", cron: "0 3 1 * *" }, after)).toBe(at("2026-11-01T03:00:00Z"));
    // strictly after: a run due exactly now is the following one
    expect(nextRunAt({ type: "cron", cron: "7 10 * * *" }, after)).toBe(at("2026-10-13T10:07:00Z"));
  });

  test("SET-134 interval, monthly, weekly, daily and hourly schedules", () => {
    const after = at("2026-10-12T10:07:00Z");
    expect(nextRunAt({ type: "interval", seconds: 600 }, after, after - 120_000)).toBe(at("2026-10-12T10:15:00Z"));
    expect(nextRunAt({ type: "interval", seconds: 600 }, after)).toBeNull(); // never ran: start unknown
    expect(nextRunAt({ type: "monthly", day: 1, hourUTC: 6, minuteUTC: 0 }, after)).toBe(at("2026-11-01T06:00:00Z"));
    expect(nextRunAt({ type: "daily", hourUTC: 9, minuteUTC: 0 }, after)).toBe(at("2026-10-13T09:00:00Z"));
    expect(nextRunAt({ type: "hourly", minuteUTC: 5 }, after)).toBe(at("2026-10-12T11:05:00Z"));
    expect(nextRunAt({ type: "weekly", dayOfWeek: "wednesday", hourUTC: 1, minuteUTC: 0 }, after)).toBe(
      at("2026-10-14T01:00:00Z"),
    );
  });
});

describe("SET-134 cron status rows", () => {
  const now = at("2026-10-12T10:07:00Z");
  test("SET-134 every registered cron with last run, duration, result and next run; overdue and never-run states", () => {
    const rows = cronStatusRows(
      [
        {
          name: "members.expire",
          functionName: "members:expireCron",
          job: "cron.members.expire",
          schedule: { type: "cron", cron: "5 * * * *" },
        },
        {
          name: "system.clock",
          functionName: "system:clockCron",
          job: "cron.system.clock",
          schedule: { type: "interval", seconds: 600 },
        },
        {
          name: "dsgvo.deadlines",
          functionName: "dsgvo:deadlinesCron",
          job: "cron.dsgvo.deadlines",
          schedule: { type: "cron", cron: "30 7 * * *" },
        },
      ],
      [
        { job: "cron.members.expire", lastRunAt: at("2026-10-12T10:05:00Z"), durationMs: 42, result: "ok" },
        // last ran 3 h ago although it should run every 10 minutes
        { job: "cron.system.clock", lastRunAt: at("2026-10-12T07:00:00Z"), durationMs: 1200, result: "ok" },
      ],
      now,
    );
    expect(rows).toEqual([
      {
        name: "dsgvo.deadlines",
        job: "cron.dsgvo.deadlines",
        schedule: "30 7 * * * (UTC)",
        lastRunAt: null,
        durationMs: null,
        result: null,
        nextRunAt: at("2026-10-13T07:30:00Z"),
        state: "never",
      },
      {
        name: "members.expire",
        job: "cron.members.expire",
        schedule: "5 * * * * (UTC)",
        lastRunAt: at("2026-10-12T10:05:00Z"),
        durationMs: 42,
        result: "ok",
        nextRunAt: at("2026-10-12T11:05:00Z"),
        state: "ok",
      },
      {
        name: "system.clock",
        job: "cron.system.clock",
        schedule: "alle 10 Min.",
        lastRunAt: at("2026-10-12T07:00:00Z"),
        durationMs: 1200,
        result: "ok",
        nextRunAt: at("2026-10-12T07:10:00Z"),
        state: "overdue",
      },
    ]);
  });
});

describe("SET-134 cron schedule: edge cases", () => {
  const after = at("2026-10-12T10:07:00Z"); // Monday

  test("SET-134 Sunday may be written as 7; with day-of-month and weekday restricted either may match", () => {
    expect(nextRunAt({ type: "cron", cron: "0 4 * * 7" }, after)).toBe(at("2026-10-18T04:00:00Z"));
    // classic cron: „the 20th or a Wednesday“ → Wednesday 14th comes first
    expect(nextRunAt({ type: "cron", cron: "0 4 20 * 3" }, after)).toBe(at("2026-10-14T04:00:00Z"));
    expect(nextRunAt({ type: "cron", cron: "0 4 13 * 5" }, after)).toBe(at("2026-10-13T04:00:00Z"));
  });

  test("SET-134 stepped ranges and months; an impossible date has no next run", () => {
    expect(nextRunAt({ type: "cron", cron: "0 10-22/6 * * *" }, after)).toBe(at("2026-10-12T16:00:00Z"));
    expect(nextRunAt({ type: "cron", cron: "0 0 1 1 *" }, after)).toBe(at("2027-01-01T00:00:00Z"));
    expect(nextRunAt({ type: "cron", cron: "0 12 5/10 * *" }, after)).toBe(at("2026-10-15T12:00:00Z"));
    expect(nextRunAt({ type: "cron", cron: "0 0 31 2 *" }, after)).toBeNull();
  });

  test("SET-134 schedules without explicit minute default to :00; intervals in minutes or hours", () => {
    expect(nextRunAt({ type: "hourly" }, after)).toBe(at("2026-10-12T11:00:00Z"));
    expect(nextRunAt({ type: "daily", hourUTC: 23 }, after)).toBe(at("2026-10-12T23:00:00Z"));
    expect(nextRunAt({ type: "weekly", dayOfWeek: "monday", hourUTC: 9 }, after)).toBe(at("2026-10-19T09:00:00Z"));
    expect(nextRunAt({ type: "monthly", day: 15, hourUTC: 2 }, after)).toBe(at("2026-10-15T02:00:00Z"));
    expect(nextRunAt({ type: "interval", minutes: 30 }, after, after)).toBe(after + 30 * 60_000);
    expect(nextRunAt({ type: "interval", hours: 2 }, after, after)).toBe(after + 2 * 3_600_000);
    expect(nextRunAt({ type: "interval" }, after, after)).toBeNull();
  });

  test("SET-134 the German schedule texts for every schedule type", () => {
    expect(scheduleText({ type: "interval", hours: 2 })).toBe("alle 2 Std.");
    expect(scheduleText({ type: "interval", minutes: 90 })).toBe("alle 90 Min.");
    expect(scheduleText({ type: "hourly" })).toBe("stündlich (:00 UTC)");
    expect(scheduleText({ type: "hourly", minuteUTC: 5 })).toBe("stündlich (:05 UTC)");
    expect(scheduleText({ type: "daily", hourUTC: 3 })).toBe("täglich 03:00 UTC");
    expect(scheduleText({ type: "daily", hourUTC: 3, minuteUTC: 30 })).toBe("täglich 03:30 UTC");
    expect(scheduleText({ type: "weekly", dayOfWeek: "monday", hourUTC: 6 })).toBe("wöchentlich (monday) 06:00 UTC");
    expect(scheduleText({ type: "weekly", dayOfWeek: "monday", hourUTC: 6, minuteUTC: 15 })).toBe(
      "wöchentlich (monday) 06:15 UTC",
    );
    expect(scheduleText({ type: "monthly", day: 1, hourUTC: 4 })).toBe("monatlich am 1. 04:00 UTC");
    expect(scheduleText({ type: "monthly", day: 1, hourUTC: 4, minuteUTC: 5 })).toBe("monatlich am 1. 04:05 UTC");
  });

  test("SET-134 a failed last run shows „error“; a cron without system job never has a run", () => {
    const rows = cronStatusRows(
      [
        { name: "a.failed", functionName: "a:f", job: "cron.a", schedule: { type: "hourly", minuteUTC: 0 } },
        { name: "b.nojob", functionName: "b:f", job: null, schedule: { type: "daily", hourUTC: 1 } },
      ],
      [{ job: "cron.a", lastRunAt: at("2026-10-12T10:00:00Z"), durationMs: 5, result: "error" }],
      after,
    );
    expect(rows.map((r) => [r.name, r.state, r.result])).toEqual([
      ["a.failed", "error", "error"],
      ["b.nojob", "never", null],
    ]);
  });
});
