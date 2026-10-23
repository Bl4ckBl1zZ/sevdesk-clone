import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { WebhooksAdmin } from "./webhooks-admin";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: {} as Record<string, unknown>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
const fn = (name: string) => {
  backend.calls[name] ??= vi.fn().mockResolvedValue(backend.results[name] ?? null);
  return backend.calls[name];
};
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => fn(getFunctionName(ref as never)),
  useAction: (ref: unknown) => fn(getFunctionName(ref as never)),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NOW = Date.UTC(2026, 9, 23, 10);
const endpoint = (over: Record<string, unknown>) => ({
  endpointId: "ep1",
  url: "https://www.firma.de/api/rechnung-webhook",
  description: "Website",
  events: ["invoice.paid", "quote.accepted"],
  enabled: true,
  disabledReason: null,
  disabledAt: null,
  secretHint: "whsec_…abcd",
  secretRollingUntil: null,
  failingSince: null,
  lastSuccessAt: NOW,
  lastFailureAt: null,
  createdAt: NOW,
  ...over,
});
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

beforeEach(() => {
  backend.calls = {};
  backend.results = {
    "webhooks:create": { endpointId: "ep9", secret: SECRET },
    "webhooks:rollSecret": { secret: SECRET, previousValidUntil: NOW + 24 * 3600_000 },
  };
  toast.success.mockReset();
  toast.error.mockReset();
  backend.data = {
    "webhooks:list": [
      endpoint({}),
      endpoint({
        endpointId: "ep2",
        url: "https://n8n.tail1234.ts.net/webhook/x",
        description: null,
        events: ["*"],
        enabled: false,
        disabledReason: "gone",
        lastSuccessAt: null,
        lastFailureAt: NOW,
      }),
    ],
    "webhooks:deliveries": [
      {
        deliveryId: "d1",
        eventId: "evt_abc",
        type: "test.ping",
        status: "failed",
        attempts: 2,
        nextAttemptAt: NOW + 300_000,
        lastAttemptAt: NOW,
        httpStatus: 500,
        error: null,
        durationMs: 120,
        requestSnippet: '{"type":"test.ping"}',
        responseSnippet: "Interner Fehler",
        replayOf: null,
        createdAt: NOW,
      },
    ],
  };
});

describe("/einstellungen/webhooks (05 §5.1)", () => {
  test("API-028 the list shows URL, events or „Alle Ereignisse“, status incl. 410-disable, last delivery and only the secret hint", () => {
    renderWithIntl(<WebhooksAdmin />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const site = rows[1] as HTMLElement;
    expect(site).toHaveTextContent("https://www.firma.de/api/rechnung-webhook");
    expect(site).toHaveTextContent("Website");
    expect(site).toHaveTextContent("2 Ereignisse");
    expect(site).toHaveTextContent("Aktiv");
    expect(site).toHaveTextContent("whsec_…abcd");
    const gone = rows[2] as HTMLElement;
    expect(gone).toHaveTextContent("Alle Ereignisse");
    expect(gone).toHaveTextContent("Deaktiviert (410 Gone)");
    expect(gone).toHaveTextContent("Fehlgeschlagen:");
    // every action button names its endpoint for screen readers
    expect(within(site).getByRole("button", { name: "Test senden (www.firma.de)" })).toBeInTheDocument();
  });

  test("API-028 „Endpunkt hinzufügen“ validates, sends url/events/enabled and shows the whsec_ secret once", async () => {
    const user = userEvent.setup();
    renderWithIntl(<WebhooksAdmin />);
    await user.click(screen.getByRole("button", { name: "Endpunkt hinzufügen" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "Alle Ereignisse" }));
    await user.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(within(dialog).getByText("Bitte eine URL angeben.")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Bitte mindestens ein Ereignis oder „Alle Ereignisse“ wählen."),
    ).toBeInTheDocument();
    expect(backend.calls["webhooks:create"]).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/^URL/), "https://hooks.example.com/h");
    await user.click(within(dialog).getByRole("checkbox", { name: "invoice.paid" }));
    await user.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    await waitFor(() =>
      expect(backend.calls["webhooks:create"]).toHaveBeenCalledWith({
        values: { url: "https://hooks.example.com/h", events: ["invoice.paid"], enabled: true },
      }),
    );
    const shown = await screen.findByRole("dialog", { name: "Endpunkt angelegt" });
    expect(within(shown).getByLabelText("Secret")).toHaveValue(SECRET);
    expect(shown).toHaveTextContent(`Später sehen Sie nur noch whsec_…${SECRET.slice(-4)}.`);
  });

  test("API-028 „Secret erneuern“ shows the new secret and the 24 h overlap; „Test senden“ queues test.ping", async () => {
    const user = userEvent.setup();
    renderWithIntl(<WebhooksAdmin />);
    const site = within(screen.getByRole("table")).getAllByRole("row")[1] as HTMLElement;
    await user.click(within(site).getByRole("button", { name: "Test senden (www.firma.de)" }));
    await waitFor(() => expect(backend.calls["webhooks:sendTest"]).toHaveBeenCalledWith({ endpointId: "ep1" }));
    expect(toast.success).toHaveBeenCalledWith("Test-Ereignis wird gesendet.");

    await user.click(within(site).getByRole("button", { name: "Secret erneuern (www.firma.de)" }));
    await user.click(screen.getByRole("button", { name: "Neues Secret erzeugen" }));
    const shown = await screen.findByRole("dialog", { name: "Neues Secret" });
    expect(within(shown).getByLabelText("Secret")).toHaveValue(SECRET);
    expect(shown).toHaveTextContent("Das alte Secret bleibt bis");
  });

  test("API-029 the delivery log shows status, HTTP code, next attempt and snippets; „Erneut senden“ replays", async () => {
    const user = userEvent.setup();
    renderWithIntl(<WebhooksAdmin />);
    const site = within(screen.getByRole("table")).getAllByRole("row")[1] as HTMLElement;
    await user.click(within(site).getByRole("button", { name: "Zustellprotokoll (www.firma.de)" }));
    const log = screen.getByRole("dialog", { name: "Zustellprotokoll: www.firma.de" });
    expect(log).toHaveTextContent("test.ping");
    expect(log).toHaveTextContent("Fehlgeschlagen");
    expect(log).toHaveTextContent("500");
    expect(log).toHaveTextContent("Nächster Versuch:");
    expect(log).toHaveTextContent("evt_abc");
    expect(within(log).getByText("Interner Fehler", { exact: false })).toBeInTheDocument();
    await user.click(within(log).getByRole("button", { name: /^Erneut senden/ }));
    await waitFor(() => expect(backend.calls["webhooks:replay"]).toHaveBeenCalledWith({ deliveryId: "d1" }));
  });
});
