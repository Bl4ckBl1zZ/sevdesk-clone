import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ContactsList } from "./contacts-list";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  paged: { results: [] as unknown[], status: "Exhausted" as string, loadMore: vi.fn() },
  pagedArgs: [] as unknown[],
  search: "",
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return backend.data[name];
  },
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
        ["10001", "Muster GmbH"],
      ];
    },
  }),
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return null;
  },
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/kontakte",
  useSearchParams: () => new URLSearchParams(backend.search),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const rows = [
  {
    _id: "c1",
    number: "10001",
    kind: "organization",
    displayName: "Muster GmbH",
    status: "active",
    roles: ["customer"],
    parentName: null,
    city: "Berlin",
    countryCode: "DE",
    email: "rechnung@muster.de",
    phone: "+49 30 123456",
    vatId: "DE123456789",
    vatBadge: { kind: "qualified", text: "✓ qualifiziert bestätigt am 01.10.2026" },
    isConsumer: false,
    isPublicAuthority: false,
    tags: [{ _id: "t1", name: "Stammkunde", color: null }],
    openCents: 123_456,
    revenueYearCents: 1_000_000,
  },
  {
    _id: "c2",
    number: "10002",
    kind: "person",
    displayName: "Erika Mustermann",
    status: "active",
    roles: ["supplier", "prospect"],
    parentName: "Muster GmbH",
    city: null,
    countryCode: null,
    email: null,
    phone: null,
    vatId: null,
    vatBadge: null,
    isConsumer: true,
    isPublicAuthority: false,
    tags: [],
    openCents: 0,
    revenueYearCents: 5_000,
  },
];

beforeEach(() => {
  backend.calls = [];
  backend.pagedArgs = [];
  backend.search = "";
  router.replace.mockReset();
  backend.paged = { results: rows, status: "Exhausted", loadMore: vi.fn() };
  backend.data = {
    "members:me": { role: "owner" },
    "lookups:listTags": [{ tagId: "t1", name: "Stammkunde" }],
  };
});

describe("contacts list (F02 §6.2)", () => {
  test("CON-172 rows show number, name, roles, city, VAT badge, tags and the formatted figures", () => {
    renderWithIntl(<ContactsList />);
    const table = screen.getByRole("table");
    const first = within(table).getByRole("row", { name: /10001/ });
    expect(first).toHaveTextContent("10001");
    expect(first).toHaveTextContent("Kunde");
    expect(first).toHaveTextContent("Berlin");
    expect(first).toHaveTextContent("rechnung@muster.de");
    expect(first).toHaveTextContent("✓ qualifiziert bestätigt am 01.10.2026");
    expect(first).toHaveTextContent("Stammkunde");
    expect(first).toHaveTextContent("1.234,56 €");
    expect(first).toHaveTextContent("10.000,00 €");
    const second = within(table).getByRole("row", { name: /Erika Mustermann/ });
    expect(second).toHaveTextContent("Ansprechpartner bei Muster GmbH");
    expect(second).toHaveTextContent("Lieferant, Interessent");
    // phone cards: call and mail links only for contacts that have the channel
    expect(screen.getByRole("link", { name: "Muster GmbH anrufen" })).toHaveAttribute("href", "tel:+4930123456");
    expect(screen.getByRole("link", { name: "E-Mail an Muster GmbH" })).toHaveAttribute(
      "href",
      "mailto:rechnung@muster.de",
    );
    expect(screen.queryByRole("link", { name: "Erika Mustermann anrufen" })).toBeNull();
  });

  test("CON-173 status chip and filters come from the URL and are passed to contacts:list", async () => {
    backend.search = "status=customer&type=b2c&vat=invalid&q=muster";
    renderWithIntl(<ContactsList />);
    expect(backend.pagedArgs.at(-1)).toEqual({
      q: "muster",
      status: "open",
      role: "customer",
      type: "b2c",
      vatStatus: "invalid",
    });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Kundentyp"), "b2b");
    expect(router.replace).toHaveBeenLastCalledWith("/kontakte?status=customer&type=b2b&vat=invalid&q=muster", {
      scroll: false,
    });
    await user.selectOptions(screen.getByLabelText("USt-IdNr-Status"), "");
    expect(router.replace).toHaveBeenLastCalledWith("/kontakte?status=customer&type=b2c&q=muster", {
      scroll: false,
    });
  });

  test("CON-153 sorting by „Offen“ uses contacts:ranking and toggles the direction in the URL", async () => {
    backend.search = "sort=open-desc";
    backend.data["contacts:ranking"] = [rows[0]];
    renderWithIntl(<ContactsList />);
    const ranking = backend.calls.find((c) => c.name === "contacts:ranking");
    expect(ranking?.args).toMatchObject({ sortBy: "open", dir: "desc", status: "open" });
    const header = screen.getByRole("columnheader", { name: "Offen" });
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(screen.queryByText("Erika Mustermann")).toBeNull();
    await userEvent.click(within(header).getByRole("button"));
    expect(router.replace).toHaveBeenLastCalledWith("/kontakte?sort=open-asc", { scroll: false });
    await userEvent.click(screen.getByRole("button", { name: "Umsatz (Jahr)" }));
    expect(router.replace).toHaveBeenLastCalledWith("/kontakte?sort=revenueYear-desc", { scroll: false });
  });

  test("CON-174 bulk actions: select all, archive and add a tag call the bulk mutations", async () => {
    renderWithIntl(<ContactsList />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Alle auf dieser Seite auswählen" }));
    const bar = screen.getByRole("region", { name: "2 ausgewählt" });
    const add = within(bar).getByRole("button", { name: "Tag hinzufügen" });
    expect(add).toBeDisabled();
    await user.selectOptions(within(bar).getByLabelText("Tag wählen"), "t1");
    await user.click(add);
    expect(backend.calls.find((c) => c.name === "contacts:bulkTag")?.args).toEqual({
      ids: ["c1", "c2"],
      tagId: "t1",
      add: true,
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: /ausgewählt/ })).toBeNull());
    await user.click(screen.getAllByRole("checkbox", { name: "Erika Mustermann auswählen" })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Archivieren" }));
    expect(backend.calls.find((c) => c.name === "contacts:bulkArchive")?.args).toEqual({ ids: ["c2"] });
  });

  test("CON-144 the XLSX export queries contacts:exportRows with the current filter and downloads the workbook", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    backend.search = "status=supplier";
    renderWithIntl(<ContactsList />);
    await userEvent.click(screen.getByRole("button", { name: "Excel (XLSX)" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(backend.calls.find((c) => c.name === "contacts:exportRows")?.args).toEqual({
      status: "open",
      role: "supplier",
    });
    expect(createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });

  test("CON-172 viewers see no checkboxes, import or new buttons", () => {
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<ContactsList />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("link", { name: "Importieren" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Neuer Kontakt/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Duplikate" })).toHaveAttribute("href", "/kontakte/duplikate");
  });

  test("CON-172 empty, no-results, loading and load-more states", async () => {
    backend.paged = { results: [], status: "Exhausted", loadMore: vi.fn() };
    const { unmount } = renderWithIntl(<ContactsList />);
    expect(screen.getByText("Noch keine Kontakte vorhanden.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ersten Kontakt anlegen" })).toHaveAttribute("href", "/kontakte/neu");
    unmount();
    backend.search = "q=xyz";
    const second = renderWithIntl(<ContactsList />);
    expect(screen.getByText("Keine Kontakte gefunden.")).toBeInTheDocument();
    second.unmount();
    backend.search = "";
    backend.paged = { results: [], status: "LoadingFirstPage", loadMore: vi.fn() };
    const third = renderWithIntl(<ContactsList />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    third.unmount();
    const loadMore = vi.fn();
    backend.paged = { results: rows, status: "CanLoadMore", loadMore };
    renderWithIntl(<ContactsList />);
    await userEvent.click(screen.getByRole("button", { name: "Weitere laden" }));
    expect(loadMore).toHaveBeenCalledWith(50);
  });
});
