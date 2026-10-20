import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { KpiGrid } from "./kpi-card";

describe("Übersicht „Kennzahlen“ (RPT-002)", () => {
  test("RPT-002 revenue, expenses, result, payables, cash, USt-Zahllast, AfA YTD, tax reserve and the liquidity sparkline", () => {
    renderWithIntl(
      <KpiGrid
        data={{
          period: "month",
          from: "2026-10-01",
          to: "2026-10-20",
          revenueCents: 500_000,
          expensesCents: 120_000,
          resultCents: 380_000,
          openPayablesCents: 30_000,
          cashCents: 15_000,
          ust: { period: "2026-10", cents: 76_000 },
          afaYtdCents: 40_000,
          taxReserve: {
            reserveNowCents: 900_000,
            monthlyCents: 100_000,
            disclaimer: "Schätzung – keine Steuerberatung",
          },
          liquidity: {
            openingCents: 1_000_000,
            weeks: [
              { to: "2026-10-26", cents: 1_000_000 },
              { to: "2026-11-02", cents: 1_200_000 },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Umsatz (netto)" })).toHaveAttribute(
      "href",
      "/auswertungen?bericht=umsatz",
    );
    expect(screen.getByText(/^3\.800,00/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "USt-Zahllast 10/2026" })).toHaveAttribute("href", "/steuern/ustva");
    expect(screen.getByRole("link", { name: "Steuer-Rücklage jetzt" })).toHaveAttribute("href", "/steuern/ruecklage");
    expect(screen.getByText("Schätzung – keine Steuerberatung")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Liquiditätsvorschau 90 Tage/ })).toHaveAttribute(
      "href",
      "/auswertungen/liquiditaet",
    );
  });
});
