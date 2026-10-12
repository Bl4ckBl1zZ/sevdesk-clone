import { ConvexHttpClient } from "convex/browser";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importPKCS8, SignJWT } from "jose";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { errorCode } from "../../convex/lib/errors";
import { SERVER_JWT_AUDIENCE } from "../../src/domain/access/identity";
import { type InvariantTarget, useInvariantTarget } from "../invariants";

/**
 * JWT providers and session revocation against the real self-hosted backend (02 §4.4, 07-testing P0 gate).
 * Prerequisites: scripts/convex-local-backend.sh + `pnpm test:backend` (writes .env.test.local); skipped otherwise.
 *
 * A server JWT that passes Convex's verification reaches our wrapper, which then refuses the unknown key with
 * `key_revoked`. Tokens with a foreign `kid`, an expired `exp` or a wrong `aud` never get that far.
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
const siteUrl = process.env.CONVEX_SITE_URL;
const origin = process.env.INTEGRATION_SITE_URL ?? "http://localhost:3000";
const owner = process.env.OWNER_EMAIL ?? "owner@example.test";
const pem = process.env.JWT_PRIVATE_KEY_PEM;
const apiOrigin = process.env.API_ORIGIN;
const enabled = Boolean(url && adminKey && siteUrl && pem && apiOrigin);

function adminClient(): ConvexHttpClient {
  const client = new ConvexHttpClient(url as string);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey as string);
  return client;
}

async function serverJwt(opts: { key?: CryptoKey; kid?: string; exp?: number; aud?: string } = {}) {
  const real = await importPKCS8(pem as string, "ES256", { extractable: true });
  const key = opts.key ?? real;
  const { kty, crv, x, y } = await exportJWK(key);
  const kid = opts.kid ?? (await calculateJwkThumbprint({ kty, crv, x, y }));
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scopes: ["audit:read"] })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject("api-key:key_doesnotexist")
    .setIssuer((apiOrigin as string).replace(/\/$/, ""))
    .setAudience(opts.aud ?? SERVER_JWT_AUDIENCE)
    .setIssuedAt(now - 120)
    .setExpirationTime(opts.exp ?? now + 60)
    .sign(key);
}

async function codeWith(token: string): Promise<string> {
  const client = new ConvexHttpClient(url as string);
  client.setAuth(token);
  try {
    await client.query(api.integrity.status, {});
    return "ok";
  } catch (e) {
    return errorCode(e) ?? "rejected";
  }
}

describe.skipIf(!enabled)("JWT providers on the self-hosted backend (02 §4.4)", () => {
  beforeEach(() => {
    const admin = adminClient();
    // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
    useInvariantTarget({ query: (ref, args) => admin.query(ref as any, args as any) } as InvariantTarget);
  });

  test("SEC-02 a valid server JWT is verified by Convex and reaches the key check (unknown key → key_revoked)", async () => {
    expect(await codeWith(await serverJwt())).toBe("key_revoked");
  });

  test("SEC-02 a server JWT signed with an unknown key (kid) is rejected", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    expect(await codeWith(await serverJwt({ key: privateKey }))).not.toBe("key_revoked");
    // Same foreign key but claiming the real kid: the signature does not verify.
    const real = await importPKCS8(pem as string, "ES256", { extractable: true });
    const { kty, crv, x, y } = await exportJWK(real);
    const realKid = await calculateJwkThumbprint({ kty, crv, x, y });
    expect(await codeWith(await serverJwt({ key: privateKey, kid: realKid }))).not.toBe("key_revoked");
  });

  test("SEC-02 an expired server JWT is rejected", async () => {
    expect(await codeWith(await serverJwt({ exp: Math.floor(Date.now() / 1000) - 30 }))).not.toBe("key_revoked");
  });

  test("SEC-02 a server JWT for another audience is rejected", async () => {
    expect(await codeWith(await serverJwt({ aud: "convex" }))).not.toBe("key_revoked");
  });
});

describe.skipIf(!enabled)("session revocation on the self-hosted backend (02 §4.2, E-AUD-31)", () => {
  const admin = enabled ? adminClient() : (undefined as never);
  // biome-ignore lint/suspicious/noExplicitAny: internal functions via the admin key
  const internalQuery = (ref: unknown, args: Record<string, unknown>) => admin.query(ref as any, args as any);
  // biome-ignore lint/suspicious/noExplicitAny: internal functions via the admin key
  const internalMutation = (ref: unknown, args: Record<string, unknown>) => admin.mutation(ref as any, args as any);

  beforeEach(async () => {
    useInvariantTarget({ query: (ref, args) => internalQuery(ref, args) } as InvariantTarget);
    await internalMutation(internal.signup.resetOtpQuota, { email: owner });
  });

  async function post(path: string, body: unknown, cookie?: string) {
    const res = await fetch(`${siteUrl}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      setCookie: res.headers.getSetCookie(),
    };
  }

  test("SEC-02 after sign-out the still-unexpired Convex JWT can read but no longer write (session_invalid)", async () => {
    const sent = await post("/email-otp/send-verification-otp", { email: owner, type: "sign-in" });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const mail = (await internalQuery(internal.signup.latestMailFor, { to: owner })) as { text: string } | null;
    const otp = mail?.text.match(/Ihr Anmeldecode lautet: (\d{6})/)?.[1];
    const signedIn = await post("/sign-in/email-otp", { email: owner, otp });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    if (signedIn.json.twoFactorRedirect) return; // owner enabled TOTP in an earlier E2E run: covered by convex/auth.test.ts
    const cookie = signedIn.setCookie.map((c) => c.split(";")[0]).join("; ");
    const tokenRes = await fetch(`${siteUrl}/api/auth/convex/token`, { headers: { cookie, origin } });
    const { token } = (await tokenRes.json()) as { token: string };
    const client = new ConvexHttpClient(url as string);
    client.setAuth(token);
    const args = { values: { notificationEmail: owner } };
    await expect(client.mutation(api.settings.saveNotificationEmail, args)).resolves.toBeNull();

    const out = await post("/sign-out", {}, cookie);
    expect(out.status).toBe(200);
    expect(await client.query(api.members.me, {})).toMatchObject({ role: "owner" });
    const code = await client.mutation(api.settings.saveNotificationEmail, args).then(
      () => "ok",
      (e: unknown) => errorCode(e),
    );
    expect(code).toBe("session_invalid");
  });
});
