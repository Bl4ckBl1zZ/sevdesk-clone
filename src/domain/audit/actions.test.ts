import { expect, test } from "vitest";
import { assertAuditAction, isAuditAction } from "./actions";

test.each([
  "document.finalize",
  "settings.company.update",
  "contact.merge",
  "auth.sign_in",
  "member.create",
  "invite.accept",
  "integrity.checkpoint",
  "security.write_rejected",
  "webhook.endpoint.create",
])("AUD-002 %s is in the action taxonomy", (a) => {
  expect(isAuditAction(a)).toBe(true);
});

test.each(["document.explode", "unknown.x", "document", "document.", ".x", "auth.signin"])(
  "AUD-002 %j is rejected",
  (a) => {
    expect(isAuditAction(a)).toBe(false);
    expect(() => assertAuditAction(a)).toThrow("unknown_audit_action");
  },
);
