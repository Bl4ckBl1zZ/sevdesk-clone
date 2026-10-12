import type messages from "@/i18n/messages/de.json";

export type AuthErrorKey = keyof (typeof messages)["auth"]["errors"];

export interface AuthErrorMessage {
  key: AuthErrorKey;
  values?: Record<string, string | number>;
}

interface ErrorLike {
  code?: string;
  status?: number;
  message?: string;
  /** Seconds until a throttled request may be retried (if the server sends it). */
  retryAfter?: number;
}

const BY_CODE: Record<string, AuthErrorKey> = {
  // email-otp plugin
  INVALID_OTP: "codeInvalid",
  OTP_EXPIRED: "codeInvalid",
  TOO_MANY_ATTEMPTS: "tooManyAttempts",
  // sign-up gate (02 §4.3): no invite / not OWNER_EMAIL during first run
  FORBIDDEN: "noInvite",
  // passkey plugin
  AUTH_CANCELLED: "passkeyCancelled",
  AUTHENTICATION_FAILED: "passkeyFailed",
  PASSKEY_NOT_FOUND: "passkeyFailed",
  CHALLENGE_NOT_FOUND: "passkeyFailed",
  REGISTRATION_CANCELLED: "passkeyRegistrationCancelled",
  PREVIOUSLY_REGISTERED: "passkeyAlreadyRegistered",
  FAILED_TO_VERIFY_REGISTRATION: "passkeyRegistrationFailed",
  YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY: "passkeyRegistrationFailed",
  SESSION_REQUIRED: "sessionRequired",
};

/**
 * Maps Better Auth client errors to German messages (04-ui-ux §4.9). Unknown errors fall back to `fallback`
 * so no English server text ever reaches the user.
 */
export function mapAuthError(error: unknown, fallback: AuthErrorKey = "unknown"): AuthErrorMessage {
  if (error instanceof TypeError) return { key: "network" };
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") return { key: "passkeyCancelled" };
    if (error.name === "NotSupportedError") return { key: "passkeyUnsupported" };
  }
  if (!error || typeof error !== "object") return { key: fallback };
  const e = error as ErrorLike;
  if (e.status === 429 || e.code === "TOO_MANY_REQUESTS" || e.code === "RATE_LIMITED") {
    const minutes = e.retryAfter ? Math.max(1, Math.ceil(e.retryAfter / 60)) : 60;
    return { key: "rateLimited", values: { minutes } };
  }
  if (e.code && BY_CODE[e.code]) return { key: BY_CODE[e.code] as AuthErrorKey };
  if (e.status === 403) return { key: "noInvite" };
  if (e.status === 0) return { key: "network" };
  return { key: fallback };
}
