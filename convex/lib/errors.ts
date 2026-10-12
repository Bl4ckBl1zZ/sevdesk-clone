import { ConvexError, type Value } from "convex/values";

/**
 * Structured application errors. Clients receive `{ code, message }` (German message for the UI); REST/MCP
 * map `code` to HTTP status / problem+json (05 §3).
 */
export const ERRORS = {
  unauthenticated: "Bitte melden Sie sich an.",
  session_invalid: "Sitzung abgelaufen. Bitte melden Sie sich erneut an.",
  not_a_member: "Für dieses Konto besteht kein Zugang.",
  member_expired: "Ihr Zugang ist abgelaufen.",
  member_disabled: "Ihr Zugang wurde beendet.",
  forbidden_role: "Ihre Rolle erlaubt diese Aktion nicht.",
  forbidden_scope: "Der API-Schlüssel hat nicht die nötige Berechtigung.",
  key_revoked: "Der API-Schlüssel ist widerrufen oder abgelaufen.",
  signup_forbidden: "Für diese E-Mail-Adresse besteht keine Einladung.",
  otp_throttled: "Zu viele Codes angefordert — bitte später erneut versuchen.",
  totp_required: "Bitte geben Sie den Code aus Ihrer Authenticator-App ein.",
  audit_missing: "Interner Fehler: Änderung ohne Protokolleintrag abgelehnt.",
  immutable_record: "Dieser Datensatz ist unveränderlich (GoBD).",
  invalid_input: "Ungültige Eingabe.",
  not_found: "Nicht gefunden.",
  not_configured: "Nicht eingerichtet.",
  conflict: "Konflikt.",
  version_conflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
  setup_incomplete: "Die Einrichtung ist noch nicht abgeschlossen.",
} as const;

export type ErrorCode = keyof typeof ERRORS;

export type AppErrorData = { [key: string]: Value } & { code: ErrorCode; message: string };

export function appError(code: ErrorCode, message?: string, extra?: Record<string, Value>): ConvexError<AppErrorData> {
  return new ConvexError<AppErrorData>({ code, message: message ?? ERRORS[code], ...(extra ?? {}) });
}

export function errorCode(e: unknown): string | undefined {
  if (e instanceof ConvexError && typeof e.data === "object" && e.data !== null && "code" in e.data) {
    return String((e.data as { code: unknown }).code);
  }
  if (e instanceof Error && "code" in e) return String((e as { code: unknown }).code);
  return undefined;
}
