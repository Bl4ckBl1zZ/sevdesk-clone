import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BankConnectionView, type ConnectionView } from "./bank-connection";

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
        } as Partial<ConnectionView>)}
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
});
