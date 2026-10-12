import { describe, expect, test } from "vitest";
import { DAY_MS, decideSignup, type InviteLike, memberAccess, validateInviteInput } from "./signup";

const NOW = Date.UTC(2026, 9, 12, 10);
const invite = (over: Partial<InviteLike> = {}): InviteLike => ({
  _id: "inv1",
  email: "steuer@example.de",
  role: "bookkeeper",
  expiresAt: NOW + DAY_MS,
  createdAt: NOW - DAY_MS,
  ...over,
});

describe("sign-up gate (02 §4.3)", () => {
  test("SEC-01 bootstrap: while no user exists only OWNER_EMAIL may sign up and becomes owner", () => {
    const base = { ownerEmail: " Inhaber@Example.de ", anyUserExists: false, invites: [], now: NOW };
    expect(decideSignup({ ...base, email: "inhaber@example.de" })).toEqual({
      allowed: true,
      kind: "bootstrap",
      role: "owner",
    });
    expect(decideSignup({ ...base, email: "INHABER@example.de  " })).toMatchObject({ allowed: true });
    expect(decideSignup({ ...base, email: "other@example.de" })).toMatchObject({
      allowed: false,
      reason: "bootstrap_owner_only",
      message: "Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich.",
    });
  });

  test("SEC-01 bootstrap fails closed when OWNER_EMAIL is not configured", () => {
    expect(
      decideSignup({ email: "a@b.de", ownerEmail: undefined, anyUserExists: false, invites: [], now: NOW }),
    ).toMatchObject({ allowed: false, reason: "owner_email_missing" });
  });

  test("SEC-01 after bootstrap an uninvited address is refused (E-AUD-26), also OWNER_EMAIL itself", () => {
    const r = decideSignup({
      email: "inhaber@example.de",
      ownerEmail: "inhaber@example.de",
      anyUserExists: true,
      invites: [],
      now: NOW,
    });
    expect(r).toEqual({
      allowed: false,
      reason: "not_invited",
      message: "Für diese E-Mail-Adresse besteht keine Einladung.",
    });
  });

  test("SEC-01 a usable invite admits the address with the invite's role", () => {
    const r = decideSignup({
      email: "Steuer@Example.de",
      ownerEmail: "x@y.de",
      anyUserExists: true,
      invites: [invite({ _id: "old", createdAt: NOW - 3 * DAY_MS, role: "viewer" }), invite()],
      now: NOW,
    });
    expect(r).toEqual({ allowed: true, kind: "invite", role: "bookkeeper", inviteId: "inv1" });
  });

  test.each([
    ["expired", { expiresAt: NOW }],
    ["revoked", { revokedAt: NOW - 1 }],
    ["accepted", { acceptedAt: NOW - 1 }],
    ["other e-mail", { email: "other@example.de" }],
  ])("SEC-01 an %s invite does not admit the address", (_label, over) => {
    const r = decideSignup({
      email: "steuer@example.de",
      ownerEmail: "x@y.de",
      anyUserExists: true,
      invites: [invite(over)],
      now: NOW,
    });
    expect(r).toMatchObject({ allowed: false, reason: "not_invited" });
  });
});

describe("invite rules", () => {
  test("AUD-022 auditor invites need an expiry of at most 30 days, a purpose and fiscal years", () => {
    const auditor = { purpose: "Az 123/2026", fiscalYears: [2024, 2025] };
    expect(validateInviteInput({ email: "p@fa.de", role: "auditor", auditor }, NOW)).toBe("auditor_expiry_required");
    expect(
      validateInviteInput({ email: "p@fa.de", role: "auditor", auditor, memberExpiresAt: NOW + 31 * DAY_MS }, NOW),
    ).toBe("auditor_expiry_too_long");
    expect(
      validateInviteInput(
        {
          email: "p@fa.de",
          role: "auditor",
          auditor: { purpose: " ", fiscalYears: [] },
          memberExpiresAt: NOW + DAY_MS,
        },
        NOW,
      ),
    ).toBe("auditor_scope_required");
    expect(
      validateInviteInput({ email: "p@fa.de", role: "auditor", auditor, memberExpiresAt: NOW + 30 * DAY_MS }, NOW),
    ).toBeNull();
  });

  test("SEC-01 invites need a valid e-mail and a future member expiry", () => {
    expect(validateInviteInput({ email: "nope", role: "viewer" }, NOW)).toBe("invalid_email");
    expect(validateInviteInput({ email: "a@b.de", role: "viewer", memberExpiresAt: NOW }, NOW)).toBe(
      "member_expiry_in_past",
    );
    expect(validateInviteInput({ email: "a@b.de", role: "bookkeeper" }, NOW)).toBeNull();
  });

  test("SEC-01 expired or disabled members are treated as signed out", () => {
    expect(memberAccess({}, NOW)).toBe("active");
    expect(memberAccess({ expiresAt: NOW }, NOW)).toBe("expired");
    expect(memberAccess({ expiresAt: NOW + 1 }, NOW)).toBe("active");
    expect(memberAccess({ disabledAt: NOW - 1, expiresAt: NOW + 1 }, NOW)).toBe("disabled");
  });
});
