import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { SevdeskImport } from "./sevdesk-import";

/** F09 IMP-016 ZIP uploads and IMP-024 import protocol on `/einstellungen/import` (backend mocked). */
const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
const upload = vi.hoisted(() => vi.fn());
vi.mock("@/components/banking/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/banking/shared")>()),
  uploadFile: upload,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const file = (id: string, name: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  sha256: `${id}`.padEnd(64, "0"),
  bytes: 100,
  mime: kind === "zip" ? "application/zip" : "application/pdf",
  detectedKind: kind,
  kind,
  ...extra,
});

function workspace(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "imp1",
    status,
    revision: 1,
    files: [
      file("f1", "Rechnungen_18.10.26.zip", "zip", { unpacked: { files: 2, ignored: ["__MACOSX/._a.pdf"] } }),
      file("f2", "2026-06-10_Rechnung_RE-5000_x.pdf", "pdf", { container: "f1" }),
      file("f3", "2026-06-26_Rechnung_RE-5001_x.pdf", "pdf", { container: "f1" }),
      file("f4", "einzeln.pdf", "pdf"),
    ],
    mapping: {},
    resolutions: {},
    previewHash: null,
    preview: null,
    stats: { documentsCreated: 2, contactsCreated: 0, productsCreated: 0 } as Record<string, number>,
    log: [] as string[],
    error: null,
    startedAt: Date.UTC(2026, 9, 18, 8),
    committedAt: status === "done" ? Date.UTC(2026, 9, 18, 9) : null,
    committedBy: null,
    retentionUntil: status === "done" ? "2036-12-31" : null,
    importerVersion: "sevdesk-export-import@1",
    presets: [],
    protocol: null,
    ...extra,
  };
}

const listRow = (status: string) => ({
  id: "imp1",
  source: "sevdesk_export",
  status,
  files: 4,
  startedAt: Date.UTC(2026, 9, 18, 8),
  committedAt: null,
  actor: "user:u1",
  committedBy: null,
  counts: {},
});

function setWorkspace(ws: ReturnType<typeof workspace>) {
  backend.data = { "imports:list": [listRow(ws.status)], "imports:get": ws };
}

beforeEach(() => {
  backend.mutations = {};
  backend.data = { "imports:list": [] };
  upload.mockReset();
  for (const t of Object.values(toast)) t.mockReset();
});

describe("F09 IMP-016 ZIP uploads and IMP-024 import protocol (UI)", () => {
  test("IMP-016 files unpacked from a ZIP are listed under their archive; the archive keeps its kind", () => {
    setWorkspace(workspace("uploaded"));
    renderWithIntl(<SevdeskImport canRun canCommit />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "Rechnungen_18.10.26.zip2 Dateien entpackt",
      "2026-06-10_Rechnung_RE-5000_x.pdfaus Rechnungen_18.10.26.zip",
      "2026-06-26_Rechnung_RE-5001_x.pdfaus Rechnungen_18.10.26.zip",
      "einzeln.pdf",
    ]);
    expect(screen.getByLabelText("Dateiart: Rechnungen_18.10.26.zip")).toBeDisabled();
    expect(screen.getByLabelText("Ignorieren: Rechnungen_18.10.26.zip")).toBeDisabled();
    expect(screen.getByLabelText("Dateiart: 2026-06-10_Rechnung_RE-5000_x.pdf")).toBeEnabled();
    expect(screen.getByText(/ZIP-Archive werden automatisch entpackt/)).toBeInTheDocument();
  });

  test("IMP-016 E-IMP-29 a rejected ZIP and skipped system files are reported after the upload", async () => {
    setWorkspace(workspace("uploaded"));
    backend.mutations["imports:generateUploadUrl"] = vi.fn().mockResolvedValue("https://upload");
    backend.mutations["imports:addFiles"] = vi.fn().mockResolvedValue({
      added: ["f5", "f6"],
      duplicates: [],
      rejected: [
        {
          name: "boese.zip",
          code: "E-IMP-29",
          message: "Die ZIP-Datei boese.zip ist ungültig oder zu groß: „../x.pdf“ zeigt aus dem Archiv heraus.",
        },
      ],
      ignoredEntries: ["export.zip/__MACOSX/._a.pdf"],
    });
    upload.mockResolvedValue("st1");
    renderWithIntl(<SevdeskImport canRun canCommit />);
    await userEvent.upload(
      screen.getByLabelText("Dateien auswählen"),
      new File(["PK"], "export.zip", { type: "application/zip" }),
    );
    expect(toast.success).toHaveBeenCalledWith("2 Dateien hinzugefügt");
    expect(toast.error).toHaveBeenCalledWith(
      "Die ZIP-Datei boese.zip ist ungültig oder zu groß: „../x.pdf“ zeigt aus dem Archiv heraus.",
    );
    expect(toast.info).toHaveBeenCalledWith(
      "In ZIP-Archiven übersprungen (Systemdateien): export.zip/__MACOSX/._a.pdf",
    );
  });

  test("IMP-024 a committed import links its protocol PDF with the SHA-256", async () => {
    setWorkspace(
      workspace("done", {
        protocol: {
          name: "Importprotokoll_2026-10-18_imp1.pdf",
          sha256: "ab".repeat(32),
          bytes: 1000,
          url: "https://f/p",
        },
      }),
    );
    renderWithIntl(<SevdeskImport canRun canCommit />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const link = screen.getByRole("link", { name: "Importprotokoll herunterladen (PDF)" });
    expect(link).toHaveAttribute("href", "https://f/p");
    expect(link).toHaveAttribute("download", "Importprotokoll_2026-10-18_imp1.pdf");
    expect(screen.getByText(`SHA-256: ${"ab".repeat(32)}`)).toBeInTheDocument();
  });

  test("IMP-024 a missing protocol can be created by the owner; others only see that it is missing", async () => {
    setWorkspace(workspace("done"));
    backend.mutations["imports:generateProtocol"] = vi.fn().mockResolvedValue({ created: true });
    const { unmount } = renderWithIntl(<SevdeskImport canRun canCommit />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(screen.getByText("Das Importprotokoll wurde noch nicht erzeugt.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Protokoll erzeugen" }));
    expect(backend.mutations["imports:generateProtocol"]).toHaveBeenCalledWith({ importId: "imp1" });
    unmount();
    renderWithIntl(<SevdeskImport canRun canCommit={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(screen.queryByRole("button", { name: "Protokoll erzeugen" })).toBeNull();
  });
});
