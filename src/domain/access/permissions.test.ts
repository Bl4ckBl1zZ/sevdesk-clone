import { describe, expect, test } from "vitest";
import { MEMBER_ROLES, type MemberRole } from "../schemas/actor";
import { isScope, RESERVED_SCOPES } from "../schemas/scopes";
import {
  ALL_PERMISSIONS,
  canDo,
  canKeyDo,
  confirmIntentFor,
  PERMISSIONS,
  type Permission,
  scopeFor,
} from "./permissions";

/** Expected matrix, written out by hand so a change to PERMISSIONS must be mirrored here (TST-AUD-29). */
const EXPECTED: Record<Permission, readonly MemberRole[]> = {
  "session.self": ["owner", "bookkeeper", "viewer", "auditor"],
  "members.read": ["owner"],
  "members.manage": ["owner"],
  "invites.manage": ["owner"],
  "settings.read": ["owner", "bookkeeper", "viewer"],
  "settings.write": ["owner"],
  "company.public": ["owner", "bookkeeper", "viewer"],
  "workspace.overview": ["owner", "bookkeeper", "viewer"],
  "settings.ownerOnly": ["owner"],
  "integrations.manage": ["owner"],
  "notifications.read": ["owner", "bookkeeper", "viewer"],
  "notifications.write": ["owner", "bookkeeper"],
  "audit.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "integrity.read": ["owner", "bookkeeper", "auditor"],
  "integrity.acknowledge": ["owner"],
  "apiKeys.read": ["owner"],
  "apiKeys.manage": ["owner"],
  "apiKeys.revoke": ["owner"],
  "apiKeys.self": [],
  "system.security": ["owner"],
  "accounting.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "accounting.openingBalance": ["owner", "bookkeeper"],
  "accounting.roles": ["owner"],
  "contacts.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "contacts.write": ["owner", "bookkeeper"],
  "contacts.merge": ["owner", "bookkeeper"],
  "contacts.mergeUndo": ["owner", "bookkeeper"],
  "products.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "products.write": ["owner", "bookkeeper"],
  "banking.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "banking.write": ["owner", "bookkeeper"],
  "banking.mark": ["owner", "bookkeeper"],
  "cash.write": ["owner", "bookkeeper"],
  // F09: imports are bookkeeping work (02 §4.3); the commit continues number ranges (a settings write) → owner only.
  "imports.read": ["owner", "bookkeeper"],
  "imports.run": ["owner", "bookkeeper"],
  "imports.commit": ["owner"],
  "documents.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "documents.write": ["owner", "bookkeeper"],
  "documents.export": ["owner", "bookkeeper", "viewer", "auditor"],
  "invoices.finalize": ["owner", "bookkeeper"],
  "invoices.send": ["owner", "bookkeeper"],
  "invoices.cancel": ["owner", "bookkeeper"],
  "payments.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "payments.write": ["owner", "bookkeeper"],
  "payments.reverse": ["owner", "bookkeeper"],
  "payments.receipt": ["owner", "bookkeeper", "viewer"],
  "dunning.write": ["owner", "bookkeeper"],
  "dunning.run": ["owner", "bookkeeper"],
  "dunning.manage": ["owner"],
  "banking.match": ["owner", "bookkeeper"],
  // 04 §4.7 DASH-011: every member role reads the Übersicht; widgets are gated by their own read permission.
  "dashboard.read": ["owner", "bookkeeper", "viewer", "auditor"],
  // F06 P2 vouchers: auditors read purchase vouchers (Z1), writes are bookkeeping work (02 §4.3).
  "vouchers.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "vouchers.write": ["owner", "bookkeeper"],
  "vouchers.finalize": ["owner", "bookkeeper"],
  "vouchers.correct": ["owner", "bookkeeper"],
  "vouchers.approve": ["owner", "bookkeeper"],
  "vouchers.pay": ["owner", "bookkeeper"],
  "exports.full": ["owner"],
};

describe("permission matrix (02 §4.3)", () => {
  const pairs = MEMBER_ROLES.flatMap((role) => ALL_PERMISSIONS.map((action) => [role, action] as const));

  test.each(pairs)("SEC-01 canDo(%s, %s) matches the expected matrix", (role, action) => {
    expect(canDo(role, action)).toBe(EXPECTED[action].includes(role));
  });

  test("SEC-01 viewer and auditor never get a write permission (E-AUD-29, E-AUD-32)", () => {
    for (const action of ALL_PERMISSIONS) {
      if (!PERMISSIONS[action].write) continue;
      expect(canDo("viewer", action)).toBe(false);
      expect(canDo("auditor", action)).toBe(false);
    }
  });

  test("SEC-01 auditor reads contacts and products master data read-only (GoBD Z1, 02 §4.3)", () => {
    for (const action of ["contacts.read", "products.read"] as const) expect(canDo("auditor", action)).toBe(true);
    for (const action of ["contacts.write", "contacts.merge", "products.write"] as const) {
      expect(canDo("auditor", action)).toBe(false);
      expect(canDo("viewer", action)).toBe(false);
    }
  });

  test("SEC-01 SET-142 members, invites, integrations, API keys, owner-only settings and integrity acknowledgement are never grantable via API", () => {
    for (const action of [
      "members.read",
      "members.manage",
      "invites.manage",
      "integrations.manage",
      "apiKeys.read",
      "apiKeys.manage",
      "apiKeys.revoke",
      "integrity.acknowledge",
      "session.self",
      "settings.ownerOnly",
    ] as const) {
      expect(scopeFor(action)).toBeNull();
      expect(canKeyDo(["settings:write", "audit:read"], action)).toBe(false);
    }
  });

  test("SEC-02 keys need the matching scope", () => {
    expect(canKeyDo(["audit:read"], "audit.read")).toBe(true);
    expect(canKeyDo(["settings:read"], "settings.write")).toBe(false);
    expect(canKeyDo(["settings:write"], "settings.write")).toBe(true);
  });

  test("SEC-02 every scope named in the matrix is a known scope and none is reserved", () => {
    for (const action of ALL_PERMISSIONS) {
      const scope = scopeFor(action);
      if (scope === null) continue;
      expect(isScope(scope)).toBe(true);
      expect(RESERVED_SCOPES).not.toContain(scope);
    }
  });

  test("API-005 apiKeys.self is open to any valid key and to no member role", () => {
    expect(canKeyDo([], "apiKeys.self")).toBe(true);
    for (const role of MEMBER_ROLES) expect(canDo(role, "apiKeys.self")).toBe(false);
  });

  test("SET-021 company.public is granted by company:public or settings:read", () => {
    expect(canKeyDo(["company:public"], "company.public")).toBe(true);
    expect(canKeyDo(["settings:read"], "company.public")).toBe(true);
    expect(canKeyDo(["contacts:read"], "company.public")).toBe(false);
    expect(canKeyDo(["company:public"], "settings.read")).toBe(false);
  });

  test("MCP-007 workspace_overview is granted by any read scope, not by write or company:public alone", () => {
    expect(canKeyDo(["contacts:read"], "workspace.overview")).toBe(true);
    expect(canKeyDo(["audit:read"], "workspace.overview")).toBe(true);
    expect(canKeyDo(["contacts:write"], "workspace.overview")).toBe(false);
    expect(canKeyDo(["company:public"], "workspace.overview")).toBe(false);
  });

  test("MCP-004 contacts.merge is a ⚠ action that needs a contact_merge confirm token", () => {
    expect(confirmIntentFor("contacts.merge")).toBe("contact_merge");
    expect(confirmIntentFor("contacts.write")).toBeUndefined();
  });

  test("INV-10 MCP-004 invoices.cancel is a ⚠ action that needs an invoice_cancel confirm token and a fresh session", () => {
    expect(confirmIntentFor("invoices.cancel")).toBe("invoice_cancel");
    expect(PERMISSIONS["invoices.cancel"].scope).toBe("invoices:cancel");
    expect(PERMISSIONS["invoices.cancel"].fresh).toBe(true);
  });

  test("MCP-004 PAY-019 payments and bank matches are ⚠ actions with their own confirm intents (06 §2.1)", () => {
    expect(confirmIntentFor("payments.write")).toBe("payment_record");
    expect(confirmIntentFor("payments.reverse")).toBe("payment_reverse");
    expect(confirmIntentFor("banking.match")).toBe("bank_match_confirm");
    expect(confirmIntentFor("banking.mark")).toBe("bank_transaction_mark");
    expect(confirmIntentFor("cash.write")).toBe("cash_transfer_record");
  });

  test("MCP-004 DOC-24 SND-24 finalising and marking as sent are ⚠ (document_finalize / document_mark_sent tokens)", () => {
    expect(confirmIntentFor("invoices.finalize")).toBe("document_finalize");
    expect(confirmIntentFor("invoices.send")).toBe("document_mark_sent");
    // Exporting transmits nothing and only writes the audit entry (SND-24): not ⚠.
    expect(confirmIntentFor("documents.export")).toBeUndefined();
  });

  test("MCP-004 DUN-031 the dunning run is ⚠ (dunning_run token); reminder drafts and policies are not", () => {
    expect(confirmIntentFor("dunning.run")).toBe("dunning_run");
    expect(confirmIntentFor("dunning.write")).toBeUndefined();
    expect(scopeFor("dunning.manage")).toBe("dunning:manage");
    expect(canDo("bookkeeper", "dunning.manage")).toBe(false);
    expect(canDo("bookkeeper", "dunning.run")).toBe(true);
    expect(scopeFor("payments.write")).toBe("payments:write");
    expect(scopeFor("payments.reverse")).toBe("payments:write");
    expect(scopeFor("banking.match")).toBe("banking:write");
    expect(canKeyDo(["payments:read"], "payments.read")).toBe(true);
    expect(canKeyDo(["payments:read"], "payments.write")).toBe(false);
  });

  test("API-002 key creation needs a fresh session, revocation does not (EC-186)", () => {
    expect(PERMISSIONS["apiKeys.manage"]).toMatchObject({ fresh: true });
    expect("fresh" in PERMISSIONS["apiKeys.revoke"]).toBe(false);
  });
});
