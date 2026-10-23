import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ContactDetail } from "./contact-detail";
import { AT, contactBundle } from "./test-fixtures";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return null;
  },
  useAction: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return { reused: false, message: "gültig" };
  },
}));
// Sub-screens with their own tests.
vi.mock("@/components/audit/entity-history", () => ({ EntityHistory: () => <div data-testid="entity-history" /> }));
vi.mock("@/components/payments/contact-receivables", () => ({
  ContactReceivables: ({ contactId }: { contactId: string }) => <div data-testid="receivables">{contactId}</div>,
}));
vi.mock("./contact-form", () => ({
  ContactForm: ({ contact }: { contact: { displayName: string } }) => (
    <div data-testid="contact-form">{contact.displayName}</div>
  ),
}));
vi.mock("./self-billing-agreement", () => ({ SelfBillingAgreementCard: () => <div data-testid="self-billing" /> }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

beforeEach(() => {
  backend.calls = [];
  router.push.mockReset();
  backend.data = { "members:me": { role: "owner" }, "contacts:get": contactBundle() };
});

describe("contact detail (F02 §6.3)", () => {
  test("CON-120 header, facts and the Verlauf tab with manual and derived entries, newest first", () => {
    renderWithIntl(<ContactDetail id="c1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Muster GmbH" })).toBeInTheDocument();
    expect(screen.getByText("10001 · Kunde, Lieferant")).toBeInTheDocument();
    const facts = screen.getByRole("complementary", { name: "Eckdaten" });
    expect(facts).toHaveTextContent("ATU12345678");
    expect(facts).toHaveTextContent("rechnung@muster.de (EM)");
    expect(facts).toHaveTextContent("14 Tage");
    expect(facts).toHaveTextContent("Unternehmen");
    expect(within(facts).getByRole("link", { name: /030 123456/ })).toHaveAttribute("href", "tel:+4930123456");
    // CON-152 supplier view
    const supplier = screen.getByTestId("supplier-stats");
    expect(supplier).toHaveTextContent("2.500,00 €");
    expect(supplier).toHaveTextContent("12.345,67 €");
    expect(supplier).toHaveTextContent("99,00 €");
    const timeline = screen.getAllByRole("list", { name: "Neuer Eintrag" })[0] as HTMLElement;
    const entries = within(timeline).getAllByRole("listitem");
    expect(entries.map((e) => e.textContent)).toEqual([
      expect.stringContaining("Mahnung prüfen"),
      expect.stringContaining("Rückruf wegen Angebot"),
      expect.stringContaining("USt-IdNr ATU12345678 geprüft: gültig"),
    ]);
    expect(entries[0]).toHaveTextContent("fällig am 20.10.2026");
    expect(entries[2]).toHaveTextContent("automatisch");
    expect(screen.getByRole("tab", { name: "Offene Posten" })).toBeInTheDocument();
  });

  test("CON-122 tasks can be marked done and manual entries deleted", async () => {
    renderWithIntl(<ContactDetail id="c1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Erledigt" }));
    expect(backend.calls.at(-1)).toEqual({
      name: "contacts:setTaskDone",
      args: { activityId: "act2", done: true },
    });
    await user.click(screen.getAllByRole("button", { name: "Löschen" }).at(-1) as HTMLElement);
    expect(backend.calls.at(-1)).toEqual({ name: "contacts:removeActivity", args: { activityId: "act1" } });
  });

  test("CON-121 the composer adds a note via contacts:addActivity; a task needs a due date", async () => {
    renderWithIntl(<ContactDetail id="c1" />);
    const user = userEvent.setup();
    const composer = screen.getByRole("form", { name: "Neuer Eintrag" });
    await user.selectOptions(within(composer).getByLabelText("Art"), "task");
    await user.type(within(composer).getByLabelText("Text"), "Angebot nachfassen");
    await user.click(within(composer).getByRole("button", { name: "Hinzufügen" }));
    expect(within(composer).getByLabelText("Fällig am")).toHaveAttribute("aria-invalid", "true");
    expect(backend.calls.some((c) => c.name === "contacts:addActivity")).toBe(false);
    await user.selectOptions(within(composer).getByLabelText("Art"), "call");
    await user.click(within(composer).getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.name === "contacts:addActivity")?.args).toMatchObject({
        contactId: "c1",
        values: { kind: "call", text: "Angebot nachfassen" },
      }),
    );
  });

  test("CON-171 archive, unarchive and delete; delete is blocked by references", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithIntl(<ContactDetail id="c1" />);
    await user.click(screen.getByRole("button", { name: "Archivieren" }));
    expect(backend.calls.at(-1)).toEqual({ name: "contacts:archive", args: { id: "c1" } });
    await user.click(screen.getAllByRole("button", { name: "Löschen" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Kontakt endgültig löschen?" });
    await user.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/kontakte"));
    expect(backend.calls.at(-1)).toEqual({ name: "contacts:remove", args: { id: "c1" } });
    unmount();

    const archived = contactBundle({ deleteBlockedBy: ["Rechnung RE-2026-0001"] });
    (archived.contact as { status: string }).status = "archived";
    backend.data["contacts:get"] = archived;
    renderWithIntl(<ContactDetail id="c1" />);
    expect(screen.getByText("archiviert")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Neuer Eintrag" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    expect(backend.calls.at(-1)).toEqual({ name: "contacts:unarchive", args: { id: "c1" } });
    await user.click(screen.getAllByRole("button", { name: "Löschen" })[0] as HTMLElement);
    const blocked = await screen.findByRole("dialog");
    expect(blocked).toHaveTextContent("Löschen nicht möglich (Rechnung RE-2026-0001) — bitte archivieren.");
    expect(within(blocked).getByRole("button", { name: "Löschen" })).toBeDisabled();
  });

  test("CON-133 merged, restricted and duplicate banners; undo a merge", async () => {
    const data = contactBundle({
      mergedInto: null,
      merges: [{ _id: "m1", at: AT, loser: { _id: "c9", number: "10009", displayName: "Muster G.m.b.H." }, moved: 3 }],
      duplicateHints: [{ id: "c5", number: "10005", displayName: "Muster Gmbh", reasons: ["vat_id"], score: 0.9 }],
    });
    (data.contact as { dsgvo?: unknown }).dsgvo = { restrictedAt: AT, scheduledPurgeAt: "2036-12-31" };
    backend.data["contacts:get"] = data;
    renderWithIntl(<ContactDetail id="c1" />);
    expect(screen.getByText(/Gesperrt nach Art\. 18 DSGVO.*Löschung ab 31\.12\.2036\./)).toBeInTheDocument();
    expect(screen.getByText(/Zusammengeführt: Muster G\.m\.b\.H\. \(10009\)/)).toBeInTheDocument();
    const hints = screen.getByRole("region", { name: "Mögliche Duplikate" });
    expect(hints).toHaveTextContent("Muster Gmbh (10005) — gleiche USt-IdNr");
    await userEvent.click(screen.getByRole("button", { name: "Rückgängig machen" }));
    expect(backend.calls.at(-1)).toEqual({ name: "contacts:undoMerge", args: { mergeId: "m1" } });
  });

  test("CON-133 a merged-away contact links to the winner and offers no actions", () => {
    const data = contactBundle({ mergedInto: { _id: "c2", number: "10002", displayName: "Ziel AG" } });
    (data.contact as { mergedIntoId?: string }).mergedIntoId = "c2";
    backend.data["contacts:get"] = data;
    renderWithIntl(<ContactDetail id="c1" />);
    expect(screen.getByRole("link", { name: "Ziel AG (10002)" })).toHaveAttribute("href", "/kontakte/c2");
    expect(screen.queryByRole("button", { name: "Archivieren" })).toBeNull();
  });

  test("CON-045 the tax tab shows the derived tax cases and warnings; persons tab lists contacts", async () => {
    renderWithIntl(<ContactDetail id="c1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Steuer & E-Rechnung" }));
    const profile = await screen.findByRole("region", { name: "Abgeleiteter Steuerfall" });
    expect(profile).toHaveTextContent("EU-B2B-Leistung (Reverse Charge)");
    expect(profile).toHaveTextContent("Innergemeinschaftliche Lieferung");
    expect(profile).toHaveTextContent("USt-IdNr vor der ersten Rechnung qualifiziert prüfen");
    expect(screen.getByRole("region", { name: "USt-IdNr-Prüfung" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Ansprechpartner" }));
    expect(await screen.findByRole("link", { name: /Erika Mustermann/ })).toHaveAttribute("href", "/kontakte/p1");
    expect(screen.getByRole("link", { name: "Ansprechpartner anlegen" })).toHaveAttribute(
      "href",
      "/kontakte/neu?parent=c1",
    );
    await user.click(screen.getByRole("tab", { name: "Stammdaten" }));
    expect(await screen.findByTestId("contact-form")).toHaveTextContent("Muster GmbH");
  });

  test("CON-009 viewers get the read-only master data and no actions", async () => {
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<ContactDetail id="c1" />);
    expect(screen.queryByRole("button", { name: "Archivieren" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Neuer Eintrag" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Stammdaten" }));
    expect(await screen.findByText("12/345/67890")).toBeInTheDocument();
    expect(screen.getByText("DE89370400440532013000")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-form")).toBeNull();
  });

  test("CON-120 loading and not-found states", () => {
    backend.data["contacts:get"] = undefined;
    const { unmount } = renderWithIntl(<ContactDetail id="c1" />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    unmount();
    backend.data["contacts:get"] = null;
    renderWithIntl(<ContactDetail id="c1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Kontakt nicht gefunden.");
  });
});
