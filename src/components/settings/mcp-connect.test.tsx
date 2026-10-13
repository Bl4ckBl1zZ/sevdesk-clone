import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { presetScopes } from "@/domain/api/scopes";
import { renderWithIntl } from "@/i18n/test-utils";
import { McpConnect, mcpSnippets } from "./mcp-connect";

const backend = vi.hoisted(() => ({
  calls: {} as Record<string, ReturnType<typeof vi.fn>>,
  host: "app.firma.de" as string | null,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({ useAuthedQuery: () => undefined }));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls[name] ??= vi.fn().mockResolvedValue(null);
    return backend.calls[name];
  },
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls[name] ??= vi.fn().mockResolvedValue(null);
    return backend.calls[name];
  },
}));
vi.mock("./api-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api-host")>()),
  useLocationHost: () => backend.host,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const URL_ = "https://api.firma.de/api/mcp";

beforeEach(() => {
  backend.calls = {};
  backend.host = "app.firma.de";
});

describe("/einstellungen/mcp (06 §6)", () => {
  test("MCP-001 the snippets contain the MCP URL derived from the app host", async () => {
    const user = userEvent.setup();
    renderWithIntl(<McpConnect />);
    expect(screen.getByText(URL_)).toBeInTheDocument();
    const cli = screen.getByLabelText("Claude Code (Terminal)");
    expect(cli).toHaveTextContent(
      `claude mcp add --transport http rechnungen ${URL_} --header "Authorization: Bearer $RECHNUNG_MCP_KEY" --scope user`,
    );
    const mcpJson = JSON.parse(screen.getByLabelText("Claude Code (Projektdatei .mcp.json)").textContent ?? "");
    expect(mcpJson).toEqual({
      mcpServers: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference expanded by Claude Code.
        rechnungen: { type: "http", url: URL_, headers: { Authorization: "Bearer ${RECHNUNG_MCP_KEY}" } },
      },
    });
    const desktop = JSON.parse(screen.getByLabelText("Claude Desktop (claude_desktop_config.json)").textContent ?? "");
    expect(desktop).toEqual({
      mcpServers: {
        rechnungen: {
          command: "npx",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env-var reference expanded by mcp-remote.
          args: ["-y", "mcp-remote", URL_, "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: "Bearer sk_live_…" },
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Claude Code (Terminal) kopieren" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(mcpSnippets(URL_).claudeCode);
  });

  test("MCP-001 claude.ai web/mobile and custom connectors are stated as „Nicht unterstützt“", () => {
    renderWithIntl(<McpConnect />);
    const note = screen.getByRole("note", { name: "Nicht unterstützt" });
    expect(note).toHaveTextContent("claude.ai im Browser oder in der Mobil-App");
    expect(note).toHaveTextContent("benutzerdefinierte Connectors");
    expect(note).toHaveTextContent("erreichen Ihr Tailnet nicht");
    expect(screen.getByText(/Claude Desktop: nur über die lokale Brücke „mcp-remote“/)).toBeInTheDocument();
    expect(screen.getByText(/nur nach einer Vorschau und nur mit Ihrer Freigabe/)).toBeInTheDocument();
    expect(screen.getByText(/Nichts löschen/)).toBeInTheDocument();
  });

  test("MCP-001 „Schlüssel für Claude erstellen“ opens the key dialog preset to „Claude (MCP), sicher“ on channel MCP", async () => {
    const user = userEvent.setup();
    renderWithIntl(<McpConnect />);
    await user.click(screen.getByRole("button", { name: "Schlüssel für Claude erstellen" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /^Claude \(MCP\), sicher/ })).toBeChecked();
    expect(within(dialog).getByLabelText(/^Kanal/)).toHaveValue("mcp");
    const checked = within(dialog)
      .getAllByRole("checkbox")
      .filter((c) => (c as HTMLInputElement).checked)
      .map((c) => c.getAttribute("value"));
    expect(checked.sort()).toEqual(presetScopes("claude_safe"));
  });

  test("MCP-001 without an app.<domain> host the snippets use a placeholder domain", () => {
    backend.host = "localhost:3000";
    renderWithIntl(<McpConnect />);
    expect(screen.getByLabelText("Claude Code (Terminal)")).toHaveTextContent("https://api.<Ihre-Domain>/api/mcp");
    expect(screen.getByText(/Platzhalter in den Beispielen/)).toBeInTheDocument();
  });
});
