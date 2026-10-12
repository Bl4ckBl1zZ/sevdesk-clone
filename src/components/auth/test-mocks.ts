import { vi } from "vitest";

/** Shared mocks for auth component tests (Better Auth client + Next router). */
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };

export const authClientMock = {
  signIn: { passkey: vi.fn(), emailOtp: vi.fn() },
  emailOtp: { sendVerificationOtp: vi.fn() },
  passkey: {
    addPasskey: vi.fn(),
    deletePasskey: vi.fn(),
    updatePasskey: vi.fn(),
    listUserPasskeys: vi.fn(),
  },
  useSession: vi.fn(() => ({ data: null, isPending: false, error: null, refetch: vi.fn() })),
  useListPasskeys: vi.fn(() => ({ data: [], isPending: false, error: null, refetch: vi.fn() })),
  listSessions: vi.fn(),
  revokeOtherSessions: vi.fn(),
  signOut: vi.fn(),
};

export function resetAuthMocks() {
  for (const fn of [
    ...Object.values(router),
    authClientMock.signIn.passkey,
    authClientMock.signIn.emailOtp,
    authClientMock.emailOtp.sendVerificationOtp,
    ...Object.values(authClientMock.passkey),
    authClientMock.listSessions,
    authClientMock.revokeOtherSessions,
    authClientMock.signOut,
  ]) {
    fn.mockReset();
  }
  authClientMock.signIn.passkey.mockResolvedValue({ data: null, error: { code: "AUTH_CANCELLED", status: 400 } });
  authClientMock.passkey.listUserPasskeys.mockResolvedValue({ data: [{ id: "pk1" }], error: null });
  sessionStorage.clear();
}
