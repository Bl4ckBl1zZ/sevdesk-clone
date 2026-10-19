import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { PrivacyPage } from "./privacy-page";

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

const service = (over: Record<string, unknown>) => ({
  id: "tailscale",
  name: "Tailscale",
  role: "processor",
  effectiveRegion: "us",
  purpose: "Zugang über das Tailnet",
  dataCategories: "IP-Adressen, Gerätenamen",
  detail: null,
  dpaUrl: "https://tailscale.com/dpa",
  avvConfirmedAt: null,
  avvMissing: true,
  warning: null,
  ...over,
});

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "privacy:externalServices": [
      service({}),
      service({
        id: "ntfy",
        name: "ntfy",
        effectiveRegion: "unknown",
        detail: "ntfy.sh",
        warning: "ntfy.sh verarbeitet Daten möglicherweise außerhalb der EU.",
      }),
      service({ id: "evatr", name: "BZSt eVatR", role: "public_authority", effectiveRegion: "de", dpaUrl: null }),
    ],
    "privacy:retention": {
      version: "retention-2026.1",
      classes: [
        { cls: "books10", label: "Bücher und Abschlüsse", years: 10, tables: ["journalEntries"] },
        { cls: "vouchers8", label: "Buchungsbelege", years: 8, tables: ["salesDocuments"] },
        { cls: "none", label: "Keine Aufbewahrungspflicht", years: null, tables: ["notifications"] },
      ],
    },
    "privacy:art30": {
      record: {
        title: "Verzeichnis von Verarbeitungstätigkeiten",
        controller: { name: "Muster GmbH", address: "Markt 1, 52062 Aachen" },
        activities: [
          {
            name: "Rechnungsstellung",
            purpose: "Rechnungen erstellen",
            legalBasis: "Art. 6 Abs. 1 lit. b, c DSGVO",
            recipients: "Kunden",
            thirdCountry: "keine",
            retention: "8 Jahre",
          },
        ],
      },
      markdown: "# Verzeichnis",
    },
  };
});

describe("Datenschutz page (PRV-016, SET-114, PRV-001, PRV-015)", () => {
  test("SET-114 SET-048 lists services with role, region, AVV status and the non-EU warning; the owner confirms the AVV", async () => {
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    const list = screen.getByRole("list", { name: "Externe Dienste" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByText("AVV fehlt")).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByRole("alert")).toHaveTextContent("außerhalb der EU");
    expect(within(items[2] as HTMLElement).queryByText("AVV fehlt")).toBeNull();
    expect(within(items[2] as HTMLElement).queryByRole("button")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "AVV für Tailscale bestätigen" }));
    expect(backend.mutations["privacy:confirmAvv"]).toHaveBeenCalledWith({ serviceId: "tailscale", confirmed: true });
    expect(toast.success).toHaveBeenCalledWith("AVV-Bestätigung gespeichert.");
  });

  test("SET-109 a bookkeeper sees the AVV status but cannot confirm it", () => {
    backend.data["members:me"] = { role: "bookkeeper" };
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    expect(screen.getAllByText("AVV fehlt").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /AVV für/ })).toBeNull();
  });

  test("PRV-001 PRV-015 the retention tab lists the classes; the Art. 30 tab shows the record", async () => {
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    await userEvent.click(screen.getByRole("tab", { name: "Aufbewahrung" }));
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "Buchungsbelege" })).toBeInTheDocument();
    expect(screen.getByText(/retention-2026\.1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Verzeichnis (Art. 30)" }));
    expect(screen.getByRole("heading", { name: "Verzeichnis von Verarbeitungstätigkeiten" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Rechnungsstellung" })).toHaveTextContent(
      "Art. 6 Abs. 1 lit. b, c DSGVO",
    );
    expect(screen.getByRole("button", { name: "Als Datei herunterladen" })).toBeInTheDocument();
  });
});
