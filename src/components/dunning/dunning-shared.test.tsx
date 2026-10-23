import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import {
  CaseStatusBadge,
  DispatchStatus,
  formatRateBp,
  InterestSegments,
  LimitationBadge,
  ReminderExportMenu,
  ReminderMarkSentDialog,
  ReminderStatusBadge,
} from "./dunning-shared";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  push: vi.fn(),
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
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const detail = (documentDate: string) => ({
  reminder: {
    id: "rem1",
    number: "MA-2026-0003",
    status: "finalized",
    level: 2,
    title: "1. Mahnung",
    invoiceId: "inv1",
    invoiceNumber: "RE-2026-0042",
    documentDate,
    sentOn: null,
    zugang: null,
    artifactStatus: "ready",
  },
  artifacts: [
    { _id: "a1", kind: "pdf", variant: "original", name: "MA-2026-0003.pdf", sha256: "x", bytes: 1 },
    { _id: "a2", kind: "validation_report_pdf", variant: "original", name: "report.pdf", sha256: "y", bytes: 1 },
  ],
  defaultMarkSelection: [],
  today: "2026-10-16",
});

beforeEach(() => {
  backend.data = {};
  backend.mutations = {};
  backend.push = vi.fn();
  vi.clearAllMocks();
});

describe("dunning shared pieces (F05 §6.4–§6.7)", () => {
  test("DUN-010 status badges and dispatch lines for draft, withdrawn and unmarked reminders", () => {
    renderWithIntl(
      <div>
        <ReminderStatusBadge status="finalized" />
        <ReminderStatusBadge status="weird" />
        <CaseStatusBadge status="handed_over" />
        <CaseStatusBadge status={null} />
        <DispatchStatus reminder={{ status: "draft", sentOn: null, zugang: null }} />
        <DispatchStatus reminder={{ status: "cancelled", sentOn: null, zugang: null }} />
        <DispatchStatus reminder={{ status: "finalized", sentOn: null, zugang: null }} />
        <DispatchStatus
          reminder={{ status: "sent", sentOn: "2026-10-12", zugang: { date: "2026-10-12", basis: "manual" } }}
        />
      </div>,
    );
    expect(screen.getByText("Fertiggestellt – nicht versendet")).toHaveAttribute("data-status", "finalized");
    expect(screen.getAllByText("Entwurf").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("An Inkasso übergeben")).toBeInTheDocument();
    expect(screen.getByText("Kein Mahnfall")).toBeInTheDocument();
    expect(screen.getByText("gegenstandslos, nie versendet")).toBeInTheDocument();
    expect(screen.getByText("nicht als versendet markiert")).toBeInTheDocument();
    expect(screen.getByText("versendet am 12.10.2026 · Zugang 12.10.2026 (manuell festgelegt)")).toBeInTheDocument();
  });

  test("DUN-041 the limitation badge: hidden while ok, „verjährt“ once expired", () => {
    const { container, unmount } = renderWithIntl(
      <LimitationBadge limitation={{ date: "2029-12-31", state: "ok", message: null }} />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();
    renderWithIntl(<LimitationBadge limitation={{ date: "2025-12-31", state: "expired", message: "Verjährt" }} />);
    expect(screen.getByTestId("limitation-badge")).toHaveTextContent("verjährt");
    expect(screen.getByTestId("limitation-badge")).toHaveAttribute("title", "Verjährt");
  });

  test("DUN-022 interest segments list period, days, rate, principal and total; none shows a hint", () => {
    expect(formatRateBp(1_027)).toBe("10,27 %");
    const { unmount } = renderWithIntl(
      <InterestSegments
        segments={[
          {
            from: "2026-01-01",
            to: "2026-06-30",
            days: 181,
            principalCents: 100_000,
            rateBp: 1_027,
            amountCents: 5_093,
          },
        ]}
        totalCents={5_093}
      />,
    );
    const table = screen.getByTestId("interest-segments");
    expect(within(table).getAllByText("01.01.2026 – 30.06.2026")).toHaveLength(2);
    expect(within(table).getAllByText("10,27 %").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("50,93 €").length).toBeGreaterThan(1);
    expect(within(table).getAllByText("1.000,00 €").length).toBeGreaterThan(0);
    unmount();
    renderWithIntl(<InterestSegments segments={[]} />);
    expect(screen.queryByTestId("interest-segments")).toBeNull();
  });

  test("DUN-058 „Exportieren ▾“ exports the reminder PDF", async () => {
    const user = userEvent.setup();
    backend.mutations["documentArtifacts:exportFiles"] = vi.fn().mockResolvedValue({ files: [], zipName: null });
    renderWithIntl(<ReminderExportMenu id="rem1" />);
    await user.click(screen.getByTestId("reminder-export"));
    await user.click(await screen.findByRole("menuitem", { name: "PDF" }));
    await waitFor(() =>
      expect(backend.mutations["documentArtifacts:exportFiles"]).toHaveBeenCalledWith({
        id: "rem1",
        request: { entry: "pdf" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Export heruntergeladen.");
  });

  test("DUN-058 channel „Sonstiges“ needs a note; validation reports are not offered as handed-over files", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = detail("2026-10-15");
    renderWithIntl(<ReminderMarkSentDialog id="rem1" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Mahnung MA-2026-0003 als versendet markieren" });
    expect(within(dialog).getByRole("checkbox", { name: /MA-2026-0003\.pdf · PDF \(Original\)/ })).toBeChecked();
    expect(within(dialog).queryByText(/report\.pdf/)).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText("Kanal"), "post");
    expect(within(dialog).getByText(/Bei Post gilt die Mahnung/)).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Kanal"), "other");
    const confirm = within(dialog).getByRole("button", { name: "Als versendet markieren" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Notiz (Pflicht bei „Sonstiges“)"), "Fax");
    await user.click(confirm);
    await waitFor(() =>
      expect(backend.mutations["invoices:markSent"]).toHaveBeenCalledWith({
        id: "rem1",
        values: { sentOn: "2026-10-16", channel: "other", note: "Fax", artifactIds: ["a1"] },
      }),
    );
  });

  test("DUN-056 „Gegenstandslos setzen und neu erstellen“ withdraws without notice and re-issues the same level", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    backend.data["dunning:reminder"] = detail("2026-10-01");
    backend.mutations["dunning:createReminder"] = vi.fn().mockResolvedValue({ id: "rem9" });
    renderWithIntl(<ReminderMarkSentDialog id="rem1" onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Gegenstandslos setzen und neu erstellen" }));
    await waitFor(() => expect(backend.push).toHaveBeenCalledWith("/mahnungen/rem9"));
    expect(backend.mutations["dunning:withdraw"]).toHaveBeenCalledWith({
      id: "rem1",
      values: {
        reason: "Versand mehr als 3 Tage nach dem Mahndatum – Frist im Schreiben zu kurz, Mahnung neu erstellt.",
      },
    });
    expect(backend.mutations["dunning:createReminder"]).toHaveBeenCalledWith({
      invoiceId: "inv1",
      values: { level: 2 },
    });
    expect(onClose).toHaveBeenCalled();
    expect(backend.mutations["invoices:markSent"]).not.toHaveBeenCalled();
  });
});
