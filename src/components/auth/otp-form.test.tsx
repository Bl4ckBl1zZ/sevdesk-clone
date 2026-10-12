import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { OtpForm } from "./otp-form";
import { authClientMock, hardNavigate, resetAuthMocks } from "./test-mocks";

vi.mock("@/lib/auth-client", async () => ({ authClient: (await import("./test-mocks")).authClientMock }));
vi.mock("next/navigation", async () => {
  const { router } = await import("./test-mocks");
  return { useRouter: () => router };
});

beforeEach(() => resetAuthMocks());
afterEach(() => vi.useRealTimers());

const digits = () => screen.getAllByRole("textbox");

describe("/anmelden/code (04-ui-ux §4.9)", () => {
  test("SMOKE six single-digit inputs with numeric keyboard and one-time-code autofill", () => {
    renderWithIntl(<OtpForm email="inhaber@firma.de" />);
    expect(digits()).toHaveLength(6);
    for (const input of digits()) expect(input).toHaveAttribute("inputmode", "numeric");
    expect(digits()[0]).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.getByText(/inhaber@firma\.de/)).toBeInTheDocument();
  });

  test("SMOKE pasting the code fills all inputs and signs in", async () => {
    authClientMock.signIn.emailOtp.mockResolvedValue({ data: { user: {} }, error: null });
    renderWithIntl(<OtpForm email="inhaber@firma.de" redirectTo="/kontakte" />);
    await userEvent.click(digits()[0] as HTMLElement);
    await userEvent.paste("123456");
    expect(digits().map((d) => (d as HTMLInputElement).value)).toEqual(["1", "2", "3", "4", "5", "6"]);
    await waitFor(() =>
      expect(authClientMock.signIn.emailOtp).toHaveBeenCalledWith({ email: "inhaber@firma.de", otp: "123456" }),
    );
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith("/kontakte"));
  });

  test("SMOKE typing moves focus to the next digit", async () => {
    renderWithIntl(<OtpForm email="inhaber@firma.de" />);
    await userEvent.click(digits()[0] as HTMLElement);
    await userEvent.keyboard("12");
    expect(digits()[2]).toHaveFocus();
    await userEvent.keyboard("{Backspace}");
    expect(digits()[1]).toHaveFocus();
    expect(digits()[1]).toHaveValue("");
  });

  test("SMOKE a wrong code shows „Der Code ist falsch oder abgelaufen.“", async () => {
    authClientMock.signIn.emailOtp.mockResolvedValue({ data: null, error: { code: "INVALID_OTP", status: 400 } });
    renderWithIntl(<OtpForm email="inhaber@firma.de" />);
    await userEvent.click(digits()[0] as HTMLElement);
    await userEvent.paste("000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Code ist falsch oder abgelaufen.");
  });

  test("SMOKE an address without invite learns it only after a valid code", async () => {
    authClientMock.signIn.emailOtp.mockResolvedValue({ data: null, error: { code: "FORBIDDEN", status: 403 } });
    renderWithIntl(<OtpForm email="fremd@example.org" />);
    await userEvent.click(digits()[0] as HTMLElement);
    await userEvent.paste("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent("Für diese E-Mail-Adresse besteht keine Einladung.");
  });

  test("SMOKE a member without passkey continues to the passkey enrolment", async () => {
    authClientMock.signIn.emailOtp.mockResolvedValue({ data: { user: {} }, error: null });
    authClientMock.passkey.listUserPasskeys.mockResolvedValue({ data: [], error: null });
    renderWithIntl(<OtpForm email="inhaber@firma.de" redirectTo="/einrichtung" />);
    await userEvent.click(digits()[0] as HTMLElement);
    await userEvent.paste("123456");
    await waitFor(() =>
      expect(hardNavigate).toHaveBeenCalledWith("/anmelden/passkey-einrichten?weiter=%2Feinrichtung"),
    );
  });

  test("SMOKE „Neuen Code senden“ is disabled for 60 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authClientMock.emailOtp.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
    renderWithIntl(<OtpForm email="inhaber@firma.de" />);
    expect(screen.getByRole("button", { name: /Neuen Code senden/ })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    const resend = screen.getByRole("button", { name: "Neuen Code senden" });
    expect(resend).toBeEnabled();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(resend);
    expect(authClientMock.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "inhaber@firma.de",
      type: "sign-in",
    });
  });

  test("SMOKE without a stored e-mail address the page links back to /anmelden", () => {
    renderWithIntl(<OtpForm email={null} />);
    expect(screen.getByText("Bitte zuerst Ihre E-Mail-Adresse eingeben.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Andere E-Mail-Adresse verwenden" })).toHaveAttribute("href", "/anmelden");
  });
});
