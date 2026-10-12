import { describe, expect, test } from "vitest";
import { actorSchema, formatActor, isActor, parseActor } from "./actor";

describe("actor identifiers (03 §0.1)", () => {
  test.each([
    "user:k57f3abc",
    "api-key:key_abc123",
    "mcp:key_abc123",
    "system:cron.integrity.verify",
    "system:auth",
    "portal:ptk_9f2",
  ])("AUD-002 accepts %s", (actor) => {
    expect(actorSchema.safeParse(actor).success).toBe(true);
  });

  test.each(["owner:owner", "auditor:x", "apiKey:x", "api_key:x", "key:x", "user:", "user:has space", "user:a/b", ""])(
    "AUD-002 rejects %j",
    (actor) => {
      expect(actorSchema.safeParse(actor).success).toBe(false);
      expect(isActor(actor)).toBe(false);
    },
  );

  test("AUD-002 parse and format round-trip and keep the id after the first colon", () => {
    expect(parseActor("system:cron.dunning.run")).toEqual({ kind: "system", id: "cron.dunning.run" });
    expect(formatActor("api-key", "key_1")).toBe("api-key:key_1");
    expect(() => formatActor("user", "")).toThrow("invalid_actor");
    expect(() => parseActor("owner:owner")).toThrow("invalid_actor");
  });
});
