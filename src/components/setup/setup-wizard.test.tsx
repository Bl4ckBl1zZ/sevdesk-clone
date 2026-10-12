import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { authClientMock, resetAuthMocks, router } from "@/components/auth/test-mocks";
import { companyDefaults } from "@/domain/schemas/settings";
import { renderWithIntl } from "@/i18n/test-utils";
import { CompanyForm } from "./forms/company-form";
import { SetupWizard } from "./setup-wizard";

vi.mock("@/lib/auth-client", async () => ({
  authClient: (await import("@/components/auth/test-mocks")).authClientMock,
}));
vi.mock("next/navigation", async () => {
  const { router } = await import("@/components/auth/test-mocks");
  return { useRouter: () => router, usePathname: () => "/einrichtung" };
});
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

// Live server state (settings.getSetupState) and the Convex adapters are replaced; the real ones need a backend.
const setup = vi.hoisted(() => ({ state: undefined as unknown, saveNotificationEmail: vi.fn() }));
vi.mock("./use-setup-state", () => ({
  useSetupState: () => setup.state,
  useSetupChecklist: () => undefined,
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  saveNotificationEmail: setup.saveNotificationEmail,
}));

const serverState = (completedSteps: string[]) => ({
  version: 1,
  completedSteps,
  ownerEmail: "inhaber@firma.de",
  access: { baseDomain: "firma.de", hosts: [], checks: [] },
  email: { sender: "noreply@firma.de", accountId: "acc", tokenConfigured: true, notificationEmail: "inhaber@firma.de" },
  storage: { checks: [] },
});

beforeEach(() => {
  resetAuthMocks();
  toast.info.mockReset();
  toast.error.mockReset();
  setup.state = serverState([]);
  setup.saveNotificationEmail.mockReset().mockResolvedValue(undefined);
  authClientMock.useSession.mockReturnValue({
    data: { user: { email: "inhaber@firma.de" }, session: {} },
    isPending: false,
    error: null,
  } as never);
  authClientMock.useListPasskeys.mockReturnValue({ data: [], isPending: false, error: null } as never);
});

const nextButton = () => screen.getByRole("button", { name: "Weiter" });

describe("setup wizard (F01 §6.2)", () => {
  test("SET-009 „Weiter“ stays disabled until the owner has registered a passkey", async () => {
    const { rerender } = renderWithIntl(<SetupWizard stepSlug="inhaberkonto" />);
    expect(screen.getByRole("heading", { level: 1, name: "Inhaberkonto" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("inhaber@firma.de")).toHaveAttribute("readonly");
    await waitFor(() => expect(nextButton()).toBeDisabled());

    authClientMock.useListPasskeys.mockReturnValue({
      data: [{ id: "pk1", name: "MacBook", createdAt: "2026-10-12T10:00:00Z" }],
      isPending: false,
      error: null,
    } as never);
    rerender(<SetupWizard stepSlug="inhaberkonto" />);
    await waitFor(() => expect(nextButton()).toBeEnabled());
    await userEvent.click(nextButton());
    expect(router.push).toHaveBeenCalledWith("/einrichtung?schritt=zugriff", { scroll: true });
  });

  test("SET-002 progress shows the step position; Bank offers „Später“, Steuern does not", () => {
    const { rerender } = renderWithIntl(<SetupWizard stepSlug="bank" />);
    expect(screen.getAllByText("Schritt 8 von 11").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Später" })).toBeInTheDocument();
    rerender(<SetupWizard stepSlug="steuern" />);
    expect(screen.queryByRole("button", { name: "Später" })).toBeNull();
    const steps = screen.getByRole("navigation", { name: "Schritte der Einrichtung" });
    expect(within(within(steps).getByRole("list")).getAllByRole("link")).toHaveLength(11);
    expect(within(steps).getByRole("link", { current: "step" })).toHaveTextContent("Steuern");
  });

  test("SET-003 without a step the wizard waits for the server state and resumes at the first open step", () => {
    setup.state = undefined;
    const { container, rerender } = renderWithIntl(<SetupWizard stepSlug={null} />);
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    setup.state = serverState(["inhaberkonto", "zugriff"]);
    rerender(<SetupWizard stepSlug={null} />);
    expect(screen.getByRole("heading", { level: 1, name: "E-Mail-Versand" })).toBeInTheDocument();
  });

  test("SMOKE invalid company data blocks „Weiter“ with linked German errors", async () => {
    renderWithIntl(<SetupWizard stepSlug="unternehmen" />);
    await userEvent.click(nextButton());
    const name = await screen.findByLabelText(/Firma bzw\. vollständiger Name/);
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Bitte den Namen des Unternehmens angeben.");
    expect(screen.getByText("Straße oder Postfach fehlt.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  test("SET-140 a valid step is saved on the server before the wizard continues", async () => {
    renderWithIntl(<SetupWizard stepSlug="e-mail" />);
    await userEvent.click(nextButton());
    await waitFor(() =>
      expect(setup.saveNotificationEmail).toHaveBeenCalledWith({ notificationEmail: "inhaber@firma.de" }),
    );
    expect(router.push).toHaveBeenCalledWith("/einrichtung?schritt=speicher", { scroll: true });
    expect(toast.info).not.toHaveBeenCalled();
  });

  test("SET-141 a refused save shows the German server message and stays on the step", async () => {
    setup.saveNotificationEmail.mockRejectedValue(
      new ConvexError({ code: "invalid_input", message: "Bitte eine gültige E-Mail-Adresse angeben." }),
    );
    renderWithIntl(<SetupWizard stepSlug="e-mail" />);
    await userEvent.click(nextButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Bitte eine gültige E-Mail-Adresse angeben."));
    expect(router.push).not.toHaveBeenCalled();
  });

  test("SET-046 a server outside the EU shows the AO warning and requires the confirmation", async () => {
    renderWithIntl(<SetupWizard stepSlug="zugriff" />);
    await userEvent.selectOptions(screen.getByLabelText(/Serverstandort/), "US");
    expect(screen.getByText(/§ 146 Abs\. 2b AO/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Die Anwendung ist nur im Tailnet erreichbar"));
    await userEvent.click(nextButton());
    expect(await screen.findByLabelText(/Genehmigung des Finanzamts/)).toHaveAttribute("aria-invalid", "true");
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("company form (F01 §6.3)", () => {
  test("SET-011 choosing GmbH shows Registergericht, HRB and Geschäftsführer as mandatory and the footer delta", async () => {
    renderWithIntl(<CompanyForm id="f" defaultValues={companyDefaults} onValid={() => {}} />);
    expect(screen.queryByLabelText(/Registergericht/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/Rechtsform/), "gmbh");
    expect(screen.getByLabelText(/Registergericht/)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/Registernummer \(HRB\)/)).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("group", { name: /Geschäftsführer/ })).toBeInTheDocument();
    expect(
      screen.getByText("Pflichtangaben im Fußtext: + Sitz, + Registergericht, + HRB, + Geschäftsführer"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Fehlt: Registergericht, HRB-Registernummer, Geschäftsführer/)).toBeInTheDocument();
  });
});
