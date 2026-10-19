import type { ConfirmIntent } from "../api/confirm";
import type { MemberRole } from "../schemas/actor";
import { SCOPES, type Scope } from "../schemas/scopes";

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
  /** Further scopes that also grant the action (e.g. `settings:read` covers `company:public`). */
  alsoScopes?: readonly Scope[];
  /** Any valid API key may call it, without a scope (`GET /me`, the key's own rate limit and access log). */
  anyKey?: true;
  /**
   * ⚠ action (06 §2, CLAUDE.md rule 8): an `mcp:` actor needs a valid `confirm_token` issued for this intent by a
   * preview; the mutation wrapper consumes it in the same transaction (EC-188). REST and UI callers are unaffected.
   */
  confirm?: ConfirmIntent;
}

const ALL: readonly MemberRole[] = ["owner", "bookkeeper", "viewer", "auditor"];
const STAFF_READ: readonly MemberRole[] = ["owner", "bookkeeper", "viewer"];
/** Every `:read` scope (05 §2.2) — „any read" in the MCP catalog (06 §3.1). */
const READ_SCOPES: readonly Scope[] = SCOPES.filter((s): s is Scope => s.endsWith(":read"));

export const PERMISSIONS = {
  /** The signed-in member's own record (role, expiry, TOTP state). */
  "session.self": { roles: ALL, scope: null, write: false },
  "members.read": { roles: ["owner"], scope: null, write: false },
  "members.manage": { roles: ["owner"], scope: null, write: true, fresh: true },
  "invites.manage": { roles: ["owner"], scope: null, write: true, fresh: true },
  "settings.read": { roles: STAFF_READ, scope: "settings:read", write: false },
  "settings.write": { roles: ["owner"], scope: "settings:write", write: true },
  /** F01 SET-021 public company data for website footers (`company:public`, also covered by `settings:read`). */
  "company.public": { roles: STAFF_READ, scope: "company:public", alsoScopes: ["settings:read"], write: false },
  /** 06 §3.1 `workspace_overview`: the first call of every MCP session — any read scope grants it. */
  "workspace.overview": {
    roles: STAFF_READ,
    scope: "settings:read",
    alsoScopes: READ_SCOPES,
    write: false,
  },
  /**
   * F01 SET-142 owner-only settings, never via REST/MCP: tax status (KU, Soll/Ist, UStVA period, profit method,
   * chart, fiscal year), server location, access concept, completing the setup.
   */
  "settings.ownerOnly": { roles: ["owner"], scope: null, write: true },
  /** Integration credentials, auth-mail test, R2 tests (F01 SET-106/107/115). */
  "integrations.manage": { roles: ["owner"], scope: null, write: true },
  /** F12 NTF-001: bell, list and read state (shared per instance); auditors never see operational notifications. */
  "notifications.read": { roles: STAFF_READ, scope: "settings:read", write: false },
  "notifications.write": { roles: ["owner", "bookkeeper"], scope: "settings:write", write: true },
  "audit.read": { roles: ALL, scope: "audit:read", write: false },
  "integrity.read": { roles: ["owner", "bookkeeper", "auditor"], scope: "audit:read", write: false },
  "integrity.acknowledge": { roles: ["owner"], scope: null, write: true },
  /** 05 §2.1 key list (owner; never via REST/MCP). */
  "apiKeys.read": { roles: ["owner"], scope: null, write: false },
  /** 05 §2.1 key creation: owner, fresh session (02 §4.2). */
  "apiKeys.manage": { roles: ["owner"], scope: null, write: true, fresh: true },
  /** 05 §2.1 revocation: owner, without re-authentication so a leaked key is revoked at once (EC-186). */
  "apiKeys.revoke": { roles: ["owner"], scope: null, write: true },
  /** The calling key itself: `/me`, rate limit, access log, idempotency records (05 §3, §4.8). */
  "apiKeys.self": { roles: [], scope: null, write: false, anyKey: true },
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
  /** CON-132…134 merge and undo (⚠ for MCP: confirm token from `preview_action {action: "contact_merge"}`). */
  "contacts.merge": { roles: ["owner", "bookkeeper"], scope: "contacts:write", write: true, confirm: "contact_merge" },
  /**
   * F02 CON-134 undoing a merge (restores the losers). Not an MCP tool (06 §4.1 lists only `contact_merge`), so no
   * confirm intent of its own; REST `POST /contacts/{id}/merge/undo` arrives with the remaining contact endpoints.
   */
  "contacts.mergeUndo": { roles: ["owner", "bookkeeper"], scope: "contacts:write", write: true },
  /** F03 products, categories and customer prices (auditor: read-only master data for Z1, like contacts). */
  "products.read": { roles: ALL, scope: "products:read", write: false },
  "products.write": { roles: ["owner", "bookkeeper"], scope: "products:write", write: true },
  /** F07 bank accounts, transactions, statements and the Kasse — read (auditor: Z1 access to bank data). */
  "banking.read": { roles: ALL, scope: "banking:read", write: false },
  /** F07 statement import, PDF archive, duplicate review, reversal link, rollback (BNK-030…036, BNK-110/121). */
  "banking.write": { roles: ["owner", "bookkeeper"], scope: "banking:write", write: true },
  /** F07 BNK-060/061/063, CSH-025 marking (⚠ legally relevant: MCP needs the confirm token, 06 §2). */
  "banking.mark": {
    roles: ["owner", "bookkeeper"],
    scope: "banking:write",
    write: true,
    confirm: "bank_transaction_mark",
  },
  /** F07 CSH-024/027 „Bargeld eingezahlt / entnommen“ and reversals (⚠, never-negative CSH-026). */
  "cash.write": {
    roles: ["owner", "bookkeeper"],
    scope: "banking:write",
    write: true,
    confirm: "cash_transfer_record",
  },
  /** F09 import projects: list, status, preview, protocol (02 §4.3: imports are bookkeeping work). */
  "imports.read": { roles: ["owner", "bookkeeper"], scope: "imports:run", write: false },
  /** F09 IMP-016/017/009/023: upload, classify, map, resolve, preview, discard (02 §4.3 bookkeeper: „imports“). */
  "imports.run": { roles: ["owner", "bookkeeper"], scope: "imports:run", write: true },
  /**
   * F09 IMP-023 commit: writes archived documents and continues the number ranges (F01 SET-065, a settings write
   * the bookkeeper may not make, 02 §4.3) — conservative: owner only.
   */
  "imports.commit": { roles: ["owner"], scope: "imports:run", write: true },
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
  /**
   * DOC-24 finalise (⚠, irreversible number assignment; fresh session, 02 §4.2). MCP: confirm token from
   * `document_preview` (intent finalize), bound to id + version + the finalisation options (06 §3.4).
   */
  "invoices.finalize": {
    roles: ["owner", "bookkeeper"],
    scope: "invoices:finalize",
    write: true,
    fresh: true,
    confirm: "document_finalize",
  },
  /**
   * SND-07/SND-18 mark as sent and retract (⚠; scope name kept, 05 §2). MCP: confirm token from
   * `preview_action { action: "document_mark_sent" }` (SND-24); the retraction is not exposed via MCP.
   */
  "invoices.send": {
    roles: ["owner", "bookkeeper"],
    scope: "invoices:send",
    write: true,
    fresh: true,
    confirm: "document_mark_sent",
  },
  /**
   * INV-10/11/15 Storno (⚠, creates and finalises the Stornorechnung; MCP: confirm token from `document_preview`
   * with `intent: "cancel"`, 06 §3.4). Fresh session like finalising.
   */
  "invoices.cancel": {
    roles: ["owner", "bookkeeper"],
    scope: "invoices:cancel",
    write: true,
    fresh: true,
    confirm: "invoice_cancel",
  },
  /** F05 payments, open items, credit balances — read (auditor: Z1 access to receivables). */
  "payments.read": { roles: ALL, scope: "payments:read", write: false },
  /**
   * F05 PAY-010…PAY-063 record a payment (bank, clearing, cash), Sammelzahlung, write-off, credit application and
   * refund (⚠: MCP needs a `payment_record` confirm token from `preview_action`, PAY-019).
   */
  "payments.write": { roles: ["owner", "bookkeeper"], scope: "payments:write", write: true, confirm: "payment_record" },
  /** F05 PAY-040…042 reversal („Zahlung stornieren“, BNK-047 „Zuordnung aufheben“) (⚠ `payment_reverse`). */
  "payments.reverse": {
    roles: ["owner", "bookkeeper"],
    scope: "payments:write",
    write: true,
    confirm: "payment_reverse",
  },
  /**
   * F05 PAY-063 Quittung: archived on first generation (`receiptFile`, set once), „Kopie“ afterwards; like the
   * document export only the archive copy and the audit entry are written (05 §4.4: `payments:read`).
   */
  "payments.receipt": { roles: STAFF_READ, scope: "payments:read", write: false },
  /**
   * F05 dunning: reminder drafts (DUN-008), withdrawal (DUN-009), pause/dispute/block/hand-over (DUN-034/042) and the
   * manual Zugang override (PAY-052). Drafts are free (W tools); finalising a reminder needs `invoices.finalize`.
   */
  "dunning.write": { roles: ["owner", "bookkeeper"], scope: "dunning:write", write: true },
  /** F05 DUN-030/031 dunning run (⚠: MCP needs a `dunning_run` token from `dunning_preview`; never sends). */
  "dunning.run": { roles: ["owner", "bookkeeper"], scope: "dunning:write", write: true, confirm: "dunning_run" },
  /**
   * F05 DUN-001 policies and Einstellungen › Mahnwesen (05 §2.2 `dunning:manage`): a change alters what the daily run
   * creates and finalises; settings writes are owner-only (02 §4.3).
   */
  "dunning.manage": { roles: ["owner"], scope: "dunning:manage", write: true },
  /** F07 BNK-046 confirming a bank match runs F05 `payments.record` (⚠ `bank_match_confirm`). */
  "banking.match": {
    roles: ["owner", "bookkeeper"],
    scope: "banking:write",
    write: true,
    confirm: "bank_match_confirm",
  },
  /**
   * 04 §4.7 DASH-011 Übersicht (dashboard view model): every member role; each widget is additionally gated by the
   * read permission of its data (e.g. `audit.read` for „Verlauf“). UI only — not exposed via REST/MCP.
   */
  "dashboard.read": { roles: ALL, scope: null, write: false },
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
  const rule = PERMISSIONS[action] as PermissionRule;
  if (rule.anyKey) return true;
  if (rule.scope === null) return false;
  return [rule.scope, ...(rule.alsoScopes ?? [])].some((s) => scopes.includes(s));
}

/** The intent whose confirm token an `mcp:` actor needs for `action`, if it is a ⚠ action. */
export function confirmIntentFor(action: Permission): ConfirmIntent | undefined {
  return (PERMISSIONS[action] as PermissionRule).confirm;
}

/** German labels for roles (E-AUD-29 message „Ihre Rolle ({rolle}) erlaubt diese Aktion nicht."). */
export const ROLE_LABEL_DE: Record<MemberRole, string> = {
  owner: "Inhaber",
  bookkeeper: "Buchhaltung",
  viewer: "Lesezugriff",
  auditor: "Prüfer",
};
