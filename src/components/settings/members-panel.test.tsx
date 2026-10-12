import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { IntegrityBanner } from "../shell/integrity-banner";
import { MembersPanel } from "./members-panel";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NOW = Date.UTC(2026, 9, 12, 10);
const member = (over: Record<string, unknown>) => ({
  memberId: `m-${String(over.email)}`,
  name: null,
  createdAt: NOW,
  expiresAt: null,
  disabledAt: null,
  access: "active",
  totpEnabled: false,
  hasPasskey: false,
  lastSignInAt: null,
  ...over,
});

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  toast.error.mockReset();
  backend.data = {
    "members:list": [
      member({ email: "inhaber@firma.de", role: "owner", hasPasskey: true, totpEnabled: true, lastSignInAt: NOW }),
      member({ email: "buch@firma.de", role: "bookkeeper" }),
    ],
    "invites:list": [
      {
        inviteId: "i1",
        email: "neu@firma.de",
        role: "viewer",
        createdAt: NOW,
        expiresAt: NOW + 7 * 86_400_000,
        memberExpiresAt: null,
        auditor: null,
        sentAt: null,
        mailOutcome: "failed",
        status: "open",
      },
      { inviteId: "i2", email: "alt@firma.de", role: "viewer", status: "accepted", expiresAt: NOW, sentAt: NOW },
    ],
  };
});

describe("/einstellungen/mitglieder (04 §4.10)", () => {
  test("SEC-01 the owner row has no actions; other members can be deactivated with a reason", async () => {
    renderWithIntl(<MembersPanel />);
    // Table and card layout both render the actions for the bookkeeper only (CSS decides which is visible).
    const triggers = screen.getAllByRole("button", { name: /Aktionen für/ });
    expect(triggers.every((b) => b.getAttribute("aria-label")?.includes("buch@firma.de"))).toBe(true);
    expect(screen.queryByRole("button", { name: /inhaber@firma\.de/ })).toBeNull();
    await userEvent.click(triggers[0] as HTMLElement);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Deaktivieren" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Grund (optional)"), "ausgeschieden");
    await userEvent.click(within(dialog).getByRole("button", { name: "Deaktivieren" }));
    await waitFor(() =>
      expect(backend.mutations["members:disable"]).toHaveBeenCalledWith({
        memberId: "m-buch@firma.de",
        reason: "ausgeschieden",
      }),
    );
  });

  test("SEC-01 „Rolle ändern“ offers only the other staff role and calls members.changeRole", async () => {
    renderWithIntl(<MembersPanel />);
    await userEvent.click(screen.getAllByRole("button", { name: /Aktionen für buch@firma\.de/ })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rolle ändern" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText("Neue Rolle");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Lesezugriff"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Rolle ändern" }));
    await waitFor(() =>
      expect(backend.mutations["members:changeRole"]).toHaveBeenCalledWith({
        memberId: "m-buch@firma.de",
        role: "viewer",
      }),
    );
  });

  test("AUD-022 „Verlängern“ of an auditor requires a reason field and sends the new expiry", async () => {
    backend.data["members:list"] = [
      member({ email: "pruefer@finanzamt.de", role: "auditor", expiresAt: NOW + 86_400_000 }),
    ];
    renderWithIntl(<MembersPanel />);
    await userEvent.click(screen.getAllByRole("button", { name: /Aktionen für/ })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Verlängern" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Unbefristet/)).toBeNull();
    expect(within(dialog).getByLabelText(/Grund/)).toBeRequired();
    await userEvent.type(within(dialog).getByLabelText(/Grund/), "Prüfung dauert an");
    await userEvent.click(within(dialog).getByRole("button", { name: "Verlängern" }));
    await waitFor(() =>
      expect(backend.mutations["members:extend"]).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: "m-pruefer@finanzamt.de", reason: "Prüfung dauert an" }),
      ),
    );
  });

  test("SEC-02 „Sitzungen abmelden“ confirms and calls members.revokeSessions", async () => {
    renderWithIntl(<MembersPanel />);
    await userEvent.click(screen.getAllByRole("button", { name: /Aktionen für buch@firma\.de/ })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sitzungen abmelden" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sitzungen abmelden" }));
    await waitFor(() =>
      expect(backend.mutations["members:revokeSessions"]).toHaveBeenCalledWith({ memberId: "m-buch@firma.de" }),
    );
  });

  test("SET-107 open invites show a failed mail in German and offer resend/revoke; accepted ones are hidden", async () => {
    renderWithIntl(<MembersPanel />);
    expect(screen.getByText(/Die Einladungs-E-Mail konnte nicht gesendet werden/)).toBeInTheDocument();
    expect(screen.queryByText("alt@firma.de")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Zurückziehen/ }));
    await waitFor(() => expect(backend.mutations["invites:revoke"]).toHaveBeenCalledWith({ inviteId: "i1" }));
  });

  test("AUD-022 an auditor invite needs „Gültig bis“, Aktenzeichen and a Wirtschaftsjahr before it is sent", async () => {
    renderWithIntl(<MembersPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Person einladen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/E-Mail-Adresse/), "pruefer@finanzamt.de");
    await userEvent.selectOptions(within(dialog).getByLabelText(/Rolle/), "auditor");
    await userEvent.click(within(dialog).getByRole("button", { name: "Einladung senden" }));
    expect(await within(dialog).findByText("Für einen Prüferzugang ist ein Ablaufdatum erforderlich.")).toBeVisible();
    expect(within(dialog).getByText("Bitte mindestens ein Wirtschaftsjahr auswählen.")).toBeVisible();
    expect(backend.mutations["invites:create"]).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Gerät im Tailnet/)).toBeInTheDocument();
  });
});

describe("integrity banner (F12 AUD-015)", () => {
  const failed = {
    finalisationBlocked: true,
    lastRun: {
      id: "run1",
      at: NOW,
      ok: false,
      scope: "incremental",
      lastVerifiedSeq: 41,
      findings: [{ kind: "hash_mismatch", severity: "error", detail: "Hash weicht ab", firstBrokenSeq: 42 }],
      acknowledgedAt: null,
    },
  };

  test("AUD-015 a failed run blocks finalising; only the owner can acknowledge it with a note", async () => {
    backend.data["members:me"] = { role: "owner" };
    backend.data["integrity:status"] = failed;
    renderWithIntl(<IntegrityBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Integritätsprüfung fehlgeschlagen: hash_mismatch (seq 42). Neue Rechnungen sind bis zur Bestätigung gesperrt.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Bestätigen …" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Notiz"), "Admin-Zugriff geprüft, Ursache behoben");
    await userEvent.click(within(dialog).getByRole("button", { name: "Bestätigen" }));
    await waitFor(() =>
      expect(backend.mutations["integrity:acknowledge"]).toHaveBeenCalledWith({
        runId: "run1",
        note: "Admin-Zugriff geprüft, Ursache behoben",
      }),
    );
  });

  test("AUD-015 a bookkeeper sees the banner without the acknowledge action; viewers see nothing", () => {
    backend.data["members:me"] = { role: "bookkeeper" };
    backend.data["integrity:status"] = failed;
    const { unmount } = renderWithIntl(<IntegrityBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<IntegrityBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
