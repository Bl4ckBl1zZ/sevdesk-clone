import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BankOverview } from "./bank-overview";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return null;
  };
  return { useMutation: fn, useAction: fn };
});
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const account = (over: Record<string, unknown> = {}) => ({
  id: "acc1",
  name: "Revolut EUR",
  kind: "bank",
  currency: "EUR",
  iban: "DE89370400440532013000",
  ledgerAccount: "1200",
  openCount: 3,
  lastBookingDate: "2026-09-30",
  possibleDuplicates: 2,
  lastStatement: {
    id: "st1",
    periodFrom: "2026-09-01",
    periodTo: "2026-09-30",
    closingBalanceCents: 219_000,
    reconciled: true,
    hasPdf: false,
  },
  ...over,
});

beforeEach(() => {
  backend.calls = [];
  backend.data = {
    "members:me": { role: "owner" },
    "banking:accounts": [
      account(),
      account({
        id: "acc2",
        name: "Revolut USD",
        currency: "USD",
        iban: null,
        lastStatement: null,
        openCount: 0,
        possibleDuplicates: 0,
      }),
    ],
    "banking:todos": [
      {
        accountId: "acc1",
        accountName: "Revolut EUR",
        month: "2026-09",
        kind: "statement",
        severity: "warning",
        title: "Kontoauszug September 2026 importieren",
      },
    ],
    "banking:possibleDuplicates": [],
    "bankFeed:connection": {
      status: "reauth_required",
      lastError: "Zustimmung abgelaufen – bitte neu verbinden.",
      feedLostMessage: null,
      statusLabel: "Neu verbinden",
      banner: null,
    },
  };
});

describe("BankOverview (F07 §6)", () => {
  test("BNK-030 shows the statement to-do, the account cards with the last statement and the duplicates count", () => {
    renderWithIntl(<BankOverview />);
    expect(screen.getByRole("heading", { name: "Zu erledigen" })).toBeInTheDocument();
    expect(screen.getByText("Kontoauszug September 2026 importieren")).toBeInTheDocument();
    const eur = screen.getByRole("link", { name: /Revolut EUR/ });
    expect(eur).toHaveAttribute("href", "/bank/acc1");
    expect(within(eur).getByText(/Endsaldo 30\.09\.2026: 2\.190,00\s€/)).toBeInTheDocument();
    expect(within(eur).getByText("abgestimmt")).toBeInTheDocument();
    expect(within(eur).getByText("PDF fehlt")).toBeInTheDocument();
    expect(within(eur).getByText("3 offene Umsätze · 2 mögliche Dubletten")).toBeInTheDocument();
    const usd = screen.getByRole("link", { name: /Revolut USD/ });
    expect(within(usd).getByText("ohne eigene IBAN")).toBeInTheDocument();
    expect(within(usd).getByText("Noch kein Kontoauszug importiert.")).toBeInTheDocument();
    expect(within(usd).getByText("Keine offenen Umsätze")).toBeInTheDocument();
  });

  test("BNK-105 the connection banner shows the reauth error with the reconnect link", () => {
    renderWithIntl(<BankOverview />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Zustimmung abgelaufen – bitte neu verbinden.");
    expect(within(banner).getByRole("link", { name: "Neu verbinden" })).toHaveAttribute(
      "href",
      "/einstellungen/bank/verbindung",
    );
  });

  test("BNK-001 „Konto anlegen“ creates a currency account from the form values", async () => {
    renderWithIntl(<BankOverview />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Konto anlegen" }));
    const dialog = screen.getByRole("dialog", { name: "Bankkonto anlegen" });
    await user.type(within(dialog).getByLabelText(/^Name/), "Revolut GBP");
    await user.selectOptions(within(dialog).getByLabelText(/^Währung/), "GBP");
    await user.type(within(dialog).getByLabelText(/^Kontoinhaber/), "Muster GmbH");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(backend.calls.some((c) => c.name === "banking:createAccount")).toBe(true));
    expect(backend.calls.find((c) => c.name === "banking:createAccount")?.args).toMatchObject({
      values: { kind: "bank", name: "Revolut GBP", currency: "GBP", accountHolder: "Muster GmbH" },
    });
  });

  test("BNK-030 „Kontoauszug importieren“ opens the import dialog for owners only", async () => {
    const { unmount } = renderWithIntl(<BankOverview />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Kontoauszug importieren" }));
    expect(screen.getByRole("dialog", { name: "Kontoauszug importieren" })).toBeInTheDocument();
    unmount();
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<BankOverview />);
    expect(screen.queryByRole("button", { name: "Kontoauszug importieren" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Konto anlegen" })).toBeNull();
    expect(screen.getByRole("link", { name: /Zuordnungen prüfen/ })).toHaveAttribute("href", "/bank/zuordnungen");
  });

  test("BNK-001 without accounts the empty state asks for one account per currency", () => {
    backend.data["banking:accounts"] = [];
    backend.data["banking:todos"] = [];
    backend.data["bankFeed:connection"] = {
      status: "connected",
      banner: { message: "Zustimmung läuft in 14 Tagen ab." },
    };
    renderWithIntl(<BankOverview />);
    expect(screen.getByText(/Noch kein Bankkonto angelegt/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Zustimmung läuft in 14 Tagen ab.");
    expect(screen.queryByRole("heading", { name: "Zu erledigen" })).toBeNull();
  });
});
