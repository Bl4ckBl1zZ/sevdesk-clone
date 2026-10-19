import { canonicalize } from "../../src/domain/audit/canonical";
import type { EncryptedValue } from "../../src/domain/audit/personal";
import { env } from "../lib/env";
import { appError } from "../lib/errors";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Per-contact data keys for crypto-shredding of personal values in audit diffs (03 §2 `contactKeys`,
 * F02 §5.12, DSGVO-02 vs GOBD-06). AES-256-GCM data key per contact, wrapped (AES-256-GCM) with
 * `APP_ENCRYPTION_KEY` (base64, 32 bytes). Shredding removes `wrappedKey` and sets `shreddedAt`; the audit chain
 * keeps verifying because it covers the ciphertext.
 */

const b64 = {
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

async function kek(): Promise<CryptoKey> {
  const raw = env("APP_ENCRYPTION_KEY");
  if (!raw)
    throw appError(
      "not_configured",
      "APP_ENCRYPTION_KEY fehlt – personenbezogene Protokolldaten können nicht verschlüsselt werden.",
    );
  const bytes = b64.decode(raw);
  if (bytes.length !== 32) throw appError("not_configured", "APP_ENCRYPTION_KEY muss 32 Byte (Base64) lang sein.");
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function aesEncrypt(key: CryptoKey, plain: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));
  return `${b64.encode(iv)}:${b64.encode(ct)}`;
}

async function aesDecrypt(key: CryptoKey, packed: string): Promise<Uint8Array> {
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

export async function getContactKeyRow(ctx: ReadCtx, contactId: string) {
  return ctx.db
    .query("contactKeys")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .unique();
}

async function dataKey(ctx: ModelCtx, contactId: string): Promise<CryptoKey> {
  const row = await getContactKeyRow(ctx, contactId);
  if (row?.shreddedAt !== undefined) {
    throw appError(
      "immutable_record",
      "Die personenbezogenen Daten dieses Kontakts wurden gelöscht (Schlüssel vernichtet).",
    );
  }
  if (row?.wrappedKey) {
    const raw = await aesDecrypt(await kek(), row.wrappedKey);
    return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrappedKey = await aesEncrypt(await kek(), raw);
  await ctx.db.insert("contactKeys", { contactId, wrappedKey, createdAt: ctx.now() });
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Returns an encryptor for one contact (creates the data key on first use). */
export async function personalEncryptor(
  ctx: ModelCtx,
  contactId: string,
): Promise<(value: unknown) => Promise<EncryptedValue>> {
  const key = await dataKey(ctx, contactId);
  return async (value) => {
    const packed = await aesEncrypt(key, encoder.encode(canonicalize(value)));
    const [iv, ct] = packed.split(":") as [string, string];
    return { enc: { contactId, iv, ct } };
  };
}

/** Decrypts an encrypted audit value; returns `null` once the contact's key was shredded. */
export async function decryptPersonal(ctx: ReadCtx, value: EncryptedValue): Promise<unknown> {
  const row = await getContactKeyRow(ctx, value.enc.contactId);
  if (!row?.wrappedKey) return null;
  const raw = await aesDecrypt(await kek(), row.wrappedKey);
  const key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plain = await aesDecrypt(key, `${value.enc.iv}:${value.enc.ct}`);
  return JSON.parse(decoder.decode(plain));
}

/**
 * Crypto-shredding (DSGVO-02, F12 PRV-007/F02 CON-163): destroys the contact's data key. The caller (purge job,
 * P3) writes the audit entry; the matrix allows exactly this change (wrappedKey removed once, shreddedAt once).
 */
export async function shredContactKey(ctx: ModelCtx, contactId: string): Promise<boolean> {
  const row = await getContactKeyRow(ctx, contactId);
  if (!row || row.shreddedAt !== undefined) return false;
  await ctx.db.patch("contactKeys", row._id, { wrappedKey: undefined, shreddedAt: ctx.now() });
  return true;
}

/** Small integration secrets at rest (e.g. the ntfy access token, NTF-004), wrapped with `APP_ENCRYPTION_KEY`. */
export async function encryptSecret(plain: string): Promise<string> {
  return aesEncrypt(await kek(), new TextEncoder().encode(plain));
}

export async function decryptSecret(packed: string): Promise<string> {
  return new TextDecoder().decode(await aesDecrypt(await kek(), packed));
}
