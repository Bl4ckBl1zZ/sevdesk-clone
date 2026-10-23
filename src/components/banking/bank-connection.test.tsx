import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BankConnectionPanel, BankConnectionView, type ConnectionView } from "./bank-connection";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls[name] ??= vi.fn().mockResolvedValue({
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----",
      redirectUrl: "x",
    });
    return backend.calls[name];
  };
  return { useMutation: fn, useAction: fn };
});
const sync = vi.hoisted(() => ({ syncNowAction: vi.fn() }));
vi.mock("@/app/(app)/(shell)/einstellungen/bank/verbindung/actions", () => sync);
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCan: () => true,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const REDIRECT = "https://app.example.org/einstellungen/bank/callback";

function view(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    status: "not_configured",
    statusLabel: "Nicht eingerichtet",
    configured: false,
    environment: "production",
    applicationId: null,
    keyStored: false,
    keySource: null,
    publicKeyPem: null,
    redirectUrl: REDIRECT,
    aspsp: null,
    validUntil: null,
    remindersSent: [],
    validity: null,
    banner: null,
    lastSuccessfulPollAt: null,
    nextPollAt: null,
    lastError: null,
    backfill: null,
    pendingAccounts: [],
    feedLost: null,
    feedLostMessage: null,
    sandboxNotice: null,
    confirmation: { status: "pending", label: "ausstehend", recordedAt: null, note: null, fileName: null },
    evaluationNotice: null,
    checklist: [
      { step: "app", label: "Anwendung im Enable Banking Control Panel (eingeschränkter Modus) anlegen", done: false },
      { step: "key", label: "Schlüsselpaar erzeugen oder privaten Schlüssel hochladen", done: false },
    ],
    accounts: [],
    ...over,
  } as ConnectionView;
}

beforeEach(() => {
  backend.data = { "banking:accounts": [] };
  backend.calls = {};
  vi.clearAllMocks();
});

describe("Einstellungen › Bank › Verbindung (SET-049, SET-049a, BNK-101)", () => {
  test("SET-049 BNK-101 „Bank verbinden“ stays disabled until application ID and key are stored; the redirect URL can be copied", () => {
    renderWithIntl(<BankConnectionView view={view()} canSetup canFetch />);
    expect(screen.getByRole("button", { name: "Bank verbinden" })).toBeDisabled();
    expect(
      screen.getByText("Erst Anwendungs-ID und Schlüssel speichern, dann kann die Bank verbunden werden."),
    ).toBeVisible();
    expect(screen.getByText(REDIRECT)).toBeVisible();
    expect(screen.getByRole("button", { name: "Weiterleitungs-URL kopieren" })).toBeVisible();
    expect(screen.getAllByText(/\(offen\)/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Jetzt abrufen" })).toBeNull();
  });

  test("BNK-101 BNK-013 saving generates the key pair server-side and only the public key is shown", async () => {
    const user = userEvent.setup();
    renderWithIntl(<BankConnectionView view={view()} canSetup canFetch />);
    const save = screen.getByRole("button", { name: "Einrichtung speichern" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Anwendungs-ID"), "1f3c0000-aaaa-bbbb-cccc-000000000001");
    await user.click(save);
    expect(backend.calls["bankFeedNode:saveSetup"]).toHaveBeenCalledWith({
      applicationId: "1f3c0000-aaaa-bbbb-cccc-000000000001",
      environment: "production",
      generateKey: true,
    });
    expect(await screen.findByText(/BEGIN PUBLIC KEY/)).toBeVisible();
    expect(screen.queryByText(/PRIVATE KEY-----\n/)).toBeNull();
  });

  test("SET-049a T-SET-104 the status card shows validity and polls; „Jetzt abrufen“ runs the Server Action", async () => {
    sync.syncNowAction.mockResolvedValue({ ok: true, result: { skipped: null, accounts: [{ inserted: 3 }] } });
    const user = userEvent.setup();
    renderWithIntl(
      <BankConnectionView
        view={view({
          status: "active",
          statusLabel: "Verbunden",
          configured: true,
          applicationId: "1f3c0000-aaaa-bbbb-cccc-000000000001",
          keyStored: true,
          validity: "gültig bis 17.04.2027, noch 180 Tage",
          aspsp: { name: "Revolut", country: "LT" },
          accounts: [
            {
              id: "acc1",
              name: "Revolut EUR",
              currency: "EUR",
              iban: "LT12",
              linked: true,
              missing: false,
              lastPolledAt: null,
              unattendedToday: 2,
              unattendedLimit: 4,
              remaining: 2,
              backoffUntil: null,
              pending: 1,
            },
          ],
        } as unknown as Partial<ConnectionView>)}
        canSetup
        canFetch
      />,
    );
    expect(screen.getByText("gültig bis 17.04.2027, noch 180 Tage")).toBeVisible();
    expect(screen.getByRole("button", { name: "Neu verbinden" })).toBeEnabled();
    expect(screen.getByText("2/4")).toBeVisible();
    expect(screen.getByText("1 vorgemerkter Umsatz")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Jetzt abrufen" }));
    expect(sync.syncNowAction).toHaveBeenCalled();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("3 neue Umsätze abgerufen."));
  });

  test("BNK-011 „Trennen“ revokes the session; with lost access a reason is required (BNK-117)", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <BankConnectionView
        view={view({ status: "active", statusLabel: "Verbunden", configured: true, keyStored: true })}
        canSetup
        canFetch
      />,
    );
    await user.click(screen.getByRole("button", { name: "Trennen" }));
    const dialog = screen.getByRole("dialog", { name: "Bankanbindung trennen" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Privaten Schlüssel ebenfalls löschen" }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Zugang dauerhaft verloren/ }));
    const confirm = within(dialog).getByRole("button", { name: "Trennen" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Grund"), "eingeschränkter Modus beendet");
    await user.click(confirm);
    expect(backend.calls["bankFeedNode:disconnect"]).toHaveBeenCalledWith({
      deleteKey: true,
      feedLost: "eingeschränkter Modus beendet",
    });
  });

  test("BNK-101 an uploaded PEM key is sent only when it looks like a private key", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <BankConnectionView
        view={view({ applicationId: "1f3c0000-aaaa-bbbb-cccc-000000000001", keyStored: true, configured: true })}
        canSetup
        canFetch
      />,
    );
    expect(screen.getByRole("radio", { name: "Gespeicherten Schlüssel behalten" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Vorhandenen privaten Schlüssel hochladen/ }));
    const save = screen.getByRole("button", { name: "Einrichtung speichern" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Privater Schlüssel (PEM)"), "-----BEGIN PRIVATE KEY-----");
    await user.selectOptions(screen.getByLabelText("Umgebung"), "sandbox");
    await user.click(save);
    expect(backend.calls["bankFeedNode:saveSetup"]).toHaveBeenCalledWith({
      applicationId: "1f3c0000-aaaa-bbbb-cccc-000000000001",
      environment: "sandbox",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----",
    });
  });

  test("BNK-104 a new consent account is mapped to an existing account of the same currency", async () => {
    backend.data = {
      "banking:accounts": [
        { id: "acc1", name: "Revolut EUR", kind: "bank", currency: "EUR" },
        { id: "acc2", name: "Revolut USD", kind: "bank", currency: "USD" },
      ],
    };
    const user = userEvent.setup();
    renderWithIntl(
      <BankConnectionView
        view={view({
          status: "active",
          configured: true,
          pendingAccounts: [
            {
              uid: "u1",
              message: "Neues EUR-Konto in der Zustimmung",
              iban: null,
              localDetails: [{ scheme: "SORT", identification: "04-00-75" }],
              currency: "EUR",
              name: "Main",
              printable: false,
            },
          ],
        } as unknown as Partial<ConnectionView>)}
        canSetup
        canFetch
      />,
    );
    expect(screen.getByText("Neues EUR-Konto in der Zustimmung")).toBeVisible();
    expect(screen.getByText("SORT 04-00-75 · EUR · Main")).toBeVisible();
    expect(screen.getByText("Ohne eigene IBAN – erscheint nicht auf Rechnungen.")).toBeVisible();
    const select = screen.getByLabelText("Zuordnen zu") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Neues Bankkonto anlegen", "Revolut EUR"]);
    await user.selectOptions(select, "acc1");
    await user.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(backend.calls["bankFeedNode:mapAccount"]).toHaveBeenCalledWith({ uid: "u1", accountId: "acc1" });
  });

  test("BNK-116 the written confirmation of Enable Banking is recorded with status and note", async () => {
    const user = userEvent.setup();
    renderWithIntl(<BankConnectionView view={view()} canSetup canFetch />);
    expect(screen.getByText("ausstehend", { selector: "p" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Status"), "confirmed");
    await user.type(screen.getByLabelText("Vermerk"), "E-Mail vom 01.10.2026");
    await user.click(screen.getByRole("button", { name: "Bestätigung speichern" }));
    expect(backend.calls["bankFeed:recordEvaluationConfirmation"]).toHaveBeenCalledWith({
      status: "confirmed",
      note: "E-Mail vom 01.10.2026",
    });
  });

  test("BNK-107 a skipped or failed „Jetzt abrufen“ shows the error toast", async () => {
    sync.syncNowAction.mockResolvedValueOnce({ ok: true, result: { skipped: "budget", accounts: [] } });
    sync.syncNowAction.mockResolvedValueOnce({ ok: false, message: "Bitte erneut anmelden." });
    const user = userEvent.setup();
    renderWithIntl(
      <BankConnectionView view={view({ status: "active", configured: true })} canSetup={false} canFetch />,
    );
    expect(screen.queryByRole("button", { name: "Trennen" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Jetzt abrufen" }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Der Abruf wurde nicht ausgeführt. Details stehen bei der Verbindung."),
    );
    await user.click(screen.getByRole("button", { name: "Jetzt abrufen" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith("Bitte erneut anmelden."));
  });

  test("SET-049 the panel loads the connection view from Convex", () => {
    backend.data = { "banking:accounts": [], "bankFeed:connection": view() };
    renderWithIntl(<BankConnectionPanel />);
    expect(screen.getByRole("button", { name: "Bank verbinden" })).toBeDisabled();
  });
});
