import { passkey } from "@better-auth/passkey";
import { type AuthFunctions, createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireRunMutationCtx } from "@convex-dev/better-auth/utils";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { type BetterAuthOptions, betterAuth } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins/email-otp";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { GenericActionCtx } from "convex/server";
import { normalizeEmail } from "../src/domain/access/signup";
import type { Actor } from "../src/domain/schemas/actor";
import { otpMail } from "../src/emails/auth-mails";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import authConfig from "./auth.config";
import authSchema from "./betterAuth/schema";
import { senderFromEnv } from "./lib/authMail";
import { appName, assertAuthEnv, env, passkeyRpId, siteUrl } from "./lib/env";
import { appError } from "./lib/errors";
import { guardedDb, newWriteStats } from "./model/db";
import { auditAuthEvent, createMemberFromSignup, getMemberByAuthUserId, setTotpEnabled } from "./model/members";
import type { ActorContext, ModelCtx } from "./model/types";

/**
 * Better Auth inside Convex (02 §4.2, ADR-015, research 14): Local Install component in convex/betterAuth/,
 * passkey (primary), e-mail OTP (fallback/recovery), optional TOTP; no passwords; sign-up gate; static JWKS;
 * cookie cache off; Better Auth's IP rate limit off (OTP throttle per address instead).
 */

// ── triggers: same transaction as the Better Auth write (02 §4.3) ──────────────────────────────────────
const authFunctions: AuthFunctions = internal.auth;

/** Runs trigger work with the guarded db and an actor; aborts with audit_missing if nothing was audited. */
async function asModel(ctx: MutationCtx, actor: ActorContext, work: (m: ModelCtx) => Promise<void>): Promise<void> {
  const stats = newWriteStats();
  const m: ModelCtx = {
    ...ctx,
    db: guardedDb(ctx.db, stats),
    actor: actor.actor,
    role: actor.role,
    actorContext: actor,
    now: () => Date.now(),
  };
  await work(m);
  if (stats.writes > 0 && stats.audits === 0) throw appError("audit_missing");
}

const SYSTEM_AUTH: ActorContext = { actor: "system:auth", channel: "system" };

async function userActor(ctx: MutationCtx, userId: string, extra: Partial<ActorContext> = {}): Promise<ActorContext> {
  const member = await getMemberByAuthUserId(ctx, userId);
  return {
    actor: `user:${userId}` as Actor,
    channel: "ui",
    ...(member ? { role: member.role, label: member.email } : {}),
    ...extra,
  };
}

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
  authFunctions,
  triggers: {
    user: {
      // The authoritative sign-up gate: creates the member (owner bootstrap or invite) or aborts the user insert.
      onCreate: async (ctx, user) => {
        await asModel(ctx, SYSTEM_AUTH, (m) =>
          createMemberFromSignup(m, { authUserId: user._id, email: user.email, name: user.name }).then(() => undefined),
        );
      },
      onUpdate: async (ctx, newUser, oldUser) => {
        if (Boolean(newUser.twoFactorEnabled) === Boolean(oldUser.twoFactorEnabled)) return;
        await asModel(ctx, await userActor(ctx, newUser._id), (m) =>
          setTotpEnabled(m, newUser._id, Boolean(newUser.twoFactorEnabled)),
        );
      },
    },
    session: {
      onCreate: async (ctx, session) => {
        const actor = await userActor(ctx, session.userId, {
          sessionId: session._id,
          ...(session.userAgent ? { userAgent: session.userAgent } : {}),
        });
        await asModel(ctx, actor, (m) =>
          auditAuthEvent(m, "auth.sign_in", session.userId, { table: "session", id: session._id }),
        );
      },
      onDelete: async (ctx, session) => {
        const actor = await userActor(ctx, session.userId, { sessionId: session._id });
        await asModel(ctx, actor, (m) =>
          auditAuthEvent(m, "auth.sign_out", session.userId, { table: "session", id: session._id }),
        );
      },
    },
    passkey: {
      onCreate: async (ctx, pk) => {
        await asModel(ctx, await userActor(ctx, pk.userId), (m) =>
          auditAuthEvent(m, "auth.passkey_add", pk.userId, { table: "passkey", id: pk._id }),
        );
      },
      onDelete: async (ctx, pk) => {
        await asModel(ctx, await userActor(ctx, pk.userId), (m) =>
          auditAuthEvent(m, "auth.passkey_remove", pk.userId, { table: "passkey", id: pk._id }),
        );
      },
    },
  },
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

// ── Better Auth options ───────────────────────────────────────────────────────────────────────────────
const OTP_PATH = "/email-otp/send-verification-otp";

const hasRun = (ctx: GenericCtx<DataModel>) => typeof (ctx as { runQuery?: unknown }).runQuery === "function";

/** Better Auth callbacks run inside the auth HTTP action (or a mutation); both can run queries and mutations. */
function runner(ctx: GenericCtx<DataModel>): Pick<GenericActionCtx<DataModel>, "runQuery" | "runMutation"> {
  return requireRunMutationCtx(ctx) as unknown as GenericActionCtx<DataModel>;
}

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  // Fail closed (F12 AUD-021): never serve auth requests without the secrets. The static instance used for schema
  // generation and route registration (`createAuth({})`) has no runQuery and is exempt.
  if (hasRun(ctx)) assertAuthEnv();
  const site = siteUrl();
  // createAuth(ctx) runs once per HTTP request, so this is per-request state.
  let otpMailFailure: string | undefined;

  return {
    appName: appName(),
    baseURL: site,
    trustedOrigins: site ? [site] : [],
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: false },
    rateLimit: { enabled: false }, // IP-based limits are meaningless behind the proxy; #432 (research 14 §2.2)
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 600,
      cookieCache: { enabled: false }, // #434: cookie cache mints JWTs for deleted sessions
    },
    advanced: { useSecureCookies: !site?.startsWith("http://") },
    hooks: {
      before: createAuthMiddleware(async (c) => {
        if (c.path !== OTP_PATH) return;
        const body = (c.body ?? {}) as { email?: unknown; type?: unknown };
        if (typeof body.email !== "string") return; // Better Auth validates the body
        const run = runner(ctx);
        if (body.type === "sign-in") {
          const check = await run.runQuery(internal.signup.checkSignIn, { email: body.email });
          if (!check.allowed) {
            await run.runMutation(internal.signup.recordAccessDenied, {
              email: body.email,
              reason: check.reason ?? "denied",
            });
            throw new APIError("FORBIDDEN", { message: check.message, code: "SIGNUP_FORBIDDEN" });
          }
        }
        // E-AUD-27: per-address throttle (5/hour, 20/day), never per IP.
        const quota = await run.runMutation(internal.signup.consumeOtpQuota, { email: body.email });
        if (!quota.ok) throw new APIError("TOO_MANY_REQUESTS", { message: quota.message, code: "OTP_THROTTLED" });
      }),
      after: createAuthMiddleware(async (c) => {
        if (c.path !== OTP_PATH || otpMailFailure === undefined) return;
        throw new APIError("SERVICE_UNAVAILABLE", {
          message: "Code konnte nicht gesendet werden — bitte später erneut versuchen.",
          code: otpMailFailure,
        });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Fast, friendly refusal before anything is written; the authoritative check runs in the trigger.
          before: async (user) => {
            const run = runner(ctx);
            const check = await run.runQuery(internal.signup.checkSignIn, { email: user.email });
            if (!check.allowed) {
              await run.runMutation(internal.signup.recordAccessDenied, {
                email: user.email,
                reason: check.reason ?? "signup_forbidden",
              });
              throw new APIError("FORBIDDEN", { message: check.message, code: "SIGNUP_FORBIDDEN" });
            }
            return { data: { ...user, email: normalizeEmail(user.email) } };
          },
        },
      },
    },
    plugins: [
      passkey({
        rpID: passkeyRpId(),
        rpName: appName(),
        ...(site ? { origin: site } : {}),
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        storeOTP: "hashed",
        // Better Auth awaits this callback but swallows its errors (`runInBackgroundOrAwait`), so the gate and the
        // throttle run in `hooks.before` and a mail failure is turned into an error response in `hooks.after`.
        async sendVerificationOTP({ email, otp, type }) {
          const run = runner(ctx);
          const sender = senderFromEnv(async (mail) => {
            await run.runMutation(internal.signup.storeDevMail, {
              to: mail.to,
              subject: mail.subject,
              text: mail.text,
              kind: mail.kind,
            });
          });
          const result = await sender.send({
            to: email,
            kind: `otp.${type}`,
            ...otpMail({ code: otp, appName: appName() }),
          });
          if (!result.ok) {
            otpMailFailure = result.code;
            await run.runMutation(internal.signup.recordOtpMailFailed, {
              email,
              code: result.code,
              detail: result.detail,
            });
          }
        },
      }),
      twoFactor({ issuer: appName(), allowPasswordless: true }),
      convex({ authConfig, jwks: env("JWKS") }),
    ],
  } satisfies BetterAuthOptions;
};

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth(createAuthOptions(ctx));
