import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ProductDetail } from "./product-detail";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  push: vi.fn(),
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: backend.push, replace: vi.fn() }),
  usePathname: () => "/produkte/p1",
  useSearchParams: () => new URLSearchParams(),
}));
// Sub-tabs with their own tests.
vi.mock("./product-form", () => ({
  ProductForm: ({ product }: { product: { name: string } }) => <div data-testid="product-form">{product.name}</div>,
}));
vi.mock("./stock-tab", () => ({ StockTab: () => <div data-testid="stock-tab" /> }));
vi.mock("./usage-tab", () => ({ UsageTab: () => <div data-testid="usage-tab" /> }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const bundle = (over: Record<string, unknown> = {}, product: Record<string, unknown> = {}) => ({
  product: {
    _id: "p1",
    number: "A-1001",
    name: "Netzwerkkabel 5 m",
    description: "Cat 6, grau",
    gtin: "4006381333931",
    type: "good",
    unitCode: "C62",
    vatRateKey: "standard",
    priceMode: "net",
    unitPriceMicros: 100_000,
    active: true,
    version: 3,
    tags: [],
    scheduledPrice: null,
    ...product,
  },
  netMicros: 100_000,
  grossMicros: 119_000,
  rateBp: 1_900,
  margin: { marginBp: 4_000, costLabel: "EK 6,00 €" },
  category: "Waren > Kabel",
  customerPrices: [
    {
      _id: "cp1",
      contact: { _id: "c1", number: "10001", displayName: "Muster GmbH", status: "active" },
      unitPriceMicros: 85_000,
      priceMode: "net",
      validFrom: null,
    },
    {
      _id: "cp2",
      contact: { _id: "c1", number: "10001", displayName: "Muster GmbH", status: "active" },
      unitPriceMicros: 80_000,
      priceMode: "gross",
      validFrom: "2027-01-01",
    },
  ],
  tags: [{ _id: "t1", name: "Bestseller", color: null }],
  usageCount: 4,
  ...over,
});

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.mutations = {};
  backend.push = vi.fn();
  vi.clearAllMocks();
});

describe("product detail (F03 §6.3)", () => {
  test("PRD-001 loading is busy; an unknown id says „Produkt nicht gefunden“", () => {
    const { container, unmount } = renderWithIntl(<ProductDetail id="p1" />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["products:get"] = null;
    renderWithIntl(<ProductDetail id="p1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Produkt nicht gefunden.");
  });

  test("PRD-013 PRD-036 the facts show number, unit, both price views, today's rate, margin, category and tags", () => {
    backend.data["products:get"] = bundle();
    renderWithIntl(<ProductDetail id="p1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Netzwerkkabel 5 m" })).toBeInTheDocument();
    expect(screen.getByText("A-1001 · Ware")).toBeInTheDocument();
    const facts = screen.getByRole("complementary", { name: "Eckdaten" });
    expect(facts).toHaveTextContent("A-1001");
    expect(facts).toHaveTextContent("C62");
    expect(facts).toHaveTextContent("10,00 €");
    expect(facts).toHaveTextContent("11,90 €");
    expect(facts).toHaveTextContent("(19 %)");
    expect(facts).toHaveTextContent("40 %");
    expect(facts).toHaveTextContent("EK 6,00 €");
    expect(facts).toHaveTextContent("Waren > Kabel");
    expect(within(facts).getByRole("list", { name: "Tags" })).toHaveTextContent("Bestseller");
    expect(screen.getByTestId("product-form")).toHaveTextContent("Netzwerkkabel 5 m");
    expect(screen.getByRole("tab", { name: "Bestand" })).toBeInTheDocument();
  });

  test("PRD-072 archiving and restoring the product", async () => {
    const user = userEvent.setup();
    backend.data["products:get"] = bundle();
    const { unmount } = renderWithIntl(<ProductDetail id="p1" />);
    await user.click(screen.getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(backend.mutations["products:archive"]).toHaveBeenCalledWith({ id: "p1" }));
    expect(toast.success).toHaveBeenCalledWith("Produkt archiviert.");
    unmount();
    backend.data["products:get"] = bundle({}, { active: false, type: "service", unitCode: "HUR" });
    renderWithIntl(<ProductDetail id="p1" />);
    expect(screen.getByText("A-1001 · Dienstleistung · archiviert")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Bestand" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    await waitFor(() => expect(backend.mutations["products:unarchive"]).toHaveBeenCalledWith({ id: "p1" }));
  });

  test("PRD-073 deleting asks for confirmation and returns to the list", async () => {
    const user = userEvent.setup();
    backend.data["products:get"] = bundle();
    renderWithIntl(<ProductDetail id="p1" />);
    await user.click(screen.getByRole("button", { name: "Löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Produkt endgültig löschen?" });
    expect(dialog).toHaveTextContent("Kundenpreise werden mitgelöscht.");
    await user.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(backend.mutations["products:remove"]).toHaveBeenCalledWith({ id: "p1" }));
    expect(backend.push).toHaveBeenCalledWith("/produkte");
  });

  test("PRD-030 the price tab lists customer prices and removes one", async () => {
    const user = userEvent.setup();
    backend.data["products:get"] = bundle();
    renderWithIntl(<ProductDetail id="p1" />);
    await user.click(screen.getByRole("tab", { name: "Preise" }));
    const table = await screen.findByRole("table");
    const [, first, second] = within(table).getAllByRole("row");
    expect(within(first as HTMLElement).getByRole("link", { name: "Muster GmbH (10001)" })).toHaveAttribute(
      "href",
      "/kontakte/c1",
    );
    expect(first).toHaveTextContent("8,50 €");
    expect(first).toHaveTextContent("netto");
    expect(first).toHaveTextContent("sofort");
    expect(second).toHaveTextContent("brutto");
    expect(second).toHaveTextContent("01.01.2027");
    await user.click(within(second as HTMLElement).getByRole("button", { name: "Entfernen" }));
    await waitFor(() =>
      expect(backend.mutations["products:removeCustomerPrice"]).toHaveBeenCalledWith({ priceId: "cp2" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Kundenpreis entfernt.");
  });

  test("PRD-030 adding a customer price saves contact, mode, price and start date", async () => {
    const user = userEvent.setup();
    backend.data["products:get"] = bundle({ customerPrices: [] });
    backend.data["contacts:options"] = [{ _id: "c2", displayName: "Beispiel AG", number: "10002" }];
    renderWithIntl(<ProductDetail id="p1" />);
    await user.click(screen.getByRole("tab", { name: "Preise" }));
    expect(await screen.findByText("Keine Kundenpreise.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kundenpreis hinzufügen" }));
    const dialog = await screen.findByRole("dialog", { name: "Kundenpreis hinzufügen" });
    await user.type(within(dialog).getByLabelText("Kontakt suchen"), "Beisp");
    await user.selectOptions(within(dialog).getByLabelText(/^Kunde/), "c2");
    await user.type(within(dialog).getByLabelText(/^Preis\b/), "9,5");
    await user.type(within(dialog).getByLabelText(/^Gültig ab/), "2027-02-01");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.mutations["products:saveCustomerPrice"]).toHaveBeenCalledWith({
        productId: "p1",
        values: { contactId: "c2", priceMode: "net", price: "9,5", validFrom: "2027-02-01" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Kundenpreis gespeichert.");
  });

  test("PRD-031 a scheduled price is shown, planned and cancelled", async () => {
    const user = userEvent.setup();
    backend.data["products:get"] = bundle(
      {},
      { scheduledPrice: { validFrom: "2027-01-01", unitPriceMicros: 120_000, priceMode: "gross" } },
    );
    renderWithIntl(<ProductDetail id="p1" />);
    await user.click(screen.getByRole("tab", { name: "Preise" }));
    expect(await screen.findByText("Ab 01.01.2027: 12,00 € (brutto)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Planung aufheben" }));
    await waitFor(() =>
      expect(backend.mutations["products:setScheduledPrice"]).toHaveBeenCalledWith({ id: "p1", values: null }),
    );
    await user.click(screen.getByRole("button", { name: "Neuen Preis planen" }));
    const dialog = await screen.findByRole("dialog", { name: "Neuer Preis ab einem Datum" });
    await user.type(within(dialog).getByLabelText(/^Gültig ab/), "2027-03-01");
    await user.selectOptions(within(dialog).getByLabelText(/^Preisart/), "gross");
    await user.type(within(dialog).getByLabelText(/^Preis\b/), "13,00");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.mutations["products:setScheduledPrice"]).toHaveBeenLastCalledWith({
        id: "p1",
        values: { validFrom: "2027-03-01", priceMode: "gross", price: "13,00" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Preisänderung geplant.");
  });

  test("PRD-037 a viewer sees read-only master data and no price or header actions", async () => {
    const user = userEvent.setup();
    backend.data["members:me"] = { role: "viewer" };
    backend.data["products:get"] = bundle();
    renderWithIntl(<ProductDetail id="p1" />);
    expect(screen.queryByTestId("product-form")).toBeNull();
    expect(screen.getByText("Cat 6, grau")).toBeInTheDocument();
    expect(screen.getByText("4006381333931")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archivieren" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Preise" }));
    expect(await screen.findByText("Keine Preisänderung geplant.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kundenpreis hinzufügen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Entfernen" })).toBeNull();
  });
});
