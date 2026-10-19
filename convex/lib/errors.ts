import { ConvexError, type Value } from "convex/values";
import { CONFIRM_TOKEN_MESSAGES } from "../../src/domain/api/confirm";

/**
 * Structured application errors. Clients receive `{ code, message }` (German message for the UI); REST/MCP
 * map `code` to HTTP status / problem+json (05 §3).
 */
export const ERRORS = {
  unauthenticated: "Bitte melden Sie sich an.",
  session_invalid: "Sitzung abgelaufen. Bitte melden Sie sich erneut an.",
  reauth_required: "Zur Bestätigung bitte erneut mit Passkey bestätigen.",
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
  // F08 journal
  period_locked: "Der Zeitraum ist festgeschrieben.",
  posting_rejected: "Die Buchung ist nicht möglich.",
  role_unmapped: "Für diese Kontenrolle ist noch kein Konto zugeordnet.",
  account_unknown: "Das Konto ist im Kontenrahmen nicht vorhanden.",
  cash_negative: "Der Kassenbestand würde negativ werden.",
  already_posted: "Für diesen Beleg wurde bereits gebucht.",
  already_reversed: "Diese Buchung wurde bereits storniert.",
  chart_locked: "Der Kontenrahmen kann erst zum Beginn des nächsten Wirtschaftsjahres gewechselt werden.",
  bookkeeping_start_locked: "Der Buchungsbeginn kann nach der ersten Buchung nicht mehr geändert werden.",
  // 05 §3 idempotency
  idempotency_key_reused: "Dieser Idempotency-Key wurde bereits für eine andere Anfrage verwendet.",
  idempotency_in_progress: "Eine Anfrage mit diesem Idempotency-Key wird gerade verarbeitet.",
  // 06 §2.3 confirm tokens (messages: src/domain/api/confirm.ts)
  confirm_token_required: CONFIRM_TOKEN_MESSAGES.confirm_token_required,
  confirm_token_invalid: CONFIRM_TOKEN_MESSAGES.confirm_token_invalid,
  confirm_token_expired: CONFIRM_TOKEN_MESSAGES.confirm_token_expired,
  confirm_token_used: CONFIRM_TOKEN_MESSAGES.confirm_token_used,
  confirm_token_intent_mismatch: CONFIRM_TOKEN_MESSAGES.confirm_token_intent_mismatch,
  preview_outdated: CONFIRM_TOKEN_MESSAGES.preview_outdated,
  // F04 sales documents (§5.1, §4.6)
  illegal_transition: "Diese Aktion ist im aktuellen Status nicht möglich.",
  document_not_draft: "Das Dokument ist fertiggestellt und kann nicht mehr geändert werden.",
  validation_failed: "Das Dokument kann noch nicht fertiggestellt werden.",
  revalidation_failed:
    "Firmen- oder Kundendaten wurden während der Fertigstellung geändert. Bitte die Vorschau erneut prüfen.",
  integrity_alert_open:
    "Die Integritätsprüfung hat einen Fehler gemeldet. Bitte zuerst unter Einstellungen › System prüfen und bestätigen.",
  number_conflict: "Die Nummer ist bereits vergeben. Bitte den Nummernkreis prüfen.",
  einvoice_validation_failed: "Die E-Rechnung ist ungültig.",
  dependency_unavailable:
    "Die E-Rechnungs-Prüfung ist gerade nicht erreichbar. Fertigstellen ist erst nach erfolgreicher Prüfung möglich – bitte später erneut versuchen.",
  artifacts_not_ready: "PDF/E-Rechnung wird noch erzeugt.",
  artifacts_blocked: "Die E-Rechnung konnte nicht erzeugt werden – Export und Versand gesperrt.",
  mark_sent_invalid: "Die Versandmarkierung ist nicht möglich.",
  retraction_invalid: "Die Versandmarkierung kann nicht zurückgenommen werden.",
  resend_original_reason: "Bitte begründen, warum das Original erneut exportiert wird (wird protokolliert).",
  clock_skew: "Die Serveruhr weicht zu stark ab. Fertigstellen ist gesperrt, bis die Uhrzeit korrigiert ist.",
  // F08 P2: Festschreibung, Steuermeldungen, Anlagen
  period_lock_blocked: "Die Festschreibung ist nicht möglich.",
  transfer_ticket_required: "Bitte das Transferticket aus dem ELSTER-Übermittlungsprotokoll eintragen.",
  sheet_changed: "Die Werte haben sich seit dem Öffnen der Ausfüllhilfe geändert.",
  cross_check_mismatch: "Der Kontrollwert aus ELSTER weicht von der Buchhaltung ab.",
  filing_blocked: "Die Meldung kann noch nicht erfasst werden.",
  asset_rejected: "Die Anlagenbuchung ist nicht möglich.",
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
