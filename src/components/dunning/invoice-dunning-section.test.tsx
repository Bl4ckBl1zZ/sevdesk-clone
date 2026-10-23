import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoiceDunningSection } from "./invoice-dunning-section";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  push: vi.fn(),
  enabled: [] as boolean[],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) => {
    backend.enabled.push(enabled);
    if (!enabled) return undefined;
    return backend.data[getFunctionName(ref as never)];
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
  useRouter: () => ({ push: backend.push, replace: vi.fn() }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const reminder = (over: Record<string, unknown> = {}) => ({
  id: "rem1",
  number: "MA-2026-0001",
  status: "sent",
  level: 1,
  title: "Zahlungserinnerung",
  invoiceId: "inv1",
  invoiceNumber: "RE-2026-0042",
  contactId: "c1",
  contactName: "Muster GmbH",
  documentDate: "2026-09-10",
  openAmountCents: 119_000,
  feeCents: 0,
  interestCents: 0,
  flatFee40Cents: 0,
  totalCents: 119_000,
  newDueDate: "2026-09-17",
  defaultStartDate: null,
  createdByRun: true,
  finalizedAt: 1,
  sentOn: "2026-09-10",
  zugang: { date: "2026-09-13", basis: "post" },
  artifactStatus: "ready",
  cancellation: null,
  version: 1,
  ...over,
});

const forInvoice = (over: Record<string, unknown> = {}) => ({
  dunnable: true,
  zugang: { date: "2026-08-04", basis: "post" },
  sentOn: "2026-08-01",
  zugangNotice: null,
  disputed: null,
  blocked: null,
  contactBlocked: false,
  isConsumer: false,
  case: {
    status: "active",
    currentLevel: 1,
    pausedUntil: null,
    pausedReason: null,
    flatFeeCharged: false,
    handedOver: null,
    graceUntil: null,
  },
  defaultStart: { date: "2026-09-18", route: "after_printed_deadline", label: "Verzug seit 18.09.2026 (Mahnfrist)" },
  limitation: { date: "2029-12-31", state: "ok", message: null },
  reminders: [reminder()],
  next: {
    kind: "create_draft",
    level: 2,
    earliestDate: "2026-10-20",
    reasonLabel: "1. Mahnung",
    detail: "14 Tage nach Zugang",
  },
  ...over,
});

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" }, "dunning:forInvoice": forInvoice() };
  backend.mutations = {};
  backend.push = vi.fn();
  backend.enabled = [];
  vi.clearAllMocks();
});

describe("InvoiceDunningSection (DUN-010)", () => {
  test("DUN-010 shows the case, the default start, the next action and every reminder with its dispatch line", () => {
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    const section = screen.getByTestId("invoice-dunning");
    expect(within(section).getByText("Mahnverfahren aktiv")).toBeInTheDocument();
    expect(section).toHaveTextContent("Verzug seit 18.09.2026 (Mahnfrist)");
    expect(section).toHaveTextContent("31.12.2029");
    expect(within(section).getByTestId("next-action")).toHaveTextContent(
      "Entwurf erstellen · Stufe 2 · frühestens am 20.10.2026",
    );
    expect(within(section).getByTestId("next-action")).toHaveTextContent("1. Mahnung – 14 Tage nach Zugang");
    const list = within(section).getByTestId("invoice-reminders");
    expect(within(list).getByRole("link", { name: "MA-2026-0001" })).toHaveAttribute("href", "/mahnungen/rem1");
    expect(list).toHaveTextContent("versendet am 10.09.2026 · Zugang 13.09.2026 (Post)");
    expect(list).toHaveTextContent("1.190,00 €");
    expect(within(section).getByTestId("create-reminder")).toHaveTextContent("Nächste Mahnstufe");
    expect(within(section).getByTestId("mahnbescheid-sheet")).toBeInTheDocument();
  });

  test("DUN-008 „Nächste Mahnstufe“ creates the draft and opens it", async () => {
    const user = userEvent.setup();
    backend.mutations["dunning:createReminder"] = vi.fn().mockResolvedValue({ id: "rem2" });
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    await user.click(screen.getByTestId("create-reminder"));
    await waitFor(() =>
      expect(backend.mutations["dunning:createReminder"]).toHaveBeenCalledWith({ invoiceId: "inv1", values: {} }),
    );
    expect(backend.push).toHaveBeenCalledWith("/mahnungen/rem2");
    expect(toast.success).toHaveBeenCalledWith("Mahnentwurf erstellt.");
  });

  test("DUN-041 a time-barred claim needs the ⚑ confirmation, then the call repeats with the acknowledged code", async () => {
    const user = userEvent.setup();
    backend.mutations["dunning:createReminder"] = vi
      .fn()
      .mockRejectedValueOnce(
        new ConvexError({
          code: "invalid_input",
          message: "Die Forderung ist verjährt.",
          reason: "WARNINGS_UNACKNOWLEDGED",
          warnings: "limitation_passed",
        }),
      )
      .mockResolvedValue({ id: "rem2" });
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    await user.click(screen.getByTestId("create-reminder"));
    expect(await screen.findByTestId("dunning-warning")).toHaveTextContent("Die Forderung ist verjährt.");
    await user.click(screen.getByRole("button", { name: "Trotzdem erstellen" }));
    await waitFor(() =>
      expect(backend.mutations["dunning:createReminder"]).toHaveBeenLastCalledWith({
        invoiceId: "inv1",
        values: { acknowledgeWarnings: ["limitation_passed"] },
      }),
    );
  });

  test("DUN-034 „Bestritten“ needs a reason and records the case action", async () => {
    const user = userEvent.setup();
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    await user.click(screen.getByRole("button", { name: "Mahnverfahren" }));
    expect(await screen.findByRole("menuitem", { name: "Pausieren" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Fortsetzen" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Bestritten" }));
    const dialog = await screen.findByRole("dialog", { name: "Forderung als bestritten markieren" });
    const confirm = within(dialog).getByRole("button", { name: "Als bestritten markieren" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Grund"), "Ware mangelhaft");
    await user.click(confirm);
    await waitFor(() =>
      expect(backend.mutations["dunning:caseAction"]).toHaveBeenCalledWith({
        invoiceId: "inv1",
        values: { action: "dispute", reason: "Ware mangelhaft" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Forderung als bestritten markiert.");
  });

  test("DUN-042 handing over to Inkasso needs the partner name", async () => {
    const user = userEvent.setup();
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    await user.click(screen.getByRole("button", { name: "Mahnverfahren" }));
    await user.click(await screen.findByRole("menuitem", { name: "An Inkasso übergeben" }));
    const dialog = await screen.findByRole("dialog", { name: "An Inkasso übergeben" });
    await user.type(within(dialog).getByLabelText("Inkassobüro"), "Inkasso Nord");
    await user.click(within(dialog).getByRole("button", { name: "Übergeben" }));
    await waitFor(() =>
      expect(backend.mutations["dunning:caseAction"]).toHaveBeenCalledWith({
        invoiceId: "inv1",
        values: { action: "hand_over", partner: "Inkasso Nord" },
      }),
    );
  });

  test("DUN-034 a disputed, paused case offers „Fortsetzen“ and shows the badges and the pause date", async () => {
    const user = userEvent.setup();
    backend.data["dunning:forInvoice"] = forInvoice({
      disputed: { reason: "Ware mangelhaft", at: 1 },
      blocked: { reason: "Kulanz" },
      contactBlocked: true,
      case: { ...forInvoice().case, status: "paused", pausedUntil: "2026-11-01" },
      zugangNotice: { severity: "W", message: "Zugang nur geschätzt." },
      limitation: { date: "2026-12-31", state: "soon", message: "Verjährung naht" },
    });
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    const section = screen.getByTestId("invoice-dunning");
    expect(within(section).getByText("Bestritten: Ware mangelhaft")).toBeInTheDocument();
    expect(within(section).getByText("Nicht mahnen: Kulanz")).toBeInTheDocument();
    expect(within(section).getByText("Kontakt: nicht mahnen")).toBeInTheDocument();
    expect(within(section).getByTestId("limitation-badge")).toHaveTextContent("verjährt am 31.12.2026");
    expect(within(section).getByTestId("zugang-notice")).toHaveTextContent("Zugang nur geschätzt.");
    expect(section).toHaveTextContent("01.11.2026");
    await user.click(screen.getByRole("button", { name: "Mahnverfahren" }));
    expect(await screen.findByRole("menuitem", { name: "Fortsetzen" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "„Nicht mahnen“ aufheben" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Bestritten" })).toBeNull();
  });

  test("DUN-010 a viewer sees the chain without actions; credit notes do not query; nothing to show renders nothing", () => {
    backend.data["members:me"] = { role: "viewer" };
    const { unmount } = renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    expect(screen.getByTestId("invoice-reminders")).toBeInTheDocument();
    expect(screen.queryByTestId("create-reminder")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mahnverfahren" })).toBeNull();
    unmount();
    backend.enabled = [];
    const credit = renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="credit_note" />);
    expect(backend.enabled).toContain(false);
    expect(credit.container).toBeEmptyDOMElement();
    credit.unmount();
    backend.data["dunning:forInvoice"] = forInvoice({ dunnable: false, reminders: [], case: null });
    const none = renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    expect(none.container).toBeEmptyDOMElement();
  });

  test("DUN-010 without reminders: „Mahnung erstellen“ and the empty hint", () => {
    backend.data["dunning:forInvoice"] = forInvoice({ reminders: [], case: null, defaultStart: null, next: null });
    renderWithIntl(<InvoiceDunningSection invoiceId="inv1" type="invoice" />);
    expect(screen.getByText("Noch keine Mahnungen zu dieser Rechnung.")).toBeInTheDocument();
    expect(screen.getByTestId("create-reminder")).toHaveTextContent("Mahnung erstellen");
    expect(screen.getByText("Kein Mahnfall")).toBeInTheDocument();
    expect(screen.getByText("Noch kein Verzug")).toBeInTheDocument();
    expect(screen.queryByTestId("mahnbescheid-sheet")).toBeNull();
  });
});
