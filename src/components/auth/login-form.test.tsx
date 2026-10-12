import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { LoginForm } from "./login-form";
import { authClientMock, hardNavigate, resetAuthMocks, router } from "./test-mocks";

vi.mock("@/lib/auth-client", async () => ({ authClient: (await import("./test-mocks")).authClientMock }));
vi.mock("next/navigation", async () => {
  const { router } = await import("./test-mocks");
  return { useRouter: () => router };
});

beforeEach(() => resetAuthMocks());

describe("/anmelden (04-ui-ux §4.9)", () => {
  test("SEC-01 sign-in offers the passkey first and the e-mail code as fallback, without a password field", () => {
    const { container } = renderWithIntl(<LoginForm />);
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Mit Passkey anmelden");
    expect(buttons[1]).toHaveAccessibleName("Code per E-Mail senden");
    expect(container.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByLabelText("E-Mail-Adresse")).toHaveAttribute("autocomplete", "username webauthn");
  });

  test("SEC-01 a successful passkey sign-in returns to the ?weiter target", async () => {
    authClientMock.signIn.passkey.mockResolvedValue({ data: { session: {}, user: {} }, error: null });
    renderWithIntl(<LoginForm redirectTo="/rechnungen" />);
    await userEvent.click(screen.getByRole("button", { name: "Mit Passkey anmelden" }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/rechnungen"));
  });

  test("SMOKE a cancelled passkey prompt shows a German error", async () => {
    renderWithIntl(<LoginForm />);
    await userEvent.click(screen.getByRole("button", { name: "Mit Passkey anmelden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Die Anmeldung mit Passkey wurde abgebrochen.");
  });

  test("SMOKE requesting a code validates the e-mail address first", async () => {
    renderWithIntl(<LoginForm />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "keine-adresse");
    await userEvent.click(screen.getByRole("button", { name: "Code per E-Mail senden" }));
    expect(await screen.findByText("Bitte eine gültige E-Mail-Adresse eingeben.")).toBeInTheDocument();
    expect(screen.getByLabelText("E-Mail-Adresse")).toHaveAttribute("aria-invalid", "true");
    expect(authClientMock.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  });

  test("SMOKE requesting a code sends a sign-in OTP and moves to the code step", async () => {
    authClientMock.emailOtp.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
    renderWithIntl(<LoginForm redirectTo="/rechnungen" />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), " inhaber@firma.de ");
    await userEvent.click(screen.getByRole("button", { name: "Code per E-Mail senden" }));
    await waitFor(() =>
      expect(authClientMock.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
        email: "inhaber@firma.de",
        type: "sign-in",
      }),
    );
    expect(router.push).toHaveBeenCalledWith("/anmelden/code?weiter=%2Frechnungen");
    expect(sessionStorage.getItem("anmelden.email")).toBe("inhaber@firma.de");
  });

  test("SMOKE an unknown address gets the same neutral answer (no account enumeration)", async () => {
    authClientMock.emailOtp.sendVerificationOtp.mockResolvedValue({ data: null, error: { status: 403 } });
    renderWithIntl(<LoginForm />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "fremd@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Code per E-Mail senden" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/anmelden/code"));
  });

  test("SMOKE throttled code requests show the waiting time", async () => {
    authClientMock.emailOtp.sendVerificationOtp.mockResolvedValue({
      data: null,
      error: { status: 429, retryAfter: 600 },
    });
    renderWithIntl(<LoginForm />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "inhaber@firma.de");
    await userEvent.click(screen.getByRole("button", { name: "Code per E-Mail senden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Zu viele Codes angefordert — bitte in 10 Minuten erneut versuchen.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  test("SMOKE first run explains that only the owner e-mail address is accepted", () => {
    renderWithIntl(<LoginForm firstRun />);
    expect(screen.getByText(/Ersteinrichtung/)).toBeInTheDocument();
  });

  test("SEC-01 during first run a refused address sees the German gate message instead of the code step", async () => {
    authClientMock.emailOtp.sendVerificationOtp.mockResolvedValue({
      data: null,
      error: { status: 403, message: "Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich." },
    });
    renderWithIntl(<LoginForm firstRun />);
    await userEvent.type(screen.getByLabelText("E-Mail-Adresse"), "fremd@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Code per E-Mail senden" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich.",
    );
    expect(router.push).not.toHaveBeenCalled();
  });
});
