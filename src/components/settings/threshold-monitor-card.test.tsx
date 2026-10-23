import { screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ThresholdMonitorCard } from "./threshold-monitor-card";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));

const nb = (s: string | null) => (s ?? "").replace(/ /g, " ");

describe("ThresholdMonitorCard", () => {
  test("SET-040 renders turnover/profit against 800.000 € / 80.000 €, the unknown EÜR profit and the § 141 AO notice", () => {
    backend.data = {
      "settings:thresholdMonitor": {
        blocking: false,
        bars: [
          {
            key: "turnover_prior_year",
            year: 2025,
            amountCents: 85_000_000,
            limitCents: 80_000_000,
            bp: 10625,
            level: "exceeded",
          },
          {
            key: "turnover_current_year",
            year: 2026,
            amountCents: 66_000_000,
            limitCents: 80_000_000,
            bp: 8250,
            level: "warn_80",
          },
          { key: "profit_prior_year", year: 2025, amountCents: null, limitCents: 8_000_000, bp: 0, level: "unknown" },
        ],
        notices: [
          {
            code: "bookkeeping_duty_info",
            severity: "info",
            message: "Umsatz oder Gewinn 2025 liegen über den Grenzen des § 141 AO.",
          },
        ],
      },
    };
    renderWithIntl(<ThresholdMonitorCard />);
    const card = screen.getByTestId("threshold-monitor");
    expect(nb(card.textContent)).toContain("Gesamtumsatz 2025");
    expect(nb(card.textContent)).toContain("850.000,00 € von 800.000,00 €");
    expect(nb(card.textContent)).toContain("Noch nicht bekannt – folgt aus der EÜR 2025.");
    expect(nb(card.textContent)).toContain("§ 141 AO");
    expect(screen.getByRole("progressbar", { name: /Gesamtumsatz 2026 \(laufend\): 82 %/ })).toBeInTheDocument();
    // information only: no button, nothing to confirm
    expect(screen.queryByRole("button")).toBeNull();
  });
});
