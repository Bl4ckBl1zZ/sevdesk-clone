import { describe, expect, test } from "vitest";
import { MEMBER_MESSAGES_DE, validateExtension, validateRoleChange } from "./members";
import { DAY_MS } from "./signup";

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const staff = { role: "bookkeeper" as const };
const auditor = {
  role: "auditor" as const,
  expiresAt: NOW + 5 * DAY_MS,
  auditor: { purpose: "Az 1", fiscalYears: [2025], extensions: [] },
};

describe("role change (04 §4.10, 02 §4.3)", () => {
  test("SEC-01 the owner row cannot be changed and nobody can be made owner", () => {
    expect(validateRoleChange({ role: "owner" }, { role: "viewer" }, NOW)).toBe("owner_immutable");
    expect(validateRoleChange(staff, { role: "owner" as never }, NOW)).toBe("owner_unique");
  });

  test("SEC-01 bookkeeper ↔ viewer is a plain change; the same role is refused as no-op", () => {
    expect(validateRoleChange(staff, { role: "viewer" }, NOW)).toBeNull();
    expect(validateRoleChange({ role: "viewer" }, { role: "bookkeeper" }, NOW)).toBeNull();
    expect(validateRoleChange(staff, { role: "bookkeeper" }, NOW)).toBe("role_unchanged");
  });

  test("SEC-03 E-AUD-34 becoming an auditor needs an expiry ≤ 30 days and purpose + fiscal years", () => {
    expect(validateRoleChange(staff, { role: "auditor" }, NOW)).toBe("auditor_expiry_required");
    expect(validateRoleChange(staff, { role: "auditor", expiresAt: NOW + 31 * DAY_MS }, NOW)).toBe(
      "auditor_expiry_too_long",
    );
    expect(validateRoleChange(staff, { role: "auditor", expiresAt: NOW + 10 * DAY_MS }, NOW)).toBe(
      "auditor_scope_required",
    );
    expect(
      validateRoleChange(
        staff,
        { role: "auditor", expiresAt: NOW + 10 * DAY_MS, auditor: { purpose: "Az 7", fiscalYears: [2024] } },
        NOW,
      ),
    ).toBeNull();
  });

  test("SEC-01 a disabled member cannot get a new role (re-invite instead)", () => {
    expect(validateRoleChange({ ...staff, disabledAt: NOW - 1, disabledReason: "x" }, { role: "viewer" }, NOW)).toBe(
      "member_disabled",
    );
  });

  test("SEC-01 every refusal has a German message", () => {
    for (const m of Object.values(MEMBER_MESSAGES_DE)) expect(m).toMatch(/[a-zäöü]/);
  });
});

describe("extend access (F12 AUD-022, E-AUD-34)", () => {
  test("SEC-03 an auditor grant is extended by at most 30 days from now and needs a reason", () => {
    expect(validateExtension(auditor, { expiresAt: NOW + 20 * DAY_MS, reason: "" }, NOW)).toBe("reason_required");
    expect(validateExtension(auditor, { expiresAt: NOW + 31 * DAY_MS, reason: "Prüfung dauert an" }, NOW)).toBe(
      "auditor_expiry_too_long",
    );
    expect(validateExtension(auditor, { expiresAt: NOW + 30 * DAY_MS, reason: "Prüfung dauert an" }, NOW)).toBeNull();
  });

  test("SEC-03 an auditor always keeps an expiry; staff may drop it (unlimited access)", () => {
    expect(validateExtension(auditor, { expiresAt: null, reason: "x" }, NOW)).toBe("auditor_expiry_required");
    expect(validateExtension({ ...staff, expiresAt: NOW + DAY_MS }, { expiresAt: null }, NOW)).toBeNull();
  });

  test("SEC-01 the new expiry must lie in the future and after the current one", () => {
    expect(validateExtension({ ...staff, expiresAt: NOW + 5 * DAY_MS }, { expiresAt: NOW - 1 }, NOW)).toBe(
      "member_expiry_in_past",
    );
    expect(validateExtension({ ...staff, expiresAt: NOW + 5 * DAY_MS }, { expiresAt: NOW + 2 * DAY_MS }, NOW)).toBe(
      "extension_shorter",
    );
  });

  test("SEC-01 the owner has no expiry; a member deactivated by hand is not reactivated by an extension", () => {
    expect(validateExtension({ role: "owner" }, { expiresAt: NOW + DAY_MS }, NOW)).toBe("owner_immutable");
    expect(
      validateExtension(
        { ...staff, disabledAt: NOW - 1, disabledReason: "Mitarbeiter ausgeschieden" },
        { expiresAt: NOW + DAY_MS },
        NOW,
      ),
    ).toBe("member_disabled");
    // Expired by the members.expire cron: the extension reactivates (E-AUD-34 „extension allowed after expiry review").
    expect(
      validateExtension(
        { ...staff, expiresAt: NOW - DAY_MS, disabledAt: NOW - 1, disabledReason: "expired" },
        { expiresAt: NOW + DAY_MS },
        NOW,
      ),
    ).toBeNull();
  });
});
