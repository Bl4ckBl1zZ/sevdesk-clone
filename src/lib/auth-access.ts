import { canDo, type Permission, ROLE_LABEL_DE } from "@/domain/access/permissions";
import { memberAccess } from "@/domain/access/signup";
import type { MemberRole } from "@/domain/schemas/actor";

/**
 * Pure access decision for Server Components and Server Actions (02 §4.1 step 5). The input is the result
 * of Convex `api.members.me` (fetched with the session's Convex JWT); Convex re-checks everything in its
 * wrappers, this only decides what Next renders or whether a Server Action may proceed.
 */
export interface CurrentMember {
  actor: string;
  memberId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  expiresAt: number | null;
  totpEnabled: boolean;
  auditor: { organisation: string | null; purpose: string; fiscalYears: number[] } | null;
}

export type AccessDecision =
  | { ok: true; member: CurrentMember }
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "member_expired" | "forbidden_role"; message: string };

export function checkAccess(member: CurrentMember | null, permission: Permission, now: number): AccessDecision {
  if (!member) return { ok: false, reason: "unauthenticated" };
  if (memberAccess(member.expiresAt === null ? {} : { expiresAt: member.expiresAt }, now) === "expired") {
    return { ok: false, reason: "member_expired", message: "Ihr Zugang ist abgelaufen." };
  }
  if (!canDo(member.role, permission)) {
    return {
      ok: false,
      reason: "forbidden_role",
      message: `Ihre Rolle (${ROLE_LABEL_DE[member.role]}) erlaubt diese Aktion nicht.`,
    };
  }
  return { ok: true, member };
}
