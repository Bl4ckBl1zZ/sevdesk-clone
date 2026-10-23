import { describe, expect, test } from "vitest";
import { type CurrentMember, checkAccess } from "./auth-access";

const member = (role: CurrentMember["role"], extra: Partial<CurrentMember> = {}): CurrentMember => ({
  actor: "user:u1",
  memberId: "m1",
  email: "a@example.test",
  name: null,
  role,
  expiresAt: null,
  totpEnabled: false,
  auditor: null,
  ...extra,
});

describe("requireRole decision for Server Components / Actions (02 §4.1 step 5)", () => {
  test("SEC-02 no member (signed out or not a member) → sign-in", () => {
    expect(checkAccess(null, "settings.read", 0)).toEqual({ ok: false, reason: "unauthenticated" });
  });

  test("SEC-02 the role matrix from src/domain/access decides", () => {
    expect(checkAccess(member("owner"), "members.manage", 0)).toMatchObject({ ok: true });
    expect(checkAccess(member("viewer"), "members.manage", 0)).toEqual({
      ok: false,
      reason: "forbidden_role",
      message: "Ihre Rolle (Lesezugriff) erlaubt diese Aktion nicht.",
    });
  });

  test("E-AUD-32 a Server Action of an auditor is refused with „Nur Lesezugriff.“; reads pass", () => {
    const auditor = member("auditor", { auditor: { organisation: "Finanzamt", purpose: "Az 1", fiscalYears: [2025] } });
    expect(checkAccess(auditor, "documents.write", 0)).toEqual({
      ok: false,
      reason: "forbidden_role",
      message: "Nur Lesezugriff.",
    });
    expect(checkAccess(auditor, "documents.read", 0)).toMatchObject({ ok: true });
  });

  test("SEC-02 an expired member is refused even if the session is still alive (E-AUD-30)", () => {
    expect(checkAccess(member("bookkeeper", { expiresAt: 10 }), "session.self", 11)).toMatchObject({
      ok: false,
      reason: "member_expired",
    });
  });
});
