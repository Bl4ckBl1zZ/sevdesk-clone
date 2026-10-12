import { describe, expect, test } from "vitest";
import { MEMBER_ROLES, type MemberRole } from "../schemas/actor";
import { isScope, RESERVED_SCOPES } from "../schemas/scopes";
import { ALL_PERMISSIONS, canDo, canKeyDo, PERMISSIONS, type Permission, scopeFor } from "./permissions";

/** Expected matrix, written out by hand so a change to PERMISSIONS must be mirrored here (TST-AUD-29). */
const EXPECTED: Record<Permission, readonly MemberRole[]> = {
  "session.self": ["owner", "bookkeeper", "viewer", "auditor"],
  "members.read": ["owner"],
  "members.manage": ["owner"],
  "invites.manage": ["owner"],
  "settings.read": ["owner", "bookkeeper", "viewer"],
  "settings.write": ["owner"],
  "settings.ownerOnly": ["owner"],
  "integrations.manage": ["owner"],
  "audit.read": ["owner", "bookkeeper", "viewer", "auditor"],
  "integrity.read": ["owner", "bookkeeper", "auditor"],
  "integrity.acknowledge": ["owner"],
  "apiKeys.manage": ["owner"],
  "system.security": ["owner"],
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

  test("SEC-01 SET-142 members, invites, integrations, API keys, owner-only settings and integrity acknowledgement are never grantable via API", () => {
    for (const action of [
      "members.read",
      "members.manage",
      "invites.manage",
      "integrations.manage",
      "apiKeys.manage",
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
});
