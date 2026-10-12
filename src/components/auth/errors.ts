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
  // two-factor plugin
  INVALID_CODE: "totpInvalid",
  INVALID_TWO_FACTOR_COOKIE: "totpExpired",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "tooManyAttempts",
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

/** Server codes whose `message` is German text written by us (convex/auth.ts hooks) and shown verbatim. */
const SERVER_TEXT_CODES = new Set(["SIGNUP_FORBIDDEN", "OTP_THROTTLED"]);

const isGerman = (m: string | undefined): m is string => !!m && /[äöüß]|\b(der|die|das|für|bitte|nicht)\b/i.test(m);

/**
 * Maps Better Auth client errors to German messages (04-ui-ux §4.9). The sign-up gate (403), the OTP throttle
 * (429) and a failed code mail (503) carry our own German message, which is shown as is; everything else maps to a
 * fixed text. Unknown errors fall back to `fallback` so no English server text ever reaches the user.
 */
export function mapAuthError(error: unknown, fallback: AuthErrorKey = "unknown"): AuthErrorMessage {
  if (error instanceof TypeError) return { key: "network" };
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") return { key: "passkeyCancelled" };
    if (error.name === "NotSupportedError") return { key: "passkeyUnsupported" };
  }
  if (!error || typeof error !== "object") return { key: fallback };
  const e = error as ErrorLike;
  const serverText =
    (e.code && SERVER_TEXT_CODES.has(e.code)) || e.status === 403 || e.status === 429 || e.status === 503;
  if (serverText && isGerman(e.message)) return { key: "serverMessage", values: { message: e.message } };
  if (e.status === 429 || e.code === "TOO_MANY_REQUESTS" || e.code === "RATE_LIMITED" || e.code === "OTP_THROTTLED") {
    const minutes = e.retryAfter ? Math.max(1, Math.ceil(e.retryAfter / 60)) : 60;
    return { key: "rateLimited", values: { minutes } };
  }
  if (e.status === 503) return { key: "mailFailed" };
  if (e.code && BY_CODE[e.code]) return { key: BY_CODE[e.code] as AuthErrorKey };
  if (e.status === 403) return { key: "noInvite" };
  if (e.status === 0) return { key: "network" };
  return { key: fallback };
}

/** Errors the sign-in form shows instead of continuing to the code step. */
export function blocksCodeStep(error: AuthErrorMessage | null): boolean {
  return !!error && ["rateLimited", "network", "serverMessage", "mailFailed", "noInvite"].includes(error.key);
}
