/**
 * Secret redaction for audit diffs (F12 AUD-003, F01 SET-140, DSGVO-05). Applied **before** hashing and
 * storage, so the chain covers the redacted entry. Matching is by property name, recursively.
 *
 * Note: F01 SET-140 writes the placeholder as `"***"`, F12 TST-AUD-03 as `"[redacted]"`. The audit owner
 * (F12) wins; the UI shows it as „[geschwärzt]".
 */
export const REDACTED = "[redacted]";

export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "password",
  "secret",
  "secrets",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "sessionToken",
  "privateKey",
  "clientSecret",
  "apiKey",
  "otp",
  "hash", // apiKeys.hash (SHA-256 of the key) — AUD-003 "API key hashes"
  "encryptedSecret",
  "encryptedSecrets",
  "encryptedToken",
  "wrappedKey",
]);

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) && v !== undefined && v !== null ? REDACTED : redact(v);
  }
  return out;
}
