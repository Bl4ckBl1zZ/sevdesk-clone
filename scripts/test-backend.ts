/**
 * Prepares a local self-hosted Convex backend for the integration and E2E suites (07-testing §3.2; no Docker).
 *
 *   scripts/convex-local-backend.sh &     # precompiled backend on :3210 (API) / :3211 (HTTP actions);
 *                                         # CONVEX_PORT / CONVEX_SITE_PORT move both (parallel worktrees)
 *   pnpm test:backend                     # this script: Convex env + keys, push functions, write .env.test.local
 *   pnpm test -p integration              # reads .env.test.local (test/load-test-env.ts)
 *   pnpm e2e --project=desktop --project=pixel   # playwright.config.ts reads .env.test.local
 *
 * Test-only settings: IS_TEST=true and AUTH_MAIL_SENDER=memory (sign-in codes land in the devMailbox table and are
 * readable only through the internal `signup.latestMailFor` with the admin key — never in production, where
 * IS_TEST is unset and the Cloudflare transport is used). Keys are generated once and cached in
 * .convex/local/test-keys.json (gitignored) so repeated runs keep sessions valid.
 *
 * Flags: --no-deploy (env only), --site-url <url> (default http://localhost:<E2E_PORT|3000>).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { betterAuthJwks, es256KeyPair } from "./generate-jwks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS_FILE = join(ROOT, ".convex/local/test-keys.json");
const ENV_FILE = join(ROOT, ".env.test.local");

export const TEST_OWNER_EMAIL = "owner@example.test";

interface Keys {
  BETTER_AUTH_SECRET: string;
  JWKS: string;
  SERVER_JWKS: string;
  JWT_PRIVATE_KEY_PEM: string;
  CHECKPOINT_SIGNING_KEY_PEM: string;
  APP_ENCRYPTION_KEY: string;
}

async function keys(): Promise<Keys> {
  if (existsSync(KEYS_FILE)) return JSON.parse(readFileSync(KEYS_FILE, "utf8")) as Keys;
  const secret = randomBytes(32).toString("base64url");
  const server = await es256KeyPair();
  const checkpoint = await es256KeyPair();
  const k: Keys = {
    BETTER_AUTH_SECRET: secret,
    JWKS: await betterAuthJwks(secret),
    SERVER_JWKS: JSON.stringify({ keys: [server.publicJwk] }),
    JWT_PRIVATE_KEY_PEM: server.privatePem,
    CHECKPOINT_SIGNING_KEY_PEM: checkpoint.privatePem,
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}

function backendEnv(): { url: string; adminKey: string } {
  let url = process.env.CONVEX_SELF_HOSTED_URL;
  let adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (!url || !adminKey) {
    const res = spawnSync(join(ROOT, "scripts/convex-local-backend.sh"), ["env"], { encoding: "utf8" });
    for (const line of res.stdout.split("\n")) {
      const m = /^([A-Z_]+)='?(.*?)'?$/.exec(line.trim());
      if (m?.[1] === "CONVEX_SELF_HOSTED_URL") url = m[2];
      if (m?.[1] === "CONVEX_SELF_HOSTED_ADMIN_KEY") adminKey = m[2];
    }
  }
  if (!url || !adminKey)
    throw new Error("CONVEX_SELF_HOSTED_URL/_ADMIN_KEY not found (start scripts/convex-local-backend.sh)");
  return { url, adminKey };
}

function convex(args: string[], env: NodeJS.ProcessEnv): void {
  const res = spawnSync("pnpm", ["exec", "convex", ...args], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) throw new Error(`convex ${args[0]} ${args[1] ?? ""} failed`);
}

async function main() {
  const args = process.argv.slice(2);
  const port = process.env.E2E_PORT ?? "3000";
  const siteIdx = args.indexOf("--site-url");
  const siteUrl = siteIdx >= 0 ? (args[siteIdx + 1] as string) : `http://localhost:${port}`;
  const { url, adminKey } = backendEnv();
  // HTTP actions listen on CONVEX_SITE_PORT (scripts/convex-local-backend.sh), default API port + 1.
  const apiPort = new URL(url).port || "3210";
  const sitePort = process.env.CONVEX_SITE_PORT ?? String(Number(apiPort) + 1);
  const siteActions = url.replace(new RegExp(`:${apiPort}\\b`), `:${sitePort}`);
  const k = await keys();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONVEX_SELF_HOSTED_URL: url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };
  delete env.CONVEX_DEPLOYMENT;

  const convexEnv: Record<string, string> = {
    IS_TEST: "true",
    AUTH_MAIL_SENDER: "memory",
    INSTANCE_NAME: "test",
    SITE_URL: siteUrl,
    BASE_DOMAIN: new URL(siteUrl).hostname,
    PASSKEY_RP_ID: new URL(siteUrl).hostname,
    OWNER_EMAIL: TEST_OWNER_EMAIL,
    BETTER_AUTH_SECRET: k.BETTER_AUTH_SECRET,
    JWKS: k.JWKS,
    SERVER_JWKS: k.SERVER_JWKS,
    CHECKPOINT_SIGNING_KEY_PEM: k.CHECKPOINT_SIGNING_KEY_PEM,
    APP_ENCRYPTION_KEY: k.APP_ENCRYPTION_KEY,
  };
  for (const [name, value] of Object.entries(convexEnv)) convex(["env", "set", "--", name, value], env);
  if (!args.includes("--no-deploy")) convex(["deploy", "--yes", "--typecheck", "disable"], env);

  const quote = (v: string) => JSON.stringify(v);
  const lines = {
    CONVEX_SELF_HOSTED_URL: url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    CONVEX_SITE_URL: siteActions,
    INTEGRATION_SITE_URL: siteUrl,
    OWNER_EMAIL: TEST_OWNER_EMAIL,
    JWT_PRIVATE_KEY_PEM: k.JWT_PRIVATE_KEY_PEM,
    API_ORIGIN: `https://api.${new URL(siteUrl).hostname}`,
    // web (Next) for the E2E run
    NEXT_PUBLIC_CONVEX_URL: url,
    NEXT_PUBLIC_SITE_URL: siteUrl,
    CONVEX_URL_INTERNAL: url,
    CONVEX_SITE_URL_INTERNAL: siteActions,
    E2E_BACKEND: "1",
  };
  writeFileSync(
    ENV_FILE,
    `# generated by scripts/test-backend.ts — local test backend only, never commit\n${Object.entries(lines)
      .map(([n, v]) => `${n}=${quote(v)}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  console.error(`✔ test backend configured (${url}), wrote ${ENV_FILE}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
