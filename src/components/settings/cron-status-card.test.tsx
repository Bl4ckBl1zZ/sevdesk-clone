import { screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { CronStatusCard } from "./cron-status-card";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));

describe("CronStatusCard", () => {
  test("SET-134 shows each job with last run, duration, result and next run (Berlin time); overdue and never-run rows", () => {
    backend.data = {
      "settings:cronStatus": [
        {
          name: "members.expire",
          job: "cron.members.expire",
          schedule: "5 * * * * (UTC)",
          lastRunAt: Date.parse("2026-10-12T10:05:00Z"),
          durationMs: 1500,
          result: "ok",
          nextRunAt: Date.parse("2026-10-12T11:05:00Z"),
          state: "ok",
        },
        {
          name: "rules.freshness",
          job: "cron.rules.freshness",
          schedule: "20 6 * * 1 (UTC)",
          lastRunAt: null,
          durationMs: null,
          result: null,
          nextRunAt: Date.parse("2026-10-19T06:20:00Z"),
          state: "never",
        },
        {
          name: "system.clock",
          job: "cron.system.clock",
          schedule: "alle 10 Min.",
          lastRunAt: Date.parse("2026-10-12T07:00:00Z"),
          durationMs: 40,
          result: "ok",
          nextRunAt: Date.parse("2026-10-12T07:10:00Z"),
          state: "overdue",
        },
      ],
    };
    renderWithIntl(<CronStatusCard />);
    const rows = within(screen.getByTestId("cron-status")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("members.expire");
    expect(rows[1]).toHaveTextContent("12.10.26, 12:05"); // 10:05 UTC = 12:05 CEST
    expect(rows[1]).toHaveTextContent("1,5 s");
    expect(rows[1]).toHaveTextContent("in Ordnung");
    expect(rows[1]).toHaveTextContent("12.10.26, 13:05");
    expect(rows[2]).toHaveTextContent("noch nie");
    expect(rows[2]).toHaveTextContent("noch nicht gelaufen");
    expect(rows[3]).toHaveTextContent("überfällig");
    expect(rows[3]).toHaveTextContent("40 ms");
  });
});
