/**
 * PDF consent history (F02 CON-081/082, MAIL-01, EC-091) and §13b certificates (USt 1 TG, CON-070…072, UST-22,
 * EC-047). Both are history lists on the contact; nothing is ever removed (evidence, GOBD-06).
 */
import type { CalendarDate } from "../time/calendar-date";
import { addDays, formatGermanDate } from "../time/calendar-date";
import { type FieldIssue, fieldIssue, type Validation } from "./core";

export const CONSENT_SOURCES = ["email", "contract", "tacit", "portal"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_SOURCE_LABELS: Readonly<Record<ConsentSource, string>> = {
  email: "per E-Mail",
  contract: "im Vertrag",
  tacit: "stillschweigend",
  portal: "im Kundenportal",
};

export interface PdfConsent {
  readonly givenAt: string;
  readonly source: ConsentSource;
  readonly note?: string | undefined;
  readonly revokedAt?: string | undefined;
  readonly recordedAt: number;
}

/** §5.6: `givenAt` ≤ today, a note is mandatory for `tacit`. */
export function validateConsent(
  c: { givenAt: string; source: ConsentSource; note?: string | undefined },
  today: CalendarDate,
): Validation {
  const errors: FieldIssue[] = [];
  if (c.givenAt > today) {
    errors.push(fieldIssue("givenAt", "DATE_IN_FUTURE", "Das Datum der Zustimmung darf nicht in der Zukunft liegen."));
  }
  if (c.source === "tacit" && !(c.note ?? "").trim()) {
    errors.push(
      fieldIssue(
        "note",
        "CONSENT_NOTE_REQUIRED",
        "Bitte beschreiben, woraus sich die stillschweigende Zustimmung ergibt.",
      ),
    );
  }
  if ((c.note ?? "").length > 1000) {
    errors.push(fieldIssue("note", "TOO_LONG", "Der Text ist zu lang (max. 1.000 Zeichen)."));
  }
  return { errors, warnings: [] };
}

/** CON-082/E16/E17: a consent is valid on `date` if given on or before it and not revoked on or before it. */
export function consentValidOn(consents: readonly PdfConsent[], date: string): PdfConsent | undefined {
  return consents.find((c) => c.givenAt <= date && (c.revokedAt === undefined || c.revokedAt > date));
}

/** Revocation of the currently valid consent (keeps the history). Returns the index to revoke or an error. */
export function revocationTarget(
  consents: readonly PdfConsent[],
  revokedAt: CalendarDate,
  today: CalendarDate,
): { index: number } | { error: FieldIssue } {
  if (revokedAt > today) {
    return {
      error: fieldIssue("revokedAt", "DATE_IN_FUTURE", "Das Datum des Widerrufs darf nicht in der Zukunft liegen."),
    };
  }
  const index = consents.findIndex((c) => c.revokedAt === undefined);
  if (index < 0)
    return { error: fieldIssue("revokedAt", "NO_ACTIVE_CONSENT", "Es liegt keine aktive Zustimmung vor.") };
  const target = consents[index] as PdfConsent;
  if (revokedAt < target.givenAt) {
    return {
      error: fieldIssue("revokedAt", "REVOKED_BEFORE_GIVEN", "Der Widerruf kann nicht vor der Zustimmung liegen."),
    };
  }
  return { index };
}

/**
 * CON-082 send-dialog rule: PDF-only is offered when ER-03 returns MAY_PAPER_OR_PDF / NOT_REQUIRED, or
 * PDF_NEEDS_CONSENT with a consent valid on the send date.
 */
export function pdfOnlyAllowed(
  er03: "MUST_E" | "PDF_NEEDS_CONSENT" | "MAY_PAPER_OR_PDF" | "NOT_REQUIRED" | string,
  consents: readonly PdfConsent[],
  sendDate: string,
): boolean {
  if (er03 === "MAY_PAPER_OR_PDF" || er03 === "NOT_REQUIRED") return true;
  if (er03 === "PDF_NEEDS_CONSENT") return consentValidOn(consents, sendDate) !== undefined;
  return false;
}

// ── §13b certificates (USt 1 TG) ──────────────────────────────────────────────────────────────────────
export interface Certificate13b {
  readonly validUntil: string;
  readonly addedAt: number;
  readonly replacedAt?: number | undefined;
  readonly file?: { readonly sha256: string; readonly bytes: number; readonly mime: string } | undefined;
}

export const CERTIFICATE_MIME = ["application/pdf", "image/jpeg", "image/png"] as const;
export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;

/** §5.6 file rule and the "already expired" warning. */
export function validateCertificate(
  input: { validUntil: string; file?: { bytes: number; mime: string } | undefined },
  today: CalendarDate,
): Validation {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  if (
    input.file &&
    (!(CERTIFICATE_MIME as readonly string[]).includes(input.file.mime) || input.file.bytes > CERTIFICATE_MAX_BYTES)
  ) {
    errors.push(fieldIssue("file", "FILE_INVALID", "Bitte PDF, JPG oder PNG bis 10 MB hochladen."));
  }
  if (input.validUntil < today) {
    warnings.push(fieldIssue("validUntil", "CERTIFICATE_EXPIRED", "Die Bescheinigung ist bereits abgelaufen."));
  }
  return { errors, warnings };
}

/** CON-072: the latest entry is current; adding a new one marks the previous current entry replaced. */
export function currentCertificate<T extends Certificate13b>(history: readonly T[]): T | undefined {
  return history.filter((c) => c.replacedAt === undefined).at(-1);
}

export type CertificateGate =
  | { readonly kind: "ok" }
  | { readonly kind: "needs_confirmation"; readonly message: string; readonly reason: "missing" | "expired" };

export const CONSTRUCTION_CONFIRMATION_TEXT =
  "Der Kunde ist nachhaltig als Bauleistender tätig (Nachweis liegt anderweitig vor)";

/**
 * CON-071 (EC-047, T-CON-017): finalising a §13b document whose supply date is after `validUntil` (or without a
 * certificate) needs the audited confirmation with a reason, or a switch to domestic VAT.
 */
export function certificateGate(history: readonly Certificate13b[], supplyDate: string): CertificateGate {
  const current = currentCertificate(history);
  if (!current) {
    return {
      kind: "needs_confirmation",
      reason: "missing",
      message: `Keine Freistellungsbescheinigung (USt 1 TG) hinterlegt. Bestätigen: „${CONSTRUCTION_CONFIRMATION_TEXT}“ oder mit Umsatzsteuer abrechnen.`,
    };
  }
  if (current.validUntil < supplyDate) {
    return {
      kind: "needs_confirmation",
      reason: "expired",
      message: `Die Bescheinigung (USt 1 TG) war nur bis ${formatGermanDate(current.validUntil as CalendarDate)} gültig. Bestätigen: „${CONSTRUCTION_CONFIRMATION_TEXT}“ oder mit Umsatzsteuer abrechnen.`,
    };
  }
  return { kind: "ok" };
}

/** CON-071: notification 30 days before expiry. */
export function certificateExpiresSoon(history: readonly Certificate13b[], today: CalendarDate): boolean {
  const current = currentCertificate(history);
  return !!current && current.validUntil >= today && current.validUntil <= addDays(today, 30);
}
