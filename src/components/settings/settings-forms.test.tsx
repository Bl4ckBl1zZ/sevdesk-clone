import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SEEDED_RANGES } from "@/components/setup/seed-ranges";
import { companyDefaults } from "@/domain/schemas/settings";
import { renderWithIntl } from "@/i18n/test-utils";
import {
  BankSettings,
  CompanySettings,
  LayoutSettings,
  NumberRangesSettings,
  SaveButton,
  TaxSettings,
} from "./settings-forms";

const backend = vi.hoisted(() => ({
  state: undefined as unknown,
  data: {} as Record<string, unknown>,
}));
const actions = vi.hoisted(() => ({
  saveCompanyProfile: vi.fn(),
  saveTaxSettings: vi.fn(),
  saveBankAccount: vi.fn(),
  saveLayout: vi.fn(),
  saveNumberRanges: vi.fn(),
}));
vi.mock("@/components/setup/use-setup-state", () => ({
  useSetupState: () => backend.state,
  useSetupChecklist: () => undefined,
}));
vi.mock("@/components/setup/actions", async (orig) => ({
  ...(await orig<typeof import("@/components/setup/actions")>()),
  ...actions,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./shareholder-clearing", () => ({ ShareholderClearingPanel: () => null }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const company = {
  ...companyDefaults,
  name: "Max Mustermann",
  street: "Hauptstr. 1",
  postalCode: "10115",
  city: "Berlin",
  contactName: "Max Mustermann",
  phone: "+49 30 123456",
  email: "info@muster.de",
};

function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <SaveButton />
    </>
  );
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset().mockResolvedValue(undefined);
  actions.saveCompanyProfile.mockResolvedValue(8);
  toast.success.mockReset();
  toast.error.mockReset();
  backend.state = {
    version: 7,
    company,
    tax: { taxNumber: "21/815/08150", taxNumberState: "BE", vatId: "DE123456788" },
    bank: { iban: "DE89370400440532013000", bic: "COBADEFFXXX", accountHolder: "Max Mustermann", currency: "EUR" },
    layout: { template: "classic", accentColor: "#16a34a" },
    numberRanges: SEEDED_RANGES,
  };
  backend.data = {
    "settings:listInvoiceAccounts": [
      {
        name: "Revolut",
        iban: "DE89370400440532013000",
        bic: "REVOLT21",
        accountHolder: "Max",
        showOnInvoices: true,
        archivedAt: null,
      },
    ],
    "settings:companyChangeImpact": { drafts: 2 },
  };
});

describe("Einstellungen forms (F01 §6.3)", () => {
  test("SET-020 saving the company profile sends the loaded version and reports the drafts that follow", async () => {
    renderWithIntl(
      <Page>
        <CompanySettings />
      </Page>,
    );
    expect(screen.getByText("Bereits fertiggestellte Dokumente bleiben unverändert.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hauptstr. 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(actions.saveCompanyProfile).toHaveBeenCalled());
    expect(actions.saveCompanyProfile.mock.calls[0]?.[0]).toMatchObject({ name: "Max Mustermann", city: "Berlin" });
    expect(actions.saveCompanyProfile.mock.calls[0]?.[1]).toBe(7);
    expect(toast.success).toHaveBeenCalledWith("Gespeichert · 2 Entwürfe übernehmen die Änderung.");
  });

  test("SET-141 a version conflict shows the German server message instead of a success toast", async () => {
    actions.saveCompanyProfile.mockRejectedValue(
      new ConvexError({
        code: "version_conflict",
        message: "Die Einstellungen wurden inzwischen geändert. Bitte neu laden.",
      }),
    );
    renderWithIntl(
      <Page>
        <CompanySettings />
      </Page>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Die Einstellungen wurden inzwischen geändert. Bitte neu laden."),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("SET-020 the settings pages wait for the server state", () => {
    backend.state = undefined;
    const { container } = renderWithIntl(<BankSettings />);
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(screen.queryByText("Bereits fertiggestellte Dokumente bleiben unverändert.")).toBeNull();
  });

  test("SET-020 bank and layout settings save through their adapters", async () => {
    const { unmount } = renderWithIntl(
      <Page>
        <BankSettings />
      </Page>,
    );
    expect(screen.getByDisplayValue("DE89370400440532013000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(actions.saveBankAccount).toHaveBeenCalled());
    expect(actions.saveBankAccount.mock.calls[0]?.[0]).toMatchObject({
      iban: "DE89370400440532013000",
      currency: "EUR",
    });
    expect(toast.success).toHaveBeenCalledWith("Gespeichert.");
    unmount();
    renderWithIntl(
      <Page>
        <LayoutSettings />
      </Page>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(actions.saveLayout).toHaveBeenCalled());
    // The accent colour is not asserted: jsdom reports a react-hook-form-registered <input type="color"> as #000000.
    expect(actions.saveLayout.mock.calls[0]?.[0]).toMatchObject({ template: "classic", logo: null });
  });

  test("SET-059 raising „Nächste Nummer“ asks for the gap reason and saves again with it", async () => {
    actions.saveNumberRanges.mockRejectedValueOnce(
      new ConvexError({ code: "invalid_input", reason: "REASON_REQUIRED", message: "Begründung erforderlich." }),
    );
    renderWithIntl(
      <Page>
        <NumberRangesSettings />
      </Page>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    const dialog = await screen.findByRole("dialog", { name: "Nummern überspringen?" });
    expect(toast.error).not.toHaveBeenCalled();
    const save = within(dialog).getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Begründung (Lückenprotokoll)"), "Jahreswechsel");
    await user.click(save);
    await waitFor(() => expect(actions.saveNumberRanges).toHaveBeenCalledTimes(2));
    expect(actions.saveNumberRanges.mock.calls[1]?.[0]).toMatchObject({ reason: "Jahreswechsel" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("Gespeichert.");
  });

  test("SET-030 the tax page renders the tax form with the stored tax number", () => {
    renderWithIntl(<TaxSettings />);
    expect(screen.getByDisplayValue("21/815/08150")).toBeInTheDocument();
    expect(screen.getByDisplayValue("DE123456788")).toBeInTheDocument();
  });
});
