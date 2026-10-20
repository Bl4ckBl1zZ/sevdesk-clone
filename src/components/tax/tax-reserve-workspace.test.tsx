import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { estimateTaxReserve } from "@/domain/tax/reserve";
import { renderWithIntl } from "@/i18n/test-utils";
import { Result } from "./tax-reserve-workspace";

const view = {
  ...estimateTaxReserve({
    year: 2026,
    today: "2026-10-20",
    entity: "natural",
    gewerbe: true,
    ytdProfitCents: 0,
    profitBasis: "euer",
    profitOverrideCents: 6_000_000,
    splitting: false,
    churchTaxBp: 0,
    hebesatzBp: 40_000,
    prepaidCents: { est: 0, gewst: 0, kst: 0 },
    ust: { openCents: 190_000, periods: ["09/2026"] },
  }),
  saved: null,
  legalForm: "einzelunternehmen",
};

describe("/steuern/ruecklage (RPT-011)", () => {
  test("RPT-011 the result is visibly labelled „Schätzung – keine Steuerberatung“ and lists every assumption", () => {
    renderWithIntl(<Result view={view} />);
    expect(screen.getByRole("note")).toHaveTextContent("Schätzung – keine Steuerberatung");
    const list = screen.getByRole("heading", { name: "Annahmen" }).parentElement as HTMLElement;
    expect(within(list).getAllByRole("listitem")).toHaveLength(view.assumptions.length);
    expect(screen.getByText("Gewerbesteueranrechnung (§ 35 EStG)")).toBeInTheDocument();
    expect(screen.getByText("Jetzt zurücklegen")).toBeInTheDocument();
  });
});
