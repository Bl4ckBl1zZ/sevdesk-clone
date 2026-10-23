import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ProductsList } from "./products-list";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  paged: { results: [] as unknown[], status: "Exhausted" as string, loadMore: vi.fn() },
  pagedArgs: [] as unknown[],
  search: "",
  replace: vi.fn(),
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  usePaginatedQuery: (_ref: unknown, args: unknown) => {
    backend.pagedArgs.push(args);
    return backend.paged;
  },
  useConvex: () => ({
    query: async (ref: unknown, args: unknown) => {
      backend.calls.push({ name: getFunctionName(ref as never), args });
      return [
        ["Nummer", "Name"],
        ["A-1001", "Netzwerkkabel"],
      ];
    },
  }),
  useMutation: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: backend.replace }),
  usePathname: () => "/produkte",
  useSearchParams: () => new URLSearchParams(backend.search),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const product = (over: Record<string, unknown> = {}) => ({
  _id: "p1",
  number: "A-1001",
  name: "Netzwerkkabel",
  type: "good",
  category: "Waren > Kabel",
  unitCode: "C62",
  priceMode: "net",
  netMicros: 100_000,
  grossMicros: 119_000,
  rateBp: 1_900,
  marginBp: 4_000,
  active: true,
  scheduledPrice: null,
  ...over,
});

beforeEach(() => {
  backend.data = {
    "members:me": { role: "owner" },
    "products:categories": [{ _id: "cat1", path: "Waren > Kabel" }],
    "products:rateChangeBanners": [],
  };
  backend.calls = [];
  backend.pagedArgs = [];
  backend.paged = { results: [], status: "Exhausted", loadMore: vi.fn() };
  backend.search = "";
  backend.replace = vi.fn();
  vi.clearAllMocks();
});

describe("Produkte list (F03 §6.2)", () => {
  test("PRD-001 loading, a pristine empty list and filtered no-results", () => {
    backend.paged.status = "LoadingFirstPage";
    const { container, unmount } = renderWithIntl(<ProductsList />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.paged.status = "Exhausted";
    const second = renderWithIntl(<ProductsList />);
    expect(screen.getByText("Noch keine Produkte vorhanden.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Erstes Produkt anlegen" })).toHaveAttribute("href", "/produkte/neu");
    second.unmount();
    backend.search = "q=kabel&type=service&category=cat1&status=archived";
    renderWithIntl(<ProductsList />);
    expect(screen.getByText("Keine Produkte gefunden.")).toBeInTheDocument();
    expect(backend.pagedArgs.at(-1)).toEqual({ status: "archived", q: "kabel", type: "service", categoryId: "cat1" });
  });

  test("PRD-013 rows show number, name, type, category, unit, both prices, VAT and margin", () => {
    backend.paged.results = [
      product(),
      product({
        _id: "p2",
        number: "D-1",
        name: "Beratung",
        type: "service",
        category: "",
        unitCode: "HUR",
        priceMode: "gross",
        marginBp: null,
        scheduledPrice: { validFrom: "2027-01-01" },
      }),
    ];
    renderWithIntl(<ProductsList />);
    const [, first, second] = within(screen.getByRole("table")).getAllByRole("row");
    expect(within(first as HTMLElement).getByRole("link", { name: "Netzwerkkabel" })).toHaveAttribute(
      "href",
      "/produkte/p1",
    );
    for (const text of ["A-1001", "Ware", "Waren > Kabel", "C62", "10,00 €", "11,90 €", "19 %", "40 %"]) {
      expect(first).toHaveTextContent(text);
    }
    expect(second).toHaveTextContent("Dienstleistung");
    expect(second).toHaveTextContent("neuer Preis ab 01.01.2027");
    expect(second).toHaveTextContent("—");
    // Phone cards show the price in the entered mode.
    expect(screen.getByText("VK brutto / HUR")).toBeInTheDocument();
  });

  test("PRD-027 a rate change banner is shown above the list", () => {
    backend.data["products:rateChangeBanners"] = ["Ab 01.01.2027 ändert sich der Steuersatz für 3 Produkte."];
    backend.paged.results = [product()];
    renderWithIntl(<ProductsList />);
    expect(screen.getByRole("status")).toHaveTextContent("Ab 01.01.2027 ändert sich der Steuersatz");
  });

  test("PRD-001 the type and category filters are written to the URL; more rows load on demand", async () => {
    const user = userEvent.setup();
    backend.paged = { results: [product()], status: "CanLoadMore", loadMore: vi.fn() };
    renderWithIntl(<ProductsList />);
    await user.selectOptions(screen.getByLabelText("Typ"), "good");
    expect(backend.replace).toHaveBeenCalledWith("/produkte?type=good", { scroll: false });
    await user.selectOptions(screen.getByLabelText("Kategorie"), "cat1");
    expect(backend.replace).toHaveBeenCalledWith("/produkte?category=cat1", { scroll: false });
    await user.click(screen.getByRole("button", { name: "Weitere laden" }));
    expect(backend.paged.loadMore).toHaveBeenCalledWith(50);
  });

  test("PRD-085 the CSV export queries the rows of the current filter", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    backend.search = "type=good";
    backend.paged.results = [product()];
    renderWithIntl(<ProductsList />);
    await user.click(screen.getByRole("button", { name: "Export als CSV" }));
    await user.click(await screen.findByRole("menuitem", { name: "CSV (Excel)" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(backend.calls.find((c) => c.name === "products:exportRows")?.args).toEqual({
      status: "active",
      type: "good",
    });
    expect(toast.success).toHaveBeenCalledWith("Export erstellt.");
    click.mockRestore();
  });

  test("PRD-001 a viewer has no import or new product links", () => {
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<ProductsList />);
    expect(screen.queryByRole("link", { name: "Importieren" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Neues Produkt/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Erstes Produkt anlegen" })).toBeNull();
    expect(screen.getByRole("link", { name: "Kategorien" })).toHaveAttribute("href", "/produkte/kategorien");
  });
});
