import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { StockTab } from "./stock-tab";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  results: {} as Record<string, unknown>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return backend.results[name] ?? null;
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const at = Date.UTC(2026, 9, 12, 8, 0);

beforeEach(() => {
  backend.calls = [];
  backend.results = {};
  backend.data = {
    "stock:history": {
      type: "good",
      unitCode: "C62",
      stock: { enabled: true, quantityMilli: 3000, reorderLevelMilli: 5000, belowReorderSince: at },
      movements: [
        {
          id: "m2",
          at: at + 60_000,
          quantityMilli: -7000,
          balanceMilli: 3000,
          reason: "delivery_note",
          actor: "user:u1",
          document: { id: "d1", label: "LS-2026-0001", href: "/lieferscheine/d1" },
        },
        {
          id: "m1",
          at,
          quantityMilli: 10_000,
          balanceMilli: 10_000,
          reason: "manual_in",
          text: "Wareneingang",
          actor: "user:u1",
        },
      ],
    },
  };
});

describe("Bestand tab (PRD-090…097)", () => {
  test("PRD-092 PRD-097 the Buchungsverlauf shows signed quantities, the running balance and the delivery note link", () => {
    renderWithIntl(<StockTab productId={"p1" as never} canWrite />);
    expect(screen.getByTestId("stock-quantity")).toHaveTextContent("3 C62");
    expect(screen.getByText("Unter Meldebestand")).toBeInTheDocument();
    const rows = within(screen.getByTestId("stock-history")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Lieferschein");
    expect(rows[0]).toHaveTextContent("-7");
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "LS-2026-0001" })).toHaveAttribute(
      "href",
      "/lieferscheine/d1",
    );
    expect(rows[1]).toHaveTextContent("Zugang");
    expect(rows[1]).toHaveTextContent("+10");
    expect(rows[1]).toHaveTextContent("Wareneingang");
  });

  test("PRD-094 a manual movement needs a text and books Zugang / Abgang / Korrektur in milli", async () => {
    backend.results["stock:adjust"] = { id: "m3", quantityMilli: 1000 };
    renderWithIntl(<StockTab productId={"p1" as never} canWrite />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Bestand buchen" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Art"), "correction");
    await user.type(within(dialog).getByLabelText(/^Menge/), "-2");
    await user.type(within(dialog).getByLabelText(/^Text/), "Inventur");
    await user.click(within(dialog).getByRole("button", { name: "Bestand buchen" }));
    expect(backend.calls).toContainEqual({
      name: "stock:adjust",
      args: { productId: "p1", values: { kind: "correction", quantity: "-2", text: "Inventur" } },
    });
  });

  test("PRD-090 PRD-096 settings: enable stock and set the reorder level; services cannot carry stock", async () => {
    renderWithIntl(<StockTab productId={"p1" as never} canWrite />);
    const user = userEvent.setup();
    const level = screen.getByLabelText("Meldebestand");
    await user.clear(level);
    await user.type(level, "2,5");
    await user.click(screen.getByRole("button", { name: "Einstellungen speichern" }));
    expect(backend.calls).toContainEqual({
      name: "stock:configure",
      args: { productId: "p1", values: { enabled: true, reorderLevel: "2,5" } },
    });
    backend.data["stock:history"] = { type: "service", unitCode: "HUR", stock: null, movements: [] };
    renderWithIntl(<StockTab productId={"p2" as never} canWrite />);
    expect(screen.getByText("Bestandsführung ist nur für Waren möglich.")).toBeInTheDocument();
  });

  test("PRD-097 without products.write the history is read-only", () => {
    renderWithIntl(<StockTab productId={"p1" as never} canWrite={false} />);
    expect(screen.queryByRole("button", { name: "Bestand buchen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Einstellungen speichern" })).not.toBeInTheDocument();
    expect(screen.getByTestId("stock-history")).toBeInTheDocument();
  });
});
