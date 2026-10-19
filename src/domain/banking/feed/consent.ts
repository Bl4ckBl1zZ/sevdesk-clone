/**
 * Enable Banking consent lifecycle (F07 BNK-102, BNK-105, BNK-115, §4.1; EC-BNK-80…83, EC-158). Pure: the clock is
 * passed in, Europe/Berlin calendar days decide the reminder thresholds.
 */
import { berlinCalendarDate } from "../../time/berlin";
import { type CalendarDate, daysBetween, formatGermanDate } from "../../time/calendar-date";
import { FEED_MESSAGES } from "./messages";

/** PSD2 RTS Art. 10a (Delegated Regulation (EU) 2022/2360): AIS consent renewal every 180 days (research 13 §2). */
export const CONSENT_MAX_DAYS = 180;
export const DAY_MS = 86_400_000;
/** Single-use `state` nonce lifetime (BNK-102). */
export const STATE_TTL_MS = 10 * 60_000;
/** Reminder thresholds in days before `validUntil` (BNK-105). */
export const REMINDER_DAYS = [14, 3, 0] as const;
export type ReminderDays = (typeof REMINDER_DAYS)[number];

export type ConnectionStatus =
  | "not_configured"
  | "pending_consent"
  | "active"
  | "reauth_required"
  | "error"
  | "disconnected";

export const CONNECTION_STATUS_LABEL_DE: Readonly<Record<ConnectionStatus, string>> = {
  not_configured: "Nicht eingerichtet",
  pending_consent: "Freigabe ausstehend",
  active: "Aktiv",
  reauth_required: "Erneuerung nötig",
  error: "Fehler",
  disconnected: "Getrennt",
};

/**
 * BNK-115 (resolved 2026-10-19): the consent redirect target. Since the owner decision of 2026-10-18 the instance runs
 * in public edge mode (08 §12), so `app.<BASE_DOMAIN>` is a public HTTPS host that Enable Banking accepts in the
 * whitelist; the redirect is still performed by the owner's browser and nothing calls the app from outside.
 */
export const CALLBACK_PATH = "/einstellungen/bank/callback";
export const redirectUrlFor = (baseDomain: string): string =>
  `https://app.${baseDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}${CALLBACK_PATH}`;

/** BNK-102: `valid_until` = min(now + the ASPSP's `maximum_consent_validity`, now + 180 days). */
export function consentValidUntil(now: number, maximumConsentValiditySeconds?: number | null): number {
  const cap = now + CONSENT_MAX_DAYS * DAY_MS;
  if (!maximumConsentValiditySeconds || maximumConsentValiditySeconds <= 0) return cap;
  return Math.min(cap, now + maximumConsentValiditySeconds * 1000);
}

/** Berlin calendar days until the consent ends (0 = it ends today; negative = expired). */
export const consentDaysLeft = (validUntil: number, now: number): number =>
  daysBetween(berlinCalendarDate(now), berlinCalendarDate(validUntil));

/**
 * BNK-105 / EC-BNK-83 reminders: once per threshold. The most urgent due threshold is sent; larger thresholds that
 * were missed (e.g. the job did not run) are recorded as handled without a second notification.
 */
export function dueReminder(
  validUntil: number,
  now: number,
  sent: readonly number[],
): { daysBefore: ReminderDays; alsoHandled: ReminderDays[]; message: string } | null {
  const left = consentDaysLeft(validUntil, now);
  if (left < 0) return null;
  const due = REMINDER_DAYS.filter((d) => left <= d && !sent.includes(d));
  if (due.length === 0) return null;
  const daysBefore = due[due.length - 1] as ReminderDays;
  return {
    daysBefore,
    alsoHandled: due.filter((d) => d !== daysBefore),
    message: FEED_MESSAGES.expiring(formatGermanDate(berlinCalendarDate(validUntil) as CalendarDate)),
  };
}

/** §6.1/§6.5 banner while the consent ends within 14 days. */
export function expiryBanner(
  validUntil: number | undefined,
  now: number,
): { daysLeft: number; message: string } | null {
  if (validUntil === undefined) return null;
  const left = consentDaysLeft(validUntil, now);
  if (left < 0 || left > 14) return null;
  return {
    daysLeft: left,
    message: `Bankverbindung läuft am ${formatGermanDate(berlinCalendarDate(validUntil))} ab – jetzt erneuern`,
  };
}

/** „gültig bis 10.04.2027, noch 180 Tage“ (§6.5). */
export function validityLabel(validUntil: number, now: number): string {
  const left = Math.max(0, consentDaysLeft(validUntil, now));
  return `gültig bis ${formatGermanDate(berlinCalendarDate(validUntil))}, noch ${left} ${left === 1 ? "Tag" : "Tage"}`;
}

export type FeedErrorKind = "reauth" | "rate_limited" | "transient" | "jwt_rejected" | "client";

/**
 * Classifies an Enable Banking failure (§4.1, BNK-105/106, EC-BNK-81/82/86): `EXPIRED_SESSION`, a revoked/expired
 * consent, `401`/`403` on account data → `reauth`; a rejected application JWT → `jwt_rejected` (status `error`);
 * `429`/`ASPSP_RATE_LIMIT_EXCEEDED` → `rate_limited` (6 h backoff); `5xx`/network → `transient` (retry in budget).
 */
export function classifyFeedError(e: { status?: number; error?: string; message?: string }): FeedErrorKind {
  const code = (e.error ?? "").toUpperCase();
  const msg = (e.message ?? "").toLowerCase();
  if (e.status === 429 || code === "ASPSP_RATE_LIMIT_EXCEEDED") return "rate_limited";
  if (code.includes("JWT") || /\bjwt\b|application/.test(msg)) return "jwt_rejected";
  if (
    code === "EXPIRED_SESSION" ||
    code === "REVOKED_SESSION" ||
    code === "CLOSED_SESSION" ||
    code === "SESSION_DOES_NOT_EXIST" ||
    code.includes("CONSENT") ||
    e.status === 401 ||
    e.status === 403
  )
    return "reauth";
  if (e.status === undefined || e.status >= 500) return "transient";
  return "client";
}

export type ConnectionEvent =
  | "setup_saved"
  | "consent_started"
  | "consent_completed"
  | "consent_failed"
  | "expired"
  | "reauth"
  | "jwt_rejected"
  | "transient"
  | "poll_ok"
  | "disconnect";

/** §4.1 state machine; `null` = the event does not apply in this state. */
export function nextConnectionStatus(current: ConnectionStatus, event: ConnectionEvent): ConnectionStatus | null {
  switch (event) {
    case "disconnect":
      return "disconnected";
    case "setup_saved":
      return current === "not_configured" || current === "disconnected" ? "pending_consent" : current;
    case "consent_started":
      return current === "not_configured" ? null : "pending_consent";
    case "consent_completed":
      return current === "pending_consent" || current === "reauth_required" ? "active" : null;
    case "consent_failed":
      return current === "pending_consent" ? "pending_consent" : current;
    case "expired":
    case "reauth":
      return current === "active" || current === "error" ? "reauth_required" : current;
    case "jwt_rejected":
      return current === "disconnected" ? null : "error";
    case "transient":
      return current === "active" ? "error" : current;
    case "poll_ok":
      return current === "error" || current === "active" ? "active" : current;
  }
}

/** Whether unattended polling runs in this state (polling is paused on `reauth_required`, BNK-105). */
export const pollingActive = (s: ConnectionStatus): boolean => s === "active" || s === "error";
