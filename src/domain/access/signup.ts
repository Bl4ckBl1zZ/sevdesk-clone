import type { MemberRole } from "../schemas/actor";

/**
 * Sign-up gate (02 §4.3) — the single rule that decides whether Better Auth may create a user.
 * Pure: the caller passes the current state (does any user exist, matching invites) and `now`.
 *
 * 1. Bootstrap: while no user exists, only OWNER_EMAIL (case-insensitive, trimmed) → role owner.
 * 2. Afterwards: only with an unexpired, unrevoked, unaccepted invite for the e-mail → the invite's role.
 * 3. Otherwise refused (E-AUD-26).
 */

export const SIGNUP_MESSAGES_DE = {
  not_invited: "Für diese E-Mail-Adresse besteht keine Einladung.",
  bootstrap_owner_only: "Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich.",
  owner_email_missing: "Die Inhaber-Adresse (OWNER_EMAIL) ist nicht konfiguriert. Anmeldung nicht möglich.",
} as const;

export type SignupRefusal = keyof typeof SIGNUP_MESSAGES_DE;

export interface InviteLike<Id = string> {
  _id: Id;
  email: string;
  role: Exclude<MemberRole, "owner">;
  expiresAt: number;
  createdAt: number;
  acceptedAt?: number;
  revokedAt?: number;
}

export type SignupDecision<Id = string> =
  | { allowed: true; kind: "bootstrap"; role: "owner" }
  | { allowed: true; kind: "invite"; role: Exclude<MemberRole, "owner">; inviteId: Id }
  | { allowed: false; reason: SignupRefusal; message: string };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isInviteUsable(invite: InviteLike<unknown>, now: number): boolean {
  return invite.acceptedAt === undefined && invite.revokedAt === undefined && invite.expiresAt > now;
}

export function decideSignup<Id>(input: {
  email: string;
  ownerEmail: string | undefined;
  anyUserExists: boolean;
  invites: readonly InviteLike<Id>[];
  now: number;
}): SignupDecision<Id> {
  const email = normalizeEmail(input.email);
  const refuse = (reason: SignupRefusal): SignupDecision<Id> => ({
    allowed: false,
    reason,
    message: SIGNUP_MESSAGES_DE[reason],
  });

  if (!input.anyUserExists) {
    if (!input.ownerEmail || normalizeEmail(input.ownerEmail) === "") return refuse("owner_email_missing");
    return email === normalizeEmail(input.ownerEmail)
      ? { allowed: true, kind: "bootstrap", role: "owner" }
      : refuse("bootstrap_owner_only");
  }

  const usable = input.invites
    .filter((i) => normalizeEmail(i.email) === email && isInviteUsable(i, input.now))
    .sort((a, b) => b.createdAt - a.createdAt);
  const invite = usable[0];
  if (!invite) return refuse("not_invited");
  return { allowed: true, kind: "invite", role: invite.role, inviteId: invite._id };
}

// ── Invite creation rules (02 §4.3, F12 AUD-022, E-AUD-34) ─────────────────────────────────────────

export const DAY_MS = 86_400_000;
export const INVITE_VALIDITY_DAYS = 7;
export const AUDITOR_MAX_DAYS = 30;

export const INVITE_MESSAGES_DE = {
  invalid_email: "Bitte eine gültige E-Mail-Adresse angeben.",
  auditor_expiry_required: "Für einen Prüferzugang ist ein Ablaufdatum erforderlich.",
  auditor_expiry_too_long: "Ein Prüferzugang ist höchstens 30 Tage gültig. Bitte verlängern Sie bei Bedarf.",
  member_expiry_in_past: "Das Ablaufdatum muss in der Zukunft liegen.",
  auditor_scope_required: "Für einen Prüferzugang sind Zweck/Aktenzeichen und mindestens ein Geschäftsjahr nötig.",
  already_member: "Diese E-Mail-Adresse gehört bereits zu einem Mitglied.",
} as const;

export type InviteError = keyof typeof INVITE_MESSAGES_DE;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateInviteInput(
  input: {
    email: string;
    role: Exclude<MemberRole, "owner">;
    memberExpiresAt?: number;
    auditor?: { purpose: string; fiscalYears: number[] };
  },
  now: number,
): InviteError | null {
  if (!EMAIL_RE.test(normalizeEmail(input.email))) return "invalid_email";
  if (input.memberExpiresAt !== undefined && input.memberExpiresAt <= now) return "member_expiry_in_past";
  if (input.role === "auditor") {
    if (input.memberExpiresAt === undefined) return "auditor_expiry_required";
    if (input.memberExpiresAt - now > AUDITOR_MAX_DAYS * DAY_MS) return "auditor_expiry_too_long";
    if (!input.auditor || input.auditor.purpose.trim() === "" || input.auditor.fiscalYears.length === 0) {
      return "auditor_scope_required";
    }
  }
  return null;
}

// ── Member state (02 §4.3 "Expiry and disabling") ──────────────────────────────────────────────────

export type MemberAccess = "active" | "expired" | "disabled";

export function memberAccess(member: { expiresAt?: number; disabledAt?: number }, now: number): MemberAccess {
  if (member.disabledAt !== undefined) return "disabled";
  if (member.expiresAt !== undefined && member.expiresAt <= now) return "expired";
  return "active";
}
