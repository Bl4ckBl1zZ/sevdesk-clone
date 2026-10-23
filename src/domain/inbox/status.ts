/**
 * Inbox item lifecycle (F06 §4.1, INB-010, INB-024, INB-028, EC-INB-12/13). Pure; `today` / `now` passed in.
 *
 *   new ──classify──▶ processing ──draft created──▶ needs_review ──voucher booked──▶ converted
 *    │                    │  (sidecar down: stays processing, retried with backoff ≤ 24 h, never „valid“)
 *    └─ exact hash / same Message-ID ─▶ duplicate ── „Trotzdem verarbeiten“ (reason) ─▶ processing
 *   new | processing | needs_review | duplicate ──reject (reason)──▶ rejected
 *   new | needs_review | duplicate ──split / merge (INB-009)──▶ superseded (kept; the new items carry the files)
 */
import { addDays, type CalendarDate } from "../time/calendar-date";

export const INBOX_STATUSES = [
  "new",
  "processing",
  "needs_review",
  "converted",
  "rejected",
  "duplicate",
  "superseded",
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export const REJECT_REASONS = [
  "no_business_document",
  "not_addressed_to_us",
  "faulty_invoice_correction_requested",
  "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const REJECT_REASON_LABEL_DE: Readonly<Record<RejectReason, string>> = {
  no_business_document: "Kein Geschäftsbeleg (Spam, Newsletter, privat)",
  not_addressed_to_us: "Nicht an uns adressiert",
  faulty_invoice_correction_requested: "Fehlerhafte Rechnung – Korrektur angefordert",
  other: "Sonstiges",
};

export const INBOX_MESSAGES = {
  rejectState: "Dieser Beleg kann in seinem aktuellen Status nicht abgelehnt werden.",
  rejectText: "Bitte den Grund kurz beschreiben (mindestens 5 Zeichen).",
  overrideReason: "Bitte angeben, warum die Dublette trotzdem verarbeitet wird (mindestens 5 Zeichen).",
  notDuplicate: "Der Beleg ist nicht als Dublette markiert.",
  duplicateFile: (when: string) => `Diese Datei wurde bereits erfasst (${when}).`,
  sidecarUnavailable: "E-Rechnungsprüfung derzeit nicht möglich – wird automatisch wiederholt.",
  sidecarGaveUp:
    "E-Rechnungsprüfung war 24 Stunden lang nicht möglich. Die Rechnung gilt nicht als geprüft – bitte später erneut prüfen lassen.",
  manual: "Bitte Belegdaten manuell erfassen.",
} as const;

/** Statuses an owner may reject from (converted items have a booked voucher; rejected stays rejected). */
export const canReject = (s: InboxStatus): boolean =>
  s === "new" || s === "processing" || s === "needs_review" || s === "duplicate";

/** VOU-050 „Trotzdem verarbeiten“: only for duplicates, with a reason. */
export const canOverrideDuplicate = (s: InboxStatus): boolean => s === "duplicate";

/**
 * EC-INB-12 retention of a rejected item (GOBD-20/21, F06 Q-04): `no_business_document` → purge-eligible after 90
 * days (manual purge only, logged; never automatic); faulty / not addressed to us / any parsed E-Rechnung → `letters6`
 * (31.12. of receipt year + 6). `other` keeps the conservative `letters6`.
 */
export function rejectRetention(input: { reason: RejectReason; receivedOn: CalendarDate; parsedEinvoice: boolean }): {
  retentionUntil: string;
  purgeEligibleFrom?: string;
} {
  const letters6 = `${Number(input.receivedOn.slice(0, 4)) + 6}-12-31`;
  if (input.reason === "no_business_document" && !input.parsedEinvoice) {
    const purge = addDays(input.receivedOn, 90);
    return { retentionUntil: purge, purgeEligibleFrom: purge };
  }
  return { retentionUntil: letters6 };
}

/**
 * INB-024 / EC-INB-13 retry schedule when the einvoice-tools sidecar is unavailable: 1, 5, 15, 30 min, then hourly,
 * capped so that the total wait stays within 24 h. Returns null once 24 h since the first attempt have passed —
 * the item then gets a draft with the verdict „nicht geprüft“ (acceptable: false), never „valid“.
 */
export const SIDECAR_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const STEPS_MIN = [1, 5, 15, 30, 60];

export function nextRetryDelayMs(attempts: number, firstAttemptAt: number, now: number): number | null {
  if (now - firstAttemptAt >= SIDECAR_GIVE_UP_MS) return null;
  const minutes = STEPS_MIN[Math.min(Math.max(attempts - 1, 0), STEPS_MIN.length - 1)] as number;
  const delay = minutes * 60_000;
  return Math.min(delay, firstAttemptAt + SIDECAR_GIVE_UP_MS - now);
}

/** Display label per status (UI chips, MCP). */
export const INBOX_STATUS_LABEL_DE: Readonly<Record<InboxStatus, string>> = {
  new: "Neu",
  processing: "In Verarbeitung",
  needs_review: "Zu prüfen",
  converted: "Gebucht",
  rejected: "Abgelehnt",
  duplicate: "Dublette",
  superseded: "Aufgeteilt/zusammengeführt",
};

/** /posteingang filter chips (F06 §6.1). */
export const INBOX_FILTERS = [
  "all",
  "new",
  "needs_review",
  "einvoice",
  "faulty",
  "duplicate",
  "rejected",
  "older_than_10_days",
] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export interface InboxFilterable {
  status: InboxStatus;
  receivedAt: number;
  einvoice?: { validation?: { acceptable: boolean } | undefined } | undefined;
  classification?: string | undefined;
}

/** Does an item match a filter chip? `older_than_10_days` = still open (not converted/rejected/superseded) and received > 10 days ago. */
export function matchesInboxFilter(item: InboxFilterable, filter: InboxFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "new":
      return item.status === "new" || item.status === "processing";
    case "needs_review":
      return item.status === "needs_review";
    case "einvoice":
      return item.einvoice !== undefined;
    case "faulty":
      return item.einvoice?.validation !== undefined && item.einvoice.validation.acceptable === false;
    case "duplicate":
      return item.status === "duplicate";
    case "rejected":
      return item.status === "rejected";
    case "older_than_10_days":
      return (
        item.status !== "converted" &&
        item.status !== "rejected" &&
        item.status !== "superseded" &&
        now - item.receivedAt > 10 * 24 * 60 * 60 * 1000
      );
  }
}
