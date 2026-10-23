import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContactImport } from "@/components/contacts/contact-import";
import { ProductImport } from "@/components/products/product-import";
import { renderWithIntl } from "@/i18n/test-utils";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  preview: [] as unknown[],
  commit: [] as unknown[],
  commitError: null as Error | null,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: async (ref: unknown, args: unknown) => {
      backend.calls.push({ name: getFunctionName(ref as never), args });
      return backend.preview;
    },
  }),
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    if (backend.commitError) throw backend.commitError;
    return backend.commit;
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const CSV =
  "Firma;Ort;E-Mail;Unbekannt\nMuster GmbH;Berlin;rechnung@muster.de;x\nBeta AG;Hamburg;rechnung@muster.de;y\n;;;\n";
const csvFile = (text: string, name = "kontakte.csv") => new File([text], name, { type: "text/csv" });

beforeEach(() => {
  backend.calls = [];
  backend.commitError = null;
  toast.error.mockReset();
  backend.preview = [
    { rowNumber: 2, status: "new", message: null },
    { rowNumber: 3, status: "new", message: null },
  ];
  backend.commit = [
    { rowNumber: 2, status: "created" },
    { rowNumber: 3, status: "error", message: "E-Mail doppelt" },
  ];
});

describe("CSV import wizard (F02 §6.8, F03 PRD-080)", () => {
  test("CON-140 the file is parsed and the columns are auto-mapped (unknown columns are ignored)", async () => {
    renderWithIntl(<ContactImport />);
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("1. Datei");
    await userEvent.upload(screen.getByLabelText("CSV-Datei"), csvFile(CSV));
    expect(await screen.findByRole("heading", { name: "Spalten zuordnen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Feld: Firma")).toHaveValue("organizationName");
    expect(screen.getByLabelText("Feld: Ort")).toHaveValue("city");
    expect(screen.getByLabelText("Feld: E-Mail")).toHaveValue("email");
    expect(screen.getByLabelText("Feld: Unbekannt")).toHaveValue("");
    expect(screen.getByRole("row", { name: /Firma/ })).toHaveTextContent("Muster GmbH");
  });

  test("CON-141 the mapping check blocks the preview without „Firma“ or „Nachname“", async () => {
    renderWithIntl(<ContactImport />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("CSV-Datei"), csvFile(CSV));
    await user.selectOptions(await screen.findByLabelText("Feld: Firma"), "");
    await user.click(screen.getByRole("button", { name: "Vorschau prüfen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte mindestens „Firma“ oder „Nachname“ zuordnen.");
    expect(backend.calls).toHaveLength(0);
  });

  test("CON-141 preview: server statuses plus duplicate keys inside the file; „nur Fehler“ filters", async () => {
    renderWithIntl(<ContactImport />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("CSV-Datei"), csvFile(CSV));
    await user.click(await screen.findByRole("radio", { name: "Neue anlegen und vorhandene aktualisieren" }));
    await user.click(screen.getByRole("button", { name: "Vorschau prüfen" }));
    const section = await screen.findByRole("region", { name: "Vorschau" });
    const call = backend.calls.find((c) => c.name === "contacts:importPreview");
    const args = call?.args as { mode: string; rows: { rowNumber: number; values: unknown }[] };
    expect(args.mode).toBe("create_and_update");
    // the empty last line is skipped
    expect(args.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(args.rows[0]?.values).toMatchObject({ contact: { organizationName: "Muster GmbH" } });
    expect(section).toHaveTextContent("neu: 1 · Aktualisierung: 0 · Konflikt: 0 · Fehler: 1");
    expect(section).toHaveTextContent("Zeile 3 hat dieselbe E-Mail-Adresse wie Zeile 2.");
    await user.click(within(section).getByRole("checkbox", { name: "nur Fehler" }));
    expect(within(section).getAllByRole("row")).toHaveLength(2);
  });

  test("CON-142 the import commits the rows and summarises created, skipped and failed rows", async () => {
    renderWithIntl(<ContactImport />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("CSV-Datei"), csvFile(CSV));
    await user.click(await screen.findByRole("button", { name: "Vorschau prüfen" }));
    await user.click(await screen.findByRole("button", { name: "Import starten" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Import abgeschlossen: 1 angelegt, 0 aktualisiert, 0 übersprungen, 1 Fehler.",
    );
    expect(screen.getByRole("row", { name: /E-Mail doppelt/ })).toHaveTextContent("Fehler");
    const commit = backend.calls.find((c) => c.name === "contacts:importCommit");
    expect(commit?.args).toMatchObject({ mode: "create_only" });
    await user.click(screen.getByRole("button", { name: "Weitere Datei importieren" }));
    expect(screen.getByLabelText("CSV-Datei")).toBeInTheDocument();
  });

  test("CON-142 a failing commit shows the error and stays on the preview", async () => {
    backend.commitError = new Error("kaputt");
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithIntl(<ContactImport />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("CSV-Datei"), csvFile(CSV));
    await user.click(await screen.findByRole("button", { name: "Vorschau prüfen" }));
    await user.click(await screen.findByRole("button", { name: "Import starten" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "Vorschau" })).toBeInTheDocument();
  });

  test("CON-140 an empty file is rejected with a German message", async () => {
    renderWithIntl(<ContactImport />);
    await userEvent.upload(screen.getByLabelText("CSV-Datei"), csvFile(""));
    expect(await screen.findByRole("alert")).toHaveTextContent("Die Datei enthält keine Daten.");
  });

  test("PRD-080 products: name is required; preview and commit send the raw rows with the mapping", async () => {
    backend.preview = [
      { rowNumber: 2, status: "new", message: null },
      { rowNumber: 3, status: "update", message: "Artikel 1002 wird aktualisiert" },
    ];
    backend.commit = [
      { rowNumber: 2, status: "created" },
      { rowNumber: 3, status: "updated" },
    ];
    renderWithIntl(<ProductImport />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText("CSV-Datei"),
      csvFile("Artikelnummer;Name;VK netto\n1001;Kabel;1,50\n1002;Stecker;2,00\n", "produkte.csv"),
    );
    await user.selectOptions(await screen.findByLabelText("Feld: Name"), "");
    await user.click(screen.getByRole("button", { name: "Vorschau prüfen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte mindestens „Name“ zuordnen.");
    await user.selectOptions(screen.getByLabelText("Feld: Name"), "name");
    await user.click(screen.getByRole("button", { name: "Vorschau prüfen" }));
    expect(await screen.findByText("Artikel 1002 wird aktualisiert")).toBeInTheDocument();
    const preview = backend.calls.find((c) => c.name === "products:importPreview")?.args as {
      rows: { rowNumber: number; cells: string[] }[];
      mapping: (string | null)[];
    };
    expect(preview.rows[0]).toEqual({ rowNumber: 2, cells: ["1001", "Kabel", "1,50"] });
    expect(preview.mapping[1]).toBe("name");
    await user.click(screen.getByRole("button", { name: "Import starten" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 angelegt, 1 aktualisiert");
    expect(backend.calls.find((c) => c.name === "products:importCommit")?.args).toMatchObject({
      mode: "create_only",
    });
  });
});
