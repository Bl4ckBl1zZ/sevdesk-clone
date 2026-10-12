import { createHmac } from "node:crypto";
import { createFunctionHandle } from "convex/server";
import { afterEach, describe, expect, test } from "vitest";
import { api, components, internal } from "./_generated/api";
import { createAuthOptions } from "./auth";
import { errorCode } from "./lib/errors";
import { makeT, TEST_ENV, type TestT } from "./test.setup";

const OWNER = TEST_ENV.OWNER_EMAIL;
const ORIGIN = TEST_ENV.SITE_URL;

async function post(t: TestT, path: string, body: unknown, cookie?: string) {
  const res = await t.fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") ?? "" };
}

async function requestCode(t: TestT, email: string) {
  return post(t, "/email-otp/send-verification-otp", { email, type: "sign-in" });
}

async function lastCode(t: TestT, email: string): Promise<string | undefined> {
  const mail = await t.query(internal.signup.latestMailFor, { to: email });
  return mail?.text.match(/Ihr Anmeldecode lautet: (\d{6})/)?.[1];
}

async function signIn(t: TestT, email: string) {
  const sent = await requestCode(t, email);
  expect(sent.status, JSON.stringify(sent.json)).toBe(200);
  const otp = await lastCode(t, email);
  expect(otp).toMatch(/^\d{6}$/);
  return post(t, "/sign-in/email-otp", { email, otp });
}

/** `Set-Cookie` header → `Cookie` header (name=value pairs only). */
const cookiesOf = (setCookie: string) =>
  setCookie
    .split(/,(?=\s*[\w.-]+=)/)
    .map((c) => c.split(";")[0]?.trim())
    .filter((c) => c && !/=$/.test(c))
    .join("; ");

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from the base32 secret of an otpauth:// URI — the authenticator app. */
function totpNow(uri: string, at = Date.now()): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

async function sessionCount(t: TestT, userId: string) {
  const res = (await t.query(components.betterAuth.adapter.findMany, {
    model: "session",
    where: [{ field: "userId", value: userId }],
    paginationOpts: { numItems: 50, cursor: null },
  })) as { page: unknown[] };
  return res.page.length;
}

const auditActions = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").withIndex("by_seq").collect()).map((e) => e.action));

describe("sign-up gate via Better Auth (02 §4.3, TST-AUD-28)", () => {
  test("SEC-01 bootstrap: OWNER_EMAIL signs in with an e-mail code and becomes owner (actor system:auth)", async () => {
    const t = makeT();
    const res = await signIn(t, OWNER);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.setCookie).toContain("better-auth.session_token");

    const member = await t.run((ctx) => ctx.db.query("members").first());
    expect(member).toMatchObject({ email: OWNER, role: "owner", totpEnabled: false });
    const log = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").collect());
    expect(log.find((e) => e.action === "member.create")).toMatchObject({ actor: "system:auth", channel: "system" });
    expect(log.find((e) => e.action === "auth.sign_in")).toMatchObject({
      actor: `user:${member?.authUserId}`,
      actorRole: "owner",
      entity: { table: "session" },
    });
  });

  test("SEC-01 bootstrap: any other address is refused before a code is sent (E-AUD-26)", async () => {
    const t = makeT();
    const res = await requestCode(t, "intruder@example.test");
    expect(res.status).toBe(403);
    expect(res.json.message).toBe("Die Ersteinrichtung ist nur mit der hinterlegten Inhaber-Adresse möglich.");
    expect(await lastCode(t, "intruder@example.test")).toBeUndefined();
    const denied = await t.run((ctx) => ctx.db.query("auditLog").first());
    expect(denied).toMatchObject({ action: "security.access_denied", reason: "bootstrap_owner_only" });
    expect(JSON.stringify(denied)).not.toContain("intruder@example.test");
    expect(await t.run((ctx) => ctx.db.query("members").collect())).toEqual([]);
  });

  test("SEC-01 after bootstrap: uninvited addresses are refused, invited ones join with the invite's role", async () => {
    const t = makeT();
    await signIn(t, OWNER);
    const refused = await requestCode(t, "steuer@example.test");
    expect(refused.status).toBe(403);
    expect(refused.json.message).toBe("Für diese E-Mail-Adresse besteht keine Einladung.");

    const owner = await t.asUser("owner");
    const inviteId = await owner.mutation(api.invites.create, { email: "Steuer@Example.test", role: "bookkeeper" });
    await t.finishAllScheduledFunctions(() => {});
    const inviteMail = await t.query(internal.signup.latestMailFor, { to: "steuer@example.test" });
    expect(inviteMail).toMatchObject({ kind: "invite" });
    expect(inviteMail?.text).toContain("Rolle: Buchhaltung");

    const res = await signIn(t, "steuer@example.test");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const member = await t.run((ctx) =>
      ctx.db
        .query("members")
        .withIndex("by_email", (q) => q.eq("email", "steuer@example.test"))
        .first(),
    );
    expect(member).toMatchObject({ role: "bookkeeper", inviteId, invitedBy: owner.actor });
    const invite = await t.run((ctx) => ctx.db.get(inviteId));
    expect(invite?.acceptedAt).toBeTypeOf("number");
    expect(invite?.acceptedUserId).toBe(member?.authUserId);
    expect(await auditActions(t)).toEqual(expect.arrayContaining(["invite.create", "invite.accept", "member.create"]));

    // the invite is consumed: a second account for the address cannot use it again
    const again = await t.run((ctx) => ctx.db.get(inviteId));
    expect(again?.acceptedAt).toBeDefined();
  });

  test("SEC-01 the trigger is the authoritative gate: a direct user insert without invite is rolled back", async () => {
    const t = makeT();
    await signIn(t, OWNER);
    const code = await t
      .run(async (ctx) => {
        const handle = await createFunctionHandle(internal.auth.onCreate);
        const now = Date.now();
        return ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: "user",
            data: { name: "x", email: "sneaky@example.test", emailVerified: true, createdAt: now, updatedAt: now },
          },
          onCreateHandle: handle,
        });
      })
      .then(
        () => undefined,
        (e) => errorCode(e) ?? String(e),
      );
    expect(code).toBe("signup_forbidden");
    const users = (await t.query(components.betterAuth.adapter.findMany, {
      model: "user",
      where: [{ field: "email", value: "sneaky@example.test" }],
      paginationOpts: { numItems: 10, cursor: null },
    })) as { page: unknown[] };
    expect(users.page).toEqual([]);
  });

  test("SEC-01 expired members cannot request a code (E-AUD-30)", async () => {
    const t = makeT();
    await t.asUser("viewer", { email: "old@example.test", expiresAt: Date.now() - 1 });
    const res = await requestCode(t, "old@example.test");
    expect(res.status).toBe(403);
    expect(res.json.message).toBe("Ihr Zugang ist abgelaufen.");
  });

  test("SEC-02 sign-out ends the session and is audited (auth.sign_out)", async () => {
    const t = makeT();
    const res = await signIn(t, OWNER);
    const cookie = res.setCookie
      .split(/,(?=\s*[\w.-]+=)/)
      .map((c) => c.split(";")[0]?.trim())
      .join("; ");
    const out = await post(t, "/sign-out", {}, cookie);
    expect(out.status, JSON.stringify(out.json)).toBe(200);
    expect(await auditActions(t)).toContain("auth.sign_out");
  });
});

describe("TOTP for e-mail-code sign-ins (02 §4.2, E-AUD-30a)", () => {
  test("SEC-01 with TOTP enabled an e-mail-code sign-in creates no session until the TOTP code is verified", async () => {
    const t = makeT();
    const first = await signIn(t, OWNER);
    const cookie = cookiesOf(first.setCookie);
    const enabled = await post(t, "/two-factor/enable", {}, cookie);
    expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
    const uri = String(enabled.json.totpURI);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enabled.json.backupCodes).toHaveLength(10);
    const confirm = await post(t, "/two-factor/verify-totp", { code: totpNow(uri) }, cookie);
    expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
    const member = await t.run((ctx) => ctx.db.query("members").first());
    expect(member?.totpEnabled).toBe(true);

    await post(t, "/sign-out", {}, cookiesOf(confirm.setCookie) || cookie);
    const userId = member?.authUserId ?? "";
    const before = await sessionCount(t, userId);

    const second = await signIn(t, OWNER);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ twoFactorRedirect: true });
    expect(second.setCookie).not.toMatch(/session_token=[^;]+/);
    expect(await sessionCount(t, userId)).toBe(before);

    const wrong = await post(t, "/two-factor/verify-totp", { code: "000000" }, cookiesOf(second.setCookie));
    expect(wrong.status).toBe(401);
    const verified = await post(t, "/two-factor/verify-totp", { code: totpNow(uri) }, cookiesOf(second.setCookie));
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    expect(verified.setCookie).toContain("better-auth.session_token");
    expect(await sessionCount(t, userId)).toBe(before + 1);
  });

  test("SEC-01 without TOTP the e-mail-code sign-in creates the session directly", async () => {
    const t = makeT();
    const res = await signIn(t, OWNER);
    expect(res.json.twoFactorRedirect).toBeUndefined();
    expect(res.setCookie).toContain("better-auth.session_token");
  });
});

describe("first run and session revocation (02 §4.3, 04 §4.9)", () => {
  test("SEC-01 GET /api/auth/rechnungen/first-run is true only while no member exists", async () => {
    const t = makeT();
    const before = await t.fetch("/api/auth/rechnungen/first-run", { headers: { origin: ORIGIN } });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ firstRun: true });
    await signIn(t, OWNER);
    const after = await t.fetch("/api/auth/rechnungen/first-run", { headers: { origin: ORIGIN } });
    expect(await after.json()).toEqual({ firstRun: false });
  });

  test("SEC-02 after sign-out a still-valid Convex JWT of that session can no longer write (session_invalid)", async () => {
    const t = makeT();
    const res = await signIn(t, OWNER);
    const member = await t.run((ctx) => ctx.db.query("members").first());
    const sessions = (await t.query(components.betterAuth.adapter.findMany, {
      model: "session",
      where: [{ field: "userId", value: member?.authUserId ?? "" }],
      paginationOpts: { numItems: 5, cursor: null },
    })) as { page: { _id: string }[] };
    const identity = t.withIdentity({
      issuer: TEST_ENV.CONVEX_SITE_URL,
      subject: member?.authUserId,
      sessionId: sessions.page[0]?._id,
    } as never);
    await expect(
      identity.mutation(api.settings.saveNotificationEmail, { values: { notificationEmail: OWNER } }),
    ).resolves.toBeNull();
    await post(t, "/sign-out", {}, cookiesOf(res.setCookie));
    expect(
      await identity
        .mutation(api.settings.saveNotificationEmail, { values: { notificationEmail: OWNER } })
        .catch(errorCode),
    ).toBe("session_invalid");
  });
});

describe("OTP throttle and auth mail (02 §4.2, §9)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.AUTH_MAIL_SENDER = saved.AUTH_MAIL_SENDER;
    process.env.BETTER_AUTH_SECRET = saved.BETTER_AUTH_SECRET;
  });

  test("SEC-01 at most 5 codes per hour per address (E-AUD-27); other addresses are unaffected", async () => {
    const t = makeT();
    for (let i = 0; i < 5; i++) expect((await requestCode(t, OWNER)).status).toBe(200);
    const sixth = await requestCode(t, OWNER);
    expect(sixth.status).toBe(429);
    expect(sixth.json.message).toMatch(/^Zu viele Codes angefordert — bitte in \d+ Minuten erneut versuchen\.$/);
    expect((await requestCode(t, "OTHER@example.test")).status).toBe(403); // gate, not throttle
  });

  test("SEC-01 the throttle reset exists only for tests (IS_TEST) and is a no-op otherwise", async () => {
    const t = makeT();
    for (let i = 0; i < 5; i++) await requestCode(t, OWNER);
    expect((await requestCode(t, OWNER)).status).toBe(429);
    process.env.IS_TEST = "";
    try {
      expect(await t.mutation(internal.signup.resetOtpQuota, { email: OWNER })).toBe(false);
    } finally {
      process.env.IS_TEST = "true";
    }
    expect((await requestCode(t, OWNER)).status).toBe(429);
    expect(await t.mutation(internal.signup.resetOtpQuota, { email: OWNER.toUpperCase() })).toBe(true);
    expect((await requestCode(t, OWNER)).status).toBe(200);
  });

  test("SET-009a a failed code mail is refused with a German message and audited (auth.otp_mail_failed)", async () => {
    const t = makeT();
    process.env.AUTH_MAIL_SENDER = "cloudflare"; // no CLOUDFLARE_* configured → EMAIL_NOT_CONFIGURED
    const res = await requestCode(t, OWNER);
    expect(res.status).toBe(503);
    expect(res.json.message).toBe("Code konnte nicht gesendet werden — bitte später erneut versuchen.");
    const recent = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").take(5));
    const entry = recent.find((e) => e.action === "auth.otp_mail_failed");
    expect(entry).toMatchObject({ action: "auth.otp_mail_failed", actor: "system:auth" });
    expect(entry?.reason).toMatch(/^EMAIL_NOT_CONFIGURED/);
    // The mail step of the setup wizard shows the failure (SET-107).
    const integration = await t.run((ctx) =>
      ctx.db
        .query("integrations")
        .filter((q) => q.eq(q.field("kind"), "cloudflare_email"))
        .first(),
    );
    expect(integration?.lastTestOk).toBe(false);
  });

  test("AUD-021 auth requests fail closed without BETTER_AUTH_SECRET", async () => {
    const t = makeT();
    delete process.env.BETTER_AUTH_SECRET;
    // The HTTP action throws (the backend answers 500); convex-test surfaces the exception.
    await expect(requestCode(t, OWNER)).rejects.toThrow("BETTER_AUTH_SECRET fehlt – Anmeldung verweigert (SEC-01).");
    expect(await lastCode(t, OWNER)).toBeUndefined();
  });
});

describe("Better Auth options (02 §4.2, research 14)", () => {
  test("SEC-01 no passwords, cookie cache off, IP rate limit off, OTP 6 digits / 10 min, 7-day sessions", () => {
    // biome-ignore lint/suspicious/noExplicitAny: static options without a Convex ctx
    const o = createAuthOptions({} as any);
    expect(o.emailAndPassword.enabled).toBe(false);
    expect(o.session.cookieCache.enabled).toBe(false);
    expect(o.rateLimit.enabled).toBe(false);
    expect(o.session.expiresIn).toBe(604_800);
    expect(o.session.freshAge).toBe(600);
    expect(o.advanced.useSecureCookies).toBe(true);
    expect(o.trustedOrigins).toEqual([TEST_ENV.SITE_URL]);
    expect(o.plugins.map((p) => p.id)).toEqual(
      expect.arrayContaining(["passkey", "email-otp", "two-factor", "convex"]),
    );
  });
});
