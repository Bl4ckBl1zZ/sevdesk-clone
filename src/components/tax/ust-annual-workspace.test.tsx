import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ustAnnualMappingFor } from "@/domain/rules/ust-annual";
import { ustvaMappingFor } from "@/domain/rules/ustva";
import { computeUstAnnual } from "@/domain/tax/ust-annual";
import type { Contribution } from "@/domain/tax/ustva";
import { renderWithIntl } from "@/i18n/test-utils";
import { YearView } from "./ust-annual-workspace";

const c = (kz: string, part: Contribution["part"], cents: number, date: string, id: string): Contribution => ({
  kz,
  part,
  cents,
  taxPointDate: date,
  entryId: id,
  seq: Number(id.slice(1)),
  source: { kind: "salesDocument", id: `d${id}` },
});

function viewOf(ended: boolean) {
  const { yearSheet: _y, ...sheet } = computeUstAnnual({
    year: 2026,
    periods: ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"],
    contributions: [c("81", "base", 100000, "2026-02-01", "e1"), c("81", "tax", 19000, "2026-02-01", "e1")],
    recordedAt: new Map([["e1", 1]]),
    ustva: ustvaMappingFor(2026),
    annual: ustAnnualMappingFor(2026),
    filed: [],
    ku: false,
    ended,
  });
  return {
    year: 2026,
    periodKind: "quarterly" as const,
    periods: [
      { period: "2026-Q1", filed: false },
      { period: "2026-Q2", filed: false },
      { period: "2026-Q3", filed: false },
      { period: "2026-Q4", filed: false },
    ],
    sheet,
    drillDown: {
      "81": [
        {
          entryId: "e1",
          seq: 1,
          date: "2026-02-01",
          text: "RE-1",
          cents: 100000,
          source: { kind: "salesDocument", id: "d1" },
          href: "/rechnungen/d1",
        },
      ],
    },
  };
}

describe("/steuern/ust-jahr (TAX-023)", () => {
  test("TAX-023 lines with Zeile/Kz, the reconciliation with its cause, and the guide only once the year has ended", () => {
    const { unmount } = renderWithIntl(<YearView view={viewOf(false)} />);
    expect(screen.getByRole("region", { name: "Umsatzsteuererklärung 2026" }).tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Buchungen zu Kennzahl 177 anzeigen" })).toBeInTheDocument();
    expect(screen.getByText("Keine übermittelte Voranmeldung für Q1/2026")).toBeInTheDocument();
    expect(screen.getByText("Das Jahr 2026 ist noch nicht abgeschlossen.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /kopieren/i })).toBeNull();
    unmount();
    renderWithIntl(<YearView view={viewOf(true)} />);
    expect(screen.getByRole("button", { name: "Kennzahl 177 kopieren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kennzahl 820 kopieren" })).toBeInTheDocument();
  });
});
