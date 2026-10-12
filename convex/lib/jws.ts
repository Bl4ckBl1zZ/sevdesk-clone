import { CompactSign, calculateJwkThumbprint, compactVerify, exportJWK, importJWK, importPKCS8, type JWK } from "jose";
import { canonicalize } from "../../src/domain/audit/canonical";

/**
 * ES256 JWS for the signed daily checkpoint (02 §4.5/§4.6, F12 AUD-016). The key is CHECKPOINT_SIGNING_KEY_PEM
 * (PKCS#8), separate from all token keys. `kid` = RFC 7638 thumbprint of the public JWK (printed in the
 * Verfahrensdokumentation). The payload is JCS-canonical JSON.
 */
export const CHECKPOINT_JWS_TYPE = "rechnungen-checkpoint+jws";

export interface CheckpointKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
}

export async function loadCheckpointKey(pem: string): Promise<CheckpointKey> {
  const privateKey = (await importPKCS8(pem.replace(/\\n/g, "\n"), "ES256", { extractable: true })) as CryptoKey;
  const { d: _d, ...publicJwk } = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return { privateKey, publicJwk: { ...publicJwk, kid, alg: "ES256" }, kid };
}

export async function signCheckpoint(payload: Record<string, unknown>, key: CheckpointKey): Promise<string> {
  return new CompactSign(new TextEncoder().encode(canonicalize(payload)))
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: CHECKPOINT_JWS_TYPE })
    .sign(key.privateKey);
}

export async function verifyCheckpoint(
  jws: string,
  publicJwk: JWK,
): Promise<{ ok: true; payload: Record<string, unknown>; kid: string | undefined } | { ok: false; error: string }> {
  try {
    const key = await importJWK(publicJwk, "ES256");
    const { payload, protectedHeader } = await compactVerify(jws, key);
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(payload)), kid: protectedHeader.kid };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
