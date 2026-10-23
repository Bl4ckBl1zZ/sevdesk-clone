import { ConvexHttpClient } from "convex/browser";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { type InvariantTarget, useInvariantTarget } from "../invariants";

/**
 * Sign-up gate + e-mail OTP against the real self-hosted backend (07-testing §2, TST-AUD-28).
 *
 * Prerequisites (skipped otherwise):
 *   scripts/convex-local-backend.sh             # or deploy/compose.dev.yml
 *   pnpm exec convex env set …                  # see docs/adr/0002 (SITE_URL, OWNER_EMAIL, AUTH_MAIL_SENDER=memory,
 *                                               #   IS_TEST=true, BETTER_AUTH_SECRET, JWKS, SERVER_JWKS, …)
 *   pnpm exec convex dev --once                 # push functions
 *   CONVEX_SELF_HOSTED_URL=… CONVEX_SELF_HOSTED_ADMIN_KEY=… CONVEX_SITE_URL=… INTEGRATION_SITE_URL=… OWNER_EMAIL=…
 *
 * Works on a fresh or an already bootstrapped backend: the owner either is created or signs in again.
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
const siteUrl = process.env.CONVEX_SITE_URL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
const origin = process.env.INTEGRATION_SITE_URL ?? "https://app.localtest.me";
const owner = process.env.OWNER_EMAIL ?? "owner@example.test";
const enabled = Boolean(url && adminKey && siteUrl);

function adminClient(): ConvexHttpClient {
  const client = new ConvexHttpClient(url as string);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey as string);
  return client;
}

async function post(path: string, body: unknown, cookie?: string) {
  const res = await fetch(`${siteUrl}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json, setCookie: res.headers.getSetCookie() };
}

describe.skipIf(!enabled)("sign-up gate on the self-hosted backend (SEC-01)", () => {
  const admin = enabled ? adminClient() : (undefined as never);
  // biome-ignore lint/suspicious/noExplicitAny: internal functions via the admin key
  const internalQuery = (ref: unknown, args: Record<string, unknown>) => admin.query(ref as any, args as any);
  // biome-ignore lint/suspicious/noExplicitAny: internal functions via the admin key
  const internalMutation = (ref: unknown, args: Record<string, unknown>) => admin.mutation(ref as any, args as any);

  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
    useInvariantTarget({ action: (ref, args) => admin.action(ref as any, args as any) } as InvariantTarget);
    await internalMutation(internal.signup.resetOtpQuota, { email: owner });
  });

  test("SEC-01 OWNER_EMAIL signs in with a code; the Convex JWT resolves to the owner member", async () => {
    const sent = await post("/email-otp/send-verification-otp", { email: owner, type: "sign-in" });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const mail = (await internalQuery(internal.signup.latestMailFor, { to: owner })) as { text: string } | null;
    const otp = mail?.text.match(/Ihr Anmeldecode lautet: (\d{6})/)?.[1];
    expect(otp).toMatch(/^\d{6}$/);

    const signedIn = await post("/sign-in/email-otp", { email: owner, otp });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    const cookie = signedIn.setCookie.map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("better-auth.session_token");

    const tokenRes = await fetch(`${siteUrl}/api/auth/convex/token`, { headers: { cookie, origin } });
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };

    const client = new ConvexHttpClient(url as string);
    client.setAuth(token);
    const me = await client.query(api.members.me, {});
    expect(me).toMatchObject({ email: owner, role: "owner" });
  });

  test("SEC-01 an uninvited address is refused with the German message before any code is sent", async () => {
    const stranger = `fremd-${Date.now()}@example.test`;
    const res = await post("/email-otp/send-verification-otp", { email: stranger, type: "sign-in" });
    expect(res.status).toBe(403);
    expect(String(res.json.message)).toMatch(
      /^(Für diese E-Mail-Adresse besteht keine Einladung\.|Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich\.)$/,
    );
    expect(await internalQuery(internal.signup.latestMailFor, { to: stranger })).toBeNull();
  });

  test("SEC-01 public Convex functions reject calls without a JWT", async () => {
    const anonymous = new ConvexHttpClient(url as string);
    await expect(anonymous.query(api.members.list, {})).rejects.toThrow();
  });
});
