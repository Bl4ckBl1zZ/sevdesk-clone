import { describe, expect, test } from "vitest";
import { isActor } from "../schemas/actor";
import {
  API_KEY_PREFIX,
  apiKeyFromBytes,
  displayKey,
  extractApiKey,
  hashApiKey,
  parseApiKey,
  publicKeyId,
} from "./keys";

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe("API keys (05 §2.1)", () => {
  test("API-001 a key is sk_live_ + 43 base64url characters from 32 random bytes", () => {
    const key = apiKeyFromBytes(bytes(7));
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(apiKeyFromBytes(bytes(8))).not.toBe(key);
  });

  test("API-001 fewer than 32 bytes are refused", () => {
    expect(() => apiKeyFromBytes(new Uint8Array(16))).toThrow();
  });

  test("API-001 the public key id is key_ + the first 8 random characters and a valid actor id", () => {
    const key = apiKeyFromBytes(bytes(250));
    const id = publicKeyId(key);
    expect(id).toBe(`key_${key.slice(8, 16)}`);
    expect(isActor(`api-key:${id}`)).toBe(true);
    expect(isActor(`mcp:${id}`)).toBe(true);
  });

  test("API-001 parseApiKey returns id, last4 and display string; malformed keys are rejected", () => {
    const key = apiKeyFromBytes(bytes(1));
    const p = parseApiKey(key);
    expect(p).toEqual({ key, publicId: publicKeyId(key), last4: key.slice(-4), display: displayKey(key) });
    expect(displayKey(key)).toBe(`${key.slice(0, 16)}…${key.slice(-4)}`);
    for (const bad of [
      "",
      "sk_live_",
      `sk_test_${key.slice(8)}`,
      `${key}x`,
      key.slice(0, -1),
      `sk_live_${"!".repeat(43)}`,
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  test("API-001 only the SHA-256 hex of the key is stored", async () => {
    const key = apiKeyFromBytes(bytes(3));
    const h = await hashApiKey(key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(key.slice(8));
    expect(await hashApiKey(key)).toBe(h);
  });

  test("API-004 the key comes from Authorization: Bearer or X-API-Key; a key in the query string is refused", () => {
    const key = apiKeyFromBytes(bytes(5));
    const h = (init: Record<string, string>) => new Headers(init);
    expect(extractApiKey(h({ authorization: `Bearer ${key}` }), new URLSearchParams())).toEqual({ key });
    expect(extractApiKey(h({ authorization: `bearer ${key}` }), new URLSearchParams())).toEqual({ key });
    expect(extractApiKey(h({ "x-api-key": key }), new URLSearchParams())).toEqual({ key });
    expect(extractApiKey(h({}), new URLSearchParams())).toEqual({ error: "missing" });
    expect(extractApiKey(h({ authorization: "Basic abc" }), new URLSearchParams())).toEqual({ error: "missing" });
    for (const name of ["api_key", "apikey", "key", "access_token", "token"]) {
      expect(extractApiKey(h({ authorization: `Bearer ${key}` }), new URLSearchParams({ [name]: key }))).toEqual({
        error: "in_query",
      });
    }
  });
});
