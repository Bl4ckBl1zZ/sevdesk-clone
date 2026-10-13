import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { presetScopes } from "@/domain/api/scopes";
import { renderWithIntl } from "@/i18n/test-utils";
import { apiHostUrl } from "./api-host";
import { ApiKeysAdmin } from "./api-keys-admin";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  queried: [] as { name: string; args: unknown }[],
  host: "app.firma.de" as string | null,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    const name = getFunctionName(ref as never);
    if (!enabled) return undefined;
    backend.queried.push({ name, args });
    return backend.data[name];
  },
}));
const fn = (name: string, value: unknown) => {
  backend.calls[name] ??= vi.fn().mockResolvedValue(value);
  return backend.calls[name];
};
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => fn(getFunctionName(ref as never), null),
  useAction: (ref: unknown) => fn(getFunctionName(ref as never), null),
}));
vi.mock("./api-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api-host")>()),
  useLocationHost: () => backend.host,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NOW = Date.UTC(2026, 9, 12, 10);
const key = (over: Record<string, unknown>) => ({
  keyId: `k-${String(over.name)}`,
  publicId: "ak_abcdefgh",
  name: "Website",
  display: "sk_live_abcdefgh…wxyz",
  scopes: presetScopes("website"),
  preset: "website",
  channel: "api",
  createdAt: NOW,
  createdBy: "owner:u1",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  rateLimitPerMinute: null,
  status: "active",
  ...over,
});

beforeEach(() => {
  backend.calls = {};
  backend.queried = [];
  backend.host = "app.firma.de";
  toast.success.mockReset();
  toast.error.mockReset();
  backend.data = {
    "apiKeys:list": [
      key({ name: "Website" }),
      key({
        name: "Claude Laptop",
        display: "sk_live_zzzzzzzz…1234",
        scopes: ["contacts:read", "documents:read"],
        preset: null,
        channel: "mcp",
        rateLimitPerMinute: 60,
        lastUsedAt: NOW,
      }),
      key({ name: "Alt", status: "revoked", revokedAt: NOW }),
    ],
    "apiKeys:requests": [
      {
        method: "GET",
        target: "/api/v1/contacts",
        status: 200,
        durationMs: 42,
        requestId: "req_1",
        channel: "api",
        at: NOW,
      },
    ],
  };
});

const cards = () => screen.getAllByRole("listitem").filter((li) => li.dataset.apiKey !== undefined);

describe("/einstellungen/api (05 §2)", () => {
  test("API-001 the key list shows prefix…last4, preset or „Benutzerdefiniert“, channel, scopes, rate limit and status", () => {
    renderWithIntl(<ApiKeysAdmin />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    const website = rows[1] as HTMLElement;
    expect(website).toHaveTextContent("sk_live_abcdefgh…wxyz");
    expect(website).toHaveTextContent("Website");
    expect(website).toHaveTextContent("REST-API");
    expect(website).toHaveTextContent("6 Berechtigungen");
    expect(website).toHaveTextContent("120/min (Standard)");
    expect(website).toHaveTextContent("Aktiv");
    expect(website).toHaveTextContent("noch nie");
    expect(website).toHaveTextContent("unbefristet");
    const custom = rows[2] as HTMLElement;
    expect(custom).toHaveTextContent("Benutzerdefiniert");
    expect(custom).toHaveTextContent("MCP (Claude)");
    expect(custom).toHaveTextContent("60/min");
    expect(custom).not.toHaveTextContent("Standard");
    // The scope list is expandable and names every scope in German.
    expect(within(custom).getByText("Kontakte lesen")).toBeInTheDocument();
    const revoked = rows[3] as HTMLElement;
    expect(revoked).toHaveTextContent("Widerrufen");
    expect(revoked).toHaveAttribute("data-inactive");
    expect(within(revoked).queryByRole("button", { name: /Widerrufen/ })).toBeNull();
    // Narrow main area: the same keys as cards.
    expect(cards()).toHaveLength(3);
  });

  test("API-002 choosing a preset fills channel and scopes; editing a scope switches to „Benutzerdefiniert“", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ApiKeysAdmin />);
    await user.click(screen.getByRole("button", { name: "Neuer Schlüssel" }));
    const dialog = await screen.findByRole("dialog");
    // Default preset: Website (REST-API).
    expect(within(dialog).getByRole("radio", { name: /^Website/ })).toBeChecked();
    expect(within(dialog).getByLabelText(/^Kanal/)).toHaveValue("api");
    expect(within(dialog).getByRole("checkbox", { name: /Kontakte anlegen und ändern/ })).toBeChecked();

    await user.click(within(dialog).getByRole("radio", { name: /^Nur lesen/ }));
    expect(within(dialog).getByLabelText(/^Kanal/)).toHaveValue("both");
    const checked = within(dialog)
      .getAllByRole("checkbox")
      .filter((c) => (c as HTMLInputElement).checked)
      .map((c) => c.getAttribute("value"));
    expect(checked.sort()).toEqual(presetScopes("read_only"));
    expect(within(dialog).getByRole("checkbox", { name: /Kontakte anlegen und ändern/ })).not.toBeChecked();

    await user.click(within(dialog).getByRole("checkbox", { name: /Kontakte anlegen und ändern/ }));
    expect(within(dialog).getByRole("radio", { name: /^Benutzerdefiniert/ })).toBeChecked();

    await user.click(within(dialog).getByRole("radio", { name: /^Claude \(MCP\), sicher/ }));
    expect(within(dialog).getByLabelText(/^Kanal/)).toHaveValue("mcp");
    expect(within(dialog).getByRole("checkbox", { name: /Fertigstellen/i })).not.toBeChecked();
  });

  test("API-003 creating a key runs the fresh action and shows the plaintext key exactly once with a copy button", async () => {
    const user = userEvent.setup();
    backend.calls["apiKeys:create"] = vi.fn().mockResolvedValue({
      key: "sk_live_abcdefghSECRETSECRETSECRETwxyz",
      publicId: "ak_abcdefgh",
      display: "sk_live_abcdefgh…wxyz",
    });
    renderWithIntl(<ApiKeysAdmin />);
    await user.click(screen.getByRole("button", { name: "Neuer Schlüssel" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Website-Formular");
    await user.type(within(dialog).getByLabelText(/^Limit pro Minute/), "300");
    await user.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    await waitFor(() =>
      expect(backend.calls["apiKeys:create"]).toHaveBeenCalledWith({
        values: {
          name: "Website-Formular",
          channel: "api",
          scopes: presetScopes("website"),
          expiresOn: "",
          rateLimitPerMinute: "300",
        },
      }),
    );
    const shown = await screen.findByRole("dialog");
    expect(within(shown).getByLabelText("API-Schlüssel")).toHaveValue("sk_live_abcdefghSECRETSECRETSECRETwxyz");
    expect(shown).toHaveTextContent("Wird nur einmal angezeigt");
    await user.click(within(shown).getByRole("button", { name: "Schlüssel kopieren" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("sk_live_abcdefghSECRETSECRETSECRETwxyz");
    await user.click(within(shown).getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(/SECRETSECRET/)).toBeNull();
    expect(screen.queryByDisplayValue(/SECRETSECRET/)).toBeNull();
  });

  test("API-002 an invalid form is not sent (name required, at least one scope)", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ApiKeysAdmin />);
    await user.click(screen.getByRole("button", { name: "Neuer Schlüssel" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /^Benutzerdefiniert/ }));
    for (const box of within(dialog).getAllByRole("checkbox")) {
      if ((box as HTMLInputElement).checked) await user.click(box);
    }
    await user.click(within(dialog).getByRole("button", { name: "Schlüssel erstellen" }));
    expect(await within(dialog).findByText("Bitte einen Namen angeben.")).toBeVisible();
    expect(within(dialog).getByText("Bitte mindestens eine Berechtigung wählen.")).toBeVisible();
    expect(backend.calls["apiKeys:create"]).not.toHaveBeenCalled();
  });

  test("API-003 revoking asks for confirmation and sends the reason (EC-186: effective on the next request)", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ApiKeysAdmin />);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /Widerrufen/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("ab der nächsten Anfrage");
    await user.type(within(dialog).getByLabelText("Grund (optional)"), "Website neu aufgesetzt");
    await user.click(within(dialog).getByRole("button", { name: "Schlüssel widerrufen" }));
    await waitFor(() =>
      expect(backend.calls["apiKeys:revoke"]).toHaveBeenCalledWith({
        keyId: "k-Website",
        reason: "Website neu aufgesetzt",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Schlüssel widerrufen.");
  });

  test("API-008 „Letzte Zugriffe“ loads the access log of exactly that key", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ApiKeysAdmin />);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1] as HTMLElement;
    expect(backend.queried.some((q) => q.name === "apiKeys:requests")).toBe(false);
    await user.click(within(row).getByRole("button", { name: /Letzte Zugriffe/ }));
    const dialog = await screen.findByRole("dialog");
    expect(backend.queried).toContainEqual({ name: "apiKeys:requests", args: { keyId: "k-Website" } });
    expect(dialog).toHaveTextContent("GET /api/v1/contacts");
    expect(dialog).toHaveTextContent("200");
    expect(dialog).toHaveTextContent("42 ms");
  });

  test("API-004 API-007 the explanation names the tailnet, the Bearer header, refused URL keys and links the docs on the api host", () => {
    renderWithIntl(<ApiKeysAdmin />);
    expect(screen.getByText(/nur von Geräten in Ihrem Tailnet/)).toBeInTheDocument();
    expect(screen.getByText("Authorization: Bearer sk_live_…")).toBeInTheDocument();
    expect(screen.getByText(/werden abgelehnt/)).toBeInTheDocument();
    expect(screen.getByText(/eigenes Limit \(Standard: 120 Anfragen pro Minute\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://api.firma.de/api/docs" })).toHaveAttribute(
      "href",
      "https://api.firma.de/api/docs",
    );
  });

  test("API-014 the api host is derived from the app host; otherwise the plain path is used", () => {
    expect(apiHostUrl("app.buero.example.de", "/api/docs")).toBe("https://api.buero.example.de/api/docs");
    expect(apiHostUrl("localhost:3000", "/api/docs")).toBeNull();
    expect(apiHostUrl(null, "/api/mcp")).toBeNull();
    backend.host = "localhost:3000";
    renderWithIntl(<ApiKeysAdmin />);
    expect(screen.getByRole("link", { name: "/api/docs" })).toHaveAttribute("href", "/api/docs");
  });
});
