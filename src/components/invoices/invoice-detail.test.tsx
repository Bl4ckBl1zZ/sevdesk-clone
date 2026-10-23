import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoiceDetail } from "./invoice-detail";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  data: {} as Record<string, unknown>,
  result: {} as Record<string, unknown>,
  download: vi.fn(),
}));
vi.mock("convex/react", () => {
  const record = (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return backend.result[name] ?? null;
  };
  return { useMutation: record, useAction: record, useConvex: () => ({ query: vi.fn() }) };
});
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/audit/entity-history", () => ({ EntityHistory: () => null }));
vi.mock("@/components/dunning/invoice-dunning-section", () => ({
  InvoiceDunningSection: () => <div data-testid="dunning-section" />,
}));
vi.mock("./invoice-editor", () => ({
  InvoiceEditor: ({ version, type }: { version: number; type: string }) => (
    <div data-testid="editor">
      {type} v{version}
    </div>
  ),
}));
vi.mock("./invoice-shared", async (orig) => ({
  ...(await orig<typeof import("./invoice-shared")>()),
  downloadExport: backend.download,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const snapshot = {
  type: "invoice",
  currency: "EUR",
  flags: {},
  einvoice: { format: "zugferd_en16931" },
  buyer: {
    name: "Muster GmbH",
    contactPerson: { name: "Erika Muster" },
    address: { street: "Hauptstr. 1", postalCode: "10115", city: "Berlin" },
  },
  texts: { subject: "Rechnung RE-2026-0042", headText: "Vielen Dank für Ihren Auftrag.", footText: "Zahlbar sofort." },
  lines: [
    { kind: "heading", position: 1, name: "Leistungen" },
    {
      kind: "item",
      position: 2,
      name: "Beratung",
      description: "Workshop Oktober",
      quantityMilli: 10_000,
      unitCode: "HUR",
      unitLabel: "Std.",
      unitPriceMicros: 1_200_000,
      vatCategory: "S",
      vatRateBp: 1900,
      netCents: 120_000,
    },
  ],
  totals: { netCents: 120_000, vatCents: 22_800, grossCents: 142_800 },
  notes: [{ id: "n1", de: "Leistungsdatum entspricht dem Rechnungsdatum." }],
};

const doc = (over: Record<string, unknown> = {}) => ({
  _id: "d1",
  type: "invoice",
  status: "sent",
  number: "RE-2026-0042",
  contactId: "c1",
  contactName: "Muster GmbH",
  documentDate: "2026-10-01",
  dueDate: "2026-10-15",
  currency: "EUR",
  totals: { grossCents: 142_800 },
  einvoice: { decision: "MUST_E" },
  artifactStatus: "ready",
  sentAt: 1,
  sentOn: "2026-10-02",
  version: 3,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  doc: doc(),
  lines: [],
  displayStatus: { token: "open", label: "Offen" },
  today: "2026-10-23",
  productChanged: [],
  files: { attachments: [], evidence: [], proofWarning: null },
  snapshot,
  buyer: { invoiceEmail: "rechnung@muster.de" },
  artifacts: [
    { _id: "f1", kind: "zugferd_pdf", variant: "original", name: "RE-2026-0042.pdf", sha256: "ab".repeat(32) },
    { _id: "f2", kind: "validation_report_kosit", variant: "original", name: "kosit.html", sha256: "cd".repeat(32) },
  ],
  sendLog: [
    {
      _id: "s1",
      kind: "mark_sent",
      sentOn: "2026-10-02",
      channel: "email_manual",
      note: "an Buchhaltung",
      at: 1,
    },
  ],
  exportEntries: ["zugferd_pdf", "xml", "zip"],
  defaultMarkSelection: [],
  register: {
    number: "RE-2026-0042",
    rangeId: "r1",
    rangeName: "Rechnungen",
    periodKey: "2026",
    assignedAt: Date.UTC(2026, 9, 1, 8, 0),
    status: "issued",
    imported: false,
  },
  ...over,
});

beforeEach(() => {
  backend.calls = [];
  backend.result = {};
  backend.download.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "invoices:get": detail(),
    "documentFlows:chain": { documents: [], targets: [], invoicedBy: [], coveredBp: 0 },
  };
});

const user = () => userEvent.setup();
const last = (name: string) => backend.calls.filter((c) => c.name === name).at(-1)?.args;

describe("InvoiceDetail (F04 §6.4)", () => {
  test("DOC-29 a finalised invoice is read-only and shows the frozen snapshot, facts and register entry", () => {
    renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByRole("heading", { name: "Rechnung RE-2026-0042" })).toBeInTheDocument();
    expect(screen.getByText("Festgeschrieben")).toBeInTheDocument();
    const content = screen.getByRole("region", { name: "Inhalt" });
    expect(content).toHaveTextContent("Muster GmbH");
    expect(content).toHaveTextContent("z. Hd. Erika Muster");
    expect(content).toHaveTextContent("Hauptstr. 1, 10115 Berlin");
    expect(content).toHaveTextContent("Vielen Dank für Ihren Auftrag.");
    expect(content).toHaveTextContent("2. Beratung");
    expect(content).toHaveTextContent("10 Std. × 120,00");
    expect(content).toHaveTextContent("S 19 %");
    expect(content).toHaveTextContent("1.428,00 €");
    expect(content).toHaveTextContent("Leistungsdatum entspricht dem Rechnungsdatum.");
    const facts = screen.getByRole("region", { name: "Eckdaten" });
    expect(facts).toHaveTextContent("01.10.2026");
    expect(facts).toHaveTextContent("15.10.2026");
    expect(facts).toHaveTextContent("ZUGFeRD");
    expect(screen.getByTestId("register-entry")).toHaveTextContent("RE-2026-0042 · Rechnungen · 2026");
    expect(screen.getByRole("link", { name: "Im Nummernregister anzeigen" })).toHaveAttribute(
      "href",
      "/einstellungen/nummernkreise/register?range=r1&period=2026",
    );
    expect(screen.getByRole("link", { name: "Zum Kontakt" })).toHaveAttribute("href", "/kontakte/c1");
    expect(screen.getByTestId("artifacts")).toHaveTextContent(`SHA-256 ${"ab".repeat(32)}`);
    expect(screen.getByTestId("send-log")).toHaveTextContent(
      "Versendet am 02.10.2026 (E-Mail (selbst versendet)) – an Buchhaltung",
    );
    expect(screen.getByTestId("dunning-section")).toBeInTheDocument();
  });

  test("MAIL-02 „Als versendet markieren“ records channel, note and the handed-over files", async () => {
    backend.data["invoices:get"] = detail({ doc: doc({ sentAt: undefined }), sendLog: [] });
    renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByText("Noch nicht als versendet markiert.")).toBeInTheDocument();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Als versendet markieren" }));
    const dialog = screen.getByRole("dialog", { name: "Als versendet markieren" });
    // Validation reports are never handed over.
    expect(within(dialog).queryByText(/kosit\.html/)).toBeNull();
    await u.selectOptions(within(dialog).getByLabelText("Versandweg"), "post");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("muss elektronisch übermittelt werden");
    await u.selectOptions(within(dialog).getByLabelText("Versandweg"), "other");
    await u.click(within(dialog).getByRole("checkbox", { name: "Elektronisch übermittelt" }));
    await u.type(within(dialog).getByLabelText("Hinweis"), "per Portal");
    await u.click(within(dialog).getByRole("button", { name: "Markieren" }));
    expect(last("invoices:markSent")).toMatchObject({
      id: "d1",
      values: { channel: "other", note: "per Portal", electronicConfirmed: true, artifactIds: ["f1"] },
    });
  });

  test("MAIL-02 without files selected the mark cannot be saved; missing invoice e-mail is pointed out", async () => {
    backend.data["invoices:get"] = detail({ buyer: null });
    renderWithIntl(<InvoiceDetail id="d1" />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Erneut als versendet markieren" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Keine Rechnungs-E-Mail hinterlegt");
    await u.click(within(dialog).getByRole("checkbox", { name: /RE-2026-0042\.pdf · ZUGFeRD-PDF \(Original\)/ }));
    expect(within(dialog).getByRole("button", { name: "Markieren" })).toBeDisabled();
  });

  test("DOC-32 after the mark the export offers copies; the original needs a logged reason", async () => {
    backend.result["documentArtifacts:exportFiles"] = {
      files: [{ name: "a.pdf", url: "u" }],
      attachments: [],
      zipName: null,
    };
    renderWithIntl(<InvoiceDetail id="d1" />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Exportieren" }));
    expect(await screen.findByTestId("postal-hint")).toHaveTextContent("Per Post");
    await u.click(screen.getByRole("menuitem", { name: "Nur XML (Kopie)" }));
    expect(last("documentArtifacts:exportFiles")).toEqual({ id: "d1", request: { entry: "xml" } });
    expect(backend.download).toHaveBeenCalledWith([{ name: "a.pdf", url: "u" }], null);
    await u.click(screen.getByRole("button", { name: "Exportieren" }));
    await u.click(await screen.findByRole("menuitem", { name: "Original erneut exportieren" }));
    const dialog = screen.getByRole("dialog", { name: "Original erneut exportieren" });
    await u.type(within(dialog).getByLabelText("Begründung"), "Kunde hat Original verloren");
    await u.click(within(dialog).getByRole("button", { name: "Exportieren" }));
    expect(last("documentArtifacts:exportFiles")).toEqual({
      id: "d1",
      request: { entry: "zugferd_pdf", original: true, reason: "Kunde hat Original verloren" },
    });
  });

  test("MAIL-02 a mark can be retracted with a reason; retracted marks are labelled", async () => {
    renderWithIntl(<InvoiceDetail id="d1" />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Zurücknehmen" }));
    const dialog = screen.getByRole("dialog", { name: "Versandmarkierung zurücknehmen?" });
    await u.type(within(dialog).getByLabelText("Begründung"), "Falscher Kunde");
    await u.click(within(dialog).getByRole("button", { name: "Zurücknehmen" }));
    expect(last("invoices:retractMark")).toEqual({
      id: "d1",
      values: { retractsId: "s1", reason: "Falscher Kunde" },
    });
  });

  test("DOC-28 blocked artifacts: retry and „Stornieren und neu erstellen“ for an unsent invoice", async () => {
    backend.data["invoices:get"] = detail({
      doc: doc({ artifactStatus: "blocked", artifactError: "KoSIT nicht erreichbar", sentAt: undefined }),
      sendLog: [],
    });
    backend.data["corrections:cancelPreview"] = {
      original: { number: "RE-2026-0042", documentDate: "2026-10-01" },
      guard: null,
      mirror: null,
      notice: "",
    };
    renderWithIntl(<InvoiceDetail id="d1" />);
    const alert = screen.getAllByRole("alert")[0] as HTMLElement;
    expect(alert).toHaveTextContent("Die E-Rechnung konnte nicht erzeugt werden");
    expect(alert).toHaveTextContent("(KoSIT nicht erreichbar)");
    expect(screen.getByRole("button", { name: "Exportieren" })).toBeDisabled();
    const u = user();
    await u.click(within(alert).getByRole("button", { name: "Erneut erzeugen" }));
    expect(last("invoices:retryArtifacts")).toEqual({ id: "d1" });
    await u.click(within(alert).getByRole("button", { name: "Stornieren und neu erstellen" }));
    expect(await screen.findByText("Rechnung RE-2026-0042 stornieren und neu erstellen?")).toBeInTheDocument();
  });

  test("DOC-28 pending artifacts show the progress note", () => {
    backend.data["invoices:get"] = detail({ doc: doc({ artifactStatus: "pending" }) });
    renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByTestId("artifacts-pending")).toHaveTextContent("PDF und E-Rechnung werden erzeugt");
  });

  test("DOC-03 a draft opens the editor for writers and is read-only for viewers", () => {
    backend.data["invoices:get"] = detail({
      doc: doc({ status: "draft", number: undefined, sentAt: undefined }),
      values: { lines: [] },
      snapshot: null,
    });
    const { unmount } = renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByRole("heading", { name: "Rechnungsentwurf" })).toBeInTheDocument();
    expect(screen.getByTestId("editor")).toHaveTextContent("invoice v3");
    unmount();
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByText("Ihre Rolle erlaubt das Bearbeiten von Entwürfen nicht.")).toBeInTheDocument();
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  test("QUO-05 a quote shows validity, acceptance and the next steps; no payments or dunning", () => {
    backend.data["invoices:get"] = detail({
      doc: doc({
        type: "quote",
        number: "AN-2026-0007",
        status: "accepted",
        revision: 2,
        validUntil: "2026-11-01",
        acceptance: { date: "2026-10-05", byName: "Erika Muster" },
      }),
      snapshot: { ...snapshot, type: "quote" },
      register: null,
    });
    renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByRole("heading", { name: "Angebot AN-2026-0007" })).toBeInTheDocument();
    const facts = screen.getByRole("region", { name: "Eckdaten" });
    expect(facts).toHaveTextContent("Version2");
    expect(facts).toHaveTextContent("Gültig bis01.11.2026");
    expect(facts).toHaveTextContent("05.10.2026 von Erika Muster");
    expect(screen.getByRole("region", { name: "Nächste Schritte" })).toBeInTheDocument();
  });

  test("SMOKE loading and not-found states", () => {
    backend.data["invoices:get"] = undefined;
    const { container, unmount } = renderWithIntl(<InvoiceDetail id="d1" />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["invoices:get"] = null;
    renderWithIntl(<InvoiceDetail id="d1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Beleg nicht gefunden.");
  });
});
