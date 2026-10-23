import type { MemberRole } from "../schemas/actor";
import { berlinCalendarDate } from "../time/berlin";
import { formatGermanDate } from "../time/calendar-date";
import { ROLE_LABEL_DE } from "./permissions";

/**
 * Refusal texts for members and auditors (F12 §5.2 E-AUD-29, §5.3 E-AUD-30/31/32). Pure.
 *
 * - A write by role `auditor` is answered with „Nur Lesezugriff.“ (every channel: Convex wrappers, Server Actions).
 * - An expired or deactivated auditor is told the date and whom to contact; other members keep the short texts.
 */

export const AUDITOR_READ_ONLY_MESSAGE = "Nur Lesezugriff.";

export function forbiddenRoleMessage(role: MemberRole): string {
  return role === "auditor"
    ? AUDITOR_READ_ONLY_MESSAGE
    : `Ihre Rolle (${ROLE_LABEL_DE[role]}) erlaubt diese Aktion nicht.`;
}

export function memberRefusalMessage(
  member: { role: MemberRole; expiresAt?: number | undefined; disabledAt?: number | undefined },
  access: "expired" | "disabled",
  companyName: string | undefined,
): string {
  if (member.role !== "auditor")
    return access === "expired" ? "Ihr Zugang ist abgelaufen." : "Ihr Zugang wurde beendet.";
  const at = access === "disabled" ? member.disabledAt : member.expiresAt;
  const date = at === undefined ? "" : ` am ${formatGermanDate(berlinCalendarDate(at))}`;
  const verb = access === "expired" ? "abgelaufen" : "beendet";
  const who = companyName?.trim() || "den Inhaber";
  return `Ihr Prüferzugang ist${date} ${verb}. Bitte wenden Sie sich an ${who}.`;
}
