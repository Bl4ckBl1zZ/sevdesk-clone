import { sha256Hex } from "../audit/chain";

/**
 * API keys (05 §2.1, 03 §10 `apiKeys`, SEC-02).
 *
 *   sk_live_<43 chars base64url>        32 random bytes, shown once
 *   public key id   key_<first 8 chars> the `<id>` of the actors `api-key:<id>` / `mcp:<id>` (03 §0.1) and
 *                                       `apiKeys.prefix`; derived from the key, so `web` can mint the server JWT
 *                                       without a lookup — Convex then checks the key hash (02 §4.4)
 *   display         sk_live_<8>…<last4> list view („prefix…last4")
 *
 * Only `sha256(key)` (hex) is stored. Randomness is passed in (`apiKeyFromBytes`), the domain stays deterministic.
 */
export const API_KEY_PREFIX = "sk_live_";
const RANDOM_LENGTH = 43;
const KEY_RE = /^sk_live_([A-Za-z0-9_-]{43})$/;

export interface ParsedApiKey {
  key: string;
  publicId: string;
  last4: string;
  display: string;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Builds a key from ≥ 32 random bytes (only the first 32 are used). */
export function apiKeyFromBytes(random: Uint8Array): string {
  if (random.length < 32) throw new Error("API keys need 32 random bytes");
  const body = base64url(random.slice(0, 32));
  if (body.length !== RANDOM_LENGTH) throw new Error("unexpected key length");
  return `${API_KEY_PREFIX}${body}`;
}

export function publicKeyId(key: string): string {
  return `key_${key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 8)}`;
}

export function displayKey(key: string): string {
  return `${key.slice(0, API_KEY_PREFIX.length + 8)}…${key.slice(-4)}`;
}

export function parseApiKey(value: string): ParsedApiKey | null {
  const key = value.trim();
  if (!KEY_RE.test(key)) return null;
  return { key, publicId: publicKeyId(key), last4: key.slice(-4), display: displayKey(key) };
}

export function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

/** Query parameter names that would carry a credential; such requests are refused (05 §3 Auth, MCP spec). */
const QUERY_CREDENTIALS = ["api_key", "apikey", "api-key", "key", "access_token", "token", "x-api-key"];

/**
 * 05 §3 Auth: `Authorization: Bearer sk_live_…` or `X-API-Key`. A credential in the query string is an error even
 * when a header is present as well (the URL may already be logged).
 */
export function extractApiKey(
  headers: Headers,
  query: URLSearchParams,
): { key: string } | { error: "missing" | "in_query" } {
  for (const name of query.keys()) {
    if (QUERY_CREDENTIALS.includes(name.toLowerCase())) return { error: "in_query" };
  }
  const auth = headers.get("authorization");
  const bearer = auth ? /^bearer\s+(\S+)\s*$/i.exec(auth)?.[1] : undefined;
  const key = bearer ?? headers.get("x-api-key")?.trim();
  return key ? { key } : { error: "missing" };
}
