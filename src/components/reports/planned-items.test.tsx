import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { PlannedItems } from "./planned-items";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  can: new Set<string>(),
  items: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return "p1";
  },
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: () => backend.items,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/catalog/shared")>()),
  useCan: (p: string) => backend.can.has(p),
}));

beforeEach(() => {
  backend.calls = [];
  backend.can = new Set(["accounting.write"]);
  backend.items = [
    { id: "p0", label: "Miete Büro", cents: -80_000, date: "2026-10-31", recurrence: "P1M", confidence: "high" },
  ];
});

describe("Geplante Positionen (RPT-013)", () => {
  test("RPT-013 a planned outflow is added with rhythm and confidence; invalid input shows the German messages", async () => {
    const user = userEvent.setup();
    renderWithIntl(<PlannedItems />);
    expect(screen.getByText("Miete Büro")).toBeInTheDocument();
    expect(screen.getByText("Monatlich ab 31.10.2026")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Geplante Position hinzufügen" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte einen Betrag ungleich 0 € eingeben.");
    expect(backend.calls).toEqual([]);
    await user.type(screen.getByLabelText("Bezeichnung"), "Darlehensrate");
    await user.type(screen.getByLabelText("Betrag (€)"), "1.250,00");
    await user.type(screen.getByLabelText("Datum"), "2026-11-15");
    await user.selectOptions(screen.getByLabelText("Rhythmus"), "P3M");
    await user.selectOptions(screen.getByLabelText("Einschätzung"), "low");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(backend.calls).toEqual([
      {
        name: "reports:savePlannedCashItem",
        args: {
          label: "Darlehensrate",
          amountCents: -125_000,
          date: "2026-11-15",
          recurrence: "P3M",
          confidence: "low",
        },
      },
    ]);
  });

  test("RPT-013 a viewer sees the planned items but no add, edit or remove buttons", () => {
    backend.can = new Set();
    renderWithIntl(<PlannedItems />);
    expect(screen.getByText("Miete Büro")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
