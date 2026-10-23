import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { CategoriesPanel } from "./categories-panel";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const categories = [
  { _id: "k1", name: "Waren", path: "Waren", parentId: null, productCount: 0, childCount: 1 },
  { _id: "k2", name: "Kabel", path: "Waren > Kabel", parentId: "k1", productCount: 4, childCount: 1 },
  { _id: "k3", name: "Netzwerk", path: "Waren > Kabel > Netzwerk", parentId: "k2", productCount: 2, childCount: 0 },
  { _id: "k4", name: "Dienstleistungen", path: "Dienstleistungen", parentId: null, productCount: 0, childCount: 0 },
];

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" }, "products:categories": categories };
  backend.mutations = {};
  vi.clearAllMocks();
});

describe("product categories (F03 PRD-060/061)", () => {
  test("PRD-060 loading, empty and the tree with paths and product counts", () => {
    backend.data["products:categories"] = undefined;
    const { container, unmount } = renderWithIntl(<CategoriesPanel />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["products:categories"] = [];
    const empty = renderWithIntl(<CategoriesPanel />);
    expect(screen.getByText("Noch keine Kategorien.")).toBeInTheDocument();
    empty.unmount();
    backend.data["products:categories"] = categories;
    renderWithIntl(<CategoriesPanel />);
    const items = within(screen.getByRole("list", { name: "Kategorie hinzufügen" })).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[1]).toHaveTextContent("Waren > Kabel · 4 Produkte");
    expect(items[2]?.getAttribute("style")).toContain("3.25rem");
  });

  test("PRD-060 a new category may only hang below levels 1–2", async () => {
    const user = userEvent.setup();
    renderWithIntl(<CategoriesPanel />);
    await user.click(screen.getByRole("button", { name: "Kategorie hinzufügen" }));
    const dialog = await screen.findByRole("dialog", { name: "Kategorie hinzufügen" });
    const parent = within(dialog).getByLabelText(/^Übergeordnete Kategorie/);
    const options = within(parent)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["oberste Ebene", "Waren", "Waren > Kabel", "Dienstleistungen"]);
    await user.type(within(dialog).getByLabelText(/^Name/), "Adapter");
    await user.selectOptions(parent, "k2");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.mutations["products:saveCategory"]).toHaveBeenCalledWith({
        values: { name: "Adapter", parentId: "k2" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Kategorie gespeichert.");
  });

  test("PRD-060 editing excludes the category itself and its descendants as parent", async () => {
    const user = userEvent.setup();
    renderWithIntl(<CategoriesPanel />);
    await user.click(screen.getByRole("button", { name: "Bearbeiten: Kabel" }));
    const dialog = await screen.findByRole("dialog", { name: "Kategorie bearbeiten" });
    const parent = within(dialog).getByLabelText(/^Übergeordnete Kategorie/);
    expect(
      within(parent)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["oberste Ebene", "Waren", "Dienstleistungen"]);
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "Kabel & Leitungen");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.mutations["products:saveCategory"]).toHaveBeenCalledWith({
        categoryId: "k2",
        values: { name: "Kabel & Leitungen", parentId: "k1" },
      }),
    );
  });

  test("PRD-061 deleting a used category asks where products and children go", async () => {
    const user = userEvent.setup();
    renderWithIntl(<CategoriesPanel />);
    await user.click(screen.getByRole("button", { name: "Löschen: Kabel" }));
    const dialog = await screen.findByRole("dialog", { name: "Kategorie löschen" });
    expect(within(dialog).getByRole("radio", { name: "übergeordnete Kategorie" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "keine Kategorie" }));
    await user.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() =>
      expect(backend.mutations["products:deleteCategory"]).toHaveBeenCalledWith({ categoryId: "k2", target: "none" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Kategorie gelöscht.");
  });

  test("PRD-061 an unused category is deleted without a target", async () => {
    const user = userEvent.setup();
    renderWithIntl(<CategoriesPanel />);
    await user.click(screen.getByRole("button", { name: "Löschen: Dienstleistungen" }));
    const dialog = await screen.findByRole("dialog", { name: "Kategorie löschen" });
    expect(within(dialog).queryByRole("radio")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() =>
      expect(backend.mutations["products:deleteCategory"]).toHaveBeenCalledWith({ categoryId: "k4" }),
    );
  });

  test("PRD-060 a viewer sees the tree without edit controls", () => {
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<CategoriesPanel />);
    expect(screen.queryByRole("button", { name: "Kategorie hinzufügen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Bearbeiten/ })).toBeNull();
    expect(screen.getByText("Netzwerk")).toBeInTheDocument();
  });
});
