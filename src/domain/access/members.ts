import type { MemberRole } from "../schemas/actor";
import { AUDITOR_MAX_DAYS, DAY_MS } from "./signup";

/**
 * Member administration rules (04 §4.10 „Rolle ändern, Verlängern, Deaktivieren, Sitzungen abmelden", 02 §4.3,
 * F12 AUD-022/E-AUD-34). Pure; the Convex model applies the change and writes the audit entry.
 */
export const MEMBER_MESSAGES_DE = {
  owner_immutable: "Der Inhaber kann nicht geändert, verlängert oder deaktiviert werden.",
  owner_unique: "Es gibt genau einen Inhaber; diese Rolle kann nicht vergeben werden.",
  role_unchanged: "Das Mitglied hat bereits diese Rolle.",
  member_disabled: "Der Zugang wurde beendet. Bitte laden Sie die Person erneut ein.",
  auditor_expiry_required: "Für einen Prüferzugang ist ein Ablaufdatum erforderlich.",
  auditor_expiry_too_long: "Ein Prüferzugang ist höchstens 30 Tage gültig. Bitte verlängern Sie bei Bedarf.",
  auditor_scope_required: "Für einen Prüferzugang sind Zweck/Aktenzeichen und mindestens ein Geschäftsjahr nötig.",
  member_expiry_in_past: "Das Ablaufdatum muss in der Zukunft liegen.",
  extension_shorter: "Das neue Ablaufdatum muss nach dem bisherigen liegen. Zum Beenden „Deaktivieren“ verwenden.",
  reason_required: "Bitte einen Grund für die Verlängerung angeben (Prüfungsakte).",
} as const;

export type MemberError = keyof typeof MEMBER_MESSAGES_DE;

export interface MemberState {
  role: MemberRole;
  expiresAt?: number;
  disabledAt?: number;
  disabledReason?: string;
  auditor?: { purpose: string; fiscalYears: number[] };
}

/** `disabledReason` written by the members.expire cron (02 §7); only such members may be reactivated. */
export const EXPIRED_REASON = "expired";

const isHardDisabled = (m: MemberState) => m.disabledAt !== undefined && m.disabledReason !== EXPIRED_REASON;

function auditorExpiry(expiresAt: number | null | undefined, now: number): MemberError | null {
  if (expiresAt === undefined || expiresAt === null) return "auditor_expiry_required";
  if (expiresAt <= now) return "member_expiry_in_past";
  if (expiresAt - now > AUDITOR_MAX_DAYS * DAY_MS) return "auditor_expiry_too_long";
  return null;
}

export function validateRoleChange(
  member: MemberState,
  change: {
    role: Exclude<MemberRole, "owner">;
    expiresAt?: number;
    auditor?: { purpose: string; fiscalYears: number[] };
  },
  now: number,
): MemberError | null {
  if (member.role === "owner") return "owner_immutable";
  if ((change.role as MemberRole) === "owner") return "owner_unique";
  if (member.disabledAt !== undefined) return "member_disabled";
  if (change.role === member.role) return "role_unchanged";
  if (change.role === "auditor") {
    const e = auditorExpiry(change.expiresAt ?? member.expiresAt, now);
    if (e) return e;
    const scope = change.auditor ?? member.auditor;
    if (!scope || scope.purpose.trim() === "" || scope.fiscalYears.length === 0) return "auditor_scope_required";
  }
  return null;
}

/** „Verlängern": a new `expiresAt` (null = unlimited, staff only). Auditor grants need a reason (AUD-022). */
export function validateExtension(
  member: MemberState,
  change: { expiresAt: number | null; reason?: string },
  now: number,
): MemberError | null {
  if (member.role === "owner") return "owner_immutable";
  if (isHardDisabled(member)) return "member_disabled";
  if (member.role === "auditor") {
    const e = auditorExpiry(change.expiresAt, now);
    if (e) return e;
    if (!change.reason?.trim()) return "reason_required";
    return null;
  }
  if (change.expiresAt === null) return null;
  if (change.expiresAt <= now) return "member_expiry_in_past";
  if (member.expiresAt !== undefined && member.expiresAt > now && change.expiresAt <= member.expiresAt) {
    return "extension_shorter";
  }
  return null;
}
