import { describe, expect, test } from "vitest";
import { mapAuthError } from "./errors";
import { safeRedirect, withRedirect } from "./redirect";

describe("?weiter= redirect target (04-ui-ux §3.4)", () => {
  test("SMOKE only same-origin paths are accepted (no open redirect)", () => {
    expect(safeRedirect("/rechnungen?status=overdue")).toBe("/rechnungen?status=overdue");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", "/a\nb", "", null]) {
      expect(safeRedirect(bad)).toBe("/");
    }
    expect(safeRedirect("/anmelden/code")).toBe("/");
    expect(withRedirect("/anmelden/code", "/kontakte")).toBe("/anmelden/code?weiter=%2Fkontakte");
    expect(withRedirect("/anmelden/code", null)).toBe("/anmelden/code");
  });
});

describe("German auth errors", () => {
  test("SMOKE Better Auth codes map to German message keys", () => {
    expect(mapAuthError({ code: "INVALID_OTP" }).key).toBe("codeInvalid");
    expect(mapAuthError({ code: "OTP_EXPIRED" }).key).toBe("codeInvalid");
    expect(mapAuthError({ code: "TOO_MANY_ATTEMPTS" }).key).toBe("tooManyAttempts");
    expect(mapAuthError({ status: 403 }).key).toBe("noInvite");
    expect(mapAuthError({ status: 429 })).toEqual({ key: "rateLimited", values: { minutes: 60 } });
    expect(mapAuthError(new DOMException("x", "NotAllowedError")).key).toBe("passkeyCancelled");
    expect(mapAuthError(new TypeError("Failed to fetch")).key).toBe("network");
    expect(mapAuthError({ code: "SOMETHING_ELSE", message: "English text" }).key).toBe("unknown");
  });
});
