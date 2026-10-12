import { v } from "convex/values";
import { memberAccess, normalizeEmail } from "../src/domain/access/signup";
import { sha256Hex } from "../src/domain/audit/chain";
import { systemMutation, systemQuery } from "./functions";
import { isTest } from "./lib/env";
import { otpThrottleMessage, rateLimiter } from "./lib/rateLimits";
import { appendAudit } from "./model/audit";
import { latestDevMail, storeDevMail as storeDevMailRow } from "./model/devMailbox";
import { getIntegration, recordIntegrationTest } from "./model/integrations";
import { anyMemberExists, getMemberByEmail, signupDecision } from "./model/members";

/**
 * Internal helpers for the Better Auth callbacks in convex/auth.ts (they run inside the auth HTTP action).
 * Actor: `system:auth`.
 */

/** May `email` request a sign-in code? Existing active members: yes; otherwise the sign-up gate decides. */
export const checkSignIn = systemQuery({
  job: "auth",
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ allowed: boolean; message?: string; reason?: string }> => {
    const member = await getMemberByEmail(ctx, email);
    if (member) {
      const access = memberAccess(member, ctx.now());
      if (access === "active") return { allowed: true };
      return {
        allowed: false,
        reason: `member_${access}`,
        message: access === "expired" ? "Ihr Zugang ist abgelaufen." : "Ihr Zugang wurde beendet.",
      };
    }
    const decision = await signupDecision(ctx, email, ctx.now());
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, reason: decision.reason, message: decision.message };
  },
});

/**
 * 02 §4.3 / 04 §4.9 first run: true while no user (= member) exists. Served to `/anmelden` through the Better Auth
 * endpoint `GET /api/auth/rechnungen/first-run` (convex/auth.ts) — never as a public Convex function.
 */
export const firstRun = systemQuery({
  job: "auth",
  args: {},
  handler: async (ctx): Promise<boolean> => !(await anyMemberExists(ctx)),
});

/** F01 SET-009a: a delivered sign-in code completes the e-mail step (recorded once, until a failure resets it). */
export const recordAuthMailDelivered = systemMutation({
  job: "auth",
  args: { transport: v.string() },
  handler: async (ctx, { transport }) => {
    const current = await getIntegration(ctx, "cloudflare_email");
    if (current?.lastTestOk === true) return;
    await recordIntegrationTest(ctx, "cloudflare_email", { ok: true, detail: `Anmeldecode zugestellt (${transport})` });
  },
});

/** E-AUD-26: refused sign-up/sign-in attempts are audited with a hash of the address, never the address. */
export const recordAccessDenied = systemMutation({
  job: "auth",
  args: { email: v.string(), reason: v.string() },
  handler: async (ctx, { email, reason }) => {
    const hash = (await sha256Hex(normalizeEmail(email))).slice(0, 32);
    await appendAudit(ctx, {
      action: "security.access_denied",
      entity: { table: "members", id: `email-sha256:${hash}` },
      reason,
    });
  },
});

/** OTP throttle per address (02 §4.2, E-AUD-27): 5 per hour, 20 per day. */
export const consumeOtpQuota = systemMutation({
  job: "auth",
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ ok: true } | { ok: false; message: string; retryAfter: number }> => {
    const key = normalizeEmail(email);
    const day = await rateLimiter.check(ctx, "otpPerDay", { key });
    if (!day.ok) return { ok: false, retryAfter: day.retryAfter, message: otpThrottleMessage(day.retryAfter) };
    const hour = await rateLimiter.limit(ctx, "otpPerHour", { key });
    if (!hour.ok) return { ok: false, retryAfter: hour.retryAfter, message: otpThrottleMessage(hour.retryAfter) };
    await rateLimiter.limit(ctx, "otpPerDay", { key });
    return { ok: true };
  },
});

/** Tests only (IS_TEST): clears the OTP throttle of an address so integration runs are repeatable. */
export const resetOtpQuota = systemMutation({
  job: "auth",
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    if (!isTest()) return false;
    const key = normalizeEmail(email);
    await rateLimiter.reset(ctx, "otpPerHour", { key });
    await rateLimiter.reset(ctx, "otpPerDay", { key });
    return true;
  },
});

/** 02 §9: a failed OTP mail is audited (`auth.otp_mail_failed`). */
export const recordOtpMailFailed = systemMutation({
  job: "auth",
  args: { email: v.string(), code: v.string(), detail: v.string() },
  handler: async (ctx, { email, code, detail }) => {
    const hash = (await sha256Hex(normalizeEmail(email))).slice(0, 32);
    await appendAudit(ctx, {
      action: "auth.otp_mail_failed",
      entity: { table: "members", id: `email-sha256:${hash}` },
      reason: `${code}: ${detail}`.slice(0, 500),
    });
    await recordIntegrationTest(ctx, "cloudflare_email", { ok: false, detail: `${code}: ${detail}` });
  },
});

/** Dev/test transport (AUTH_MAIL_SENDER=memory): store the mail so tests can read the code. */
export const storeDevMail = systemMutation({
  job: "auth",
  args: { to: v.string(), subject: v.string(), text: v.string(), kind: v.string() },
  handler: async (ctx, mail) => {
    await storeDevMailRow(ctx, mail);
  },
});

/** Tests/E2E: the latest dev mail for an address (only returns data with IS_TEST=true). */
export const latestMailFor = systemQuery({
  job: "auth",
  args: { to: v.string() },
  handler: async (ctx, { to }) => {
    if (!isTest()) return null;
    const mail = await latestDevMail(ctx, to);
    return mail ? { subject: mail.subject, text: mail.text, kind: mail.kind, at: mail.at } : null;
  },
});
