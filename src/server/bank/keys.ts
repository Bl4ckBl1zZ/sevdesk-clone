/**
 * Application key pair for Enable Banking (F07 BNK-101 step 2, BNK-013): RSA-2048, generated on the server; the private
 * key (PKCS#8 PEM) is stored AES-GCM encrypted and never leaves the server, the public key (SPKI PEM) is shown for the
 * upload in the Enable Banking Control Panel. An uploaded key is validated the same way.
 */
import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair, importJWK, importPKCS8 } from "jose";

export interface ApplicationKey {
  privateKeyPem: string;
  publicKeyPem: string;
}

export async function generateApplicationKey(): Promise<ApplicationKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  return { privateKeyPem: await exportPKCS8(privateKey), publicKeyPem: await exportSPKI(publicKey) };
}

/** Validates an uploaded PKCS#8 RSA private key and derives its public key; throws a German message otherwise. */
export async function publicKeyOf(privateKeyPem: string): Promise<string> {
  try {
    const priv = await importPKCS8(privateKeyPem.trim().replace(/\\n/g, "\n"), "RS256", { extractable: true });
    const jwk = await exportJWK(priv);
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("kein RSA-Schlüssel");
    if (Math.ceil((jwk.n.length * 6) / 8) < 256) throw new Error("mindestens 2048 Bit erforderlich");
    const pub = await importJWK({ kty: "RSA", n: jwk.n, e: jwk.e }, "RS256");
    return exportSPKI(pub as CryptoKey);
  } catch (e) {
    const reason = e instanceof Error && /2048|RSA/.test(e.message) ? e.message : "Format nicht erkannt";
    throw new Error(
      `Der private Schlüssel ist ungültig (${reason}). Erwartet wird ein RSA-Schlüssel im PKCS#8-PEM-Format.`,
    );
  }
}
