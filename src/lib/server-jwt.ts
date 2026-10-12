import "server-only";
import { calculateJwkThumbprint, exportJWK, importPKCS8, SignJWT } from "jose";
import { SERVER_JWT_AUDIENCE } from "@/domain/access/identity";
import { parseActor } from "@/domain/schemas/actor";

/**
 * Server JWT for REST and MCP callers (02 §4.4). After `web` has verified an API key (REST) or an MCP bearer
 * token, it mints a short-lived ES256 JWT and calls Convex with it. Convex verifies it with the second
 * `customJwt` provider in convex/auth.config.ts (issuer `https://api.<BASE_DOMAIN>`, audience
 * `rechnungen-server`, JWKS = Convex env `SERVER_JWKS`), and `resolveIdentity` maps `sub` to the actor.
 *
 * Keys: `pnpm auth:keys server` prints `JWT_PRIVATE_KEY_PEM` (web env) and `SERVER_JWKS` (Convex env).
 * `kid` is the RFC 7638 thumbprint, so rotating means adding the new public key to SERVER_JWKS first.
 */
export const SERVER_JWT_TTL_SECONDS = 60;

export interface ServerJwtClaims {
  /** `api-key:<keyId>` or `mcp:<keyId>` — never a user. */
  actor: `api-key:${string}` | `mcp:${string}`;
  /** Scopes of the key (05 §2.2); Convex intersects them with the stored key again. */
  scopes: readonly string[];
  keyName?: string;
  /** MCP only: client info from the initialize handshake. */
  client?: { name: string; version: string };
  /** Request id for log correlation. */
  requestId?: string;
}

export interface ServerJwtOptions {
  privateKeyPem?: string;
  apiOrigin?: string;
  /** Seconds since epoch (tests). */
  now?: number;
}

const keyCache = new Map<string, Promise<{ key: CryptoKey; kid: string }>>();

function loadKey(pem: string) {
  let cached = keyCache.get(pem);
  if (!cached) {
    cached = (async () => {
      const key = await importPKCS8(pem, "ES256", { extractable: true });
      const { kty, crv, x, y } = await exportJWK(key);
      return { key, kid: await calculateJwkThumbprint({ kty, crv, x, y }) };
    })();
    keyCache.set(pem, cached);
  }
  return cached;
}

export async function mintServerJwt(claims: ServerJwtClaims, opts: ServerJwtOptions = {}): Promise<string> {
  const { kind } = parseActor(claims.actor);
  if (kind !== "api-key" && kind !== "mcp") throw new Error("Server-JWTs gibt es nur für api-key- und mcp-Akteure.");
  const pem = opts.privateKeyPem ?? process.env.JWT_PRIVATE_KEY_PEM ?? "";
  if (!pem) throw new Error("JWT_PRIVATE_KEY_PEM fehlt – Aufruf verweigert.");
  const apiOrigin = opts.apiOrigin ?? process.env.API_ORIGIN;
  if (!apiOrigin) throw new Error("API_ORIGIN fehlt – Aufruf verweigert.");
  const { key, kid } = await loadKey(pem);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  return new SignJWT({
    scopes: [...claims.scopes],
    ...(claims.keyName ? { keyName: claims.keyName } : {}),
    ...(claims.client ? { client: claims.client } : {}),
    ...(claims.requestId ? { requestId: claims.requestId } : {}),
  })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject(claims.actor)
    .setIssuer(apiOrigin.replace(/\/$/, ""))
    .setAudience(SERVER_JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + SERVER_JWT_TTL_SECONDS)
    .sign(key);
}
