import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { RecurringList } from "./recurring-list";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  args: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  search: "",
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.args[name] = args;
    return backend.data[name];
  },
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/rechnungen/wiederkehrend",
  useSearchParams: () => new URLSearchParams(backend.search),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const row = (over: Record<string, unknown> = {}) => ({
  _id: "rt1",
  name: "Wartungsvertrag",
  contactId: "c1",
  contactName: "Muster GmbH",
  contractReference: null,
  state: "active",
  status: "active",
  interval: "P1M",
  intervalLabel: "monatlich",
  nextDate: "2026-11-01",
  amount: { grossCents: 11_900, currency: "EUR" },
  automation: { finalize: false },
  automationConfirmed: false,
  automationEffective: false,
  generatedCount: 3,
  skippedOccurrences: [],
  archived: false,
  version: 1,
  ...over,
});

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.args = {};
  backend.mutations = {};
  backend.search = "";
  vi.clearAllMocks();
});

describe("Wiederkehrend list (F04 §6.1)", () => {
  test("REC-01 loading shows a busy placeholder; a pristine list offers the first template", () => {
    const { container, unmount } = renderWithIntl(<RecurringList />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["recurring:list"] = { counts: { active: 0, paused: 0, ended: 0 }, rows: [] };
    renderWithIntl(<RecurringList />);
    expect(screen.getByText("Noch keine wiederkehrenden Rechnungen vorhanden.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Erste Vorlage anlegen" })).toHaveAttribute(
      "href",
      "/rechnungen/wiederkehrend/neu",
    );
  });

  test("REC-03 an empty tab with templates elsewhere says „Keine Vorlagen in diesem Status“ and asks for the tab", () => {
    backend.search = "status=ended";
    backend.data["recurring:list"] = { counts: { active: 2, paused: 1, ended: 0 }, rows: [] };
    renderWithIntl(<RecurringList />);
    expect(backend.args["recurring:list"]).toEqual({ tab: "ended" });
    expect(screen.getByText("Keine Vorlagen in diesem Status.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Erste Vorlage anlegen" })).toBeNull();
    expect(screen.getByRole("link", { name: "Aktiv (2)" })).toHaveAttribute("href", "/rechnungen/wiederkehrend");
    expect(screen.getByRole("link", { name: "Pausiert (1)" })).toHaveAttribute(
      "href",
      "/rechnungen/wiederkehrend?status=paused",
    );
  });

  test("REC-01 rows show name, customer, interval, next date, amount, automation and generated count", () => {
    backend.data["recurring:list"] = {
      counts: { active: 2, paused: 0, ended: 0 },
      rows: [
        row(),
        row({
          _id: "rt2",
          name: "Hosting",
          contactName: null,
          amount: null,
          automation: { finalize: true },
          automationEffective: true,
          generatedCount: 0,
        }),
      ],
    };
    renderWithIntl(<RecurringList />);
    const table = screen.getByRole("table");
    const [, first, second] = within(table).getAllByRole("row");
    expect(within(first as HTMLElement).getByRole("link", { name: "Wartungsvertrag" })).toHaveAttribute(
      "href",
      "/rechnungen/wiederkehrend/rt1",
    );
    expect(first).toHaveTextContent("Muster GmbH");
    expect(first).toHaveTextContent("monatlich");
    expect(first).toHaveTextContent("01.11.2026");
    expect(first).toHaveTextContent("119,00 €");
    expect(first).toHaveTextContent("Entwurf zur Prüfung");
    expect(second).toHaveTextContent("Fertigstellen automatisch");
    expect(second).toHaveTextContent("—");
    expect(screen.getByText(/Fertigstellen automatisch · 0 erzeugt/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Neue Vorlage" }).length).toBeGreaterThan(0);
  });

  test("REC-12 „Jetzt erzeugen“ runs the template and reports created and finalised invoices", async () => {
    const user = userEvent.setup();
    backend.data["recurring:list"] = { counts: { active: 1, paused: 0, ended: 0 }, rows: [row()] };
    backend.mutations["recurring:runNow"] = vi.fn().mockResolvedValue({ created: 2, finalized: 1 });
    renderWithIntl(<RecurringList />);
    const table = screen.getByRole("table");
    await user.click(within(table).getByRole("button", { name: "Jetzt erzeugen: Wartungsvertrag" }));
    await waitFor(() => expect(backend.mutations["recurring:runNow"]).toHaveBeenCalledWith({ id: "rt1" }));
    expect(toast.success).toHaveBeenCalledWith("2 Rechnungen erzeugt, 1 fertiggestellt");
    await user.click(within(table).getByRole("button", { name: "Pausieren: Wartungsvertrag" }));
    await waitFor(() => expect(backend.mutations["recurring:pause"]).toHaveBeenCalledWith({ id: "rt1" }));
    expect(toast.success).toHaveBeenCalledWith("Vorlage pausiert");
  });

  test("REC-10 resuming a paused template asks „Nachberechnen“ or „Überspringen“", async () => {
    const user = userEvent.setup();
    backend.search = "status=paused";
    backend.data["recurring:list"] = {
      counts: { active: 0, paused: 1, ended: 0 },
      rows: [row({ state: "paused", status: "paused" })],
    };
    renderWithIntl(<RecurringList />);
    const table = screen.getByRole("table");
    expect(within(table).queryByRole("button", { name: /Jetzt erzeugen/ })).toBeNull();
    await user.click(within(table).getByRole("button", { name: "Fortsetzen: Wartungsvertrag" }));
    const dialog = await screen.findByRole("dialog", { name: "Vorlage fortsetzen" });
    expect(within(dialog).getByRole("radio", { name: /Überspringen/ })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: /Nachberechnen/ }));
    await user.click(within(dialog).getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() =>
      expect(backend.mutations["recurring:resume"]).toHaveBeenCalledWith({ id: "rt1", catchUp: true }),
    );
    expect(toast.success).toHaveBeenCalledWith("Vorlage fortgesetzt");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("REC-01 a viewer sees the list without actions or „Neue Vorlage“", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["recurring:list"] = { counts: { active: 1, paused: 0, ended: 0 }, rows: [row()] };
    renderWithIntl(<RecurringList />);
    expect(screen.queryByRole("link", { name: "Neue Vorlage" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Jetzt erzeugen/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Aktionen" })).toBeNull();
  });
});
