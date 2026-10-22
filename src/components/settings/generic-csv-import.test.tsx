import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { importPrivacyNotice } from "@/domain/import/privacy-notice";
import { renderWithIntl } from "@/i18n/test-utils";
import { GenericCsvImport } from "./generic-csv-import";

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

const fn = (name: string) => {
  backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
  return backend.mutations[name];
};

const VIEW = {
  id: "imp1",
  status: "previewed",
  revision: 2,
  target: "contacts",
  file: {
    name: "kontakte.csv",
    sha256: "x",
    bytes: 100,
    encoding: "utf-8",
    delimiter: ";",
    headers: ["Kundennummer", "Firmenname", "Notiz"],
    samples: [["K-1", "Beispiel GmbH", ""]],
    rows: 1,
  },
  columns: { number: "Kundennummer" },
  preset: null,
  onExisting: "skip",
  presets: [
    {
      id: "shipped:lexoffice-contacts",
      name: "lexoffice Kontakte (ungeprüft)",
      columns: { number: "kundennummer", organizationName: "FIRMENNAME", notes: "Notiz" },
      unsure: true,
    },
  ],
  previewHash: "h",
  preview: {
    target: "contacts",
    counts: { rows: 1, new: 0, existing: 0, updates: 1, skipped: 0, duplicates: 0, errors: 0 },
    samples: [],
    problems: [
      {
        line: 2,
        status: "update",
        message: "Zeile 2: Kontakt existiert bereits (K-1). Die Stammdaten werden aktualisiert.",
        cells: [],
      },
    ],
    problemsTotal: 1,
    notices: [importPrivacyNotice("einem anderen System (CSV-Datei)")],
  },
  stats: {},
  log: [],
  error: null,
  startedAt: 0,
  committedAt: null,
};

beforeEach(() => {
  backend.data = {};
  backend.mutations = {};
  upload.mockReset();
  upload.mockResolvedValue("storage1");
  toast.success.mockReset();
});

describe("generic CSV import UI (F09 §5.3)", () => {
  test("E-IMP-15 an unclear encoding shows both readings; choosing one uploads the file again with that encoding", async () => {
    backend.data["csvImports:list"] = [];
    fn("csvImports:create").mockResolvedValue("imp1");
    fn("imports:generateUploadUrl").mockResolvedValue("https://upload");
    fn("csvImports:setFile")
      .mockResolvedValueOnce({
        needsEncoding: true,
        message: "Zeichenkodierung unklar – bitte Windows-1252 oder UTF-8 wählen.",
        samples: { "windows-1252": [["MÃ¼ller GmbH"]], "utf-8": [["Müller GmbH"]] },
      })
      .mockResolvedValueOnce({ rows: 1, encoding: "utf-8" });
    const user = userEvent.setup();
    renderWithIntl(<GenericCsvImport canRun canCommit />);
    await user.upload(screen.getByLabelText(/CSV-Datei wählen/), new File(["x"], "kontakte.csv", { type: "text/csv" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Zeichenkodierung unklar – bitte Windows-1252 oder UTF-8 wählen.",
    );
    expect(screen.getByText("MÃ¼ller GmbH")).toBeInTheDocument();
    expect(screen.getByText("Müller GmbH")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Als UTF-8 lesen" }));
    await waitFor(() => expect(fn("csvImports:setFile")).toHaveBeenCalledTimes(2));
    expect(fn("csvImports:setFile").mock.calls[1]?.[0]).toMatchObject({ importId: "imp1", encoding: "utf-8" });
    expect(fn("csvImports:create")).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("generic-import-encoding")).toBeNull());
  });

  test("E-IMP-17 E-IMP-18 IMP-013 the update option is saved with the mapping, the Art. 14 notice and the update rows are shown, the lexoffice preset maps by normalised header", async () => {
    backend.data["csvImports:list"] = [
      { id: "imp1", status: "previewed", target: "contacts", fileName: "kontakte.csv", startedAt: 0, stats: {} },
    ];
    backend.data["csvImports:get"] = VIEW;
    const user = userEvent.setup();
    renderWithIntl(<GenericCsvImport canRun canCommit />);
    expect(screen.getByRole("note")).toHaveTextContent("Art. 14 DSGVO");
    expect(screen.getByText(/Kontakt existiert bereits \(K-1\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 Datensätze übernehmen" })).toBeEnabled();

    await user.selectOptions(screen.getByLabelText("Gespeicherte Vorlage anwenden"), "shipped:lexoffice-contacts");
    await user.click(screen.getByRole("checkbox", { name: "Vorhandene Kontakte aktualisieren" }));
    await user.click(screen.getByRole("button", { name: "Zuordnung speichern" }));
    expect(fn("csvImports:setMapping")).toHaveBeenCalledWith({
      importId: "imp1",
      columns: { number: "Kundennummer", organizationName: "Firmenname", notes: "Notiz" },
      preset: "lexoffice Kontakte (ungeprüft)",
      onExisting: "update",
    });
  });
});
