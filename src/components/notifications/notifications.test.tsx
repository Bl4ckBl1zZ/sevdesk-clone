import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { NotificationBell, NotificationCenter } from "./notification-center";
import { NotificationSettings } from "./notification-settings";

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
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ ok: true, message: "Testnachricht gesendet." });
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NOW = Date.UTC(2026, 9, 12, 10);
const n = (over: Record<string, unknown>) => ({
  id: `n-${String(over.title)}`,
  kind: "backup.stale",
  kindLabel: "Datensicherung veraltet",
  severity: "error",
  title: "Titel",
  body: null,
  link: null,
  count: 1,
  createdAt: NOW,
  readAt: null,
  resolvedAt: null,
  ...over,
});
const channels = (inApp: boolean, email: boolean, ntfy: boolean, digest: boolean) => ({ inApp, email, ntfy, digest });

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "notifications:unreadCount": 2,
    "notifications:list": [
      n({ title: "Letzte Datenbanksicherung vor 30 Stunden.", count: 4, link: "/einstellungen/system/backups" }),
      n({
        title: "Zahlung über 1.190,00 € erfasst",
        kind: "payment.received",
        kindLabel: "Zahlung eingegangen",
        severity: "info",
      }),
      n({ title: "Alt", severity: "warning", readAt: NOW }),
    ],
    "notifications:settings": {
      rows: [
        {
          kind: "integrity.failed",
          label: "Integritätsprüfung fehlgeschlagen",
          severity: "critical",
          locked: true,
          defaults: channels(true, true, true, false),
          channels: channels(true, true, true, false),
        },
        {
          kind: "backup.stale",
          label: "Datensicherung veraltet",
          severity: "error",
          locked: false,
          defaults: channels(true, true, true, false),
          channels: channels(true, true, true, false),
        },
      ],
      email: "alarm@firma.de",
      ntfy: { serverUrl: "https://ntfy.sh", topic: "firma", hasToken: true, sendDetails: false, failures: 3 },
      ntfyIsPublic: true,
    },
  };
});

describe("bell and notification list (NTF-001)", () => {
  test("NTF-001 the bell shows the unread count in its accessible name", () => {
    renderWithIntl(<NotificationBell label="Benachrichtigungen" />);
    expect(screen.getByRole("link", { name: "Benachrichtigungen, 2 ungelesen" })).toHaveAttribute(
      "href",
      "/benachrichtigungen",
    );
    expect(screen.getByTestId("notification-count")).toHaveTextContent("2");
  });

  test("NTF-001 NTF-006 the list shows severity, counter and link; read one and „Alle als gelesen markieren“", async () => {
    renderWithIntl(<NotificationCenter />);
    const list = screen.getByRole("list", { name: "Benachrichtigungen" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByText("4× aufgetreten")).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByRole("link", { name: /Datenbanksicherung/ })).toHaveAttribute(
      "href",
      "/einstellungen/system/backups",
    );
    expect(within(items[2] as HTMLElement).queryByRole("button", { name: /als gelesen markieren/ })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "„Zahlung über 1.190,00 € erfasst“ als gelesen markieren" }),
    );
    expect(backend.mutations["notifications:markRead"]).toHaveBeenCalledWith({
      id: "n-Zahlung über 1.190,00 € erfasst",
    });
    await userEvent.click(screen.getByRole("button", { name: "Alle als gelesen markieren" }));
    expect(backend.mutations["notifications:markAllRead"]).toHaveBeenCalledWith({});
    expect(toast.success).toHaveBeenCalledWith("Alle Benachrichtigungen als gelesen markiert.");
  });
});

describe("notification settings (NTF-002, NTF-004)", () => {
  test("NTF-002 critical kinds cannot be unticked for app and e-mail; other kinds save the new matrix row", async () => {
    renderWithIntl(<NotificationSettings />);
    expect(screen.getByRole("checkbox", { name: "Integritätsprüfung fehlgeschlagen: E-Mail" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Integritätsprüfung fehlgeschlagen: In der App" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Integritätsprüfung fehlgeschlagen: ntfy" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Datensicherung veraltet: E-Mail" }));
    expect(backend.mutations["notifications:setChannels"]).toHaveBeenCalledWith({
      kind: "backup.stale",
      channels: channels(true, false, true, false),
    });
  });

  test("NTF-004 DSGVO-04 ntfy.sh is flagged as an external service; failures and „Details senden“ are explained", async () => {
    renderWithIntl(<NotificationSettings />);
    expect(screen.getByRole("note")).toHaveTextContent("ntfy.sh ist ein externer Dienst");
    expect(screen.getByRole("alert")).toHaveTextContent("ntfy-Benachrichtigungen konnten nicht zugestellt werden.");
    expect(screen.getByRole("checkbox", { name: "Details senden" })).not.toBeChecked();
    await userEvent.type(screen.getByLabelText("Zugangstoken (optional)"), "neu");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(backend.mutations["notifications:saveNtfy"]).toHaveBeenCalledWith({
      ntfy: { serverUrl: "https://ntfy.sh", topic: "firma", token: "neu", sendDetails: false },
    });
    await userEvent.click(screen.getByRole("button", { name: "Test senden" }));
    expect(toast.success).toHaveBeenCalledWith("Testnachricht gesendet.");
  });

  test("SET-048 a non-EU ntfy server shows the region warning after saving", async () => {
    backend.mutations["notifications:saveNtfy"] = vi
      .fn()
      .mockResolvedValue({ warning: "ntfy (ntfy.sh) verarbeitet Daten außerhalb der EU." });
    renderWithIntl(<NotificationSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(
      screen.getAllByRole("alert").some((a) => a.textContent?.includes("ntfy (ntfy.sh) verarbeitet Daten außerhalb")),
    ).toBe(true);
  });
});
