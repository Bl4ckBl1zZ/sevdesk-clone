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
  /** F12 AUD-020 security status page (owner; never via REST/MCP). */
  "system.security": { roles: ["owner"], scope: null, write: false },
  /** F08 journal, chart of accounts, role mapping and opening balances — read (REST/MCP `accounting:read`). */
  "accounting.read": { roles: ALL, scope: "accounting:read", write: false },
  /**
   * F08 ACC-013 opening balances (owner, bookkeeper). Not via MCP (F08 §7: owner-only legal acts); REST
   * `POST /opening-balances` gets its own key path when the API arrives, so no scope here.
   */
  "accounting.openingBalance": { roles: ["owner", "bookkeeper"], scope: null, write: true },
  /** F08 ACC-008 role mapping overrides (audited, owner only, never via MCP). */
  "accounting.roles": { roles: ["owner"], scope: null, write: true },
  /**
   * F02 contacts: master data is part of the bookkeeper's daily work (drafts need customers, 02 §4.3).
   * The auditor reads master data read-only: a Betriebsprüfer needs debtors/creditors for GoBD Z1 access (02 §4.3 auditor row).
   */
  "contacts.read": { roles: ALL, scope: "contacts:read", write: false },
  "contacts.write": { roles: ["owner", "bookkeeper"], scope: "contacts:write", write: true },
  /** CON-132…134 merge and undo (⚠ for MCP, CLAUDE.md rule 8 — the MCP slice adds the confirm token). */
  "contacts.merge": { roles: ["owner", "bookkeeper"], scope: "contacts:write", write: true },
  /** F03 products, categories and customer prices (auditor: read-only master data for Z1, like contacts). */
  "products.read": { roles: ALL, scope: "products:read", write: false },
  "products.write": { roles: ["owner", "bookkeeper"], scope: "products:write", write: true },
  /** F04 sales documents: lists, detail, preview (auditor: read-only, Z1 access to issued invoices). */
  "documents.read": { roles: ALL, scope: "documents:read", write: false },
  /** DOC-03 draft create/update/delete. */
  "documents.write": { roles: ["owner", "bookkeeper"], scope: "documents:write", write: true },
  /**
   * SND-06/SND-22 export: the files leave the system and an audit entry is written (05 §2: exporting needs only
   * `documents:read`); the auditor and viewer may download archived files as well. Not a business write: only the
   * audit entry and the derived `firstExportedAt` cache are recorded.
   */
  "documents.export": { roles: ALL, scope: "documents:read", write: false },
  /** DOC-24 finalise (⚠, irreversible number assignment; fresh session, 02 §4.2). */
  "invoices.finalize": { roles: ["owner", "bookkeeper"], scope: "invoices:finalize", write: true, fresh: true },
  /** SND-07/SND-18 mark as sent and retract (⚠; scope name kept, 05 §2). */
  "invoices.send": { roles: ["owner", "bookkeeper"], scope: "invoices:send", write: true, fresh: true },
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
