import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { AuditViewer } from "./audit-viewer";
import { AuditWatchers } from "./audit-watchers";
import { EntityHistory } from "./entity-history";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  args: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    const name = getFunctionName(ref as never);
    backend.args[name] = args;
    return enabled ? backend.data[name] : undefined;
  },
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({
      filename: "audit-log-2026-10-12.csv",
      mime: "text/csv",
      content: "seq;at",
    });
    return backend.mutations[name];
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/buchhaltung/journal" }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NOW = Date.UTC(2026, 9, 12, 10);
const entry = (over: Record<string, unknown> = {}) => ({
  id: `e${String(over.seq ?? 1)}`,
  seq: 1,
  at: NOW,
  actor: "mcp:abc",
  badge: { kind: "mcp", label: "Claude (MCP)" },
  channel: "mcp",
  requestId: null,
  action: "document.update_draft",
  description: "Entwurf bearbeitet",
  entity: { table: "salesDocuments", id: "d1", label: "Entwurf" },
  link: "/rechnungen/d1",
  reason: null,
  diff: { before: { headText: "Alt" }, after: { headText: "Von Claude" } },
  hash: "abcdef123456",
  chain: { verified: true, text: "verifiziert bis seq 40 am 12.10.2026" },
  ...over,
});

beforeEach(() => {
  backend.mutations = {};
  backend.args = {};
  toast.info.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "auditLog:search": {
      entries: [
        entry({ seq: 41 }),
        entry({ seq: 40, actor: "user:u1", badge: { kind: "user", label: "Du" }, channel: "ui" }),
      ],
      nextCursor: 39,
      head: { seq: 41, hash: "abcdef123456" },
      lastRun: { at: NOW, ok: true, lastVerifiedSeq: 40 },
    },
    "auditLog:actors": [{ actor: "api-key:pk1", name: "website" }],
    "auditLog:entityHistory": [entry({ seq: 7, action: "payment.record", description: "Zahlung zu RE-1 erfasst" })],
    "auditLog:latestExternalChange": null,
  };
});

describe("audit viewer (AUD-006, AUD-008)", () => {
  test("AUD-006 presets, actor badges, chain status and the side-by-side diff", async () => {
    renderWithIntl(<AuditViewer />);
    expect(screen.getByTestId("chain-status")).toHaveTextContent(
      "Protokollkette verifiziert bis seq 40 (aktuell seq 41).",
    );
    const list = screen.getByRole("list", { name: "Protokolleinträge" });
    const [first] = within(list).getAllByRole("listitem");
    expect(within(first as HTMLElement).getByText("Claude (MCP)")).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText("verifiziert bis seq 40 am 12.10.2026")).toBeInTheDocument();
    await userEvent.click(within(first as HTMLElement).getByText("Änderungen anzeigen"));
    expect(within(first as HTMLElement).getByText(/Von Claude/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Was hat Claude heute geändert?" }));
    expect(backend.args["auditLog:search"]).toMatchObject({ preset: "claude_today" });
    expect(screen.getByRole("button", { name: "Was hat Claude heute geändert?" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "API-Schlüssel website" }));
    expect(backend.args["auditLog:search"]).toMatchObject({ preset: "api_key", apiKeyActor: "api-key:pk1" });
    await userEvent.selectOptions(screen.getByLabelText("Kanal"), "ui");
    expect(backend.args["auditLog:search"]).toMatchObject({ channel: "ui" });
  });

  test("AUD-008 export CSV downloads the server's file with the current filter", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    renderWithIntl(<AuditViewer />);
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(backend.mutations["auditLog:exportLog"]).toHaveBeenCalledWith({ format: "csv" });
    expect(createObjectURL).toHaveBeenCalled();
  });
});

describe("Verlauf and logged reads (AUD-007, AUD-009, DOC-41)", () => {
  test("AUD-007 the „Verlauf“ card lists the record's entries incl. related payments", () => {
    renderWithIntl(<EntityHistory table="salesDocuments" id="d1" />);
    expect(screen.getByRole("heading", { name: "Verlauf" })).toBeInTheDocument();
    expect(screen.getByText("Zahlung zu RE-1 erfasst")).toBeInTheDocument();
    expect(backend.args["auditLog:entityHistory"]).toEqual({ table: "salesDocuments", id: "d1" });
  });

  test("DOC-41 a new API/MCP change shows „Aktualisiert durch Claude (MCP)“; AUD-009 auditors log each page", async () => {
    const view = renderWithIntl(<AuditWatchers />);
    expect(toast.info).not.toHaveBeenCalled();
    expect(backend.mutations["auditLog:recordAccess"]).not.toHaveBeenCalled();
    backend.data["auditLog:latestExternalChange"] = {
      seq: 50,
      at: NOW,
      text: "Aktualisiert durch Claude (MCP)",
      description: "Entwurf bearbeitet",
    };
    backend.data["members:me"] = { role: "auditor" };
    await act(async () => view.rerender(<AuditWatchers />));
    expect(toast.info).toHaveBeenCalledWith("Aktualisiert durch Claude (MCP)", { description: "Entwurf bearbeitet" });
    expect(backend.mutations["auditLog:recordAccess"]).toHaveBeenCalledWith({ path: "/buchhaltung/journal" });
  });
});
