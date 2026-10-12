import type { MemberRole } from "../schemas/actor";
import type { Scope } from "../schemas/scopes";

/**
 * Permission matrix (02 §4.3). Shared by the UI (hide/disable), Server Actions (`requireRole`) and the
 * Convex wrappers (authoritative). Each action lists the member roles that may perform it and the API-key
 * scope that grants it to `api-key:`/`mcp:` actors; `scope: null` = never grantable via API (05-api §2.2:
 * members, invites, sign-in settings, API keys, secrets, purge, restore).
 *
 * The list grows with every feature; P0 holds the security core.
 */
export interface PermissionRule {
  roles: readonly MemberRole[];
  scope: Scope | null;
  /** Writes are refused for roles that only read (viewer, auditor) — E-AUD-29/E-AUD-32. */
  write: boolean;
  /**
   * ⚠ action: the signed-in member's session must be younger than 10 minutes (02 §4.2 "Fresh session",
   * E-AUD-28); otherwise the wrapper answers `reauth_required` and the UI asks for a passkey or a new code.
   */
  fresh?: true;
}

const ALL: readonly MemberRole[] = ["owner", "bookkeeper", "viewer", "auditor"];
const STAFF_READ: readonly MemberRole[] = ["owner", "bookkeeper", "viewer"];

export const PERMISSIONS = {
  /** The signed-in member's own record (role, expiry, TOTP state). */
  "session.self": { roles: ALL, scope: null, write: false },
  "members.read": { roles: ["owner"], scope: null, write: false },
  "members.manage": { roles: ["owner"], scope: null, write: true, fresh: true },
  "invites.manage": { roles: ["owner"], scope: null, write: true, fresh: true },
  "settings.read": { roles: STAFF_READ, scope: "settings:read", write: false },
  "settings.write": { roles: ["owner"], scope: "settings:write", write: true },
  /**
   * F01 SET-142 owner-only settings, never via REST/MCP: tax status (KU, Soll/Ist, UStVA period, profit method,
   * chart, fiscal year), server location, access concept, completing the setup.
   */
  "settings.ownerOnly": { roles: ["owner"], scope: null, write: true },
  /** Integration credentials, auth-mail test, R2 tests (F01 SET-106/107/115). */
  "integrations.manage": { roles: ["owner"], scope: null, write: true },
  "audit.read": { roles: ALL, scope: "audit:read", write: false },
  "integrity.read": { roles: ["owner", "bookkeeper", "auditor"], scope: "audit:read", write: false },
  "integrity.acknowledge": { roles: ["owner"], scope: null, write: true },
  "apiKeys.manage": { roles: ["owner"], scope: null, write: true, fresh: true },
} as const satisfies Record<string, PermissionRule>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function permissionRule(action: Permission): PermissionRule {
  return PERMISSIONS[action];
}

/** `canDo(role, action)` — the single role check (TST-AUD-29). */
export function canDo(role: MemberRole, action: Permission): boolean {
  return (PERMISSIONS[action].roles as readonly MemberRole[]).includes(role);
}

/** ⚠ actions that need a session younger than 10 minutes (E-AUD-28). */
export function requiresFreshSession(action: Permission): boolean {
  return (PERMISSIONS[action] as PermissionRule).fresh === true;
}

/** Scope an API key needs for `action`, or null when the action is never grantable via API. */
export function scopeFor(action: Permission): Scope | null {
  return PERMISSIONS[action].scope;
}

export function canKeyDo(scopes: readonly string[], action: Permission): boolean {
  const scope = scopeFor(action);
  return scope !== null && scopes.includes(scope);
}

/** German labels for roles (E-AUD-29 message „Ihre Rolle ({rolle}) erlaubt diese Aktion nicht."). */
export const ROLE_LABEL_DE: Record<MemberRole, string> = {
  owner: "Inhaber",
  bookkeeper: "Buchhaltung",
  viewer: "Lesezugriff",
  auditor: "Prüfer",
};
