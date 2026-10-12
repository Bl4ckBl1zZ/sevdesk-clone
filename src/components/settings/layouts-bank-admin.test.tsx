import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BankAccountsAdmin } from "./bank-accounts-admin";
import { LayoutsAdmin } from "./layouts-admin";

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
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const account = (over: Record<string, unknown>) => ({
  bankAccountId: "b1",
  name: "Geschäftskonto",
  currency: "EUR",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  accountHolder: "Muster GmbH",
  ledgerAccount: "1200",
  showOnInvoices: true,
  isDefaultForInvoices: true,
  archivedAt: null,
  ...over,
});

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  toast.error.mockReset();
  backend.data = {
    "settings:listInvoiceAccounts": [
      account({}),
      account({ bankAccountId: "b2", name: "Rücklagen", iban: "DE02120300000000202051", isDefaultForInvoices: false }),
    ],
    "settings:listLayoutsWithDefaults": [
      {
        layoutId: "l1",
        name: "Standard",
        isDefaultFor: ["invoice", "quote"],
        version: 3,
        template: "classic",
        accentColor: "#16a34a",
      },
      { layoutId: "l2", name: "Angebote modern", isDefaultFor: [], version: 1, template: "modern", accentColor: "#1F6FEB" },
    ],
  };
});

describe("Rechnungskonten (F01 SET-050…054)", () => {
  test("SET-051 SET-054 the default account offers only „Archivieren“; another account can become the default", async () => {
    renderWithIntl(<BankAccountsAdmin />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Standard")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByRole("button", { name: /Als Standard/ })).toBeNull();
    await userEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: /Als Standard/ }));
    expect(backend.mutations["settings:setDefaultBankAccount"]).toHaveBeenCalledWith({ bankAccountId: "b2" });
    expect(toast.success).toHaveBeenCalledWith("Standardkonto geändert.");
  });

  test("SET-050 a further account is validated with the IBAN rules before it is sent", async () => {
    renderWithIntl(<BankAccountsAdmin />);
    await userEvent.click(screen.getByRole("button", { name: "Konto hinzufügen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Bezeichnung/), "Zweitkonto");
    await userEvent.type(within(dialog).getByLabelText(/^IBAN/), "DE00 1234");
    await userEvent.type(within(dialog).getByLabelText(/Kontoinhaber/), "Muster GmbH");
    await userEvent.click(within(dialog).getByRole("button", { name: "Konto hinzufügen" }));
    expect((await within(dialog).findAllByText("Die IBAN ist ungültig.")).length).toBeGreaterThan(0);
    expect(backend.mutations["settings:addBankAccount"]).not.toHaveBeenCalled();
  });
});

describe("Layouts (F01 SET-073, SET-074)", () => {
  test("SET-074 each layout shows its document types; „Standard festlegen“ sends the chosen types", async () => {
    renderWithIntl(<LayoutsAdmin />);
    expect(screen.getByText("Standard für: Rechnung, Angebot")).toBeInTheDocument();
    expect(screen.getByText("Für keine Dokumentart Standard")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Standard festlegen.*Angebote modern/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Angebot"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(backend.mutations["settings:setLayoutDefaults"]).toHaveBeenCalledWith({ layoutId: "l2", docTypes: ["quote"] });
  });

  test("SET-073 the preview form opens the PDF route with sample type, recipient, KU switch and layout", () => {
    renderWithIntl(<LayoutsAdmin />);
    const button = screen.getByRole("button", { name: "Vorschau öffnen" });
    const form = button.closest("form") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/einstellungen/layouts/vorschau");
    expect(form.getAttribute("target")).toBe("_blank");
    const options = within(screen.getByLabelText("Dokument")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Rechnung", "Angebot", "Mahnung", "Lieferschein"]);
    expect(screen.getByLabelText("Empfänger")).toHaveAttribute("name", "kunde");
    expect(screen.getByLabelText("Besteuerung")).toHaveAttribute("name", "ku");
    expect(within(screen.getByLabelText("Layout")).getByRole("option", { name: "Angebote modern" })).toHaveValue("l2");
  });
});
