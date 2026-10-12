import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { internal } from "../convex/_generated/api";
import { expect, waitForAppOnNavigation } from "./fixtures";

/**
 * Real-backend helpers for the E2E journeys (07-testing §3.2, P0 gate). Prerequisites:
 *
 *   scripts/convex-local-backend.sh &    # self-hosted backend on :3210/:3211
 *   pnpm test:backend                    # Convex env (IS_TEST, memory mail), functions, .env.test.local
 *   pnpm e2e --project=desktop --project=pixel
 *
 * Without `E2E_BACKEND=1` (set in .env.test.local) the journeys are skipped. Sign-in codes are read from the
 * dev mailbox through the internal `signup.latestMailFor` with the admin key; that function refuses to run unless
 * the deployment has IS_TEST=true, so this path does not exist in production.
 */
export const backendEnabled = Boolean(
  process.env.E2E_BACKEND && process.env.CONVEX_SELF_HOSTED_URL && process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
);
export const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "owner@example.test";

function admin(): ConvexHttpClient {
  const client = new ConvexHttpClient(process.env.CONVEX_SELF_HOSTED_URL as string);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY as string,
  );
  return client;
}

/**
 * Empties the test deployment (app tables and component tables such as Better Auth) with
 * `convex import --replace-all` of an empty snapshot; Convex env and functions stay. Test backend only.
 */
export function resetBackend(): void {
  const dir = mkdtempSync(join(tmpdir(), "rechnungen-e2e-"));
  const zip = join(dir, "empty.zip");
  // Minimal ZIP: a single "end of central directory" record (no entries).
  writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
  execFileSync("pnpm", ["exec", "convex", "import", "--replace-all", "-y", zip], {
    env: { ...process.env, CONVEX_DEPLOYMENT: "" },
    stdio: "pipe",
  });
}

/** The latest sign-in code sent to `email` (dev mailbox, IS_TEST only). */
export async function latestCode(email: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
        const mail = (await admin().query(internal.signup.latestMailFor as any, { to: email })) as {
          text: string;
        } | null;
        code = mail?.text.match(/Ihr Anmeldecode lautet: (\d{6})/)?.[1];
        return code;
      },
      { timeout: 10_000 },
    )
    .toMatch(/^\d{6}$/);
  return code as string;
}

export async function hasMailFor(email: string): Promise<boolean> {
  // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
  return (await admin().query(internal.signup.latestMailFor as any, { to: email })) !== null;
}

/** Chromium virtual WebAuthn authenticator (platform, resident keys, user verification) for passkeys. */
export async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** /anmelden → „Code per E-Mail senden“ → six digits from the dev mailbox. */
export async function signInWithCode(page: Page, email: string): Promise<void> {
  await page.goto("/anmelden");
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.getByRole("button", { name: "Code per E-Mail senden" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Code eingeben" })).toBeVisible();
  const code = await latestCode(email);
  // Six digits submit the form automatically (04 §4.9); wait until the code page is left.
  await page.getByRole("group", { name: "Anmeldecode" }).getByRole("textbox").first().fill(code);
  await page.waitForURL((url) => !url.pathname.startsWith("/anmelden/code"), { timeout: 30_000 });
}

/** True while no member exists (the Better Auth first-run endpoint, 04 §4.9). */
export async function isFirstRun(baseURL: string): Promise<boolean> {
  const res = await fetch(new URL("/api/auth/rechnungen/first-run", baseURL));
  return ((await res.json()) as { firstRun: boolean }).firstRun;
}

/**
 * Signed-in owner session for specs that need the app shell. Expects the journey (e2e/journey.spec.ts) to have
 * created the owner and completed the setup in this project; returns null otherwise so the spec can skip.
 */
export async function ownerStorageState(
  browser: import("@playwright/test").Browser,
  use: import("@playwright/test").Project["use"] & { baseURL?: string },
  file: string,
): Promise<string | null> {
  if (!backendEnabled || !use.baseURL || (await isFirstRun(use.baseURL))) return null;
  const ctx = await browser.newContext({ ...use });
  const page = waitForAppOnNavigation(await ctx.newPage());
  await signInWithCode(page, OWNER_EMAIL);
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await ctx.storageState({ path: file });
  await ctx.close();
  return file;
}
