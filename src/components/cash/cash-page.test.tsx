import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { CashPage } from "./cash-page";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  args: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  query: vi.fn(),
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    const name = getFunctionName(ref as never);
    backend.args[name] = args;
    return backend.data[name];
  },
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({});
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn, useConvex: () => ({ query: backend.query }) };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const overview = (over: Record<string, unknown> = {}) => ({
  balanceCents: 45_000,
  account: "1000 Kasse",
  today: "2026-10-16",
  bankAccounts: [
    { id: "ba1", name: "Revolut Business" },
    { id: "ba2", name: "Sparkasse" },
  ],
  rows: [
    {
      entryId: "j1",
      seq: 1,
      date: "2026-10-01",
      voucher: "RE-2026-0040",
      text: "Barzahlung Muster",
      inCents: 50_000,
      outCents: 0,
      balanceCents: 50_000,
    },
    {
      entryId: "j2",
      seq: 1,
      date: "2026-10-05",
      voucher: "EB-2026-0001",
      text: "Privatentnahme",
      inCents: 0,
      outCents: 5_000,
      balanceCents: 45_000,
    },
  ],
  transfers: [
    {
      id: "ct1",
      kind: "private_withdrawal",
      amountCents: 5_000,
      date: "2026-10-05",
      note: "Taschengeld",
      eigenbeleg: { url: "https://files/eb1.pdf" },
      reversed: false,
      reversalOfId: null,
      fromBank: false,
    },
    {
      id: "ct0",
      kind: "deposit_to_bank",
      amountCents: 10_000,
      date: "2026-09-20",
      note: null,
      eigenbeleg: null,
      reversed: true,
      reversalOfId: null,
      fromBank: false,
    },
    {
      id: "ct2",
      kind: "deposit_to_bank",
      amountCents: 10_000,
      date: "2026-09-21",
      note: null,
      eigenbeleg: null,
      reversed: false,
      reversalOfId: "ct0",
      fromBank: false,
    },
  ],
  ...over,
});

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" }, "cash:overview": overview() };
  backend.args = {};
  backend.mutations = {};
  backend.query = vi.fn();
  vi.clearAllMocks();
});

describe("Kasse (F07 §6)", () => {
  test("CSH-029 loading is busy; an empty till shows the no-POS notice and „Noch keine Barbewegungen“", () => {
    backend.data["cash:overview"] = undefined;
    const { container, unmount } = renderWithIntl(<CashPage />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["cash:overview"] = overview({ balanceCents: 0, rows: [], transfers: [], account: null });
    renderWithIntl(<CashPage />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    expect(screen.getByTestId("cash-balance")).toHaveTextContent("0,00 €");
    expect(screen.getByText("Noch keine Barbewegungen.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Einzahlungen und Entnahmen" })).toBeNull();
  });

  test("CSH-020 balance, account and movements with running balance; transfers with Eigenbeleg and status", () => {
    renderWithIntl(<CashPage />);
    expect(screen.getByTestId("cash-balance")).toHaveTextContent("450,00 €");
    expect(screen.getByText("Konto 1000 Kasse")).toBeInTheDocument();
    const [, first, second] = within(screen.getByRole("table")).getAllByRole("row");
    expect(first).toHaveTextContent("01.10.2026");
    expect(first).toHaveTextContent("RE-2026-0040");
    expect(first).toHaveTextContent("500,00 €");
    expect(second).toHaveTextContent("50,00 €");
    expect(second).toHaveTextContent("450,00 €");
    expect(screen.getByText("−50,00 €")).toBeInTheDocument();
    const transfers = within(screen.getByRole("region", { name: "Einzahlungen und Entnahmen" })).getAllByRole(
      "listitem",
    );
    expect(transfers[0]).toHaveTextContent("Privatentnahme · 50,00 €");
    expect(transfers[0]).toHaveTextContent("05.10.2026 · Taschengeld");
    expect(within(transfers[0] as HTMLElement).getByRole("link", { name: "Eigenbeleg" })).toHaveAttribute(
      "href",
      "https://files/eb1.pdf",
    );
    expect(transfers[1]).toHaveTextContent("storniert");
    expect(within(transfers[1] as HTMLElement).queryByRole("button")).toBeNull();
    expect(transfers[2]).toHaveTextContent("Storno: Einzahlung auf die Bank · 100,00 €");
    expect(within(transfers[2] as HTMLElement).queryByRole("button")).toBeNull();
  });

  test("CSH-027 a cash transfer is reversed with a reason of at least 5 characters", async () => {
    const user = userEvent.setup();
    renderWithIntl(<CashPage />);
    await user.click(screen.getByRole("button", { name: "Stornieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Barbewegung stornieren" });
    const confirm = within(dialog).getByRole("button", { name: "Stornieren" });
    await user.type(within(dialog).getByLabelText("Grund"), "Irr");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Grund"), "tum");
    await user.click(confirm);
    await waitFor(() =>
      expect(backend.mutations["cash:reverseTransfer"]).toHaveBeenCalledWith({ id: "ct1", reason: "Irrtum" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Barbewegung storniert.");
  });

  test("CSH-024 CSH-026 a deposit shows the never-negative projection and is recorded with the bank account", async () => {
    const user = userEvent.setup();
    backend.data["cash:project"] = { ok: true, minBalanceCents: 25_000, minDate: "2026-10-16" };
    backend.mutations["cash:recordTransfer"] = vi.fn().mockResolvedValue({ warning: "Beleg bitte nachreichen." });
    renderWithIntl(<CashPage />);
    await user.click(screen.getByRole("button", { name: "Bargeld eingezahlt / entnommen" }));
    const dialog = await screen.findByRole("dialog", { name: "Bargeld eingezahlt / entnommen" });
    fireEvent.change(within(dialog).getByLabelText(/^Betrag/), { target: { value: "200,00" } });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Niedrigster Kassenbestand danach: 250,00 € am 16.10.2026",
    );
    expect(backend.args["cash:project"]).toEqual({ date: "2026-10-16", amountCents: 20_000 });
    await user.selectOptions(within(dialog).getByLabelText(/^Bankkonto/), "ba2");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.mutations["cash:recordTransfer"]).toHaveBeenCalledWith({
        kind: "deposit_to_bank",
        date: "2026-10-16",
        amountCents: 20_000,
        bankAccountId: "ba2",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Barbewegung gebucht, Eigenbeleg archiviert.");
    expect(toast.warning).toHaveBeenCalledWith("Beleg bitte nachreichen.");
  });

  test("CSH-026 a withdrawal that would make the till negative is flagged; shareholder fields appear", async () => {
    const user = userEvent.setup();
    backend.data["cash:project"] = { ok: false, minBalanceCents: -5_000, minDate: "2026-10-05" };
    renderWithIntl(<CashPage />);
    await user.click(screen.getByRole("button", { name: "Bargeld eingezahlt / entnommen" }));
    const dialog = await screen.findByRole("dialog", { name: "Bargeld eingezahlt / entnommen" });
    await user.click(within(dialog).getByRole("radio", { name: /Privatentnahme/ }));
    expect(within(dialog).queryByLabelText(/^Bankkonto/)).toBeNull();
    expect(within(dialog).getByLabelText(/^Gesellschafter/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Betrag/), { target: { value: "500" } });
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Nicht möglich: Der Kassenbestand würde am 05.10.2026 auf −50,00 € fallen.",
    );
  });

  test("CSH-030 the Kassenbericht downloads the CSV for the chosen period", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    backend.query = vi.fn().mockResolvedValue({ csv: "Datum;Betrag" });
    renderWithIntl(<CashPage />);
    await user.click(screen.getByRole("button", { name: "Bericht (CSV)" }));
    const dialog = await screen.findByRole("dialog", { name: "Kassenbericht" });
    expect(within(dialog).getByLabelText("Von")).toHaveValue("2026-10-01");
    fireEvent.change(within(dialog).getByLabelText("Von"), { target: { value: "2026-09-01" } });
    await user.click(within(dialog).getByRole("button", { name: "Herunterladen" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(backend.query).toHaveBeenCalledWith(expect.anything(), { from: "2026-09-01", to: "2026-10-16" });
    expect(createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });

  test("CSH-024 a viewer cannot record or reverse cash transfers but may download the report", () => {
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<CashPage />);
    expect(screen.queryByRole("button", { name: "Bargeld eingezahlt / entnommen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stornieren" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bericht (CSV)" })).toBeInTheDocument();
  });
});
