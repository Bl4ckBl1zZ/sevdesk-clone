import { screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { UstvaWorkspace } from "./ustva-workspace";
import { ZmWorkspace } from "./zm-workspace";

const data: Record<string, unknown> = {
  "taxes:ustva": {
    label: "Q3 2026",
    ended: true,
    deadline: { due: "2026-10-10" },
    filings: [],
    blockers: [],
    correction: null,
    drillDown: {},
    guide: null,
    sheet: {
      required: true,
      notices: [],
      fields: [{ kz: "81", label: "Umsätze 19 %", valueCents: 100000, formTaxCents: 19000, bookedTaxCents: 19000 }],
    },
  },
  "taxes:zm": {
    label: "Q3 2026",
    deadline: { due: "2026-10-25" },
    filings: [],
    blockers: [],
    reconciliation: [],
    guide: null,
    csv: "",
    zm: {
      warnings: [],
      totalEuros: 1000,
      rows: [
        { countryCode: "AT", vatNumber: "U12345678", vatId: "ATU12345678", name: "Kunde AT", type: "L", euros: 1000 },
      ],
    },
  },
};
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("Steuern: tables wider than a phone scroll in a keyboard-focusable, named region", () => {
  test.each([
    ["TAX-003 UStVA Kennzahlen", () => <UstvaWorkspace canSubmit={false} isOwner={false} />, "Kennzahlen Q3 2026"],
    ["TAX-009 ZM Meldung", () => <ZmWorkspace canSubmit={false} />, "Meldung Q3 2026"],
  ])("%s", (_name, ui, label) => {
    renderWithIntl(ui());
    const table = screen.getByRole("table", { name: label });
    const scroller = table.parentElement as HTMLElement;
    expect(scroller).toHaveAttribute("role", "region");
    expect(scroller).toHaveAccessibleName(label);
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.parentElement?.className ?? "").not.toMatch(/overflow/);
  });
});
