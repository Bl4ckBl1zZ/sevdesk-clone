import { describe, expect, test } from "vitest";
import { resolveIdentity } from "./identity";

const issuers = { user: "https://convex-site.buero.example.de", server: "https://api.buero.example.de" };

describe("identity → actor (02 §4.4)", () => {
  test("AUD-002 Better Auth identities become user:<sub> with session id", () => {
    expect(
      resolveIdentity(
        { issuer: issuers.user, subject: "k57abc", sessionId: "s1", email: "a@b.de", name: "Anna" },
        issuers,
      ),
    ).toEqual({
      kind: "user",
      actor: "user:k57abc",
      authUserId: "k57abc",
      sessionId: "s1",
      email: "a@b.de",
      name: "Anna",
    });
  });

  test("AUD-002 server JWTs carry api-key:/mcp: actors with known scopes only", () => {
    expect(
      resolveIdentity(
        { issuer: issuers.server, subject: "api-key:key_w1", scopes: ["audit:read", "bogus"], keyName: "website" },
        issuers,
      ),
    ).toEqual({
      kind: "api-key",
      actor: "api-key:key_w1",
      keyId: "key_w1",
      scopes: ["audit:read"],
      keyName: "website",
    });
    expect(
      resolveIdentity(
        {
          issuer: issuers.server,
          subject: "mcp:key_c1",
          scopes: [],
          keyName: "Claude",
          client: { name: "claude-code", version: "3.1" },
        },
        issuers,
      ),
    ).toMatchObject({ kind: "mcp", actor: "mcp:key_c1", client: { name: "claude-code", version: "3.1" } });
  });

  test("API-006 API-008 server JWTs carry the key hash, the request id and the user agent", () => {
    expect(
      resolveIdentity(
        {
          issuer: issuers.server,
          subject: "api-key:key_w1",
          scopes: [],
          keyHash: "ab".repeat(32),
          requestId: "req_1",
          ua: "website/1.0",
        },
        issuers,
      ),
    ).toMatchObject({ keyHash: "ab".repeat(32), requestId: "req_1", userAgent: "website/1.0" });
  });

  test.each([
    [{ issuer: issuers.server, subject: "user:k57" }, "invalid_subject"],
    [{ issuer: issuers.server, subject: "system:cron.x" }, "invalid_subject"],
    [{ issuer: issuers.server, subject: "owner:owner" }, "invalid_subject"],
    [{ issuer: issuers.user, subject: "a b" }, "invalid_subject"],
    [{ issuer: "https://evil.example", subject: "k57" }, "unknown_issuer"],
  ])("SEC-01 rejects %j (%s)", (identity, error) => {
    expect(resolveIdentity(identity, issuers)).toEqual({ error });
  });

  test("SEC-01 an unconfigured server issuer never matches", () => {
    expect(resolveIdentity({ issuer: "", subject: "api-key:k" }, { user: issuers.user, server: undefined })).toEqual({
      error: "unknown_issuer",
    });
  });
});
