import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { computeForecast } from "@/domain/reports/forecast";
import { renderWithIntl } from "@/i18n/test-utils";
import { ForecastChart } from "./forecast-workspace";

const f = computeForecast({
  today: "2026-10-20",
  openingCents: 500_000,
  history: [],
  thresholdCents: 200_000,
  items: [{ id: "t", source: "tax", label: "UStVA", cents: -350_000, date: "2026-11-10" }],
});

describe("Liquiditätsvorschau chart (RPT-012)", () => {
  test("RPT-012 the weekly chart has an accessible name, a legend with the threshold and a table for screen readers", () => {
    renderWithIntl(<ForecastChart weeks={f.weeks} thresholdCents={f.thresholdCents} />);
    expect(
      screen.getByRole("img", { name: "Liquiditätsvorschau je Woche: erwartet und vorsichtig" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Mindestkontostand 2\.000,00/)).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 13);
    expect(f.belowThreshold.expected).toBe("2026-11-10");
  });
});
