/**
 * Standard Webhooks signing (05 §5.2/§5.4). Secrets are `whsec_` + base64 of 24 random bytes; the HMAC key is the
 * decoded bytes (what the `standardwebhooks` library expects on the receiver). The signature header carries one
 * `v1,<base64>` per valid secret, separated by spaces — during a secret roll the new and the old one (24 h overlap).
 * Uses WebCrypto only, so it runs in Convex actions and in tests.
 */
export const SECRET_PREFIX = "whsec_";
export const SECRET_BYTES = 24;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function secretFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== SECRET_BYTES) throw new Error(`webhook secret needs ${SECRET_BYTES} bytes`);
  return `${SECRET_PREFIX}${toBase64(bytes)}`;
}

/** Last 4 characters for the endpoint list („whsec_…AbCd"); the secret itself is shown once. */
export function secretHint(secret: string): string {
  return `${SECRET_PREFIX}…${secret.slice(-4)}`;
}

export async function signPayload(secret: string, msgId: string, timestampSec: number, body: string): Promise<string> {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("webhook secret must start with whsec_");
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(secret.slice(SECRET_PREFIX.length)) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${msgId}.${timestampSec}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/** The three Standard Webhooks headers; `secrets` = [current, previous-within-overlap?]. */
export async function webhookHeaders(
  secrets: readonly string[],
  msgId: string,
  timestampSec: number,
  body: string,
): Promise<Record<string, string>> {
  const sigs = await Promise.all(secrets.map((s) => signPayload(s, msgId, timestampSec, body)));
  return {
    "content-type": "application/json",
    "webhook-id": msgId,
    "webhook-timestamp": String(timestampSec),
    "webhook-signature": sigs.join(" "),
  };
}
