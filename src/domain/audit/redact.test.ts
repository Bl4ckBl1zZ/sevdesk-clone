import { describe, expect, test } from "vitest";
import { REDACTED, REDACTED_KEYS, redactSecrets } from "./redact";

describe("audit redaction (AUD-003)", () => {
  test("AUD-003 secrets are redacted recursively, business data stays", () => {
    const diff = {
      before: { name: "website", hash: "abc", scopes: ["a"] },
      after: {
        name: "website",
        config: { bucket: "cp", encryptedSecrets: "xyz", nested: [{ token: "t" }, { ok: 1 }] },
        wrappedKey: undefined,
        password: null,
      },
    };
    expect(redactSecrets(diff)).toEqual({
      before: { name: "website", hash: REDACTED, scopes: ["a"] },
      after: {
        name: "website",
        config: { bucket: "cp", encryptedSecrets: REDACTED, nested: [{ token: REDACTED }, { ok: 1 }] },
        wrappedKey: undefined,
        password: null,
      },
    });
  });

  test("AUD-003 the redaction list covers the documented secret kinds", () => {
    for (const key of ["hash", "encryptedSecrets", "token", "password", "privateKey", "wrappedKey", "otp"]) {
      expect(REDACTED_KEYS.has(key)).toBe(true);
    }
  });

  test("AUD-003 primitives pass through unchanged", () => {
    expect(redactSecrets("x")).toBe("x");
    expect(redactSecrets(3)).toBe(3);
    expect(redactSecrets(null)).toBeNull();
  });
});
