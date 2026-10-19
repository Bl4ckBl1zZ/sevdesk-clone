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
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));
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
  nav.params = new URLSearchParams();
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

const CHECKLIST = [
  { id: "aussenpruefung", label: "Keine laufende oder angekündigte Außenprüfung (Betriebsprüfung)" },
  { id: "einspruch", label: "Keine offenen Einsprüche oder Klagen" },
];
const worklist = (over: Record<string, unknown> = {}) => ({
  today: "2035-01-02",
  groups: [{ retentionClass: "vouchers8", year: 2034, count: 3, tables: { salesDocuments: 3 } }],
  auditPrefix: { upToSeq: 0, count: 0 },
  contacts: [],
  hold: null,
  total: 3,
  classes: [
    { id: "books10", label: "Bücher (10 Jahre)" },
    { id: "vouchers8", label: "Buchungsbelege (8 Jahre)" },
  ],
  checklist: CHECKLIST,
  phrase: "ENDGÜLTIG LÖSCHEN",
  ...over,
});

describe("Aufbewahrung › Löschlauf (PRV-003…PRV-006, GOBD-21)", () => {
  test("PRV-005 GOBD-21 the purge needs a class, every checklist item and the typed phrase; the server call carries them", async () => {
    nav.params = new URLSearchParams("tab=aufbewahrung");
    backend.data["retention:worklist"] = worklist();
    backend.data["retention:history"] = [];
    backend.data["retention:preview"] = { total: 3, files: 2, counts: {}, examples: [], holdActive: false };
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    const list = screen.getByRole("list", { name: "Löschvorschläge" });
    expect(list).toHaveTextContent("Buchungsbelege (8 Jahre), Frist abgelaufen am 31.12.2034");
    expect(list).toHaveTextContent("3 Datensätze");
    await userEvent.click(screen.getByRole("button", { name: "Löschlauf starten" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Endgültig löschen" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Buchungsbelege (8 Jahre)" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "3 Datensätze und 2 Dateien werden endgültig gelöscht.",
    );
    for (const c of CHECKLIST) await userEvent.click(within(dialog).getByRole("checkbox", { name: c.label }));
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Zur Bestätigung/), "ENDGÜLTIG LÖSCHEN");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(backend.mutations["retention:startPurge"]).toHaveBeenCalledWith({
      classes: ["vouchers8"],
      years: [],
      checklist: { aussenpruefung: true, einspruch: true },
      phrase: "ENDGÜLTIG LÖSCHEN",
    });
  });

  test("PRV-004 an active Betriebsprüfung-Modus shows the banner and blocks the purge button; a bookkeeper only reads", () => {
    nav.params = new URLSearchParams("tab=aufbewahrung");
    backend.data["retention:worklist"] = worklist({
      hold: { reason: "Prüfungsanordnung 2026", fiscalYears: [2024], activeFrom: Date.UTC(2035, 0, 1) },
    });
    backend.data["retention:history"] = [];
    const { unmount } = renderWithIntl(<PrivacyPage publicEdge={false} />);
    expect(screen.getByText(/Betriebsprüfung-Modus aktiv seit/)).toHaveTextContent("Prüfungsanordnung 2026");
    expect(screen.getByRole("button", { name: "Löschlauf starten" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Betriebsprüfung-Modus beenden" })).toBeInTheDocument();
    unmount();
    backend.data["members:me"] = { role: "bookkeeper" };
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    expect(screen.getByRole("list", { name: "Löschvorschläge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Löschlauf starten" })).toBeNull();
  });
});

const request = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  kind: "erasure",
  kindLabel: "Löschung (Art. 17)",
  subject: "Erika Mustermann (K-0001)",
  contactId: "c1",
  channel: "email",
  receivedAt: "2026-10-01",
  dueAt: "2026-11-02",
  status: "open",
  identityVerified: { method: "Rückruf", at: 1 },
  extension: null,
  erasure: null,
  hasResult: false,
  overdue: false,
  stage: "none",
  ...over,
});

describe("Anfragen (PRV-010…PRV-012)", () => {
  test("PRV-010 PRV-011 the register shows the deadline; the erasure dialog lists both buckets and the purge date", async () => {
    nav.params = new URLSearchParams("tab=anfragen");
    backend.data["dsgvo:list"] = [request({ overdue: true, stage: "overdue" })];
    backend.data["dsgvo:preview"] = {
      contactId: "c1",
      contactNumber: "K-0001",
      deleteNow: [{ kind: "contactActivities", id: "a1", label: "Notiz vom 01.10.2026" }],
      clearFields: ["Notizen"],
      restrict: [
        {
          kind: "salesDocument",
          id: "d1",
          label: "Rechnung RE-2026-0001",
          retentionClass: "vouchers8",
          retentionUntil: "2034-12-31",
        },
      ],
      byClass: { vouchers8: "2035-01-01" },
      scheduledPurgeAt: "2037-01-01",
      deleteContact: false,
      openReceivablesCents: 0,
      receivablesNotice: null,
    };
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    const item = within(screen.getByRole("list", { name: "Datenschutzanfragen" })).getByRole("listitem");
    expect(item).toHaveTextContent("Frist 02.11.2026");
    expect(within(item).getByText("Überfällig")).toBeInTheDocument();
    await userEvent.click(within(item).getByRole("button", { name: "Löschung prüfen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("region", { name: "Wird sofort gelöscht" })).toHaveTextContent(
      "Notiz vom 01.10.2026",
    );
    expect(within(dialog).getByRole("region", { name: "Bleibt aufbewahrt (gesperrt)" })).toHaveTextContent(
      "Rechnung RE-2026-0001 – aufzubewahren bis 31.12.2034",
    );
    expect(dialog).toHaveTextContent("ab 01.01.2037");
    await userEvent.click(within(dialog).getByRole("button", { name: "Löschen und sperren" }));
    expect(backend.mutations["dsgvo:execute"]).toHaveBeenCalledWith({ id: "r1" });
  });

  test("CON-165 non-owners do not see the register", () => {
    nav.params = new URLSearchParams("tab=anfragen");
    backend.data["members:me"] = { role: "bookkeeper" };
    renderWithIntl(<PrivacyPage publicEdge={false} />);
    expect(screen.getByText("Datenschutzanfragen bearbeitet nur der Inhaber.")).toBeInTheDocument();
  });
});
