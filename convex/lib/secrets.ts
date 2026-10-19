import { env } from "./env";
import { appError } from "./errors";

/**
 * AES-256-GCM with the installation key `APP_ENCRYPTION_KEY` (base64, 32 bytes; 02 §4.5). Used to wrap the per-contact
 * data keys (convex/model/contactKeys.ts) and to store integration secrets such as the Claude API key
 * (`integrations.encryptedSecrets`, F01 SET-111). Ciphertext format: `<iv b64>:<ciphertext b64>`.
 */
export const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(text: string): Uint8Array {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

export async function kek(): Promise<CryptoKey> {
  const raw = env("APP_ENCRYPTION_KEY");
  if (!raw) throw appError("not_configured", "APP_ENCRYPTION_KEY fehlt – Daten können nicht verschlüsselt werden.");
  const bytes = b64.decode(raw);
  if (bytes.length !== 32) throw appError("not_configured", "APP_ENCRYPTION_KEY muss 32 Byte (Base64) lang sein.");
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function aesEncrypt(key: CryptoKey, plain: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));
  return `${b64.encode(iv)}:${b64.encode(ct)}`;
}

export async function aesDecrypt(key: CryptoKey, packed: string): Promise<Uint8Array> {
  const [iv, ct] = packed.split(":");
  if (!iv || !ct) throw new Error("malformed ciphertext");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64.decode(iv) as BufferSource },
      key,
      b64.decode(ct) as BufferSource,
    ),
  );
}

/** Encrypts a UTF-8 secret with the installation key. */
export async function encryptSecret(plain: string): Promise<string> {
  return aesEncrypt(await kek(), new TextEncoder().encode(plain));
}

/** Decrypts a secret written by `encryptSecret`. */
export async function decryptSecret(packed: string): Promise<string> {
  return new TextDecoder().decode(await aesDecrypt(await kek(), packed));
}
