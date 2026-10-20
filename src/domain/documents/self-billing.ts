/**
 * Self-billing Gutschrift (F04 §4.9, INV-16; UST-11, UST-33). Pure.
 *
 * A Gutschrift (§ 14 Abs. 2 Satz 2 UStG) is issued by us as the recipient of a supply, on behalf of the supplier: it
 * is only allowed under a stored agreement with that supplier valid at the document date. Title always „Gutschrift“,
 * TypeCode 389, own range `GS-`, the note `sb_info`; seller = the supplier, buyer = our company.
 */
import type { CalendarDate } from "../time/calendar-date";
import { type Finding, finding } from "./validate/finding";

export interface SelfBillingAgreement {
  readonly agreedOn: string;
  readonly scope: string;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
}

export const SELF_BILLING_TITLE = "Gutschrift";
export const SELF_BILLING_TYPE_CODE = "389";
export const SELF_BILLING_NOTE_KEY = "sb_info";

/** The agreement covers `date` (validFrom ≤ date ≤ validTo, agreed on or before the date). */
export function agreementValidOn(a: SelfBillingAgreement | undefined | null, date: string): boolean {
  if (!a?.scope.trim()) return false;
  if (a.agreedOn > date || a.validFrom > date) return false;
  return a.validTo === undefined || a.validTo === "" || a.validTo >= date;
}

export const selfBillingAgreementMissingMessage = (supplier: string) =>
  `Mit ${supplier} ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG).`;

/** F04 §5 `self_billing_agreement_missing` (E, UST-33; EC-DOC-103). */
export function selfBillingFindings(input: {
  type: string;
  documentDate: CalendarDate | string;
  supplierName: string;
  agreement: SelfBillingAgreement | undefined | null;
}): Finding[] {
  if (input.type !== "self_billing") return [];
  if (agreementValidOn(input.agreement, input.documentDate)) return [];
  return [
    finding(
      "self_billing_agreement_missing",
      "E",
      "UST-33",
      "pflichtangaben",
      selfBillingAgreementMissingMessage(input.supplierName || "dem Lieferanten"),
      { field: "contact/selfBillingAgreement" },
    ),
  ];
}

/** Validates an agreement before it is stored on the supplier contact. */
export function agreementIssues(a: SelfBillingAgreement): string[] {
  const out: string[] = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(a.agreedOn)) out.push("Bitte das Datum der Vereinbarung angeben.");
  if (!iso.test(a.validFrom)) out.push("Bitte angeben, ab wann die Vereinbarung gilt.");
  if (a.validTo && !iso.test(a.validTo)) out.push("Ungültiges Enddatum.");
  if (a.validTo && iso.test(a.validFrom) && a.validTo < a.validFrom) out.push("Das Enddatum liegt vor dem Beginn.");
  if (!a.scope.trim()) out.push("Bitte den Umfang der Vereinbarung beschreiben (z. B. Provisionsabrechnungen).");
  return out;
}
