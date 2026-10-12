/**
 * Key material for the security model (02 §4.5). Prints values; with `--set-convex` it also stores the Convex-side
 * values with `pnpm convex env set` (needs CONVEX_SELF_HOSTED_URL/_ADMIN_KEY, e.g. from .env.local).
 *
 *   pnpm auth:keys better-auth   # JWKS — static Better Auth key set (RS256); needs BETTER_AUTH_SECRET in the env
 *   pnpm auth:keys server        # JWT_PRIVATE_KEY_PEM (web) + SERVER_JWKS (Convex) — ES256 server JWT for API keys/MCP
 *   pnpm auth:keys checkpoint    # CHECKPOINT_SIGNING_KEY_PEM (Convex) + public JWK and fingerprint (Verfahrensdoku)
 *   pnpm auth:keys secrets       # BETTER_AUTH_SECRET + APP_ENCRYPTION_KEY (random)
 *   pnpm auth:keys dev --set-convex   # everything for a local backend (generates BETTER_AUTH_SECRET if missing)
 *
 * The Better Auth private key is encrypted with BETTER_AUTH_SECRET exactly like Better Auth's jwt plugin does, so the
 * static JWKS (`getAuthConfigProvider({ jwks })` + `convex({ jwks })`) works without `auth:rotateKeys`. Rotating
 * BETTER_AUTH_SECRET therefore requires a new JWKS (deploy/runbooks/rotate-secrets.md).
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair } from "jose";

export async function betterAuthJwks(secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must have at least 32 characters");
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const privateJwk = JSON.stringify(await exportJWK(privateKey));
  const encrypted = await symmetricEncrypt({ key: secret, data: privateJwk });
  if ((await symmetricDecrypt({ key: secret, data: encrypted })) !== privateJwk) throw new Error("round-trip failed");
  const doc = {
    id: randomUUID().replace(/-/g, ""),
    publicKey: JSON.stringify(await exportJWK(publicKey)),
    privateKey: JSON.stringify(encrypted),
    createdAt: Date.now(),
    alg: "RS256",
  };
  return JSON.stringify([doc]);
}

export async function es256KeyPair(): Promise<{ privatePem: string; publicJwk: Record<string, unknown>; kid: string }> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { privatePem: await exportPKCS8(privateKey), publicJwk: { ...jwk, kid, alg: "ES256", use: "sig" }, kid };
}

function setConvexEnv(name: string, value: string): void {
  const res = spawnSync("pnpm", ["exec", "convex", "env", "set", "--", name, value], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (res.status !== 0) throw new Error(`convex env set ${name} failed`);
  console.error(`✔ convex env ${name} set`);
}

async function main() {
  const [kind = "dev", ...flags] = process.argv.slice(2);
  const setConvex = flags.includes("--set-convex");
  const out: Record<string, string> = {};
  const convexVars = new Set<string>();

  if (kind === "secrets" || kind === "dev") {
    out.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("base64url");
    out.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    convexVars.add("BETTER_AUTH_SECRET").add("APP_ENCRYPTION_KEY");
  }
  if (kind === "better-auth" || kind === "dev") {
    const secret = out.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("set BETTER_AUTH_SECRET (the value stored in the Convex env) first");
    out.JWKS = await betterAuthJwks(secret);
    convexVars.add("JWKS");
  }
  if (kind === "server" || kind === "dev") {
    const k = await es256KeyPair();
    out.JWT_PRIVATE_KEY_PEM = k.privatePem;
    out.SERVER_JWKS = JSON.stringify({ keys: [k.publicJwk] });
    convexVars.add("SERVER_JWKS");
  }
  if (kind === "checkpoint" || kind === "dev") {
    const k = await es256KeyPair();
    out.CHECKPOINT_SIGNING_KEY_PEM = k.privatePem;
    out.CHECKPOINT_PUBLIC_JWK = JSON.stringify(k.publicJwk);
    convexVars.add("CHECKPOINT_SIGNING_KEY_PEM");
  }
  if (Object.keys(out).length === 0) throw new Error(`unknown kind ${kind}`);

  for (const [name, value] of Object.entries(out)) {
    if (setConvex && convexVars.has(name)) setConvexEnv(name, value);
    else console.log(`${name}=${value.includes("\n") ? JSON.stringify(value) : value}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}
