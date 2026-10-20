import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoiceEntriesDialog, invoiceValues } from "./invoice-dialog";
import { ReopenBanners, TimeEntryList } from "./time-entries";
import type { TimeEntryRow } from "./time-shared";
import { TimerCard } from "./timer";
import { UnbilledTimeWidget } from "./unbilled-widget";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  fail: {} as Record<string, unknown>,
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
    const failure = backend.fail[name];
    if (failure) {
      delete backend.fail[name];
      throw failure;
    }
    return backend.results[name] ?? null;
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/zeiten",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const entry = (over: Partial<TimeEntryRow>): TimeEntryRow =>
  ({
    _id: "e1",
    _creationTime: 0,
    date: "2026-10-12",
    durationMinutes: 90,
    description: "Workshop",
    hourlyRateMicros: 1_000_000,
    currency: "EUR",
    billable: true,
    status: "open",
    invoicedLineHistory: [],
    source: "manual",
    retentionClass: "none",
    actor: "user:u1",
    projectName: "Relaunch",
    contactName: null,
    productName: null,
    valueCents: 15_000,
    document: null,
    ...over,
  }) as TimeEntryRow;

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" }, "projects:options": [], "products:options": [] };
  backend.calls = [];
  backend.fail = {};
  backend.results = {};
});

describe("Zeiten list (PRJ-007, PRJ-012, PRJ-016)", () => {
  test("PRJ-012 status badges Offen / Im Entwurf / Abgerechnet; only open entries are selectable and editable", () => {
    backend.data["timeEntries:list"] = [
      entry({ _id: "e1" as never, description: "Offene Zeit" }),
      entry({
        _id: "e2" as never,
        description: "Entwurfszeit",
        status: "in_draft",
        document: { _id: "d1" as never, number: null },
      }),
      entry({
        _id: "e3" as never,
        description: "Gesperrt",
        status: "invoiced",
        document: { _id: "d2" as never, number: "RE-2026-0007" },
      }),
    ];
    renderWithIntl(<TimeEntryList args={{}} />);
    const table = screen.getByTestId("time-table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["open", "in_draft", "invoiced"]);
    expect(within(rows[0] as HTMLElement).getByText("Offen")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Im Entwurf")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Abgerechnet")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByRole("link", { name: "RE-2026-0007" })).toHaveAttribute(
      "href",
      "/rechnungen/d2",
    );
    expect(within(table).getAllByRole("checkbox", { name: /auswählen$/ })).toHaveLength(2); // select all + e1
    expect(within(table).getAllByRole("button", { name: "Bearbeiten" })).toHaveLength(1);
  });

  test("PRJ-016 bulk „Als nicht abrechenbar markieren“ and „Löschen“ act on the selected open entries", async () => {
    backend.data["timeEntries:list"] = [
      entry({ _id: "e1" as never }),
      entry({ _id: "e2" as never, description: "Call" }),
    ];
    backend.results["timeEntries:setBillableFlag"] = { updated: 1 };
    backend.results["timeEntries:remove"] = { deleted: 1 };
    renderWithIntl(<TimeEntryList args={{}} />);
    const user = userEvent.setup();
    const table = screen.getByTestId("time-table");
    await user.click(within(table).getByRole("checkbox", { name: "Call auswählen" }));
    const bar = screen.getByTestId("time-bulk-bar");
    expect(bar).toHaveTextContent("1 ausgewählt");
    await user.click(within(bar).getByRole("button", { name: "Als nicht abrechenbar markieren" }));
    expect(backend.calls).toContainEqual({
      name: "timeEntries:setBillableFlag",
      args: { ids: ["e2"], billable: false },
    });
    await user.click(within(table).getByRole("checkbox", { name: "Alle offenen Einträge auswählen" }));
    await user.click(within(screen.getByTestId("time-bulk-bar")).getByRole("button", { name: "Löschen" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Löschen" }));
    expect(backend.calls).toContainEqual({ name: "timeEntries:remove", args: { ids: ["e1", "e2"] } });
  });

  test("PRJ-007 viewers see the list without selection, edit or „Zeit erfassen“", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["timeEntries:list"] = [entry({})];
    renderWithIntl(<TimeEntryList args={{}} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zeit erfassen" })).not.toBeInTheDocument();
  });
});

describe("Zeiten abrechnen dialog (PRJ-009…013)", () => {
  test("PRJ-009 PRJ-010 dialog values carry grouping, unit, explicit rounding and per-group rounding", () => {
    expect(
      invoiceValues({
        entryIds: ["a"],
        grouping: "per_day",
        unit: "",
        increment: "default",
        mode: "up",
        perGroup: false,
      }),
    ).toEqual({ entryIds: ["a"], grouping: "per_day" });
    expect(
      invoiceValues({
        entryIds: ["a", "b"],
        grouping: "summary",
        unit: "MIN",
        increment: "15",
        mode: "nearest",
        perGroup: true,
      }),
    ).toEqual({
      entryIds: ["a", "b"],
      grouping: "summary",
      unit: "MIN",
      rounding: { incrementMinutes: 15, mode: "nearest" },
      perGroup: true,
    });
  });

  test("PRJ-010 PRJ-013 the preview shows raw vs rounded minutes, the supply period and notices; append to a draft", async () => {
    backend.data["timeEntries:previewInvoice"] = {
      ok: true,
      plan: {
        contactId: "c1",
        currency: "EUR",
        lines: [
          {
            name: "Beratung",
            quantityMilli: 1750,
            unitCode: "HUR",
            unitPriceMicros: 1_000_000,
            vatRateKey: "standard",
            linePeriod: { from: "2026-10-01", to: "2026-10-12" },
            timeEntryIds: ["e1", "e2"],
            rawMinutes: 97,
            roundedMinutes: 105,
            netCents: 17_500,
            exactNetCents: 16_167,
          },
        ],
        supplyDate: { kind: "period", from: "2026-10-01", to: "2026-10-12" },
        roundedByEntry: {},
        rounding: { incrementMinutes: 15, mode: "up", perGroup: false },
        notices: ["Gerundet auf 15 Minuten."],
      },
    };
    backend.data["timeEntries:draftsOfContact"] = [{ _id: "d9", subject: "Oktober", netCents: 0, version: 1 }];
    backend.results["timeEntries:createInvoice"] = { id: "d9", notices: [], lines: 1 };
    renderWithIntl(
      <InvoiceEntriesDialog
        candidates={[entry({ _id: "e1" as never }), entry({ _id: "e2" as never, description: "Call" })]}
        onClose={vi.fn()}
      />,
    );
    const preview = screen.getByTestId("invoice-preview");
    expect(preview).toHaveTextContent("1:37 h");
    expect(preview).toHaveTextContent("1:45 h");
    expect(preview).toHaveTextContent("175,00 €");
    expect(preview).toHaveTextContent("Leistungszeitraum 01.10.2026 – 12.10.2026");
    expect(preview).toHaveTextContent("Gerundet auf 15 Minuten.");
    expect(within(preview).getByRole("region", { name: "Vorschau" })).toHaveAttribute("tabindex", "0");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Ziel"), "d9");
    await user.click(screen.getByRole("button", { name: "Zum Entwurf hinzufügen" }));
    expect(backend.calls).toContainEqual({
      name: "timeEntries:createInvoice",
      args: { values: { entryIds: ["e1", "e2"], grouping: "per_entry", draftId: "d9" } },
    });
  });

  test("PRJ-010 E-PRJ-12 a blocking issue is shown and the submit stays disabled", () => {
    backend.data["timeEntries:previewInvoice"] = {
      ok: false,
      error: {
        code: "time_entries_contacts",
        message: "Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden.",
      },
    };
    renderWithIntl(<InvoiceEntriesDialog candidates={[entry({})]} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("verschiedener Kunden");
    expect(screen.getByRole("button", { name: "Entwurf erstellen" })).toBeDisabled();
  });
});

describe("Timer (PRJ-005)", () => {
  test("PRJ-005 E-PRJ-01 starting while another device runs a timer asks before stopping it", async () => {
    backend.data["timeEntries:timer"] = null;
    backend.fail["timeEntries:start"] = {
      data: {
        code: "conflict",
        reason: "TIMER_RUNNING",
        message: "Timer für „Relaunch“ läuft seit 42 Minuten. Stoppen und neu starten?",
      },
    };
    renderWithIntl(<TimerCard />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Tätigkeit"), "Konzept");
    await user.click(screen.getByRole("button", { name: "Zeit starten" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("läuft seit 42 Minuten");
    await user.click(within(dialog).getByRole("button", { name: "Stoppen und neu starten" }));
    expect(backend.calls.filter((c) => c.name === "timeEntries:start").map((c) => c.args)).toEqual([
      { description: "Konzept" },
      { description: "Konzept", confirmStop: true },
    ]);
  });

  test("PRJ-005 PRJ-006 a running timer shows the elapsed time and stops with the midnight split option", async () => {
    backend.data["timeEntries:timer"] = {
      _id: "t1",
      startedAt: Date.now() - 65_000,
      description: "Support",
      projectName: null,
      startedVia: "ui",
    };
    backend.results["timeEntries:stop"] = { entryIds: ["e1"], warnings: [] };
    renderWithIntl(<TimerCard />);
    expect(screen.getByTestId("timer")).toHaveAttribute("data-running", "true");
    expect(screen.getByTestId("timer-elapsed").textContent).toMatch(/^0:01:0\d$/);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("An Mitternacht teilen"));
    await user.click(screen.getByRole("button", { name: "Stoppen" }));
    expect(backend.calls).toContainEqual({
      name: "timeEntries:stop",
      args: { description: "Support", splitAtMidnight: true },
    });
  });
});

describe("Storno offer and UST-01 widget", () => {
  test("PRJ-012 E-PRJ-25 the entries of a cancelled invoice can be made billable again", async () => {
    backend.data["timeEntries:reopenOffers"] = [{ invoiceId: "inv1", number: "RE-2026-0003", count: 2 }];
    backend.results["timeEntries:reopen"] = { reopened: 2 };
    renderWithIntl(<ReopenBanners />);
    const banner = screen.getByTestId("reopen-banners");
    expect(banner).toHaveTextContent(
      "Rechnung RE-2026-0003 wurde storniert. 2 Zeiteinträge können wieder abgerechnet werden.",
    );
    await userEvent.click(within(banner).getByRole("button", { name: "Wieder abrechenbar machen" }));
    expect(backend.calls).toContainEqual({ name: "timeEntries:reopen", args: { invoiceId: "inv1" } });
  });

  test("PRJ-015 the dashboard card shows open time and the 150/180-day warnings; hidden when nothing is open", () => {
    backend.data["timeEntries:unbilled"] = {
      openCount: 3,
      openMinutes: 330,
      openValueCents: 55_000,
      warning: 1,
      escalation: 2,
    };
    const { unmount } = renderWithIntl(<UnbilledTimeWidget />);
    const card = screen.getByTestId("unbilled-time");
    expect(card).toHaveTextContent("Nicht abgerechnete Zeiten: 5:30 h offen · 550,00 €");
    expect(within(card).getByRole("alert")).toHaveTextContent("Rechnungsfrist überschritten: 2");
    expect(card).toHaveTextContent("1 abrechenbare Zeiteinträge sind älter als 150 Tage");
    unmount();
    backend.data["timeEntries:unbilled"] = {
      openCount: 0,
      openMinutes: 0,
      openValueCents: 0,
      warning: 0,
      escalation: 0,
    };
    const { container } = renderWithIntl(<UnbilledTimeWidget />);
    expect(container).toBeEmptyDOMElement();
  });
});
