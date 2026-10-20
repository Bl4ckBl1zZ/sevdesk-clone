import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ProjectDetail } from "./project-detail";
import { ProjectsList } from "./projects-list";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  results: {} as Record<string, unknown>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return backend.results[name] ?? null;
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projekte",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const budget = {
  kind: "hours",
  consumed: 510,
  budget: 600,
  ratioBp: 8500,
  level: "warning",
  label: "8:30 h von 10:00 h",
};
const summary = {
  _id: "pr1",
  number: "PRJ-00001",
  name: "Website Relaunch",
  status: "active",
  billingMode: "hourly",
  contactId: "c1",
  contactName: "Muster GmbH",
  budget,
  trackedMinutes: 510,
  unbilledMinutes: 120,
  unbilledValueCents: 20_000,
  currency: "EUR",
};

beforeEach(() => {
  backend.calls = [];
  backend.results = {};
  backend.data = { "members:me": { role: "owner" }, "products:options": [], "contacts:options": [] };
});

describe("Projekte (PRJ-001…004)", () => {
  test("PRJ-001 PRJ-003 the list shows customer, budget bar (amber ≥ 80 %) and the unbilled value", () => {
    backend.data["projects:list"] = [summary];
    renderWithIntl(<ProjectsList />);
    const table = screen.getByTestId("projects-table");
    expect(within(table).getByRole("link", { name: "Website Relaunch" })).toHaveAttribute("href", "/projekte/pr1");
    expect(table).toHaveTextContent("Muster GmbH");
    expect(within(table).getByText("8:30 h von 10:00 h")).toHaveAttribute("data-level", "warning");
    expect(table).toHaveTextContent("200,00 €");
  });

  test("PRJ-001 „Neues Projekt“ creates the project from the form values", async () => {
    backend.data["projects:list"] = [];
    backend.results["projects:create"] = { id: "pr2", number: "PRJ-00002" };
    renderWithIntl(<ProjectsList />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Neues Projekt" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Projektname/), "Support 2027");
    await user.selectOptions(within(dialog).getByLabelText("Budget"), "hours");
    await user.type(within(dialog).getByLabelText(/^Budgetwert/), "40");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    const call = backend.calls.find((c) => c.name === "projects:create");
    expect(call?.args).toMatchObject({ values: { name: "Support 2027", budgetKind: "hours", budgetValue: "40" } });
  });

  test("PRJ-002 PRJ-004 the project page shows the tabs, budget and the margin; cash basis on request", async () => {
    backend.data["projects:get"] = {
      project: {
        _id: "pr1",
        number: "PRJ-00001",
        name: "Website Relaunch",
        status: "active",
        billingMode: "hourly",
        contactId: "c1",
        hourlyRateMicros: 1_000_000,
        currency: "EUR",
        budget: { kind: "hours", value: 600 },
        budgetAlerts: [],
      },
      summary,
      defaultProduct: null,
      documents: [
        {
          _id: "d1",
          type: "invoice",
          typeLabel: "Rechnung",
          number: "RE-2026-0001",
          status: "finalized",
          documentDate: "2026-10-01",
          netCents: 90_000,
          currency: "EUR",
          href: "/rechnungen/d1",
        },
      ],
      vouchers: [],
      entryCount: 3,
      profitability: {
        revenueCents: 90_000,
        voucherCostCents: 12_000,
        timeCostCents: 20_000,
        costsCents: 32_000,
        marginCents: 58_000,
        marginBp: 6444,
        minutes: 510,
      },
    };
    backend.data["projects:profitability"] = {
      revenueCents: 45_000,
      voucherCostCents: 12_000,
      timeCostCents: 20_000,
      costsCents: 32_000,
      marginCents: 13_000,
      marginBp: 2889,
      minutes: 510,
    };
    renderWithIntl(<ProjectDetail id="pr1" />);
    for (const name of ["Übersicht", "Zeiten", "Dokumente", "Belege", "Einstellungen"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Zeiten abrechnen" })).toBeInTheDocument();
    expect(screen.getByTestId("project-budget")).toHaveTextContent("8:30 h von 10:00 h");
    const profit = screen.getByTestId("project-profitability");
    expect(profit).toHaveTextContent("580,00 €");
    expect(profit).toHaveTextContent("64,44 %");
    await userEvent.click(within(profit).getByRole("radio", { name: "Ist (bezahlte Anteile)" }));
    expect(profit).toHaveTextContent("28,89 %");
  });

  test("PRJ-002 viewers without projects.write get no settings tab and no status actions", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["projects:get"] = {
      project: {
        _id: "pr1",
        number: "PRJ-00001",
        name: "X",
        status: "active",
        billingMode: "hourly",
        currency: "EUR",
        budgetAlerts: [],
      },
      summary: { ...summary, budget: null },
      defaultProduct: null,
      documents: [],
      vouchers: [],
      entryCount: 0,
      profitability: null,
    };
    renderWithIntl(<ProjectDetail id="pr1" />);
    expect(screen.queryByRole("tab", { name: "Einstellungen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archivieren" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zeiten abrechnen" })).not.toBeInTheDocument();
  });
});
