import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { RecurringDetail } from "./recurring-detail";
import { emptyRecurringForm, toTemplateValues } from "./recurring-model";

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
  return { useMutation: fn, useAction: fn, useConvex: () => ({ query: vi.fn() }) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: backend.push, replace: vi.fn() }),
  usePathname: () => "/rechnungen/wiederkehrend/rt1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./recurring-editor", () => ({
  RecurringEditor: (p: { version: number; started: boolean; automationConfirmed: boolean }) => (
    <div data-testid="recurring-editor">
      v{p.version} started={String(p.started)} confirmed={String(p.automationConfirmed)}
    </div>
  ),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const values = (() => {
  const f = emptyRecurringForm("2026-08-01", "c1");
  return toTemplateValues({
    ...f,
    name: "Wartungsvertrag",
    editor: { ...f.editor, lines: [{ ...f.editor.lines[0], name: "Pauschale", price: "100,00" } as never] },
  }).values;
})();

const tpl = (over: Record<string, unknown> = {}) => ({
  _id: "rt1",
  name: "Wartungsvertrag",
  contactId: "c1",
  contactName: "Muster GmbH",
  contractReference: "V-7",
  state: "active",
  status: "active",
  interval: "P1M",
  intervalLabel: "monatlich",
  schedule: { ...values.schedule, nextDate: "2026-11-01" },
  nextDate: "2026-11-01",
  amount: { grossCents: 11_900, currency: "EUR" },
  automation: { finalize: false },
  automationConfirmed: false,
  automationEffective: false,
  generatedCount: 2,
  skippedOccurrences: [],
  archived: false,
  version: 5,
  draft: values.draft,
  documents: [
    {
      _id: "inv1",
      type: "invoice",
      number: "RE-2026-0010",
      status: "open",
      displayStatus: { token: "open", label: "Offen" },
      occurrence: "2026-09-01",
      supplyDate: { kind: "period", from: "2026-09-01", to: "2026-09-30" },
      documentDate: "2026-09-01",
      grossCents: 11_900,
      currency: "EUR",
    },
    {
      _id: "inv2",
      type: "invoice",
      number: null,
      status: "draft",
      displayStatus: { token: "draft", label: "Entwurf" },
      occurrence: "2026-10-01",
      supplyDate: null,
      documentDate: null,
      grossCents: 11_900,
      currency: "EUR",
    },
  ],
  ...over,
});

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.mutations = {};
  backend.push = vi.fn();
  vi.clearAllMocks();
});

describe("Vorlage detail (F04 §6.5)", () => {
  test("REC-01 loading is busy; an unknown template says „Vorlage nicht gefunden“", () => {
    const { container, unmount } = renderWithIntl(<RecurringDetail id="rt1" />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["recurring:get"] = null;
    renderWithIntl(<RecurringDetail id="rt1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Vorlage nicht gefunden." })).toBeInTheDocument();
  });

  test("REC-09 the header and the generated invoices with their periods and status", () => {
    backend.data["recurring:get"] = tpl();
    renderWithIntl(<RecurringDetail id="rt1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Wartungsvertrag" })).toBeInTheDocument();
    expect(screen.getByText("Aktiv · monatlich · Muster GmbH · Nächste Rechnung am 01.11.2026")).toBeInTheDocument();
    expect(screen.getByTestId("template-state")).toHaveTextContent("Aktiv");
    expect(screen.getByText("Entwurf zur Prüfung")).toBeInTheDocument();
    expect(screen.getByTestId("recurring-editor")).toHaveTextContent("v5 started=true confirmed=false");
    const docs = within(screen.getByTestId("generated-documents")).getAllByRole("listitem");
    expect(within(docs[0] as HTMLElement).getByRole("link", { name: "RE-2026-0010" })).toHaveAttribute(
      "href",
      "/rechnungen/inv1",
    );
    expect(docs[0]).toHaveTextContent("Zeitraum: 01.09.2026 – 30.09.2026");
    expect(docs[0]).toHaveTextContent("119,00 €");
    expect(docs[0]).toHaveTextContent("Offen");
    expect(within(docs[1] as HTMLElement).getByRole("link", { name: "Entwurf" })).toBeInTheDocument();
    expect(docs[1]).toHaveTextContent("Zeitraum: 01.10.2026");
  });

  test("REC-12 „Jetzt erzeugen“ and „Pausieren“ call the template actions", async () => {
    const user = userEvent.setup();
    backend.data["recurring:get"] = tpl();
    backend.mutations["recurring:runNow"] = vi.fn().mockResolvedValue({ created: 1, finalized: 0 });
    renderWithIntl(<RecurringDetail id="rt1" />);
    await user.click(screen.getByRole("button", { name: "Jetzt erzeugen" }));
    await waitFor(() => expect(backend.mutations["recurring:runNow"]).toHaveBeenCalledWith({ id: "rt1" }));
    expect(toast.success).toHaveBeenCalledWith("1 Rechnung erzeugt, 0 fertiggestellt");
    await user.click(screen.getByRole("button", { name: "Pausieren" }));
    await waitFor(() => expect(backend.mutations["recurring:pause"]).toHaveBeenCalledWith({ id: "rt1" }));
  });

  test("REC-10 a paused template resumes with „Überspringen“ and lists skipped dates", async () => {
    const user = userEvent.setup();
    backend.data["recurring:get"] = tpl({
      state: "paused",
      status: "paused",
      skippedOccurrences: ["2026-09-01", "2026-10-01"],
    });
    renderWithIntl(<RecurringDetail id="rt1" />);
    expect(screen.getByText("Übersprungene Termine: 01.09.2026, 01.10.2026")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jetzt erzeugen" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Fortsetzen" }));
    const dialog = await screen.findByRole("dialog", { name: "Vorlage fortsetzen" });
    await user.click(within(dialog).getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() =>
      expect(backend.mutations["recurring:resume"]).toHaveBeenCalledWith({ id: "rt1", catchUp: false }),
    );
  });

  test("REC-14 automation set up via API is confirmed by an owner with finalise permission", async () => {
    const user = userEvent.setup();
    backend.data["recurring:get"] = tpl({ automation: { finalize: true } });
    renderWithIntl(<RecurringDetail id="rt1" />);
    expect(screen.getByText("Automatik nicht bestätigt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Automatik bestätigen" }));
    await waitFor(() => expect(backend.mutations["recurring:confirmAutomation"]).toHaveBeenCalledWith({ id: "rt1" }));
    expect(toast.success).toHaveBeenCalledWith("Vorlage gespeichert");
  });

  test("REC-11 deleting a used template archives it and returns to the list", async () => {
    const user = userEvent.setup();
    backend.data["recurring:get"] = tpl();
    backend.mutations["recurring:remove"] = vi.fn().mockResolvedValue({ result: "archived" });
    renderWithIntl(<RecurringDetail id="rt1" />);
    await user.click(screen.getByRole("button", { name: "Löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Vorlage löschen?" });
    await user.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(backend.mutations["recurring:remove"]).toHaveBeenCalledWith({ id: "rt1" }));
    expect(toast.success).toHaveBeenCalledWith("Vorlage archiviert");
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/wiederkehrend");
  });

  test("REC-01 a viewer sees the template read-only without editor or actions; no documents yet", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["recurring:get"] = tpl({ documents: [], automation: { finalize: true } });
    renderWithIntl(<RecurringDetail id="rt1" />);
    expect(screen.queryByTestId("recurring-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "Jetzt erzeugen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Löschen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Automatik bestätigen" })).toBeNull();
    expect(screen.getByText("Noch keine Rechnung erzeugt.")).toBeInTheDocument();
  });
});
