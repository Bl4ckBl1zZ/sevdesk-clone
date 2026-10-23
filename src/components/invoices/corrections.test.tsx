import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { CorrectionActions, DraftBanner, RelationsPanel } from "./corrections";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  data: {} as Record<string, unknown>,
  result: {} as Record<string, unknown>,
  push: vi.fn(),
}));
vi.mock("convex/react", () => {
  const record = (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    const r = backend.result[name];
    if (r instanceof Error) throw r;
    return r ?? null;
  };
  return { useMutation: record, useAction: record };
});
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: backend.push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const snapshot = {
  lines: [
    { kind: "heading", position: 1, name: "Leistungen" },
    { kind: "item", position: 2, name: "Beratung", quantityMilli: 10_000, unitPriceMicros: 1_200_000 },
    { kind: "item", position: 3, name: "Reisekosten", quantityMilli: 1_000, unitPriceMicros: 2_500_000 },
  ],
} as never;
const invoice = { _id: "i1" as never, type: "invoice", status: "sent", number: "RE-2026-0042" };

const advance = (over: Record<string, unknown>) => ({
  id: "a1",
  type: "advance_invoice",
  number: "RE-2026-0010",
  documentDate: "2026-08-01",
  status: "sent",
  invoicedCents: 119_000,
  creditedCents: 0,
  receivedCents: 0,
  openCents: 119_000,
  deductedInNumber: null,
  resolution: "storno",
  ...over,
});
const relations = (over: Record<string, unknown> = {}) => ({
  original: null,
  cancelledBy: null,
  cancellationReason: null,
  corrections: [],
  chain: null,
  settlement: null,
  deductions: [],
  rectifiedFields: [],
  sentOrExported: true,
  ...over,
});

beforeEach(() => {
  backend.calls = [];
  backend.result = {};
  backend.push.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "corrections:cancelPreview": {
      original: { number: "RE-2026-0042", documentDate: "2026-10-01" },
      guard: null,
      mirror: null,
      notice: "",
    },
  };
});

const user = () => userEvent.setup();
const last = (name: string) => backend.calls.filter((c) => c.name === name).at(-1)?.args;

async function openMenuItem(name: string) {
  const u = user();
  await u.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
  await u.click(await screen.findByRole("menuitem", { name }));
  return u;
}

describe("CorrectionActions and the Korrektur-Assistent (F04 §4.8)", () => {
  test("INV-13 the assistant creates a Rechnungsberichtigung draft and opens it", async () => {
    backend.result["corrections:createCorrection"] = { id: "c1" };
    renderWithIntl(<CorrectionActions doc={invoice} snapshot={snapshot} />);
    const u = await openMenuItem("Korrigieren …");
    const dialog = screen.getByRole("dialog", { name: "Rechnung RE-2026-0042 korrigieren" });
    expect(within(dialog).getByRole("radio", { name: /Rechnungsberichtigung/ })).toBeChecked();
    await u.click(within(dialog).getByRole("button", { name: "Entwurf anlegen" }));
    expect(last("corrections:createCorrection")).toEqual({ originalId: "i1", kind: "rectification" });
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/c1");
  });

  test("INV-12 a Rechnungskorrektur sends only the changed positions as new quantity/price", async () => {
    backend.result["corrections:createCorrection"] = { id: "c2" };
    renderWithIntl(<CorrectionActions doc={invoice} snapshot={snapshot} />);
    const u = await openMenuItem("Korrigieren …");
    const dialog = screen.getByRole("dialog");
    await u.click(within(dialog).getByRole("radio", { name: /Rechnungskorrektur – Betrag mindern/ }));
    const create = within(dialog).getByRole("button", { name: "Entwurf anlegen" });
    expect(create).toBeDisabled();
    const lines = within(dialog).getByRole("list", { name: "Positionen mit neuer Menge oder neuem Preis" });
    expect(lines).toHaveTextContent("1. Beratung (10 × 120,00)");
    await u.type(within(dialog).getByLabelText("Neue Menge Pos. 1"), "8");
    await u.type(within(dialog).getByLabelText("Neuer Einzelpreis Pos. 2"), "20,00");
    await u.click(create);
    expect(last("corrections:createCorrection")).toEqual({
      originalId: "i1",
      kind: "credit",
      changes: [
        { position: 1, quantityMilli: 8_000 },
        { position: 2, unitPriceMicros: 200_000 },
      ],
    });
  });

  test("INV-12 „Gesamten Rechnungsbetrag korrigieren“ creates a full credit without line changes", async () => {
    backend.result["corrections:createCorrection"] = { id: "c3" };
    renderWithIntl(<CorrectionActions doc={invoice} snapshot={snapshot} />);
    const u = await openMenuItem("Korrigieren …");
    const dialog = screen.getByRole("dialog");
    await u.click(within(dialog).getByRole("radio", { name: /Rechnungskorrektur/ }));
    await u.click(within(dialog).getByRole("checkbox", { name: /Gesamten Rechnungsbetrag korrigieren/ }));
    expect(within(dialog).queryByLabelText("Neue Menge Pos. 1")).toBeNull();
    await u.click(within(dialog).getByRole("button", { name: "Entwurf anlegen" }));
    expect(last("corrections:createCorrection")).toEqual({ originalId: "i1", kind: "credit" });
  });

  test("INV-11 the Storno path of a paid invoice is blocked and points to the Rechnungskorrektur", async () => {
    backend.data["corrections:cancelPreview"] = {
      original: { number: "RE-2026-0042", documentDate: "2026-10-01" },
      guard: { code: "storno_paid_invoice", message: "Rechnung RE-2026-0042 ist (teil)bezahlt." },
      mirror: null,
      notice: "",
    };
    renderWithIntl(<CorrectionActions doc={invoice} snapshot={snapshot} />);
    const u = await openMenuItem("Korrigieren …");
    const dialog = screen.getByRole("dialog");
    await u.click(within(dialog).getByRole("radio", { name: /Storno – Rechnung vollständig aufheben/ }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("(teil)bezahlt");
    expect(within(dialog).getByRole("button", { name: "Weiter zum Storno" })).toBeDisabled();
    await u.click(within(dialog).getByRole("button", { name: "Rechnungskorrektur erstellen" }));
    expect(within(dialog).getByRole("radio", { name: /Rechnungskorrektur – Betrag mindern/ })).toBeChecked();
  });

  test("INV-10 „Weiter zum Storno“ opens the Storno dialog with the mirrored amounts", async () => {
    backend.data["corrections:cancelPreview"] = {
      original: { number: "RE-2026-0042", documentDate: "2026-10-01" },
      guard: null,
      mirror: {
        documentDate: "2026-10-23",
        currency: "EUR",
        totals: { netCents: -100_000, vatCents: -19_000, grossCents: -119_000 },
      },
      notice: "Die Stornorechnung wird heute datiert.",
    };
    renderWithIntl(<CorrectionActions doc={invoice} snapshot={snapshot} />);
    const u = await openMenuItem("Korrigieren …");
    await u.click(within(screen.getByRole("dialog")).getByRole("radio", { name: /Storno/ }));
    await u.click(screen.getByRole("button", { name: "Weiter zum Storno" }));
    expect(await screen.findByTestId("storno-gross")).toHaveTextContent("-1.190,00 €");
    expect(screen.getByTestId("storno-notice")).toHaveTextContent("Die Stornorechnung wird heute datiert.");
  });

  test("INV-03 an advance offers „Weitere Abschlagsrechnung“, which creates the next chain draft", async () => {
    backend.result["corrections:createChainDraft"] = { id: "a2" };
    renderWithIntl(
      <CorrectionActions doc={{ ...invoice, type: "advance_invoice", number: "RE-2026-0010" }} snapshot={null} />,
    );
    await openMenuItem("Weitere Abschlagsrechnung");
    expect(last("corrections:createChainDraft")).toEqual({ fromId: "i1", type: "advance_invoice" });
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/a2");
  });

  test("INV-07 the Schlussrechnung wizard blocks while an advance is unpaid (EC-DOC-55)", async () => {
    backend.data["corrections:relations"] = relations({
      chain: {
        rootId: "o1",
        order: { number: "AB-2026-0003", date: "2026-07-01" },
        advances: [
          advance({}),
          advance({
            id: "a2",
            number: "RE-2026-0011",
            receivedCents: 50_000,
            openCents: 69_000,
            resolution: "reduce",
          }),
        ],
        finals: [],
        drafts: [],
        canCreateFinal: true,
      },
    });
    backend.result["corrections:reduceAdvance"] = { id: "k1", version: 1 };
    backend.result["invoices:finalize"] = { number: "RK-1" };
    renderWithIntl(
      <CorrectionActions doc={{ ...invoice, type: "advance_invoice", number: "RE-2026-0010" }} snapshot={null} />,
    );
    const u = await openMenuItem("Schlussrechnung erstellen");
    const dialog = screen.getByRole("dialog", { name: "Schlussrechnung zu Auftrag AB-2026-0003" });
    expect(within(dialog).getByTestId("advance-not-settled")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Schlussrechnung anlegen" })).toBeDisabled();
    const row = within(dialog).getByTestId("advance-RE-2026-0011");
    expect(row).toHaveTextContent("1.190,00 €");
    expect(row).toHaveTextContent("500,00 €");
    expect(row).toHaveTextContent("Teilweise bezahlt – auf den erhaltenen Betrag mindern");
    await u.click(within(row).getByRole("button", { name: "Auf 500,00 € mindern" }));
    expect(last("corrections:reduceAdvance")).toEqual({ advanceId: "a2" });
    expect(last("invoices:finalize")).toEqual({ id: "k1", version: 1 });
    await u.click(
      within(within(dialog).getByTestId("advance-RE-2026-0010")).getByRole("button", { name: "Stornieren" }),
    );
    expect(await screen.findByText("Rechnung RE-2026-0042 stornieren?")).toBeInTheDocument();
  });

  test("INV-06 with all advances settled the wizard creates the final invoice draft", async () => {
    backend.data["corrections:relations"] = relations({
      chain: {
        rootId: "o1",
        order: { number: "AB-2026-0003", date: "2026-07-01" },
        advances: [advance({ receivedCents: 119_000, openCents: 0, resolution: "settled" })],
        finals: [],
        drafts: [],
        canCreateFinal: true,
      },
    });
    backend.result["corrections:createChainDraft"] = { id: "f1" };
    renderWithIntl(
      <CorrectionActions doc={{ ...invoice, type: "partial_invoice", number: "RE-2026-0010" }} snapshot={null} />,
    );
    const u = await openMenuItem("Schlussrechnung erstellen");
    await u.click(screen.getByRole("button", { name: "Schlussrechnung anlegen" }));
    expect(last("corrections:createChainDraft")).toEqual({ fromId: "i1", type: "final_invoice" });
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/f1");
  });

  test("INV-15 a credit correction can be cancelled; read-only roles and drafts get no menu", () => {
    const { rerender } = renderWithIntl(
      <CorrectionActions doc={{ ...invoice, type: "correction", correctionKind: "credit" }} snapshot={null} />,
    );
    expect(screen.getByRole("button", { name: "Weitere Aktionen" })).toBeInTheDocument();
    backend.data["members:me"] = { role: "viewer" };
    rerender(<CorrectionActions doc={invoice} snapshot={snapshot} />);
    expect(screen.queryByRole("button", { name: "Weitere Aktionen" })).toBeNull();
    backend.data["members:me"] = { role: "owner" };
    rerender(<CorrectionActions doc={{ ...invoice, status: "draft" }} snapshot={snapshot} />);
    expect(screen.queryByRole("button", { name: "Weitere Aktionen" })).toBeNull();
  });
});

describe("RelationsPanel and DraftBanner (F04 §6.4)", () => {
  test("INV-15 shows the original, the Storno, rectified fields, corrections and the deductions", () => {
    backend.data["corrections:relations"] = relations({
      original: {
        id: "o9",
        type: "invoice",
        correctionKind: null,
        number: "RE-2026-0001",
        documentDate: "2026-09-01",
        status: "sent",
        grossCents: 0,
      },
      cancelledBy: { id: "s1", number: "ST-2026-0001" },
      cancellationReason: "Doppelt erfasst",
      rectifiedFields: ["Anschrift"],
      corrections: [
        {
          id: "k1",
          type: "correction",
          correctionKind: "credit",
          number: null,
          documentDate: null,
          status: "draft",
          grossCents: -11_900,
        },
        {
          id: "k2",
          type: "correction",
          correctionKind: "rectification",
          number: "RK-2026-0002",
          documentDate: "2026-10-05",
          status: "cancelled",
          grossCents: 0,
        },
      ],
      chain: {
        rootId: "o1",
        order: { number: "AB-2026-0003", date: "2026-07-01" },
        advances: [advance({ resolution: "deducted", openCents: 0, receivedCents: 119_000 })],
        finals: [],
        drafts: [],
        canCreateFinal: false,
      },
      deductions: [{ advanceNumber: "RE-2026-0010", deductedGrossCents: 119_000 }],
    });
    renderWithIntl(<RelationsPanel id={"i1" as never} type="final_invoice" />);
    const panel = screen.getByTestId("relations");
    expect(panel).toHaveTextContent("Bezieht sich auf Rechnung RE-2026-0001 vom 01.09.2026");
    expect(screen.getByRole("status")).toHaveTextContent("Storniert durch ST-2026-0001 – Doppelt erfasst");
    expect(panel).toHaveTextContent("Berichtigt: Anschrift");
    expect(screen.getByRole("link", { name: "Rechnungskorrektur (Entwurf)" })).toHaveAttribute(
      "href",
      "/rechnungen/k1",
    );
    expect(panel).toHaveTextContent("-119,00 €");
    expect(panel).toHaveTextContent("(storniert)");
    expect(panel).toHaveTextContent("Abschlagskette zu Auftrag AB-2026-0003 vom 01.07.2026");
    expect(panel).toHaveTextContent("Abgezogen werden die tatsächlich erhaltenen Abschläge");
    expect(screen.getByTestId("deductions")).toHaveTextContent("Abgezogen: RE-2026-0010 (1.190,00 €)");
  });

  test("INV-15 hidden without relations", () => {
    backend.data["corrections:relations"] = relations();
    const { container } = renderWithIntl(<RelationsPanel id={"i1" as never} type="invoice" />);
    expect(container).toBeEmptyDOMElement();
  });

  test("INV-12 the draft banner explains the correction type; plain invoices get none", () => {
    const { rerender } = renderWithIntl(<DraftBanner type="correction" correctionKind="credit" />);
    expect(screen.getByTestId("draft-banner")).toHaveTextContent("Rechnungskorrektur: Mengen und Preise mindern");
    rerender(<DraftBanner type="invoice" />);
    expect(screen.queryByTestId("draft-banner")).toBeNull();
  });
});
