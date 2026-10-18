import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { inspectFile } from "@/domain/import/sevdesk/files";
import { autoMap, isMappedCsvKind } from "@/domain/import/sevdesk/mapping";
import {
  buildPlan,
  type FileMappingInput,
  type ImportFileInput,
  type ImportResolutions,
  type LocalImportState,
  parseImportFiles,
  summarizePlan,
} from "@/domain/import/sevdesk/preview";
import type { CalendarDate } from "@/domain/time/calendar-date";
import { renderWithIntl } from "@/i18n/test-utils";
import {
  sevdeskFixtureBytes,
  sevdeskPdfNames,
  sevdeskVerifiedBytes,
  sevdeskVerifiedPdfNames,
} from "../../../test/fixtures/sevdesk-export/load";
import { SevdeskImport } from "./sevdesk-import";

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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const TODAY = "2026-10-18" as CalendarDate;
const local: LocalImportState = {
  today: TODAY,
  imported: {},
  registerNumbers: {},
  contactsByNumber: {},
  contactsByName: {},
  productsByNumber: {},
  documentsByNumber: {},
  ranges: [],
  opening: { date: "2026-06-01" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "soll" },
};

/** The import workspace as `imports:get` returns it, built from the synthetic export set (F09 TST-IMP-16). */
function workspace(
  resolutions: ImportResolutions = {},
  status = "previewed",
  set: "alternate" | "verified" = "alternate",
) {
  const names =
    set === "verified"
      ? ["contacts.csv", "18-10-2026_part.csv", "invoices.csv", ...sevdeskVerifiedPdfNames().map((n) => `pdf/${n}`)]
      : ["kontakte.csv", "artikel.csv", "rechnungen.csv", ...sevdeskPdfNames().map((n) => `pdf/${n}`)];
  const bytesOf = set === "verified" ? sevdeskVerifiedBytes : sevdeskFixtureBytes;
  const files: ImportFileInput[] = [];
  const mappings: Record<string, FileMappingInput> = {};
  const viewFiles = names.map((path, i) => {
    const name = path.replace(/^pdf\//, "");
    const bytes = bytesOf(path);
    const info = inspectFile(name, bytes);
    const id = `f${i}`;
    files.push({ id, name, sha256: `sha-${name}`, kind: info.kind, ...(info.table ? { table: info.table } : {}) });
    if (isMappedCsvKind(info.kind) && info.headers) mappings[id] = { columns: autoMap(info.kind, info.headers) };
    return {
      id,
      name,
      sha256: `sha-${name}`,
      bytes: bytes.length,
      mime: name.endsWith(".csv") ? "text/csv" : "application/pdf",
      detectedKind: info.kind,
      kind: info.kind,
      ...(info.encoding ? { encoding: info.encoding } : {}),
      ...(info.headers
        ? {
            headers: info.headers,
            samples: info.table?.records.slice(0, 3).map((r) => r.cells),
            rows: info.table?.records.length,
          }
        : {}),
    };
  });
  const plan = buildPlan(parseImportFiles(files, mappings, TODAY), local, resolutions);
  return {
    id: "imp1",
    status,
    revision: 3,
    files: viewFiles,
    mapping: mappings,
    resolutions,
    previewHash: status === "uploaded" ? null : "hash-1",
    preview: status === "uploaded" ? null : summarizePlan(plan),
    stats: {} as Record<string, number>,
    log: [] as string[],
    error: null as string | null,
    startedAt: Date.UTC(2026, 9, 18, 8),
    committedAt: null,
    committedBy: null,
    retentionUntil: null as string | null,
    importerVersion: "sevdesk-export-import@1",
    presets: [],
  };
}

const listRow = (status: string) => ({
  id: "imp1",
  source: "sevdesk",
  status,
  files: 9,
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

describe("F09 sevdesk-Import (/einstellungen/import)", () => {
  test("IMP-016 IMP-023 the checklist explains the freeze-and-export steps and starts a new import project", async () => {
    backend.mutations["imports:create"] = vi.fn().mockResolvedValue("imp1");
    renderWithIntl(<SevdeskImport canRun canCommit />);
    expect(screen.getByRole("heading", { name: "So gehen Sie vor" })).toBeInTheDocument();
    expect(screen.getByText(/sevdesk einfrieren/)).toBeInTheDocument();
    expect(screen.getByText(/zusätzlich extern \(EU-Speicherort\)/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/für große Bildschirme/);
    expect(screen.getByText("Noch kein Import angelegt.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "sevdesk-Exporte importieren" }));
    expect(backend.mutations["imports:create"]).toHaveBeenCalledWith({});
  });

  test("IMP-016 a viewer sees the projects but cannot start, edit or commit an import", () => {
    setWorkspace(workspace());
    renderWithIntl(<SevdeskImport canRun={false} canCommit={false} />);
    expect(screen.queryByRole("button", { name: "sevdesk-Exporte importieren" })).toBeNull();
    expect(screen.queryByLabelText("Dateien auswählen")).toBeNull();
    expect(screen.queryByRole("button", { name: "Vorschau erstellen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import übernehmen" })).toBeNull();
    expect(screen.getByText("Nur Inhaber können den Import übernehmen.")).toBeInTheDocument();
  });

  test("IMP-016 uploading files stores the blobs and registers them; the detected file kind can be corrected", async () => {
    setWorkspace(workspace({}, "uploaded"));
    backend.mutations["imports:generateUploadUrl"] = vi.fn().mockResolvedValue("https://upload");
    backend.mutations["imports:addFiles"] = vi.fn().mockResolvedValue({ added: ["x"], duplicates: ["kontakte.csv"] });
    upload.mockResolvedValue("st1");
    renderWithIntl(<SevdeskImport canRun canCommit />);
    const file = new File(["Nr;Name"], "neu.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Dateien auswählen"), file);
    expect(upload).toHaveBeenCalledWith("https://upload", file);
    expect(backend.mutations["imports:addFiles"]).toHaveBeenCalledWith({
      importId: "imp1",
      files: [{ storageId: "st1", name: "neu.csv" }],
    });
    expect(toast.success).toHaveBeenCalledWith("1 Datei hinzugefügt");
    expect(toast.warning).toHaveBeenCalledWith("Bereits vorhanden (gleicher Inhalt): kontakte.csv");

    await userEvent.selectOptions(screen.getByLabelText("Dateiart: artikel.csv"), "unknown");
    expect(backend.mutations["imports:updateFile"]).toHaveBeenCalledWith({
      importId: "imp1",
      fileId: "f1",
      kind: "unknown",
    });
    expect(
      screen.getByText("Dateien oder Zuordnung wurden geändert – bitte die Vorschau neu erstellen."),
    ).toBeVisible();
  });

  test("IMP-017 E-IMP-21 the column mapping names a missing required column and saves with a preset name", async () => {
    const ws = workspace({}, "uploaded");
    const invoiceFile = ws.files.find((f) => f.name === "rechnungen.csv");
    if (!invoiceFile) throw new Error("fixture");
    const { number: _n, ...rest } = ws.mapping[invoiceFile.id]?.columns ?? {};
    ws.mapping[invoiceFile.id] = { columns: rest };
    setWorkspace(ws);
    renderWithIntl(<SevdeskImport canRun canCommit />);
    const card = screen
      .getByRole("heading", { name: "2. Spaltenzuordnung: rechnungen.csv" })
      .closest("[data-slot=card]");
    if (!(card instanceof HTMLElement)) throw new Error("card");
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "In rechnungen.csv fehlt die Spalte für Rechnungsnummer. Bitte Spaltenzuordnung ergänzen.",
    );
    await userEvent.selectOptions(
      within(card).getByLabelText("Spalte in der Datei: Rechnungsnummer"),
      "Rechnungsnummer",
    );
    expect(within(card).queryByRole("alert")).toBeNull();
    await userEvent.selectOptions(within(card).getByLabelText("Zahlenformat"), "de");
    await userEvent.type(within(card).getByLabelText(/Als Vorlage speichern/), "sevdesk Rechnungen");
    await userEvent.click(within(card).getByRole("button", { name: "Zuordnung speichern" }));
    const call = backend.mutations["imports:setMapping"]?.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      importId: "imp1",
      fileId: invoiceFile.id,
      mapping: { numberFormat: "de", columns: { number: "Rechnungsnummer" } },
      savePresetAs: "sevdesk Rechnungen",
    });
  });

  test("IMP-009 E-IMP-22 the preview lists counts and per-row errors with file and line; rows can be excluded or a PDF assigned", async () => {
    setWorkspace(workspace());
    renderWithIntl(<SevdeskImport canRun canCommit />);
    const counts = screen.getByTestId("preview-counts");
    expect(within(counts).getByText("Neue Kontakte").nextSibling).toHaveTextContent("3");
    expect(within(counts).getByText("Entwürfe (nicht übernommen)").nextSibling).toHaveTextContent("1");
    const errors = screen.getByRole("button", { name: /^Fehler \(/ });
    expect(errors).toHaveAttribute("aria-pressed", "true");
    const row = screen.getAllByText("E-IMP-22")[0]?.closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("row");
    expect(row).toHaveTextContent(/rechnungen\.csv:\d+/);
    await userEvent.selectOptions(within(row).getByRole("combobox"), "RE-1005_RE-1006.pdf");
    const assign = backend.mutations["imports:setResolutions"]?.mock.calls[0]?.[0];
    expect(Object.values(assign.resolutions.pdfAssignments)).toHaveLength(1);
    await userEvent.click(within(row).getByRole("button", { name: "Zeile ausschließen" }));
    const exclude = backend.mutations["imports:setResolutions"]?.mock.calls[1]?.[0];
    expect(exclude.resolutions.excluded).toEqual([expect.stringMatching(/^f2:\d+$/)]);

    await userEvent.click(screen.getByRole("button", { name: /^Hinweise \(/ }));
    expect(screen.getByRole("button", { name: /^Hinweise \(/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("E-IMP-22")).toBeNull();
  });

  test("IMP-009 an excluded row with a parse error (0 % article, E-IMP-16) no longer counts as an error", () => {
    // Without Kleinunternehmer status the verified export's two 0 % articles are ambiguous; the owner excludes one.
    const first = workspace({}, "previewed", "verified");
    const parseErrors = first.preview?.findings.filter((f) => f.code === "E-IMP-16") ?? [];
    expect(parseErrors).toHaveLength(2);
    setWorkspace(workspace({ excluded: [parseErrors[0]?.rowRef as string] }, "previewed", "verified"));
    renderWithIntl(<SevdeskImport canRun canCommit />);
    // 5 invoices after the Buchungsbeginn 2026-06-01 (E-IMP-10) + the article still included; the excluded one is
    // still listed (dimmed) so it can be taken back in, but no longer counted.
    expect(screen.getByRole("button", { name: /^Fehler \(/ })).toHaveTextContent("Fehler (6)");
    const excludedRow = screen.getByRole("button", { name: "Wieder aufnehmen" }).closest("tr");
    expect(excludedRow).toHaveTextContent("Ausgeschlossen");
    expect(excludedRow?.className).not.toMatch(/opacity/); // dimming broke the WCAG AA contrast (axe)
    expect(screen.getAllByRole("button", { name: "Wieder aufnehmen" })).toHaveLength(1);
  });

  test("IMP-019 E-IMP-07 commit stays blocked by errors and needs a reason for missing PDFs; it sends the preview hash and the confirmed ranges", async () => {
    setWorkspace(workspace());
    const { unmount } = renderWithIntl(<SevdeskImport canRun canCommit />);
    expect(screen.getByRole("alert", { name: "" })).toHaveTextContent(/Noch \d+ Fehler/);
    expect(screen.getByRole("button", { name: "Import übernehmen" })).toBeDisabled();
    unmount();

    // Exclude the ambiguous-PDF rows → no blocking error remains, only missing PDFs.
    const blocked = workspace()
      .preview?.findings.filter((f) => f.severity === "error")
      .map((f) => f.rowRef as string);
    const ws = workspace({ excluded: blocked });
    expect(ws.preview?.blocking).toBe(0);
    setWorkspace(ws);
    backend.mutations["imports:commit"] = vi.fn().mockResolvedValue({
      status: "done",
      counts: { documentsCreated: 6, contactsCreated: 4, productsCreated: 2 },
    });
    renderWithIntl(<SevdeskImport canRun canCommit />);
    const commit = screen.getByRole("button", { name: "Import übernehmen" });
    expect(ws.preview?.counts.pdfMissing).toBeGreaterThan(0);
    expect(commit).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Ohne Original-PDF übernehmen"));
    expect(commit).toBeDisabled(); // a reason is required (E-IMP-07)
    await userEvent.type(screen.getByLabelText("Begründung"), "PDF in sevdesk nicht mehr vorhanden");
    expect(screen.getByLabelText("Nummernkreis Rechnungen fortsetzen")).toBeChecked();
    expect(screen.getByLabelText("Nächste Nummer für Rechnungen")).toHaveValue("1008");
    await userEvent.click(commit);
    expect(backend.mutations["imports:commit"]).toHaveBeenCalledWith(
      expect.objectContaining({
        importId: "imp1",
        previewHash: "hash-1",
        numberRanges: expect.arrayContaining([
          expect.objectContaining({ rangeKey: "invoice", format: "RE-{####}", next: 1008 }),
        ]),
        missingPdfReason: "PDF in sevdesk nicht mehr vorhanden",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Import übernommen: 6 Belege, 4 Kontakte, 2 Artikel.");
  });

  test("IMP-019 E-IMP-11 number-range proposals appear once the preview arrives after „Vorschau erstellen“", async () => {
    setWorkspace(workspace({}, "uploaded"));
    const { rerender } = renderWithIntl(<SevdeskImport canRun canCommit />);
    await userEvent.click(screen.getByRole("button", { name: "Vorschau erstellen" }));
    expect(backend.mutations["imports:preview"]).toHaveBeenCalledWith({ importId: "imp1" });
    expect(screen.queryByLabelText("Nummernkreis Rechnungen fortsetzen")).toBeNull();
    setWorkspace(workspace());
    rerender(<SevdeskImport canRun canCommit />);
    expect(screen.getByLabelText("Nummernkreis Rechnungen fortsetzen")).toBeChecked();
    expect(screen.getByLabelText("Format für Rechnungen")).toHaveDisplayValue("RE-{####} (7)");
  });

  test("IMP-019 a bookkeeper prepares the preview but only the owner commits", () => {
    setWorkspace(workspace());
    renderWithIntl(<SevdeskImport canRun canCommit={false} />);
    expect(screen.getByRole("button", { name: "Vorschau erstellen" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Import übernehmen" })).toBeNull();
    expect(screen.getByText("Nur Inhaber können den Import übernehmen.")).toBeInTheDocument();
  });

  test("IMP-011 a failed import offers „Import fortsetzen“; discarding asks for confirmation first", async () => {
    const ws = { ...workspace(), status: "failed", error: "Netzwerkfehler" };
    setWorkspace(ws);
    renderWithIntl(<SevdeskImport canRun canCommit />);
    expect(screen.getByText("Der Import wurde abgebrochen: Netzwerkfehler")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import fortsetzen" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Verwerfen" })).toBeNull(); // failed = not editable

    const ws2 = workspace();
    setWorkspace(ws2);
    renderWithIntl(<SevdeskImport canRun canCommit />);
    await userEvent.click(screen.getAllByRole("button", { name: "Verwerfen" }).at(-1) as HTMLElement);
    expect(screen.getByText(/Import verwerfen\?/)).toBeInTheDocument();
    expect(backend.mutations["imports:discard"]).not.toHaveBeenCalled();
  });

  test("IMP-019 a finished import shows the result and the retention of the source files", async () => {
    setWorkspace({
      ...workspace(),
      status: "done",
      stats: { documentsCreated: 7, contactsCreated: 4, productsCreated: 2 },
      log: ["7 Belege übernommen."],
      retentionUntil: "2037-12-31",
    });
    renderWithIntl(<SevdeskImport canRun canCommit />);
    expect(screen.queryByRole("heading", { name: "Ergebnis" })).toBeNull(); // finished projects are not opened by default
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(screen.getByRole("heading", { name: "Ergebnis" })).toBeInTheDocument();
    expect(screen.getByText("Import übernommen: 7 Belege, 4 Kontakte, 2 Artikel.")).toBeInTheDocument();
    expect(screen.getByText(/bis 31\.12\.2037 aufbewahrt/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import übernehmen" })).toBeNull();
  });
});
