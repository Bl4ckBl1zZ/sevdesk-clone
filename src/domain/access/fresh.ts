/**
 * Fresh session for ⚠ actions (02 §4.2 "Fresh session", 04 §4.9, F12 E-AUD-28). Mirrors Better Auth's
 * `freshAge` (convex/auth.ts `session.freshAge = 600`): a session counts as fresh for 10 minutes after it was
 * created. Re-authenticating (passkey assertion or a new e-mail code) creates a new session, which is fresh again.
 */
export const FRESH_AGE_MS = 600_000;

export const REAUTH_MESSAGE_DE = "Zur Bestätigung bitte erneut mit Passkey bestätigen.";

export function isSessionFresh(sessionCreatedAt: number | undefined, now: number): boolean {
  if (sessionCreatedAt === undefined || !Number.isFinite(sessionCreatedAt)) return false;
  if (sessionCreatedAt > now) return false;
  return now - sessionCreatedAt <= FRESH_AGE_MS;
}
