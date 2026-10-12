import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { authClientMock, resetAuthMocks, router } from "@/components/auth/test-mocks";
import { renderWithIntl } from "@/i18n/test-utils";
import { CompanyForm } from "./forms/company-form";
import { companyDefaults } from "./schema";
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

beforeEach(() => {
  resetAuthMocks();
  toast.info.mockReset();
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

  test("SMOKE without a backend the wizard says so and never claims to have saved", async () => {
    renderWithIntl(<SetupWizard stepSlug="start" />);
    expect(await screen.findByText(/Noch nicht mit dem Server verbunden/)).toBeInTheDocument();
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

  test("SMOKE a valid step continues with the „Noch nicht verbunden“ notice", async () => {
    renderWithIntl(<SetupWizard stepSlug="e-mail" />);
    await userEvent.click(nextButton());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("Noch nicht verbunden", expect.anything()));
    expect(router.push).toHaveBeenCalledWith("/einrichtung?schritt=speicher", { scroll: true });
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
