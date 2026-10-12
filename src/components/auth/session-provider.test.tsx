import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { SessionProvider, useSessionState } from "./session-provider";
import { authClientMock, resetAuthMocks } from "./test-mocks";

vi.mock("@/lib/auth-client", async () => ({ authClient: (await import("./test-mocks")).authClientMock }));
vi.mock("next/navigation", async () => {
  const { router } = await import("./test-mocks");
  return { useRouter: () => router };
});

const signedIn = { data: { user: { email: "inhaber@firma.de" }, session: {} }, isPending: false, error: null };
const signedOut = { data: null, isPending: false, error: null };

let api: ReturnType<typeof useSessionState> | null = null;
function Probe() {
  api = useSessionState();
  return <p>Inhalt</p>;
}

beforeEach(() => {
  resetAuthMocks();
  api = null;
});

describe("Sitzung abgelaufen (04-ui-ux §4.9)", () => {
  test("SMOKE the re-authentication dialog opens when an existing session disappears", () => {
    authClientMock.useSession.mockReturnValue(signedIn as never);
    const { rerender } = renderWithIntl(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    authClientMock.useSession.mockReturnValue(signedOut as never);
    rerender(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Sitzung abgelaufen" });
    expect(dialog).toHaveTextContent("Ungespeicherte Eingaben bleiben erhalten.");
    expect(screen.getByRole("button", { name: "Mit Passkey anmelden" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code per E-Mail senden" })).toBeInTheDocument();
    expect(api?.expired).toBe(true);
  });

  test("SMOKE no dialog without a previous session or after an intentional sign-out", () => {
    authClientMock.useSession.mockReturnValue(signedOut as never);
    const { rerender } = renderWithIntl(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    authClientMock.useSession.mockReturnValue(signedIn as never);
    rerender(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    act(() => api?.markSigningOut());
    authClientMock.useSession.mockReturnValue(signedOut as never);
    rerender(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("SMOKE an auth error from a Convex call can open the dialog", () => {
    authClientMock.useSession.mockReturnValue(signedIn as never);
    renderWithIntl(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    act(() => api?.markExpired());
    expect(screen.getByRole("dialog", { name: "Sitzung abgelaufen" })).toBeInTheDocument();
  });
});
