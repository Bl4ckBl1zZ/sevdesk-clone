import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { todayBerlin } from "@/components/catalog/shared";
import { timeReport } from "@/domain/projects/time-report";
import { addDays, type CalendarDate } from "@/domain/time/calendar-date";
import { weekStart } from "@/domain/time/week";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoiceEntriesDialog, invoiceValues } from "./invoice-dialog";
import { memoryStore, OfflineTimeQueue, setOfflineTimeQueue } from "./offline-queue";
import { ReopenBanners, TimeEntryList } from "./time-entries";
import type { TimeEntryRow } from "./time-shared";
import { TimeReportView, WeekView } from "./time-views";
import { TimerCard } from "./timer";
import { TimerPill } from "./timer-pill";
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
    expect(within(preview).getByRole("region", { name: "Positionen der Vorschau" })).toHaveAttribute("tabindex", "0");
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
      { description: "Konzept", deviceId: expect.any(String) },
      { description: "Konzept", deviceId: expect.any(String), confirmStop: true },
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

describe("Offline capture (PRJ-018)", () => {
  test("PRJ-018 offline: start and stop are queued (no backend call) and the queued timer is shown as running", async () => {
    const queue = new OfflineTimeQueue(memoryStore());
    setOfflineTimeQueue(queue);
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      backend.data["timeEntries:timer"] = undefined;
      renderWithIntl(<TimerCard />);
      const user = userEvent.setup();
      expect(screen.getByTestId("timer-offline")).toHaveTextContent("Offline");
      await user.type(screen.getByLabelText("Tätigkeit"), "Baustellentermin");
      await user.click(screen.getByRole("button", { name: "Zeit starten" }));
      expect(await screen.findByRole("button", { name: "Stoppen" })).toBeInTheDocument();
      expect(screen.getByTestId("timer")).toHaveAttribute("data-running", "true");
      expect(screen.queryByRole("button", { name: "Verwerfen" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Stoppen" }));
      expect(await screen.findByRole("button", { name: "Zeit starten" })).toBeInTheDocument();
      expect(queue.snapshot().map((o) => [o.kind, o.kind === "timer_start" ? o.fields.description : null])).toEqual([
        ["timer_start", "Baustellentermin"],
        ["timer_stop", null],
      ]);
      expect(backend.calls.filter((c) => c.name.startsWith("timeEntries:"))).toEqual([]);
    } finally {
      if (online) Object.defineProperty(navigator, "onLine", online);
      else delete (navigator as { onLine?: boolean }).onLine;
      setOfflineTimeQueue(null);
    }
  });

  test("PRJ-018 back online: the queue is replayed with the device ID and cleared", async () => {
    const queue = new OfflineTimeQueue(
      memoryStore([{ id: "op-1", kind: "manual", at: 1, values: { duration: "1h", description: "Aufmaß" } }]),
    );
    setOfflineTimeQueue(queue);
    await queue.load();
    expect(queue.snapshot()).toHaveLength(1);
    backend.results["timeEntries:syncOffline"] = {
      applied: ["op-1"],
      skipped: [],
      entryIds: ["e9"],
      conflict: false,
      warnings: [],
    };
    backend.data["timeEntries:timer"] = null;
    try {
      renderWithIntl(<TimerCard />);
      await vi.waitFor(() => expect(queue.snapshot()).toEqual([]));
      const call = backend.calls.find((c) => c.name === "timeEntries:syncOffline");
      expect(call?.args).toMatchObject({ deviceId: expect.any(String), ops: [{ id: "op-1", kind: "manual" }] });
    } finally {
      setOfflineTimeQueue(null);
    }
  });
});

describe("Header timer pill (PRJ-005, F11 §6)", () => {
  test("PRJ-005 a running timer shows project and elapsed time in the header; a click opens stop/discard", async () => {
    backend.data["timeEntries:timer"] = {
      _id: "t1",
      startedAt: Date.now() - 3_725_000,
      description: "Workshop",
      projectId: "p1",
      projectName: "Website-Relaunch",
      startedVia: "ui",
    };
    renderWithIntl(<TimerPill />);
    const pill = screen.getByTestId("timer-pill");
    expect(pill).toHaveAttribute("data-running", "true");
    expect(pill).toHaveTextContent("Website-Relaunch");
    expect(screen.getByTestId("timer-pill-elapsed").textContent).toMatch(/^1:02:0[5-9]$/);
    expect(pill.getAttribute("aria-label")).toBe("Timer läuft: Website-Relaunch");
    const user = userEvent.setup();
    await user.click(pill);
    const popover = await screen.findByTestId("timer-popover");
    expect(within(popover).getByRole("button", { name: "Stoppen" })).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Verwerfen" })).toBeInTheDocument();
    expect(within(popover).getByLabelText("Tätigkeit")).toHaveValue("Workshop");
    // the discard confirmation opened from the popover stays usable
    await user.click(within(popover).getByRole("button", { name: "Verwerfen" }));
    const confirm = await screen.findByRole("dialog", { name: "Timer verwerfen?" });
    await user.click(within(confirm).getByRole("button", { name: "Verwerfen" }));
    expect(backend.calls.map((c) => c.name)).toContain("timeEntries:discard");
  });

  test("PRJ-005 idle: „Zeit starten“ for writers, nothing for read-only roles", async () => {
    backend.data["timeEntries:timer"] = null;
    const { unmount } = renderWithIntl(<TimerPill />);
    const pill = screen.getByRole("button", { name: "Zeit starten" });
    expect(pill).toHaveAttribute("data-running", "false");
    await userEvent.setup().click(pill);
    const popover = await screen.findByTestId("timer-popover");
    expect(within(popover).getByRole("button", { name: "Zeit starten" })).toBeInTheDocument();
    unmount();
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<TimerPill />);
    expect(screen.queryByTestId("timer-pill")).toBeNull();
  });
});

describe("Week view and time reports (F11 §6, PRJ-017)", () => {
  test("PRJ-017 the week view shows Mon–Sun columns with totals per day and project", () => {
    const monday = weekStart(todayBerlin() as CalendarDate);
    backend.data["timeEntries:list"] = [
      entry({
        _id: "e1" as never,
        date: monday,
        durationMinutes: 90,
        projectId: "p1" as never,
        projectName: "Relaunch",
      }),
      entry({
        _id: "e2" as never,
        date: addDays(monday, 2),
        durationMinutes: 60,
        projectId: "p1" as never,
        projectName: "Relaunch",
      }),
      entry({
        _id: "e3" as never,
        date: addDays(monday, 2),
        durationMinutes: 30,
        projectId: "p2" as never,
        projectName: "Shop",
      }),
    ];
    renderWithIntl(<WeekView />);
    expect(screen.getByTestId("week-label").textContent).toMatch(/^KW \d+\/\d{4} · /);
    const table = screen.getByTestId("week-table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers[0]).toBe("Projekt / Kunde");
    expect(headers.slice(1, 8).map((h) => h?.slice(0, 2))).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
    expect(headers[8]).toBe("Summe");
    const relaunch = within(table).getByRole("row", { name: /Relaunch/ });
    expect(
      within(relaunch)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["Relaunch", "1:30 h", "—", "1:00 h", "—", "—", "—", "—", "2:30 h"]);
    expect(screen.getByTestId("week-total")).toHaveTextContent("3:00 h");
    expect(screen.getByRole("button", { name: "Vorherige Woche" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nächste Woche" })).toBeInTheDocument();
  });

  test("PRJ-017 the report shows hours per group, billable vs non-billable, unbilled value and weekly utilisation", () => {
    const today = todayBerlin() as CalendarDate;
    const from = `${today.slice(0, 7)}-01` as CalendarDate;
    backend.data["timeEntries:report"] = timeReport(
      [
        {
          date: from,
          durationMinutes: 120,
          billable: true,
          status: "open",
          hourlyRateMicros: 900_000,
          projectId: "p1",
          projectName: "Relaunch",
        },
        {
          date: from,
          durationMinutes: 60,
          billable: false,
          status: "open",
          hourlyRateMicros: 900_000,
          projectId: "p1",
          projectName: "Relaunch",
        },
      ],
      { groupBy: "project", from, to: today },
    );
    renderWithIntl(<TimeReportView />);
    const totals = screen.getByTestId("time-report-totals");
    expect(totals).toHaveTextContent("Stunden gesamt3:00 h");
    expect(totals).toHaveTextContent("Nicht abgerechnet180,00 €");
    const row = within(screen.getByTestId("time-report-table")).getByRole("row", { name: /Relaunch/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent?.replace(/\s/g, " ")),
    ).toEqual(["Relaunch", "3:00 h", "2:00 h", "1:00 h", "180,00 €", "0,00 €"]);
    expect(within(screen.getByTestId("time-report-weeks")).getAllByRole("row")[1]).toHaveTextContent("66,66 %");
    expect(screen.getByRole("button", { name: /Export/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Gruppieren nach")).toHaveValue("project");
    // Phones scroll the tables sideways: each scroll container is a named, focusable region (04 §9, axe).
    expect(screen.getByRole("region", { name: "Stunden je Projekt" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Auslastung je Woche" })).toHaveAttribute("tabindex", "0");
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
