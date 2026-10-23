import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ChainCard, DocumentFlowActions } from "./document-actions";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  data: {} as Record<string, unknown>,
  result: {} as Record<string, unknown>,
  push: vi.fn(),
  info: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return backend.result[name] ?? null;
  },
  useAction: () => vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: backend.push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: backend.info } }));

type Doc = Parameters<typeof DocumentFlowActions>[0]["doc"];
const quote = (over: Record<string, unknown> = {}) =>
  ({
    _id: "q1",
    type: "quote",
    status: "sent",
    number: "AN-2026-0007",
    contactName: "Muster GmbH",
    validUntil: "2026-10-01",
    ...over,
  }) as unknown as Doc;

beforeEach(() => {
  backend.calls = [];
  backend.result = {};
  backend.push.mockReset();
  backend.info.mockReset();
  backend.data = { "members:me": { role: "owner" } };
});

const user = () => userEvent.setup();
const last = (name: string) => backend.calls.filter((c) => c.name === name).at(-1)?.args;

describe("DocumentFlowActions (F04 §6.3)", () => {
  test("QUO-05 a sent quote offers Angenommen/Abgelehnt/Neue Version/Zurückziehen; acceptance records name and channel", async () => {
    renderWithIntl(<DocumentFlowActions doc={quote()} targets={["order_confirmation", "invoice"]} />);
    const section = screen.getByRole("region", { name: "Nächste Schritte" });
    for (const label of ["Angenommen", "Abgelehnt", "Neue Version", "Umwandeln", "Zurückziehen"]) {
      expect(within(section).getByRole("button", { name: label })).toBeInTheDocument();
    }
    const u = user();
    await u.click(screen.getByRole("button", { name: "Angenommen" }));
    const dialog = screen.getByRole("dialog", { name: "Angebot als angenommen markieren" });
    expect(within(dialog).getByLabelText("Angenommen von")).toHaveValue("Muster GmbH");
    await u.selectOptions(within(dialog).getByLabelText("Weg"), "phone");
    await u.type(within(dialog).getByLabelText("Notiz"), "Telefonat mit Frau Muster");
    await u.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(last("documentFlows:accept")).toMatchObject({
      id: "q1",
      values: { byName: "Muster GmbH", channel: "phone", note: "Telefonat mit Frau Muster" },
    });
    expect(last("documentFlows:accept")).not.toHaveProperty("values.late");
  });

  test("QUO-05 an expired quote needs the „trotzdem annehmen“ confirmation (late acceptance)", async () => {
    renderWithIntl(<DocumentFlowActions doc={quote({ status: "expired" })} targets={[]} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Angenommen" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await u.click(within(dialog).getByRole("checkbox", { name: /am 01\.10\.2026 abgelaufen/ }));
    expect(save).toBeEnabled();
    await u.click(save);
    expect(last("documentFlows:accept")).toMatchObject({ values: { late: true } });
  });

  test("QUO-05 „Abgelehnt“ stores the date and the optional reason", async () => {
    renderWithIntl(<DocumentFlowActions doc={quote()} targets={[]} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Abgelehnt" }));
    const dialog = screen.getByRole("dialog", { name: "Angebot als abgelehnt markieren" });
    await u.type(within(dialog).getByLabelText("Grund (optional)"), " zu teuer ");
    await u.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(last("documentFlows:reject")).toMatchObject({ id: "q1", values: { reason: "zu teuer" } });
  });

  test("QUO-03 a rejected quote can be reopened with a reason of at least 3 characters", async () => {
    renderWithIntl(<DocumentFlowActions doc={quote({ status: "rejected" })} targets={[]} />);
    expect(screen.queryByRole("button", { name: "Angenommen" })).toBeNull();
    const u = user();
    await u.click(screen.getByRole("button", { name: "Wieder öffnen" }));
    const dialog = screen.getByRole("dialog", { name: "Abgelehntes Angebot wieder öffnen?" });
    const confirm = within(dialog).getByRole("button", { name: "Wieder öffnen" });
    await u.type(within(dialog).getByLabelText("Begründung"), "ab");
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("Begründung"), "er doch");
    await u.click(confirm);
    expect(last("documentFlows:reopen")).toEqual({ id: "q1", values: { reason: "aber doch" } });
  });

  test("QUO-15 „Zurückziehen“ withdraws the document with a reason", async () => {
    renderWithIntl(<DocumentFlowActions doc={quote({ status: "accepted" })} targets={[]} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Zurückziehen" }));
    const dialog = screen.getByRole("dialog", { name: "Angebot zurückziehen?" });
    expect(dialog).toHaveTextContent("Die Nummer bleibt vergeben");
    await u.type(within(dialog).getByLabelText("Begründung"), "Kunde hat storniert");
    await u.click(within(dialog).getByRole("button", { name: "Zurückziehen" }));
    expect(last("documentFlows:withdraw")).toEqual({ id: "q1", values: { reason: "Kunde hat storniert" } });
  });

  test("QUO-06 „Neue Version“ creates the revision draft and navigates to it", async () => {
    backend.result["documentFlows:revise"] = { id: "q2" };
    renderWithIntl(<DocumentFlowActions doc={quote()} targets={[]} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Neue Version" }));
    const dialog = screen.getByRole("dialog", { name: "Neue Version anlegen" });
    expect(dialog).toHaveTextContent("Inhalt von AN-2026-0007");
    await u.click(within(dialog).getByRole("button", { name: "Version anlegen" }));
    expect(last("documentFlows:revise")).toEqual({ id: "q1", values: {} });
    expect(backend.push).toHaveBeenCalledWith(expect.stringContaining("q2"));
  });

  test("QUO-09 a delivery note is marked as received by name", async () => {
    renderWithIntl(
      <DocumentFlowActions doc={quote({ type: "delivery_note", status: "sent", _id: "l1" })} targets={[]} />,
    );
    const u = user();
    await u.click(screen.getByRole("button", { name: "Als erhalten markieren" }));
    const dialog = screen.getByRole("dialog", { name: "Lieferschein als erhalten markieren" });
    const save = within(dialog).getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await u.type(within(dialog).getByLabelText("Empfangen von"), "Lager Nord");
    await u.click(save);
    expect(last("documentFlows:markReceived")).toMatchObject({ id: "l1", values: { byName: "Lager Nord" } });
  });

  test("QUO-10 „Umwandeln“ proposes the remaining quantities, takes optional lines and accepts the quote", async () => {
    backend.data["documentFlows:proposal"] = {
      allowed: true,
      acceptRequired: true,
      expired: false,
      lines: [
        { id: "ln1", name: "Beratung", quantityMilli: 10_000, unitCode: "HUR", optional: false, proposedMilli: 4_000 },
        { id: "ln2", name: "Wartung", quantityMilli: 1_000, unitCode: "C62", optional: true, proposedMilli: 1_000 },
      ],
    };
    backend.result["documentFlows:convert"] = { id: "inv9", notices: ["Preise neu berechnet"] };
    renderWithIntl(<DocumentFlowActions doc={quote()} targets={["order_confirmation", "invoice"]} />);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Umwandeln" }));
    const dialog = screen.getByRole("dialog", { name: "Angebot AN-2026-0007 umwandeln" });
    await u.selectOptions(within(dialog).getByLabelText("Neuer Beleg"), "invoice");
    const qty = within(dialog).getByLabelText(/Beratung/);
    expect(qty).toHaveValue("4");
    expect(dialog).toHaveTextContent("von 10");
    await u.clear(qty);
    await u.type(qty, "2,5");
    await u.click(within(dialog).getByRole("checkbox", { name: "Optionale Position übernehmen: Wartung" }));
    const accept = within(dialog).getByRole("checkbox", { name: "Angebot als angenommen markieren" });
    await u.click(accept);
    const confirm = within(dialog).getByRole("button", { name: "Entwurf erstellen" });
    expect(confirm).toBeDisabled();
    await u.click(accept);
    await u.click(confirm);
    expect(last("documentFlows:convert")).toEqual({
      id: "q1",
      values: {
        to: "invoice",
        mode: "quantities",
        quantities: { ln1: 2_500, ln2: 1_000 },
        optionalLineIds: ["ln2"],
        acceptSource: true,
      },
    });
    expect(backend.info).toHaveBeenCalledWith("Preise neu berechnet");
    expect(backend.push).toHaveBeenCalledWith(expect.stringContaining("inv9"));
  });

  test("DOC-33 a refused conversion shows the reason and keeps „Entwurf erstellen“ disabled", async () => {
    backend.data["documentFlows:proposal"] = {
      allowed: false,
      error: { code: "nothing_remaining", message: "Aus Auftrag AB-1 ist nichts mehr offen." },
      acceptRequired: false,
      expired: false,
      lines: [],
    };
    renderWithIntl(
      <DocumentFlowActions doc={quote({ type: "order_confirmation", status: "sent" })} targets={["invoice"]} />,
    );
    const u = user();
    await u.click(screen.getByRole("button", { name: "Rechnung erstellen" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Aus Auftrag AB-1 ist nichts mehr offen.");
    expect(within(dialog).getByRole("button", { name: "Entwurf erstellen" })).toBeDisabled();
  });

  test("DOC-02 no actions for drafts or for read-only roles", () => {
    const { container, rerender } = renderWithIntl(
      <DocumentFlowActions doc={quote({ status: "draft" })} targets={["invoice"]} />,
    );
    expect(container).toBeEmptyDOMElement();
    backend.data["members:me"] = { role: "viewer" };
    rerender(<DocumentFlowActions doc={quote()} targets={["invoice"]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ChainCard (DOC-34)", () => {
  test("DOC-34 lists every chain document with status, amount and invoicing progress; links the others", () => {
    const chain = {
      targets: [],
      invoicedBy: [],
      coveredBp: 0,
      documents: [
        {
          _id: "q1",
          type: "quote",
          number: "AN-2026-0007",
          status: "partially_invoiced",
          documentDate: "2026-09-01",
          grossCents: 119_000,
          currency: "EUR",
          coveredBp: 4_050,
          isCurrent: true,
        },
        {
          _id: "i1",
          type: "invoice",
          number: null,
          status: "draft",
          documentDate: "2026-10-02",
          grossCents: 47_600,
          currency: "EUR",
          coveredBp: 0,
          isCurrent: false,
        },
        {
          _id: "l1",
          type: "delivery_note",
          number: "LS-2026-0003",
          status: "accepted",
          documentDate: "2026-09-15",
          grossCents: 0,
          currency: "EUR",
          coveredBp: 0,
          isCurrent: false,
        },
      ],
    } as never;
    renderWithIntl(<ChainCard chain={chain} />);
    const list = screen.getByTestId("chain");
    expect(list).toHaveTextContent("Angebot AN-2026-0007");
    expect(list).toHaveTextContent("01.09.2026 · 40 % berechnet");
    expect(list).toHaveTextContent("1.190,00 €");
    expect(screen.getByRole("link", { name: "Rechnung (Entwurf)" })).toHaveAttribute(
      "href",
      expect.stringContaining("i1"),
    );
    expect(list).toHaveTextContent("Erhalten");
  });

  test("DOC-34 hidden while the chain has a single document", () => {
    const { container } = renderWithIntl(
      <ChainCard chain={{ documents: [{ _id: "x" }], targets: [], invoicedBy: [], coveredBp: 0 } as never} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
