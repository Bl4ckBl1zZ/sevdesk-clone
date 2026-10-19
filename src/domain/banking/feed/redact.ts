/**
 * Log redaction for the bank feed (F07 BNK-013, SEC-06, DSGVO-05): the application private key (PEM), signed JWTs,
 * the authorisation `code`, session IDs, the `state` nonce and PSU headers never reach a log line. Applied to every
 * value the feed code logs or stores as an error text (by key name, recursively, and by pattern inside strings).
 */
export const FEED_REDACTED = "[redacted]";

const SECRET_KEYS = new Set(
  [
    "authorization",
    "privatekey",
    "privatekeypem",
    "encryptedprivatekeypem",
    "pem",
    "jwt",
    "token",
    "code",
    "state",
    "statehash",
    "session_id",
    "sessionid",
    "encryptedsessionid",
    "psu-ip-address",
    "psu-user-agent",
    "psu-referer",
    "psu-accept",
    "psu-accept-language",
    "psu-geo-location",
    "psuipaddress",
    "psuuseragent",
  ].map((k) => k.toLowerCase()),
);

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /([?&](?:code|state|session_id)=)[^&\s"']+/gi,
];

/** Redacts secrets inside a free text (error messages, URLs). */
export function redactText(text: string, extra: readonly string[] = []): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p, (m: string, prefix: unknown) =>
      typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}${FEED_REDACTED}` : FEED_REDACTED,
    );
  }
  for (const s of extra) if (s && s.length >= 6) out = out.split(s).join(FEED_REDACTED);
  return out;
}

/** Deep copy with secret keys and secret-looking strings redacted. `extra` = known secret values (session id, code). */
export function redactForLog<T>(value: T, extra: readonly string[] = []): T {
  return walk(value, extra) as T;
}

function walk(value: unknown, extra: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, extra);
  if (Array.isArray(value)) return value.map((v) => walk(v, extra));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) && v !== undefined && v !== null ? FEED_REDACTED : walk(v, extra);
  }
  return out;
}
