import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoicesList, TodosWidget } from "./invoices-list";

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
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return { jobId: "j1" };
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: backend.replace }),
  usePathname: () => "/rechnungen",
  useSearchParams: () => new URLSearchParams(backend.search),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const row = (over: Record<string, unknown> = {}) => ({
  _id: "d1",
  type: "invoice",
  correctionKind: null,
  number: "RE-2026-0042",
  contactName: "Muster GmbH",
  documentDate: "2026-10-01",
  dueDate: "2026-10-15",
  grossCents: 142_800,
  openAmountCents: 142_800,
  currency: "EUR",
  status: "sent",
  displayStatus: { token: "open", label: "Offen" },
  exported: true,
  artifactStatus: "ready",
  validUntil: null,
  supplyDate: null,
  orderReference: null,
  coveredBp: null,
  invoicingDeadline: null,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  backend.calls = [];
  backend.pagedArgs = [];
  backend.search = "";
  backend.replace.mockReset();
  backend.paged = { results: [], status: "Exhausted", loadMore: vi.fn() };
  backend.data = { "members:me": { role: "owner" } };
});

describe("InvoicesList (DOC-37, F04 §6.1)", () => {
  test("DOC-37 rows show status, number, customer, dates and the gross amount; Storno rows carry their type", () => {
    backend.paged.results = [
      row(),
      row({
        _id: "d2",
        type: "cancellation",
        number: "ST-2026-0001",
        grossCents: -11_900,
        displayStatus: { token: "cancelled", label: "Storniert" },
      }),
      row({ _id: "d3", number: null, status: "draft", displayStatus: { token: "draft", label: "Entwurf" } }),
    ];
    renderWithIntl(<InvoicesList />);
    expect(screen.getAllByRole("link", { name: "RE-2026-0042" })[0]).toHaveAttribute("href", "/rechnungen/d1");
    expect(screen.getAllByRole("link", { name: "Stornorechnung ST-2026-0001" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Entwurf" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.428,00 €").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-119,00 €").length).toBeGreaterThan(0);
    expect(screen.getAllByText("15.10.2026").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Fällig" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Neue Rechnung" })[0]).toHaveAttribute("href", "/rechnungen/neu");
    expect(backend.pagedArgs.at(-1)).toEqual({ type: "invoice", tab: "all" });
  });

  test("DOC-38 selecting rows opens the bulk actions; „alle auswählen“ toggles every row", async () => {
    backend.paged.results = [row(), row({ _id: "d2", number: "RE-2026-0043" })];
    renderWithIntl(<InvoicesList />);
    const u = userEvent.setup();
    await u.click(screen.getByRole("checkbox", { name: "Alle auswählen" }));
    for (const box of screen.getAllByRole("checkbox", { name: /RE-2026-004[23] auswählen/ })) {
      expect(box).toBeChecked();
    }
    await u.click(screen.getAllByRole("checkbox", { name: "RE-2026-0043 auswählen" })[0] as HTMLElement);
    expect(screen.getAllByRole("checkbox", { name: "RE-2026-0043 auswählen" })[0]).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Alle auswählen" })).not.toBeChecked();
  });

  test("DOC-37 the Proforma tab lists proforma documents; „Weitere laden“ fetches the next page", async () => {
    backend.search = "status=proforma&q=Muster";
    backend.paged = {
      results: [row({ type: "proforma", number: "PF-2026-0001" })],
      status: "CanLoadMore",
      loadMore: vi.fn(),
    };
    renderWithIntl(<InvoicesList />);
    expect(backend.pagedArgs.at(-1)).toEqual({ type: "proforma", tab: "all", q: "Muster" });
    expect(screen.getAllByRole("link", { name: "Neue Proforma" })[0]).toHaveAttribute(
      "href",
      "/rechnungen/neu?typ=proforma",
    );
    await userEvent.click(screen.getByRole("button", { name: "Weitere laden" }));
    expect(backend.paged.loadMore).toHaveBeenCalledWith(50);
  });

  test("DOC-37 searching writes the query into the URL", async () => {
    renderWithIntl(<InvoicesList />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Rechnungen durchsuchen" }), "Muster");
    await waitFor(() => expect(backend.replace).toHaveBeenCalledWith("/rechnungen?q=Muster", { scroll: false }));
  });

  test("QUO-13 order confirmations show the order reference and the invoicing progress", () => {
    backend.paged.results = [
      row({ type: "order_confirmation", number: "AB-2026-0003", orderReference: "PO-77", coveredBp: 4_550 }),
    ];
    renderWithIntl(<InvoicesList type="order_confirmation" />);
    expect(screen.getByRole("columnheader", { name: "Bestellnr." })).toBeInTheDocument();
    expect(screen.getByText("PO-77")).toBeInTheDocument();
    expect(screen.getByText("45 %")).toBeInTheDocument();
  });

  test("QUO-14 delivery notes show the delivery date and the invoicing deadline but no prices", () => {
    backend.paged.results = [
      row({
        type: "delivery_note",
        number: "LS-2026-0003",
        supplyDate: { kind: "date", date: "2026-03-02" },
        invoicingDeadline: "escalation",
      }),
    ];
    renderWithIntl(<InvoicesList type="delivery_note" />);
    expect(screen.getByRole("columnheader", { name: "Lieferdatum" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Brutto" })).toBeNull();
    expect(screen.getAllByText("02.03.2026").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rechnungsfrist überschritten").length).toBeGreaterThan(0);
    expect(screen.queryByText("1.428,00 €")).toBeNull();
  });

  test("DOC-37 empty list: first-document action for writers, none for viewers, „keine gefunden“ when filtered", () => {
    const { unmount } = renderWithIntl(<InvoicesList type="quote" />);
    expect(screen.getByText("Noch keine Angebote vorhanden.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Erstes Angebot erstellen" })).toBeInTheDocument();
    unmount();
    backend.data["members:me"] = { role: "viewer" };
    backend.search = "status=open";
    renderWithIntl(<InvoicesList type="quote" />);
    expect(screen.getByText("Keine Angebote gefunden.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Angebot/ })).toBeNull();
  });

  test("SMOKE loading state while the first page loads", () => {
    backend.paged = { results: [], status: "LoadingFirstPage", loadMore: vi.fn() };
    const { container } = renderWithIntl(<InvoicesList />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });
});

describe("TodosWidget (SND-21)", () => {
  test("SND-21 lists open to-dos with links; loading and empty states", () => {
    const { rerender } = renderWithIntl(<TodosWidget />);
    backend.data["invoices:todos"] = [
      { _id: "n1", title: "RE-2026-0042 exportiert, nicht markiert", link: "/rechnungen/d1" },
      { _id: "n2", title: "Ohne Link", link: null },
    ];
    rerender(<TodosWidget />);
    expect(screen.getByRole("link", { name: "RE-2026-0042 exportiert, nicht markiert" })).toHaveAttribute(
      "href",
      "/rechnungen/d1",
    );
    expect(screen.getByTestId("todos")).toHaveTextContent("Ohne Link");
    backend.data["invoices:todos"] = [];
    rerender(<TodosWidget />);
    expect(screen.queryByTestId("todos")).toBeNull();
  });
});
